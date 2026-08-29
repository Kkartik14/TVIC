// Shared pipeline-loop test harness: fake providers + a controllable call handle.
// Used by the loop, state-machine, and chaos suites.
import {
  PCM16_16K_MONO,
  type Agent,
  type AgentProviders,
  type AgentAudioPolicy,
  type CallHandle,
  type InboundMediaEvent,
  type IncrementalTextToSpeechProvider,
  type InterruptionPolicy,
  type LLMProvider,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type MediaAudioCommittedEvent,
  type MediaEventId,
  type MemoryScope,
  type OutputAudioChunk,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type ProviderEventId,
  type SessionId,
  type SpeechToTextProvider,
  type StreamEndReason,
  type SttOpenRequest,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type TimeoutPolicy,
  type Timestamp,
  type ToolDefinition,
  type TurnId,
  type TranscriptEvent,
  type TtsStream,
  type TtsEvent,
  type TtsSessionOpenRequest,
  type TtsSynthesisRequest,
} from "@tvic/core";

import { defineAgent, defineTool } from "../src/index.js";

export const TS = "2026-05-20T00:00:00.000Z" as Timestamp;

export const TEST_PROVIDER_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

export function buildAgent(
  overrides: {
    readonly tools?: readonly ToolDefinition[];
    readonly memoryScopes?: readonly MemoryScope[];
    readonly interruptionPolicy?: InterruptionPolicy;
    readonly timeoutPolicy?: TimeoutPolicy;
    readonly audioPolicy?: AgentAudioPolicy;
    readonly providers?: Partial<AgentProviders>;
  } = {},
) {
  const audioPolicy: AgentAudioPolicy = overrides.audioPolicy ?? {
    input: PCM16_16K_MONO,
    output: PCM16_16K_MONO,
  };
  return defineAgent({
    id: "agent_loop",
    name: "Loop Agent",
    instructions: "Book tables.",
    tools: overrides.tools ?? [
      defineTool({
        id: "tool_loop",
        name: "check_availability",
        description: "Check availability.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        async execute() {
          return { available: true };
        },
      }),
    ],
    audioPolicy,
    memoryPolicy: { enabled: true, scopes: overrides.memoryScopes ?? ["session"] },
    ...(overrides.interruptionPolicy ? { interruptionPolicy: overrides.interruptionPolicy } : {}),
    ...(overrides.timeoutPolicy ? { timeoutPolicy: overrides.timeoutPolicy } : {}),
    providers: {
      telephony: overrides.providers?.telephony ?? stubTelephony,
      stt: overrides.providers?.stt ?? stubStt,
      llm: overrides.providers?.llm ?? stubLlm,
      tts: overrides.providers?.tts ?? stubTts,
    },
  });
}

export function withPipelineProviders(agent: Agent, overrides: Partial<AgentProviders>): Agent {
  return defineAgent({
    ...agent,
    providers: { ...agent.providers, ...overrides },
  });
}

export function ignoreInterruptionPolicy(): InterruptionPolicy {
  return {
    mode: "ignore",
    minSpeechMs: 200,
    trimOutputOnInterrupt: true,
  };
}

export function makeBlockingTts() {
  let synthesizeCalled = false;
  const provider: TextToSpeechProvider = {
    name: "blocking-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async synthesize(): Promise<TtsStream> {
      synthesizeCalled = true;
      // Never resolves: simulates a TTS connection that stalls during setup.
      return new Promise<TtsStream>(() => {});
    },
  };
  return {
    provider,
    get synthesizeCalled() {
      return synthesizeCalled;
    },
  };
}

export function makeControlledTts() {
  let queue: ReturnType<typeof pushable<OutputMediaEvent>> | null = null;
  let request: TtsSynthesisRequest | null = null;
  const provider: TextToSpeechProvider = {
    name: "controlled-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async synthesize(req): Promise<TtsStream> {
      request = req;
      queue = pushable<OutputMediaEvent>();
      return {
        events: queue.iterable as TtsStream["events"],
        async cancel() {
          queue?.end();
        },
      };
    },
  };
  return {
    provider,
    get ready() {
      return queue !== null;
    },
    pushChunk(sequence: number) {
      queue?.push(audioChunk(request as TtsSynthesisRequest, sequence) as never);
    },
    end() {
      queue?.end();
    },
  };
}

