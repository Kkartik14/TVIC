import {
  AsyncQueue,
  createMediaEvent,
  createVoiceAgent,
  nowTimestamp,
  PCM16_16K_MONO,
  type AudioTapFrame,
  type AudioTapSummary,
  type CallHandle,
  type InboundMediaEvent,
  type LLMProvider,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type SpeechToTextProvider,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type TranscriptEvent,
  type TtsEvent,
  type TtsSynthesisRequest,
  type TtsStream,
} from "voice-runtime";

const SAMPLE_RATE_HZ = 16_000;
const CHUNK_MS = 20;
const CHUNK_SAMPLES = (SAMPLE_RATE_HZ * CHUNK_MS) / 1_000;
const OUTPUT_CHUNKS = 4;

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

export interface MockRecording {
  readonly frames: readonly AudioTapFrame[];
  readonly summary: AudioTapSummary;
  readonly turnsHandled: number;
}

export async function runMockCall(): Promise<MockRecording> {
  const providers = createMockProviders();
  const frames: AudioTapFrame[] = [];
  let finishTapDrain!: (summary: AudioTapSummary) => void;
  const tapDrained = new Promise<AudioTapSummary>((resolve) => {
    finishTapDrain = resolve;
  });
  const call = createMockCallHandle();
  const agent = createVoiceAgent({
    id: "call-recording-example",
    name: "Call recording example",
    prompt: "Listen to the caller and give a short confirmation.",
    providers,
    audioTap: {
      onFrame(frame) {
        frames.push(frame);
      },
      onDrained(context) {
        finishTapDrain(context.summary);
      },
    },
  });

  try {
    const session = await agent.start({ callHandle: call.handle, channel: "simulated" });
    const running = session.run.then((result) => result);
    call.push(streamStarted(session.sessionId));
    call.push(callerAudio(session.sessionId));
    call.push(turnCommit(session.sessionId));

    await call.committedSent;
    await call.playoutConfirmed;
    call.push(streamEnded(session.sessionId));

    const result = await running;
    await session.finalSession;
    const drainedSummary = await withTimeout(tapDrained, 1_000);
    if (
      drainedSummary.droppedFrames > 0 ||
      drainedSummary.droppedEvents > 0 ||
      drainedSummary.callbackErrors > 0
    ) {
      throw new Error("The mock recording is incomplete because the audio tap dropped data");
    }
    return {
      frames,
      summary: drainedSummary,
      turnsHandled: result.turnsHandled,
    };
  } finally {
    await agent.stop();
  }
}

function createMockProviders() {
  return {
    telephony: createMockTelephony(),
    stt: createMockStt(),
    llm: createMockLlm(),
    tts: createMockTts(),
  };
}

function createMockTelephony(): TelephonyProvider {
  return {
    name: "recording-example-transport",
    kind: "telephony",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async dial() {
      throw new Error("The example supplies its own mock call handle");
    },
    async accept() {
      throw new Error("The example supplies its own mock call handle");
    },
    async hangup() {},
  };
}

function createMockStt(): SpeechToTextProvider {
  return {
    name: "recording-example-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async open(request): Promise<SttStream> {
      const events = new AsyncQueue<TranscriptEvent>();
      let emitted = false;
      let sequence = 1;
      return {
        events,
        async sendAudio() {},
        async commit() {
          if (emitted) return;
          emitted = true;
          const timestamp = nowTimestamp();
          events.push({
            id: "recording_example_final" as never,
            type: "stt.final",
            direction: "input",
            sessionId: request.sessionId,
            sequence: sequence++,
            provider: "recording-example-stt",
            text: "Please check my appointment.",
            startTimestamp: timestamp,
            endTimestamp: timestamp,
          });
          events.push({
            id: "recording_example_endpoint" as never,
            type: "stt.endpoint",
            direction: "input",
            sessionId: request.sessionId,
            sequence: sequence++,
            provider: "recording-example-stt",
            reason: "manual",
            timestamp,
          });
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
    name: "recording-example-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      const timestamp = nowTimestamp();
      const events: LlmStreamEvent[] = [
        {
          id: "recording_example_started" as never,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "recording-example-llm",
          timestamp,
          model: request.model,
        },
        {
          id: "recording_example_completed" as never,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "recording-example-llm",
          timestamp,
          text: "Your appointment request is ready for review.",
          toolCalls: [],
        },
      ];
      return { events: iterableOf(events), async cancel() {} };
    },
  };
}

function createMockTts(): TextToSpeechProvider {
  return {
    name: "recording-example-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: CAPABILITIES,
    async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
      const chunks = Array.from({ length: OUTPUT_CHUNKS }, (_, index) => {
        const id = `recording_example_chunk_${index + 1}` as never;
        return createMediaEvent({
          id,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: index + 1,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "recording-example-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: CHUNK_MS,
            frameCount: CHUNK_SAMPLES,
            bytes: toneBytes(440, CHUNK_SAMPLES, index * CHUNK_SAMPLES),
          },
        });
      });
      const commit = createMediaEvent({
        id: "recording_example_commit" as never,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: OUTPUT_CHUNKS + 1,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "recording-example-tts",
        durationMs: CHUNK_MS * OUTPUT_CHUNKS,
        frameCount: CHUNK_SAMPLES * OUTPUT_CHUNKS,
        sequenceRange: [1, OUTPUT_CHUNKS],
        chunkIds: chunks.map((chunk) => chunk.id),
      });
      const events: TtsEvent[] = [...chunks, commit];
      return { events: iterableOf(events), async cancel() {} };
    },
  };
}

