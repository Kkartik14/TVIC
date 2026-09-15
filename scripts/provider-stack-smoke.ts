import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type WsWebSocket from "ws";
import type { RawData } from "ws";

const requireFromRuntimePackage = createRequire(
  new URL("../packages/voice-runtime/package.json", import.meta.url),
);
const WebSocket = requireFromRuntimePackage("ws") as typeof WsWebSocket;

import {
  PCM16_16K_MONO,
  TvicThrowableError,
  nowTimestamp,
  type TranscriptEvent,
} from "../packages/core/dist/index.js";
import { splitPcm16leFrames } from "../packages/media/dist/index.js";
import {
  createCartesiaTtsProvider,
  createDeepgramSttProvider,
  createGroqChatLlmProvider,
  PROVIDER_API_VERSIONS,
  PROVIDER_CATALOG,
} from "../packages/providers/dist/index.js";
import { createSttSession } from "../packages/runtime/dist/index.js";
import {
  createNodeMediaPlane as createPublicNodeMediaPlane,
  createVoiceAgent as createPublicVoiceAgent,
  createWebClientAudioProvider as createPublicWebClientAudioProvider,
  createDeepgramSttProvider as createPublicDeepgramSttProvider,
  createGroqChatLlmProvider as createPublicGroqChatLlmProvider,
  createCartesiaTtsProvider as createPublicCartesiaTtsProvider,
  PCM16_16K_MONO as PUBLIC_PCM16_16K_MONO,
} from "../packages/voice-runtime/dist/index.js";

const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
const CHUNK_DURATION_MS = 20;
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const EVIDENCE_PATH = fileURLToPath(
  new URL("../local/release/1.1.0/provider-stack-smoke.json", import.meta.url),
);

interface SmokeConfig {
  readonly groqModel: string;
  readonly sttModel?: string;
  readonly sttLanguage?: string;
  readonly cartesiaModel?: string;
  readonly groqUrl?: string;
}

interface AudioResult {
  readonly bytes: Uint8Array;
  readonly chunks: number;
  readonly durationMs: number;
}

interface SttResult {
  readonly text: string;
  readonly partials: number;
  readonly finals: number;
  readonly endpoints: number;
}

interface LlmResult {
  readonly text: string;
  readonly tokens: number;
}

interface CancellationResult {
  readonly audioChunksBeforeCancel: number;
}

interface TransportResult {
  readonly transport: "web-client-audio";
  readonly sessionReady: boolean;
  readonly inputFrames: number;
  readonly outputAudioFrames: number;
  readonly assistantMessages: number;
  readonly outputCommits: number;
  readonly cleanShutdown: boolean;
}

interface SmokeEvidence {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly harness: "provider-stack-smoke";
  readonly stack: {
    readonly stt: {
      readonly provider: "deepgram";
      readonly model: string;
      readonly adapterVersion: string;
      readonly apiVersion: "v1 listen";
    };
    readonly llm: {
      readonly provider: "groq";
      readonly model: string;
      readonly adapterVersion: string;
      readonly apiVersion: "OpenAI-compatible v1 Chat Completions";
    };
    readonly tts: {
      readonly provider: "cartesia";
      readonly model: string;
      readonly adapterVersion: string;
      readonly apiVersion: string;
    };
  };
  readonly results: {
    readonly inputAudioChunks: number;
    readonly inputAudioDurationMs: number;
    readonly sttPartials: number;
    readonly sttFinals: number;
    readonly sttEndpoints: number;
    readonly llmTokens: number;
    readonly outputAudioChunks: number;
    readonly outputAudioDurationMs: number;
    readonly cancellationAudioChunksBeforeCancel: number;
    readonly transport: TransportResult;
  };
}

loadLocalEnv();