export function makeIncrementalTts(options: { readonly autoFinish?: boolean } = {}) {
  let queue: ReturnType<typeof pushable<TtsEvent>> | null = null;
  let request: TtsSessionOpenRequest | null = null;
  let synthesizeCalls = 0;
  let openCalls = 0;
  let flushCalls = 0;
  let finishCalls = 0;
  let cancelCalls = 0;
  const sentTexts: string[] = [];
  const provider: IncrementalTextToSpeechProvider = {
    name: "incremental-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async synthesize(): Promise<TtsStream> {
      synthesizeCalls += 1;
      throw new Error("one-shot synthesis must not be used");
    },
    async openSession(openRequest) {
      openCalls += 1;
      request = openRequest;
      queue = pushable<TtsEvent>();
      return {
        events: queue.iterable,
        async sendText(text) {
          sentTexts.push(text);
        },
        async flush() {
          flushCalls += 1;
          return { id: flushCalls, acknowledgedBy: "provider" } as const;
        },
        async finish() {
          finishCalls += 1;
          if (options.autoFinish !== false) {
            queue?.push(committed(openRequest));
            queue?.end();
          }
        },
        async cancel() {
          cancelCalls += 1;
          queue?.end();
        },
      };
    },
  };
  return {
    provider,
    sentTexts,
    pushChunk(sequence: number) {
      queue?.push(audioChunk(request as TtsSessionOpenRequest, sequence));
    },
    pushAlignment(
      tokens: readonly string[],
      endMs: readonly number[],
      options: {
        readonly unit?: "character" | "word" | "phoneme";
        readonly startMs?: readonly number[];
      } = {},
    ) {
      const active = request as TtsSessionOpenRequest;
      queue?.push({
        type: "tts.alignment",
        sessionId: active.sessionId,
        turnId: active.turnId,
        sequence: 1,
        provider: "incremental-tts",
        timestamp: TS,
        unit: options.unit ?? "word",
        tokens,
        startMs: options.startMs ?? tokens.map(() => 0),
        endMs,
      });
    },
    pushFlush(flushId: number) {
      const active = request as TtsSessionOpenRequest;
      queue?.push({
        type: "tts.flush.completed",
        sessionId: active.sessionId,
        turnId: active.turnId,
        sequence: flushId,
        provider: "incremental-tts",
        timestamp: TS,
        flushId,
        acknowledgedBy: "provider",
      });
    },
    end() {
      if (request) {
        queue?.push(committed(request));
      }
      queue?.end();
    },
    get ready() {
      return queue !== null;
    },
    get synthesizeCalls() {
      return synthesizeCalls;
    },
    get openCalls() {
      return openCalls;
    },
    get flushCalls() {
      return flushCalls;
    },
    get finishCalls() {
      return finishCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

export function makeBlockingLlm() {
  let completeCalled = false;
  let cancelled = false;
  const provider: LLMProvider = {
    name: "blocking-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async complete(request): Promise<LlmCompletion> {
      completeCalled = true;
      const queue = pushable<LlmStreamEvent>();
      queue.push(llmEvent(request, 1, { type: "llm.started", model: request.model }));
      // Intentionally never end the stream: simulates an LLM blocked on output.
      return {
        events: queue.iterable,
        async cancel() {
          cancelled = true;
          queue.end();
        },
      };
    },
  };
  return {
    provider,
    get completeCalled() {
      return completeCalled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

export function pushable<T>() {
  const values: T[] = [];
  const waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: unknown;
  return {
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value });
      } else {
        values.push(value);
      }
    },
    end(): void {
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined as never });
      }
    },
    fail(error: unknown): void {
      failure = error;
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(error);
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            if (failure) {
              return Promise.reject(failure);
            }
            const value = values.shift();
            if (value !== undefined) {
              return Promise.resolve({ done: false, value });
            }
            if (ended) {
              return Promise.resolve({ done: true, value: undefined as never });
            }
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

export function makeCallHandle(
  options: {
    readonly hangClear?: boolean;
    readonly dropOutput?: boolean;
    readonly dropCommit?: boolean;
    // "heard" → playout confirmed; "dropped" → caller hung up before playout.
    readonly playout?: "heard" | "dropped";
    readonly textDelivery?: "delivered" | "dropped" | "failed";
  } = {},
) {
  const inbound = pushable<InboundMediaEvent>();
  const sent: OutputMediaEvent[] = [];
  const deliveredTexts: string[] = [];
  let clearCalls = 0;
  const handle: CallHandle = {
    callId: "call_loop" as never,
    events: inbound.iterable,
    async send(event) {
      // Simulate a closing socket dropping outbound frames.
      if (options.dropOutput && event.type === "media.audio.chunk") {
        return false;
      }
      if (options.dropCommit && event.type === "media.audio.committed") {
        return false;
      }
      sent.push(event);
      return true;
    },
    async clear() {
      clearCalls += 1;
      if (options.hangClear) {
        await new Promise<never>(() => {});
      }
    },
    async close() {
      inbound.end();
    },
    ...(options.textDelivery
      ? {
          async deliverText(_turnId: TurnId, _sequence: number, text: string): Promise<boolean> {
            if (options.textDelivery === "failed") throw new Error("text delivery failed");
            deliveredTexts.push(text);
            return options.textDelivery === "delivered";
          },
        }
      : {}),
    ...(options.playout
      ? {
          async confirmPlayout(): Promise<boolean> {
            return options.playout === "heard";
          },
        }
      : {}),
  } as CallHandle;
  return {
    handle,
    push: (event: InboundMediaEvent) => inbound.push(event),
    get sent() {
      return sent;
    },
    get clearCalls() {
      return clearCalls;
    },
    get deliveredTexts() {
      return deliveredTexts;
    },
  };
}

export function makeStt() {
  const transcripts = pushable<TranscriptEvent>();
  let sequence = 1;
  let commitCalls = 0;
  let currentSessionId: SessionId | undefined;
  let openRequest: SttOpenRequest | undefined;
  const provider: SpeechToTextProvider = {
    name: "fake-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async open(request): Promise<SttStream> {
      openRequest = request;
      currentSessionId = request.sessionId;
      return {
        events: transcripts.iterable,
        async sendAudio() {
          return;
        },
        async commit() {
          commitCalls += 1;
          if (currentSessionId) {
            transcripts.push({
              id: `stt_endpoint_${sequence}` as ProviderEventId,
              type: "stt.endpoint",
              direction: "input",
              sessionId: currentSessionId,
              sequence,
              provider: "fake-stt",
              reason: "manual",
              timestamp: TS,
            });
            sequence += 1;
          }
        },
        async close() {
          transcripts.end();
        },
      };
    },
  };
  return {
    provider,
    get openRequest() {
      return openRequest;
    },
    pushFinal(sessionId: SessionId, text: string) {
      currentSessionId = sessionId;
      transcripts.push({
        id: `stt_event_${sequence}` as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId,
        sequence,
        provider: "fake-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
      });
      sequence += 1;
      transcripts.push({
        id: `stt_endpoint_${sequence}` as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId,
        sequence,
        provider: "fake-stt",
        reason: "provider",
        timestamp: TS,
      });
      sequence += 1;
    },
    pushFinalSegment(sessionId: SessionId, text: string) {
      currentSessionId = sessionId;
      transcripts.push({
        id: `stt_event_${sequence}` as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId,
        sequence,
        provider: "fake-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
      });
      sequence += 1;
    },
    pushSpeechStarted(sessionId: SessionId, audioOffsetMs = 0) {
      currentSessionId = sessionId;
      transcripts.push({
        id: `stt_speech_${sequence}` as ProviderEventId,
        type: "stt.speech.started",
        direction: "input",
        sessionId,
        sequence,
        provider: "fake-stt",
        timestamp: TS,
        audioOffsetMs,
      });
      sequence += 1;
    },
    pushEndpoint(sessionId: SessionId, audioOffsetMs?: number) {
      currentSessionId = sessionId;
      transcripts.push({
        id: `stt_endpoint_${sequence}` as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId,
        sequence,
        provider: "fake-stt",
        reason: "silence",
        timestamp: TS,
        ...(typeof audioOffsetMs === "number" ? { audioOffsetMs } : {}),
      });
      sequence += 1;
    },
    pushPartial(sessionId: SessionId, text: string) {
      currentSessionId = sessionId;
      transcripts.push({
        id: `stt_partial_${sequence}` as ProviderEventId,
        type: "stt.partial",
        direction: "input",
        sessionId,
        sequence,
        provider: "fake-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
      });
      sequence += 1;
    },
    // Ends the transcript stream as if the STT socket closed cleanly mid-call.
    endStream() {
      transcripts.end();
    },
    failStream(error: unknown) {
      transcripts.fail(error);
    },
    get commitCalls() {
      return commitCalls;
    },
  };
}

