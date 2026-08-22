import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  type LLMProvider,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type ProviderCapabilities,
  type SpeechToTextProvider,
  type SttOpenRequest,
  type TextToSpeechProvider,
  type TranscriptEvent,
  type TtsEvent,
  type TtsSynthesisRequest,
} from "@tvic/core";
import { createWebClientAudioProvider } from "@tvic/providers";
import {
  PipelineVoiceLoop,
  createNodeMediaPlane,
  createRuntime,
  defineAgent,
  type NodeMediaPlane,
} from "@tvic/runtime";

import { createVoiceUpgradeAuthorizer } from "../src/gateway.js";
import { createVoiceSessionStore, type VoiceSessionIdentity } from "../src/security.js";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

describe("voice-mode full-loop e2e", () => {
  let plane: NodeMediaPlane<VoiceSessionIdentity> | undefined;
  afterEach(async () => plane?.stop());

  it("drives a push-to-talk utterance through the real gateway and text-only loop", async () => {
    const setup = await startLoopGateway("push_to_talk");
    plane = setup.plane;
    const socket = await connect(setup);
    const messages = collectJson(socket);
    socket.send(startFrame("push_to_talk"));
    await waitFor(() => messages.some((message) => message.type === "session.ready"));
    socket.send(audioFrame(1));
    socket.send(JSON.stringify({ type: "turn.end" }));
    await waitFor(() => messages.some((message) => message.type === "assistant.text"));
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "assistant.text", text: "End-to-end answer." }),
    );
    socket.send(JSON.stringify({ type: "session.end" }));
    await expect(setup.loopResult).resolves.toMatchObject({ turnsHandled: 1, turnsFailed: 0 });
  });

  it("delivers continuous audio, honors barge-in, and suppresses the unspoken full text", async () => {
    const setup = await startLoopGateway("continuous", true);
    plane = setup.plane;
    const socket = await connect(setup);
    const messages = collectJson(socket);
    let outputFrames = 0;
    socket.on("message", (_raw, isBinary) => {
      if (isBinary) outputFrames += 1;
    });
    socket.send(startFrame("continuous"));
    await waitFor(() => messages.some((message) => message.type === "session.ready"));
    socket.send(audioFrame(1));
    await waitFor(() => outputFrames > 0);
    socket.send(audioFrame(2));
    await waitFor(() => messages.some((message) => message.type === "output.clear"));
    expect(messages.some((message) => message.type === "assistant.text")).toBe(false);
    socket.send(JSON.stringify({ type: "session.end" }));
    await expect(setup.loopResult).resolves.toMatchObject({ interruptions: 1 });
    expect(messages.some((message) => message.type === "assistant.text")).toBe(false);
  });
});

async function startLoopGateway(mode: VoiceSessionIdentity["mode"], withTts = false) {
  const runtime = createRuntime();
  await runtime.start();
  const telephony = createWebClientAudioProvider({ heartbeatIntervalMs: 60_000 });
  const stt = createE2eStt(mode);
  const llm = createE2eLlm();
  const agent = defineAgent({
    id: `full-loop-${mode}`,
    name: "Full Loop E2E",
    instructions: "Test.",
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: { enabled: false, scopes: ["session"] },
    interruptionPolicy: {
      mode: mode === "continuous" ? "graceful" : "ignore",
      minSpeechMs: 0,
      trimOutputOnInterrupt: true,
    },
    providers: {
      telephony,
      stt,
      llm,
      ...(withTts ? { tts: createBlockingE2eTts() } : {}),
    },
  });
  const store = createVoiceSessionStore({
    tokenSecret: "token-secret",
    safetyIdentifierSecret: "safety-secret",
    ttlMs: 60_000,
  });
  const issued = store.reserve("e2e-user", mode);
  if (!issued.ok) throw new Error("session reservation failed");
  let resolveLoop!: (value: Awaited<ReturnType<PipelineVoiceLoop["run"]>>) => void;
  let rejectLoop!: (reason?: unknown) => void;
  const loopResult = new Promise<Awaited<ReturnType<PipelineVoiceLoop["run"]>>>(
    (resolve, reject) => {
      resolveLoop = resolve;
      rejectLoop = reject;
    },
  );
  const plane = createNodeMediaPlane<VoiceSessionIdentity>({
    port: 0,
    path: "/voice/:sessionRef",
    authorizeUpgrade: createVoiceUpgradeAuthorizer({ tokenStore: store, allowedOrigins: [] }),
    onConnection({ socket, upgradeContext }) {
      if (!upgradeContext) return;
      void (async () => {
        const session = await runtime.startSession(agent, { channel: "web_audio" });
        const handle = await telephony.acceptWebSocket(
          socket,
          upgradeContext.sessionRef as never,
          session.id,
          { expectedMode: mode },
        );
        return new PipelineVoiceLoop({
          runtime,
          session,
          agent,
          callHandle: handle,
          llmModel: "e2e-model",
          textDelivery: "always",
        }).run();
      })().then(resolveLoop, rejectLoop);
    },
  });
  await plane.start();
  return {
    plane,
    issued: issued.issued,
    loopResult,
  };
}