function createMockCallHandle(): {
  readonly handle: CallHandle;
  readonly committedSent: Promise<void>;
  readonly playoutConfirmed: Promise<void>;
  push(event: InboundMediaEvent): void;
} {
  const events = new AsyncQueue<InboundMediaEvent>();
  const sent: OutputMediaEvent[] = [];
  let signalCommit!: () => void;
  let signalPlayout!: () => void;
  const committedSent = new Promise<void>((resolve) => {
    signalCommit = resolve;
  });
  const playoutConfirmed = new Promise<void>((resolve) => {
    signalPlayout = resolve;
  });
  const handle: CallHandle = {
    callId: "call_recording_example" as never,
    events,
    async send(event) {
      if (event.type === "media.audio.chunk") {
        await delay(event.audio.durationMs);
      }
      sent.push(event);
      if (event.type === "media.audio.committed") signalCommit();
      return true;
    },
    async clear() {},
    async close() {
      events.close();
    },
    async confirmPlayout() {
      signalPlayout();
      return true;
    },
  };
  return {
    handle,
    committedSent,
    playoutConfirmed,
    push: (event) => events.push(event),
  };
}

function streamStarted(sessionId: string): InboundMediaEvent {
  return createMediaEvent({
    id: "recording_example_stream_started" as never,
    type: "media.stream.started",
    sessionId: sessionId as never,
    sequence: 1,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    format: PCM16_16K_MONO,
  });
}

function callerAudio(sessionId: string): InboundMediaEvent {
  const sampleCount = CHUNK_SAMPLES * OUTPUT_CHUNKS;
  return createMediaEvent({
    id: "recording_example_input_audio" as never,
    type: "media.audio.chunk",
    sessionId: sessionId as never,
    sequence: 2,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: CHUNK_MS * OUTPUT_CHUNKS,
      frameCount: sampleCount,
      bytes: toneBytes(220, sampleCount, 0),
    },
  });
}

function turnCommit(sessionId: string): InboundMediaEvent {
  return createMediaEvent({
    id: "recording_example_commit_requested" as never,
    type: "media.turn.commit_requested",
    sessionId: sessionId as never,
    sequence: 3,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: CHUNK_MS * OUTPUT_CHUNKS,
  });
}

function streamEnded(sessionId: string): InboundMediaEvent {
  return createMediaEvent({
    id: "recording_example_stream_ended" as never,
    type: "media.stream.ended",
    sessionId: sessionId as never,
    sequence: 4,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: CHUNK_MS * OUTPUT_CHUNKS,
    reason: "completed",
    durationMs: CHUNK_MS * OUTPUT_CHUNKS,
  });
}

function toneBytes(frequencyHz: number, sampleCount: number, sampleStart: number): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    const phase = (2 * Math.PI * frequencyHz * (sampleStart + index)) / SAMPLE_RATE_HZ;
    view.setInt16(index * 2, Math.round(Math.sin(phase) * 4_000), true);
  }
  return bytes;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Mock call timed out waiting for tap drain")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function iterableOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}