export function makeLlm(
  script: (request: LlmCompletionRequest) => readonly LlmStreamEvent[],
): LLMProvider {
  return {
    name: "fake-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async complete(request): Promise<LlmCompletion> {
      const queue = pushable<LlmStreamEvent>();
      for (const event of script(request)) {
        queue.push(event);
      }
      queue.end();
      return {
        events: queue.iterable,
        async cancel() {
          queue.end();
        },
      };
    },
  };
}

export function makeTts(
  script: (request: TtsSynthesisRequest) => readonly OutputMediaEvent[],
  options: { readonly endStream: boolean },
): TextToSpeechProvider {
  return {
    name: "fake-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async synthesize(request): Promise<TtsStream> {
      const queue = pushable<OutputMediaEvent>();
      for (const event of script(request)) {
        queue.push(event as never);
      }
      if (options.endStream) {
        queue.end();
      }
      return {
        events: queue.iterable as TtsStream["events"],
        async cancel() {
          queue.end();
        },
      };
    },
  };
}

export function llmEvent(
  request: LlmCompletionRequest,
  sequence: number,
  body: Record<string, unknown>,
): LlmStreamEvent {
  return {
    id: `llm_${sequence}` as ProviderEventId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence,
    provider: "fake-llm",
    timestamp: TS,
    ...body,
  } as LlmStreamEvent;
}