void main().catch((error: unknown) => {
  if (error instanceof TvicThrowableError) {
    console.error(`Provider stack smoke failed (${error.error.code})`);
  } else if (error instanceof Error) {
    console.error(`Provider stack smoke failed: ${error.message}`);
  } else if (typeof errorCode(error) === "string") {
    console.error(`Provider stack smoke failed (${errorCode(error)})`);
  } else {
    console.error("Provider stack smoke failed");
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const config = loadConfig();
  const cartesia = createCartesiaTtsProvider({
    apiKey: requiredEnv("CARTESIA_API_KEY"),
    voiceId: requiredEnv("CARTESIA_VOICE_ID"),
    ...(config.cartesiaModel ? { modelId: config.cartesiaModel } : {}),
  });
  const deepgram = createDeepgramSttProvider({ apiKey: requiredEnv("DEEPGRAM_API_KEY") });
  const groq = createGroqChatLlmProvider({
    apiKey: requiredEnv("GROQ_API_KEY"),
    ...(config.groqUrl ? { url: config.groqUrl } : {}),
  });

  const sttModel = config.sttModel ?? PROVIDER_CATALOG.deepgram.defaultModel;
  const cartesiaModel = config.cartesiaModel ?? PROVIDER_CATALOG.cartesia.defaultModel;
  console.log(
    `Provider stack smoke: Deepgram/${sttModel} -> ` +
      `Groq/${config.groqModel} -> Cartesia/${cartesiaModel}`,
  );
  console.log(
    `Provider/API versions: Deepgram/${deepgram.version} + v1 listen, ` +
      `Groq/${groq.version} + OpenAI-compatible v1 Chat Completions, ` +
      `Cartesia/${cartesia.version} + ${PROVIDER_API_VERSIONS.cartesia}`,
  );

  // Generate the STT fixture through the selected TTS provider so this check is
  // self-contained. Audio and transcript text stay in memory and are never logged
  // or written to the release evidence artifact.
  const inputAudio = await synthesize(
    cartesia,
    "Please tell me today's opening hours.",
    "smoke_input",
  );
  const transcription = await transcribe(deepgram, inputAudio.bytes, config);
  if (!transcription.text) {
    throw new Error("Deepgram returned no final transcript for the generated fixture");
  }
  const response = await complete(groq, transcription.text, config);
  if (!response.text || response.tokens === 0) {
    throw new Error("Groq returned no streamed text for the transcript");
  }
  const outputAudio = await synthesize(cartesia, response.text, "smoke_output");
  const cancellation = await cancelInFlight(cartesia);
  const transport = await runTransportSmoke(config, inputAudio.bytes);
  const evidence: SmokeEvidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    harness: "provider-stack-smoke",
    stack: {
      stt: {
        provider: "deepgram",
        model: sttModel,
        adapterVersion: deepgram.version,
        apiVersion: "v1 listen",
      },
      llm: {
        provider: "groq",
        model: config.groqModel,
        adapterVersion: groq.version,
        apiVersion: "OpenAI-compatible v1 Chat Completions",
      },
      tts: {
        provider: "cartesia",
        model: cartesiaModel,
        adapterVersion: cartesia.version,
        apiVersion: PROVIDER_API_VERSIONS.cartesia,
      },
    },
    results: {
      inputAudioChunks: inputAudio.chunks,
      inputAudioDurationMs: Math.round(inputAudio.durationMs),
      sttPartials: transcription.partials,
      sttFinals: transcription.finals,
      sttEndpoints: transcription.endpoints,
      llmTokens: response.tokens,
      outputAudioChunks: outputAudio.chunks,
      outputAudioDurationMs: Math.round(outputAudio.durationMs),
      cancellationAudioChunksBeforeCancel: cancellation.audioChunksBeforeCancel,
      transport,
    },
  };
  writeEvidence(evidence);

  console.log(
    `Passed: input_audio=${inputAudio.chunks} chunks/${Math.round(inputAudio.durationMs)}ms, ` +
      `stt_final=${transcription.finals}, stt_partial=${transcription.partials}, ` +
      `stt_endpoint=${transcription.endpoints}, llm_tokens=${response.tokens}, ` +
      `output_audio=${outputAudio.chunks} chunks/${Math.round(outputAudio.durationMs)}ms, ` +
      `cancel_probe=${cancellation.audioChunksBeforeCancel} chunks, ` +
      `transport_input=${transport.inputFrames} frames, ` +
      `transport_output=${transport.outputAudioFrames} frames`,
  );
}

function loadConfig(): SmokeConfig {
  return {
    groqModel: optionalEnv("GROQ_MODEL") ?? optionalEnv("LLM_MODEL") ?? DEFAULT_GROQ_MODEL,
    ...(optionalEnv("STT_MODEL") ? { sttModel: optionalEnv("STT_MODEL") } : {}),
    ...(optionalEnv("STT_LANGUAGE") ? { sttLanguage: optionalEnv("STT_LANGUAGE") } : {}),
    ...(optionalEnv("CARTESIA_MODEL") ? { cartesiaModel: optionalEnv("CARTESIA_MODEL") } : {}),
    ...(optionalEnv("GROQ_API_URL") ? { groqUrl: optionalEnv("GROQ_API_URL") } : {}),
  };
}

async function synthesize(
  provider: ReturnType<typeof createCartesiaTtsProvider>,
  text: string,
  turnId: string,
): Promise<AudioResult> {
  const opening = provider.synthesize({
    sessionId: "provider_stack_smoke" as never,
    turnId: turnId as never,
    text,
    format: PCM16_16K_MONO,
    stream: true,
  });
  let stream: Awaited<typeof opening>;
  try {
    stream = await withTimeout(opening, OPERATION_TIMEOUT_MS, "Cartesia synthesis startup");
  } catch (error) {
    void opening
      .then((lateStream) =>
        withTimeout(
          lateStream.cancel(),
          OPERATION_TIMEOUT_MS,
          "Late Cartesia synthesis cancellation",
        ).catch(() => undefined),
      )
      .catch(() => undefined);
    throw error;
  }
  const chunks: Uint8Array[] = [];
  let durationMs = 0;
  let chunkCount = 0;
  let totalBytes = 0;
  const consume = (async (): Promise<void> => {
    for await (const event of stream.events) {
      if (event.type !== "media.audio.chunk") continue;
      const bytes = new Uint8Array(event.audio.bytes);
      if (totalBytes + bytes.byteLength > MAX_AUDIO_BYTES) {
        throw new Error("Cartesia smoke output exceeded the bounded audio limit");
      }
      chunks.push(bytes);
      totalBytes += bytes.byteLength;
      chunkCount += 1;
      durationMs += event.audio.durationMs;
    }
  })();
  try {
    await withTimeout(consume, OPERATION_TIMEOUT_MS, "Cartesia synthesis");
  } catch (error) {
    await stream.cancel().catch(() => undefined);
    await consume.catch(() => undefined);
    throw error;
  }
  await stream.cancel().catch(() => undefined);
  const bytes = concat(chunks);
  if (bytes.byteLength === 0) throw new Error("Cartesia returned no audio");
  return { bytes, chunks: chunkCount, durationMs };
}

async function cancelInFlight(
  provider: ReturnType<typeof createCartesiaTtsProvider>,
): Promise<CancellationResult> {
  const opening = provider.synthesize({
    sessionId: "provider_stack_smoke" as never,
    turnId: "smoke_cancel" as never,
    text: "This is a deliberately longer cancellation probe so the provider has an active generation to stop.",
    format: PCM16_16K_MONO,
    stream: true,
  });
  let stream: Awaited<typeof opening>;
  try {
    stream = await withTimeout(opening, OPERATION_TIMEOUT_MS, "Cartesia cancellation startup");
  } catch (error) {
    void opening
      .then((lateStream) =>
        withTimeout(
          lateStream.cancel(),
          OPERATION_TIMEOUT_MS,
          "Late Cartesia cancellation-probe cancellation",
        ).catch(() => undefined),
      )
      .catch(() => undefined);
    throw error;
  }
  let audioChunksBeforeCancel = 0;
  let cancelCalls = 0;
  const consume = (async (): Promise<void> => {
    for await (const event of stream.events) {
      if (event.type !== "media.audio.chunk") continue;
      audioChunksBeforeCancel += 1;
      if (cancelCalls > 0) continue;
      cancelCalls += 1;
      await withTimeout(stream.cancel(), OPERATION_TIMEOUT_MS, "Cartesia in-flight cancellation");
    }
  })();
  try {
    await withTimeout(consume, OPERATION_TIMEOUT_MS, "Cartesia cancellation drain");
  } catch (error) {
    await stream.cancel().catch(() => undefined);
    await consume.catch(() => undefined);
    throw error;
  }
  if (cancelCalls !== 1 || audioChunksBeforeCancel === 0) {
    throw new Error("Cartesia cancellation probe did not cancel after an audio chunk");
  }
  return { audioChunksBeforeCancel };
}

async function transcribe(
  provider: ReturnType<typeof createDeepgramSttProvider>,
  audio: Uint8Array,
  config: SmokeConfig,
): Promise<SttResult> {
  const session = await createSttSession({
    provider,
    format: PCM16_16K_MONO,
    ...(config.sttModel ? { model: config.sttModel } : {}),
    ...(config.sttLanguage ? { language: config.sttLanguage } : {}),
    interimResults: true,
    openTimeoutMs: OPERATION_TIMEOUT_MS,
  });
  let partials = 0;
  let finals = 0;
  let endpoints = 0;
  let finalText = "";
  let resolveFinal: (() => void) | undefined;
  const finalSeen = new Promise<void>((resolve) => {
    resolveFinal = resolve;
  });
  const consume = consumeStt(session.events, (event) => {
    if (event.type === "stt.partial") partials += 1;
    if (event.type === "stt.final") {
      finals += 1;
      finalText = `${finalText} ${event.text}`.trim();
      resolveFinal?.();
      resolveFinal = undefined;
    }
    if (event.type === "stt.endpoint") endpoints += 1;
  });

  try {
    for (const chunk of splitPcm16leFrames(audio, PCM16_16K_MONO, CHUNK_DURATION_MS)) {
      await session.pushPcm16(chunk);
    }
    await withTimeout(session.commit(), OPERATION_TIMEOUT_MS, "Deepgram commit");
    await withTimeout(finalSeen, OPERATION_TIMEOUT_MS, "Deepgram final transcript");
  } finally {
    await session.close().catch(() => undefined);
  }
  await consume;
  return { text: finalText, partials, finals, endpoints };
}

async function consumeStt(
  events: AsyncIterable<TranscriptEvent>,
  observe: (event: TranscriptEvent) => void,
): Promise<void> {
  for await (const event of events) observe(event);
}

async function complete(
  provider: ReturnType<typeof createGroqChatLlmProvider>,
  transcript: string,
  config: SmokeConfig,
): Promise<LlmResult> {
  const completion = await provider.complete({
    sessionId: "provider_stack_smoke" as never,
    turnId: "smoke_llm" as never,
    model: config.groqModel,
    messages: [
      { role: "system", content: "Answer briefly and naturally for a phone caller." },
      { role: "user", content: transcript },
    ],
    stream: true,
    // The selected GPT-OSS model emits hidden reasoning tokens before its
    // user-visible answer. Leave enough completion budget for both; a 96-token
    // cap can legally end with an empty visible answer even when the request
    // succeeded.
    maxTokens: 512,
  });
  let text = "";
  let tokens = 0;
  const consume = (async (): Promise<void> => {
    for await (const event of completion.events) {
      if (event.type === "llm.token") {
        text += event.text;
        tokens += 1;
      }
      if (event.type === "llm.failed") throw new Error("Groq returned a failed completion");
      if (event.type === "llm.completed" && !text) text = event.text;
    }
  })();
  try {
    await withTimeout(consume, OPERATION_TIMEOUT_MS, "Groq completion");
  } catch (error) {
    await completion.cancel().catch(() => undefined);
    await consume.catch(() => undefined);
    throw error;
  }
  return { text: text.trim(), tokens };
}

/**
 * Exercises the selected providers through the built public package bundle and the
 * real Node/WebSocket Web Client Audio transport. The client is a local test
 * peer, so no browser credentials or caller content leave the process.
 */
async function runTransportSmoke(
  config: SmokeConfig,
  inputAudio: Uint8Array,
): Promise<TransportResult> {
  const callId = "provider_stack_transport";
  const telephony = createPublicWebClientAudioProvider({
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 60_000,
    maxSessionDurationMs: 60_000,
  });
  const stt = createPublicDeepgramSttProvider({ apiKey: requiredEnv("DEEPGRAM_API_KEY") });
  const llm = createPublicGroqChatLlmProvider({
    apiKey: requiredEnv("GROQ_API_KEY"),
    ...(config.groqUrl ? { url: config.groqUrl } : {}),
  });
  const tts = createPublicCartesiaTtsProvider({
    apiKey: requiredEnv("CARTESIA_API_KEY"),
    voiceId: requiredEnv("CARTESIA_VOICE_ID"),
    ...(config.cartesiaModel ? { modelId: config.cartesiaModel } : {}),
  });
  const agent = createPublicVoiceAgent({
    id: "provider-stack-smoke-agent",
    name: "Provider Stack Smoke Agent",
    prompt: "Answer the caller briefly and naturally.",
    providers: { telephony, stt, llm, tts },
    audio: { input: PUBLIC_PCM16_16K_MONO, output: PUBLIC_PCM16_16K_MONO },
    models: {
      stt: config.sttModel ?? PROVIDER_CATALOG.deepgram.defaultModel,
      llm: config.groqModel,
      tts: config.cartesiaModel ?? PROVIDER_CATALOG.cartesia.defaultModel,
    },
  });

  let resolveStarted!: (value: {
    readonly sessionId: string;
    readonly run: Promise<unknown>;
  }) => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<{ readonly sessionId: string; readonly run: Promise<unknown> }>(
    (resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    },
  );
  const plane = createPublicNodeMediaPlane<{ readonly callId: string }>({
    host: "127.0.0.1",
    port: 0,
    path: "/provider-smoke/:callId",
    authorizeUpgrade: (_request, url, params) => {
      if (url.searchParams.get("token") !== "provider-stack-smoke") {
        return { ok: false, statusCode: 401 };
      }
      if (params.callId !== callId) {
        return { ok: false, statusCode: 403 };
      }
      return { ok: true, context: { callId } };
    },
    onConnection({ socket, upgradeContext }) {
      void (async () => {
        if (!upgradeContext) throw new Error("transport smoke authorization context missing");
        const now = nowTimestamp();
        const call = {
          id: upgradeContext.callId,
          provider: "web-client-audio",
          direction: "inbound",
          from: "smoke-client",
          to: "provider-stack-smoke",
          status: "connected",
          mediaTransport: { kind: "websocket", format: PUBLIC_PCM16_16K_MONO },
          createdAt: now,
          startedAt: now,
        } as never;
        const session = await agent.start({
          call,
          channel: "web_audio",
          textDelivery: "always",
          startupTimeoutMs: OPERATION_TIMEOUT_MS,
          callHandle: ({ sessionId, call: runtimeCall }) => {
            if (runtimeCall.id !== upgradeContext.callId) {
              throw new Error("transport smoke call identity mismatch");
            }
            telephony.attachWebSocket(socket, runtimeCall.id, sessionId);
            return telephony.accept({ call: runtimeCall });
          },
        });
        resolveStarted({ sessionId: String(session.sessionId), run: Promise.resolve(session.run) });
      })().catch(rejectStarted);
    },
  });

  let client: WsWebSocket | undefined;
  let sessionReady = false;
  let inputFrames = 0;
  let outputAudioFrames = 0;
  let assistantMessages = 0;
  let outputCommits = 0;
  let commitSeen = false;
  let sentSessionEnd = false;
  try {
    await plane.start();
    const address = plane.address;
    if (!address) throw new Error("provider smoke transport did not expose a listening address");
    client = await withTimeout(
      connectWebSocket(
        `ws://127.0.0.1:${address.port}/provider-smoke/${callId}?token=provider-stack-smoke`,
      ),
      OPERATION_TIMEOUT_MS,
      "Web Client Audio transport connect",
    );
    const session = await withTimeout(started, OPERATION_TIMEOUT_MS, "managed transport startup");
    const maybeEndSession = (): void => {
      if (assistantMessages === 0 || !commitSeen || sentSessionEnd) return;
      sentSessionEnd = true;
      setImmediate(() => client?.send(JSON.stringify({ type: "session.end" })));
    };
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        outputAudioFrames += 1;
        return;
      }
      const message = parseClientJson(data);
      if (!message) return;
      if (message.type === "session.ready" && message.sessionId === session.sessionId) {
        sessionReady = true;
      }
      if (message.type === "assistant.text") {
        assistantMessages += 1;
        maybeEndSession();
      }
      if (message.type === "output.commit" && typeof message.commitId === "string") {
        outputCommits += 1;
        commitSeen = true;
        client?.send(JSON.stringify({ type: "output.playout_ack", commitId: message.commitId }));
        maybeEndSession();
      }
    });
    client.send(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "push_to_talk",
        clientPlatform: "provider-stack-smoke",
        audioFormat: PUBLIC_PCM16_16K_MONO,
      }),
    );
    await withTimeout(
      waitFor(() => sessionReady),
      OPERATION_TIMEOUT_MS,
      "Web Client Audio session start",
    );
    for (const chunk of splitPcm16leFrames(inputAudio, PUBLIC_PCM16_16K_MONO, CHUNK_DURATION_MS)) {
      inputFrames += 1;
      client.send(webClientAudioFrame(chunk, inputFrames));
    }
    client.send(JSON.stringify({ type: "turn.end" }));
    await withTimeout(
      session.run.catch((error: unknown) => {
        if (errorCode(error) !== "voice_runtime.remote_hangup") throw error;
        return null;
      }),
      OPERATION_TIMEOUT_MS * 2,
      "managed transport run",
    );
    if (outputAudioFrames === 0 || outputCommits === 0 || assistantMessages === 0) {
      throw new Error("provider smoke transport produced no complete assistant output");
    }
    return {
      transport: "web-client-audio",
      sessionReady,
      inputFrames,
      outputAudioFrames,
      assistantMessages,
      outputCommits,
      cleanShutdown: true,
    };
  } finally {
    if (client) await closeWebSocket(client);
    await agent.stop().catch(() => undefined);
    await plane.stop().catch(() => undefined);
  }
}