function createE2eStt(mode: VoiceSessionIdentity["mode"]): SpeechToTextProvider {
  return {
    name: "e2e-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async open(request: SttOpenRequest) {
      const events = new TestQueue<TranscriptEvent>();
      let audioCount = 0;
      let sequence = 1;
      let committed = false;
      const finalAndEndpoint = (): void => {
        events.push(finalEvent(request, sequence++, "End-to-end question."));
        events.push(endpointEvent(request, sequence++));
      };
      return {
        events,
        async sendAudio() {
          audioCount += 1;
          if (mode === "continuous" && audioCount === 1) finalAndEndpoint();
          if (mode === "continuous" && audioCount === 2) {
            events.push({
              id: `speech_${sequence}` as never,
              type: "stt.speech.started",
              direction: "input",
              sessionId: request.sessionId,
              sequence: sequence++,
              provider: "e2e-stt",
              timestamp: "2026-07-31T00:00:00.000Z" as never,
              audioOffsetMs: 0,
            });
          }
        },
        async commit() {
          if (mode === "push_to_talk" && !committed) {
            committed = true;
            finalAndEndpoint();
          }
        },
        async close() {
          events.close();
        },
      };
    },
  };
}

function createE2eLlm(): LLMProvider {
  return {
    name: "e2e-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async complete(request: LlmCompletionRequest) {
      const event: LlmStreamEvent = {
        id: "llm_completed" as never,
        type: "llm.completed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        provider: "e2e-llm",
        timestamp: "2026-07-31T00:00:00.000Z" as never,
        text: "End-to-end answer.",
        toolCalls: [],
      };
      return { events: iterableOf(event), async cancel() {} };
    },
  };
}

function createBlockingE2eTts(): TextToSpeechProvider {
  return {
    name: "e2e-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async synthesize(request: TtsSynthesisRequest) {
      const events = new TestQueue<TtsEvent>();
      events.push({
        id: "tts_chunk" as never,
        type: "media.audio.chunk",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        direction: "output",
        timestamp: "2026-07-31T00:00:00.000Z" as never,
        monotonicOffsetMs: 0,
        provider: "e2e-tts",
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 20,
          frameCount: 320,
          bytes: new Uint8Array(640),
        },
      });
      return {
        events,
        async cancel() {
          events.close();
        },
      };
    },
  };
}

function finalEvent(request: SttOpenRequest, sequence: number, text: string): TranscriptEvent {
  return {
    id: `final_${sequence}` as never,
    type: "stt.final",
    direction: "input",
    sessionId: request.sessionId,
    sequence,
    provider: "e2e-stt",
    text,
    startTimestamp: "2026-07-31T00:00:00.000Z" as never,
    endTimestamp: "2026-07-31T00:00:00.000Z" as never,
  };
}

function endpointEvent(request: SttOpenRequest, sequence: number): TranscriptEvent {
  return {
    id: `endpoint_${sequence}` as never,
    type: "stt.endpoint",
    direction: "input",
    sessionId: request.sessionId,
    sequence,
    provider: "e2e-stt",
    reason: "provider",
    timestamp: "2026-07-31T00:00:00.000Z" as never,
  };
}

async function connect(setup: Awaited<ReturnType<typeof startLoopGateway>>): Promise<WebSocket> {
  const { identity, token, expMs } = setup.issued;
  const url = `ws://127.0.0.1:${setup.plane.address?.port}/voice/${identity.sessionRef}?token=${token}&exp=${expMs}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => setTimeout(() => resolve(socket), 10));
    socket.once("error", reject);
  });
}

function collectJson(socket: WebSocket): Readonly<Record<string, unknown>>[] {
  const messages: Readonly<Record<string, unknown>>[] = [];
  socket.on("message", (raw, isBinary) => {
    if (!isBinary)
      messages.push(JSON.parse(raw.toString("utf8")) as Readonly<Record<string, unknown>>);
  });
  return messages;
}

function startFrame(mode: VoiceSessionIdentity["mode"]): string {
  return JSON.stringify({
    type: "session.start",
    protocolVersion: 1,
    mode,
    clientPlatform: "full-loop-e2e",
    audioFormat: PCM16_16K_MONO,
  });
}

function audioFrame(sequence: number): Buffer {
  const frame = Buffer.alloc(12 + 640);
  frame.writeUInt8(1, 0);
  frame.writeUInt32LE(sequence, 2);
  return frame;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for e2e condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function iterableOf<T>(value: T): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield value;
    },
  };
}

class TestQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
