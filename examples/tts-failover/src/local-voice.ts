import {
  AsyncQueue,
  createMediaEvent,
  nowTimestamp,
  PCM16_16K_MONO,
  providerError,
  TvicThrowableError,
  type Call,
  type CallHandle,
  type CallId,
  type InboundMediaEvent,
  type LLMProvider,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type SpeechToTextProvider,
  type SttOpenRequest,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type TranscriptEvent,
  type TtsSynthesisRequest,
  type VoiceAgent,
} from "voice-runtime";

const LOCAL_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: false, parallelCalls: false },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

export interface ScriptedStt {
  readonly provider: SpeechToTextProvider;
  readonly opened: Promise<void>;
  emitFinal(text: string): void;
}

export interface ScriptedCall {
  readonly call: Call;
  readonly handle: CallHandle;
  readonly input: AsyncQueue<InboundMediaEvent>;
  readonly output: readonly OutputMediaEvent[];
  readonly outputCommitted: Promise<void>;
}

export function createLocalTelephony(): TelephonyProvider {
  return {
    name: "local-scripted-telephony",
    kind: "telephony",
    version: "0.1.0",
    capabilities: LOCAL_CAPABILITIES,
    async dial() {
      throw new Error("The example uses a scripted inbound call.");
    },
    async accept() {
      throw new Error("The example supplies its own scripted CallHandle.");
    },
    async hangup() {},
  };
}

export function createLocalStt(): ScriptedStt {
  const transcripts = new AsyncQueue<TranscriptEvent>();
  let resolveOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    resolveOpened = resolve;
  });
  let request: SttOpenRequest | undefined;
  let sequence = 1;

  const provider: SpeechToTextProvider = {
    name: "local-scripted-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: LOCAL_CAPABILITIES,
    async open(openRequest): Promise<SttStream> {
      request = openRequest;
      resolveOpened();
      return {
        events: transcripts,
        async sendAudio() {},
        async commit() {},
        async close() {
          transcripts.close();
        },
      };
    },
  };

  return {
    provider,
    opened,
    emitFinal(text) {
      if (!request) throw new Error("scripted STT has not opened yet");
      const timestamp = nowTimestamp();
      transcripts.push({
        id: `local_final_${sequence}` as never,
        type: "stt.final",
        direction: "input",
        sessionId: request.sessionId,
        sequence: sequence++,
        provider: provider.name,
        text,
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      transcripts.push({
        id: `local_endpoint_${sequence}` as never,
        type: "stt.endpoint",
        direction: "input",
        sessionId: request.sessionId,
        sequence: sequence++,
        provider: provider.name,
        reason: "manual",
        timestamp,
      });
    },
  };
}

export function createLocalLlm(): LLMProvider {
  return {
    name: "local-scripted-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: LOCAL_CAPABILITIES,
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      const timestamp = nowTimestamp();
      const events: LlmStreamEvent[] = [
        {
          id: "local_llm_started" as never,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "local-scripted-llm",
          timestamp,
          model: request.model,
        },
        {
          id: "local_llm_completed" as never,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "local-scripted-llm",
          timestamp,
          text: "Your request was handled by the local voice agent.",
          toolCalls: [],
        },
      ];
      return { events: iterableOf(events), async cancel() {} };
    },
  };
}

export function createLocalFailingTts(): TextToSpeechProvider {
  return {
    name: "local-sarvam-primary",
    kind: "tts",
    version: "0.1.0",
    capabilities: LOCAL_CAPABILITIES,
    async synthesize() {
      throw TvicThrowableError.from(
        providerError("provider.upstream_failed", "Simulated Sarvam outage", {
          provider: "local-sarvam-primary",
        }),
      );
    },
  };
}

export function createLocalFallbackTts(): TextToSpeechProvider {
  return {
    name: "local-elevenlabs-fallback",
    kind: "tts",
    version: "0.1.0",
    capabilities: LOCAL_CAPABILITIES,
    async synthesize(request: TtsSynthesisRequest) {
      const audio = createMediaEvent({
        id: "local_tts_audio" as never,
        type: "media.audio.chunk",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "local-elevenlabs-fallback",
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 20,
          frameCount: 320,
          bytes: new Uint8Array(640),
        },
      });
      const committed = createMediaEvent({
        id: "local_tts_committed" as never,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "local-elevenlabs-fallback",
        durationMs: 20,
        frameCount: 320,
        sequenceRange: [1, 1],
        chunkIds: [audio.id],
      });
      return { events: iterableOf([audio, committed]), async cancel() {} };
    },
  };
}

export function createScriptedCall(): ScriptedCall {
  const input = new AsyncQueue<InboundMediaEvent>();
  const outputEvents: OutputMediaEvent[] = [];
  let resolveCommitted!: () => void;
  const outputCommitted = new Promise<void>((resolve) => {
    resolveCommitted = resolve;
  });
  const callId = "local-failover-call" as CallId;
  const handle: CallHandle = {
    callId,
    events: input,
    async send(event) {
      outputEvents.push(event);
      if (event.type === "media.audio.committed") resolveCommitted();
      return true;
    },
    async deliverText() {
      return true;
    },
    async clear() {},
    async close() {
      input.close();
    },
    async confirmPlayout() {
      return true;
    },
  };
  const now = nowTimestamp();
  return {
    call: {
      id: callId,
      provider: "local-scripted-telephony",
      direction: "inbound",
      from: "example-user",
      to: "failover-agent",
      status: "connected",
      mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
      createdAt: now,
      startedAt: now,
    },
    handle,
    input,
    output: outputEvents,
    outputCommitted,
  };
}

export async function runOneTurn(
  agent: VoiceAgent,
  stt: ScriptedStt,
  scriptedCall: ScriptedCall,
): Promise<{ readonly turnsHandled: number; readonly audioChunks: number }> {
  const session = await agent.start({
    channel: "simulated",
    call: scriptedCall.call,
    callHandle: scriptedCall.handle,
  });
  const runCompletion = session.run.then((result) => result);
  scriptedCall.input.push(
    createMediaEvent({
      id: "local_stream_started" as never,
      type: "media.stream.started",
      sessionId: session.sessionId,
      sequence: 1,
      direction: "input",
      timestamp: nowTimestamp(),
      monotonicOffsetMs: 0,
      format: PCM16_16K_MONO,
    }),
  );
  await stt.opened;
  stt.emitFinal("Please handle this request.");
  await Promise.race([
    scriptedCall.outputCommitted,
    runCompletion.then(
      () => Promise.reject(new Error("the scripted call ended before audio was committed")),
      (error: unknown) => Promise.reject(error),
    ),
  ]);
  scriptedCall.input.push(
    createMediaEvent({
      id: "local_stream_ended" as never,
      type: "media.stream.ended",
      sessionId: session.sessionId,
      sequence: 2,
      direction: "input",
      timestamp: nowTimestamp(),
      monotonicOffsetMs: 20,
      reason: "completed",
      durationMs: 20,
    }),
  );
  const result = await runCompletion;
  return {
    turnsHandled: result.turnsHandled,
    audioChunks: scriptedCall.output.filter((event) => event.type === "media.audio.chunk").length,
  };
}

function iterableOf<T>(values: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}
