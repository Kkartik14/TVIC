import {
  PCM16_16K_MONO,
  nowTimestamp,
  type AudioPayload,
  type InputAudioChunk,
  type LLMProvider,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type ProviderCapabilities,
  type SpeechToTextProvider,
  type SttOpenRequest,
  type SttStream,
  type TextToSpeechProvider,
  type TtsEvent,
  type TtsSynthesisRequest,
  type TranscriptEvent,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/providers";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket", "http", "sse"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

export interface MockVoiceProviders {
  readonly stt: SpeechToTextProvider;
  readonly llm: LLMProvider;
  readonly tts: TextToSpeechProvider;
}

export function createMockVoiceProviders(): MockVoiceProviders {
  return {
    stt: createMockStt(),
    llm: createMockLlm(),
    tts: createMockTts(),
  };
}

function createMockStt(): SpeechToTextProvider {
  return {
    name: "local-mock-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async open(request: SttOpenRequest): Promise<SttStream> {
      const events = new AsyncQueue<TranscriptEvent>();
      let sequence = 1;
      let audioFrames = 0;
      let pendingAudio = false;
      let turnNumber = 0;
      const mode = request.metadata?.voiceMode === "continuous" ? "continuous" : "push_to_talk";
      const emitTurn = (): void => {
        if (!pendingAudio) return;
        pendingAudio = false;
        turnNumber += 1;
        const timestamp = nowTimestamp();
        events.push({
          id: `mock_final_${sequence}` as never,
          type: "stt.final",
          direction: "input",
          sessionId: request.sessionId,
          sequence: sequence++,
          provider: "local-mock-stt",
          text: `Hello from the local browser voice demo (turn ${turnNumber}).`,
          startTimestamp: timestamp,
          endTimestamp: timestamp,
        });
        events.push({
          id: `mock_endpoint_${sequence}` as never,
          type: "stt.endpoint",
          direction: "input",
          sessionId: request.sessionId,
          sequence: sequence++,
          provider: "local-mock-stt",
          reason: "manual",
          timestamp,
        });
      };
      return {
        events,
        async sendAudio(_chunk: InputAudioChunk) {
          pendingAudio = true;
          audioFrames += 1;
          if (mode === "continuous" && audioFrames >= 25) {
            audioFrames = 0;
            emitTurn();
          }
        },
        async commit() {
          emitTurn();
        },
        async close() {
          events.close();
        },
      };
    },
  };
}

function createMockLlm(): LLMProvider {
  return {
    name: "local-mock-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      const timestamp = nowTimestamp();
      const started: LlmStreamEvent = {
        id: "mock_llm_started" as never,
        type: "llm.started",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        provider: "local-mock-llm",
        timestamp,
        model: request.model,
      };
      const completed: LlmStreamEvent = {
        id: "mock_llm_completed" as never,
        type: "llm.completed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        provider: "local-mock-llm",
        timestamp,
        text: "Your local browser voice mode is working.",
        toolCalls: [],
      };
      return { events: iterableOf([started, completed]), async cancel() {} };
    },
  };
}

function createMockTts(): TextToSpeechProvider {
  return {
    name: "local-mock-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async synthesize(request: TtsSynthesisRequest) {
      const events = new AsyncQueue<TtsEvent>();
      const bytes = new Uint8Array(640);
      const samples = new Int16Array(bytes.buffer);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / 16_000) * 4_000);
      }
      const payload: AudioPayload = {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        data: { kind: "inline", bytes },
      };
      const chunkId =
        `mock_audio_${String(request.sessionId)}_${String(request.turnId)}_chunk` as never;
      const commitId =
        `mock_audio_${String(request.sessionId)}_${String(request.turnId)}_commit` as never;
      events.push({
        id: chunkId,
        type: "media.audio.chunk",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "local-mock-tts",
        audio: payload,
      });
      events.push({
        id: commitId,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "local-mock-tts",
        durationMs: payload.durationMs,
        frameCount: payload.frameCount,
        sequenceRange: [1, 1],
        chunkIds: [chunkId],
      });
      events.close();
      return { events, async cancel() {} };
    },
  };
}

function iterableOf<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}