export function audioChunk(request: TtsSessionOpenRequest, sequence: number): OutputAudioChunk {
  return {
    id: `tts_${sequence}` as MediaEventId,
    type: "media.audio.chunk",
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence,
    direction: "output",
    timestamp: TS,
    monotonicOffsetMs: 0,
    provider: "fake-tts",
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  };
}

export function streamStarted(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_started" as MediaEventId,
    type: "media.stream.started",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 0,
    format: PCM16_16K_MONO,
  };
}

export function committed(request: TtsSessionOpenRequest): MediaAudioCommittedEvent {
  return {
    id: "tts_committed" as MediaEventId,
    type: "media.audio.committed",
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence: 99,
    direction: "output",
    timestamp: TS,
    monotonicOffsetMs: 0,
    durationMs: 20,
    frameCount: 320,
    sequenceRange: [1, 1],
    chunkIds: ["tts_1" as MediaEventId],
  };
}

export function audioChunkIn(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_audio" as MediaEventId,
    type: "media.audio.chunk",
    sessionId,
    sequence: 2,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 5,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  };
}

export function dtmf(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_dtmf" as MediaEventId,
    type: "dtmf.received",
    sessionId,
    sequence: 3,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 10,
    digit: "#",
  };
}

export function streamEnded(
  sessionId: SessionId,
  reason: StreamEndReason = "remote_hangup",
): InboundMediaEvent {
  return {
    id: "in_ended" as MediaEventId,
    type: "media.stream.ended",
    sessionId,
    sequence: 9,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 50,
    reason,
    durationMs: 50,
  };
}

export async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

export const stubTelephony: TelephonyProvider = {
  name: "stub-telephony",
  kind: "telephony",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async dial() {
    throw new Error("not used");
  },
  async accept() {
    throw new Error("not used");
  },
  async hangup() {
    return;
  },
};

export const stubStt: SpeechToTextProvider = {
  name: "stub-stt",
  kind: "stt",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async open() {
    throw new Error("not used");
  },
};

export const stubLlm: LLMProvider = {
  name: "stub-llm",
  kind: "llm",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async complete() {
    throw new Error("not used");
  },
};

export const stubTts: TextToSpeechProvider = {
  name: "stub-tts",
  kind: "tts",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async synthesize() {
    throw new Error("not used");
  },
};