function connectWebSocket(url: string): Promise<WsWebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function closeWebSocket(socket: WsWebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
  });
}

function webClientAudioFrame(chunk: Uint8Array, sequence: number): Buffer {
  const frame = Buffer.alloc(12 + chunk.byteLength);
  frame.writeUInt8(1, 0);
  frame.writeUInt8(0, 1);
  frame.writeUInt32LE(sequence, 2);
  frame.writeUInt32LE((sequence - 1) * CHUNK_DURATION_MS, 6);
  frame.writeUInt16LE(0, 10);
  Buffer.from(chunk).copy(frame, 12);
  return frame;
}

function parseClientJson(data: RawData): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = OPERATION_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("provider smoke condition timed out");
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var for provider smoke: ${name}`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function writeEvidence(evidence: SmokeEvidence): void {
  const directory = fileURLToPath(new URL("../local/release/1.1.0/", import.meta.url));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production") return;
  let source: string;
  try {
    source = readFileSync(fileURLToPath(new URL("../.env", import.meta.url)), "utf8");
  } catch {
    return;
  }
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) continue;
    const name = match[1];
    const raw = match[2] ?? "";
    if (!name || process.env[name] !== undefined) continue;
    process.env[name] = parseEnvValue(raw);
  }
}

function parseEnvValue(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  const comment = raw.indexOf(" #");
  return comment >= 0 ? raw.slice(0, comment).trimEnd() : raw;
}
