// Shared pipeline-loop test harness: fake providers + a controllable call handle.
// Used by the loop, state-machine, and chaos suites.
import {
  PCM16_16K_MONO,
  type AgentPipelineProviders,
  type AgentAudioPolicy,
  type CallHandle,
  type InboundMediaEvent,
  type InterruptionPolicy,
  type LLMProvider,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type MediaEventId,
  type MemoryScope,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type ProviderEventId,
  type SessionId,
  type SpeechToTextProvider,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type TimeoutPolicy,
  type Timestamp,
  type ToolDefinition,
  type TranscriptEvent,
  type TtsStream,
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
    readonly providers?: Partial<Omit<AgentPipelineProviders, "mode">>;
  } = {},
) {
  const audioPolicy: AgentAudioPolicy = overrides.audioPolicy ?? {
    input: PCM16_16K_MONO,
    output: PCM16_16K_MONO,
    resampleAtEdge: true,
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
      mode: "pipeline",
      telephony: overrides.providers?.telephony ?? stubTelephony,
      stt: overrides.providers?.stt ?? stubStt,
      llm: overrides.providers?.llm ?? stubLlm,
      tts: overrides.providers?.tts ?? stubTts,
    },
  });
}

export function ignoreInterruptionPolicy(): InterruptionPolicy {
  return {
    mode: "ignore",
    minSpeechMs: 200,
    cancelOutputOnInterrupt: true,
    trimOutputOnInterrupt: true,
    resumePartialOnEnd: false,
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
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;
  return {
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        values.push(value);
      }
    },
    end(): void {
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined as never });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value !== undefined) {
              return Promise.resolve({ done: false, value });
            }
            if (ended) {
              return Promise.resolve({ done: true, value: undefined as never });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

export function makeCallHandle(
  options: {
    readonly hangCancelOutput?: boolean;
    readonly dropOutput?: boolean;
    readonly dropCommit?: boolean;
    // "heard" → playout confirmed; "dropped" → caller hung up before playout.
    readonly playout?: "heard" | "dropped";
  } = {},
) {
  const inbound = pushable<InboundMediaEvent>();
  const sent: OutputMediaEvent[] = [];
  let cancelOutputCalls = 0;
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
      cancelOutputCalls += 1;
      if (options.hangCancelOutput) {
        await new Promise<never>(() => {});
      }
    },
    async cancelOutput() {
      cancelOutputCalls += 1;
      if (options.hangCancelOutput) {
        await new Promise<never>(() => {});
      }
    },
    async close() {
      inbound.end();
    },
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
    get cancelOutputCalls() {
      return cancelOutputCalls;
    },
  };
}

export function makeStt() {
  const transcripts = pushable<TranscriptEvent>();
  const provider: SpeechToTextProvider = {
    name: "fake-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async open(): Promise<SttStream> {
      return {
        events: transcripts.iterable,
        async sendAudio() {
          return;
        },
        async commit() {
          return;
        },
        async close() {
          transcripts.end();
        },
      };
    },
  };
  return {
    provider,
    pushFinal(sessionId: SessionId, text: string) {
      transcripts.push({
        id: "stt_event" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId,
        sequence: 1,
        provider: "fake-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
        metadata: { speechFinal: true },
      });
    },
    pushPartial(sessionId: SessionId, text: string) {
      transcripts.push({
        id: "stt_partial" as ProviderEventId,
        type: "stt.partial",
        direction: "input",
        sessionId,
        sequence: 1,
        provider: "fake-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
      });
    },
    // Ends the transcript stream as if the STT socket closed cleanly mid-call.
    endStream() {
      transcripts.end();
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

export function audioChunk(request: TtsSynthesisRequest, sequence: number): OutputMediaEvent {
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
      data: { kind: "inline", bytes: new Uint8Array(640) },
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

export function committed(request: TtsSynthesisRequest): OutputMediaEvent {
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
      data: { kind: "inline", bytes: new Uint8Array(640) },
    },
  };
}

export function bargeIn(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_barge" as MediaEventId,
    type: "barge_in.detected",
    sessionId,
    sequence: 3,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 10,
    confidence: 0.9,
  };
}

export function streamEnded(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_ended" as MediaEventId,
    type: "media.stream.ended",
    sessionId,
    sequence: 9,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 50,
    reason: "remote_hangup",
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
