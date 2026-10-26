import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  createCartesiaTtsProvider,
  createElevenLabsTtsProvider,
  createTtsFailoverProvider,
  WebClientAudioCallHandle,
} from "@tvic/providers";

import {
  AsyncQueue,
  type AgentMemoryPolicy,
  createMediaEvent,
  createInMemoryDurableRuntimeStore,
  createVoiceAgent,
  defineTool,
  nowTimestamp,
  PCM16_16K_MONO,
  createSarvamTtsProvider,
  type CallHandle,
  type CallId,
  type Call,
  type CreateVoiceAgentOptions,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type InboundMediaEvent,
  type LLMProvider,
  type LlmCompletion,
  type LlmStreamEvent,
  type Memory,
  type MemoryEntry,
  type OutputAudioChunk,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type ProviderEventId,
  type RuntimeSessionTrace,
  type RuntimeOptions,
  type SessionEndEvent,
  type SessionId,
  type SessionLease,
  type SpeechToTextProvider,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type ToolDefinition,
  type TranscriptEvent,
  type TtsEvent,
  type TtsStream,
  type TtsSynthesisRequest,
  type VoiceAgentCallHandleContext,
  type VoiceAgentModels,
  type VoiceEvent,
  type AudioTapFrame,
  type AudioTapDrainContext,
  type AudioTapOptions,
  type AudioTapSummary,
} from "../src/index.js";
import { validateRunOptions } from "../src/managed-agent-validation.js";
import {
  createProviderCapabilitySnapshot,
  isTerminalSession,
  PROVIDER_CAPABILITY_FEATURES,
  type ProviderCapabilitySnapshot,
} from "@tvic/core";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

const TEST_RUNTIME_DEFAULTS = {
  durablePolicy: {
    leaseTtlMs: 30_000,
    leaseHeartbeatMs: 10_000,
  },
} satisfies RuntimeOptions;

class AutoAcknowledgingCartesiaSocket {
  readonly sent: string[] = [];
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();
  #nextFlushId = 0;
  readyState: number = WebSocket.OPEN;

  on(event: string, handler: (...values: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (...values: unknown[]) => void): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    const serialized = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    this.sent.push(serialized);
    const request = JSON.parse(serialized) as Record<string, unknown>;
    if (request.flush === true) {
      const flushId = this.#nextFlushId++;
      queueMicrotask(() =>
        this.#receive({ type: "flush_done", context_id: request.context_id, flush_id: flushId }),
      );
    } else if (request.continue === false) {
      queueMicrotask(() => this.#receive({ type: "done", context_id: request.context_id }));
    }
    if (typeof request.transcript === "string" && request.transcript.length > 0) {
      queueMicrotask(() =>
        this.#receive({
          type: "chunk",
          context_id: request.context_id,
          data: Buffer.alloc(640).toString("base64"),
        }),
      );
    }
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.#handlers.get("close") ?? []) {
      handler(1000, Buffer.alloc(0));
    }
  }

  #receive(message: Readonly<Record<string, unknown>>): void {
    const payload = Buffer.from(JSON.stringify(message));
    for (const handler of this.#handlers.get("message") ?? []) {
      handler(payload);
    }
  }
}

describe("managed voice agent", () => {
  it("copies and freezes an empty TTS controls list at call admission", () => {
    const controls: unknown[] = [];
    const validated = validateRunOptions({ ttsTextControls: controls } as never);

    expect(validated.ttsTextControls).not.toBe(controls);
    expect(validated.ttsTextControls).toEqual([]);
    expect(Object.isFrozen(validated.ttsTextControls)).toBe(true);

    controls.push({ type: "unsupported", match: "caller mutation" });
    expect(validated.ttsTextControls).toEqual([]);
  });

  it("runs the public prompt-first facade through the complete fake pipeline", async () => {
    const inbound = new AsyncQueue<InboundMediaEvent>();
    const transcripts = new AsyncQueue<TranscriptEvent>();
    let resolveSttOpen!: () => void;
    const sttOpen = new Promise<void>((resolve) => {
      resolveSttOpen = resolve;
    });
    let sttTurnProfile: string | undefined;
    const sent: unknown[] = [];
    const closeReasons: string[] = [];
    let resolveCommitted!: () => void;
    const committedSent = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
    const callHandle: CallHandle = {
      callId: "managed-call" as CallId,
      events: inbound,
      async send(event) {
        sent.push(event);
        if (event.type === "media.audio.committed") resolveCommitted();
        return true;
      },
      async clear() {
        return;
      },
      async close(reason) {
        closeReasons.push(reason);
        inbound.close();
      },
      async confirmPlayout() {
        return true;
      },
    };

    const stt: SpeechToTextProvider = {
      name: "fake-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities: {
        ...CAPABILITIES,
        models: ["universal-3-6-pro"],
        turnProfiles: [
          { model: "universal-3-6-pro", profiles: ["latency", "balanced", "accuracy"] },
        ],
      },
      async open(request): Promise<SttStream> {
        sttTurnProfile = request.turnProfile;
        resolveSttOpen();
        return {
          events: transcripts,
          async sendAudio() {
            return;
          },
          async commit() {
            return;
          },
          async close() {
            transcripts.close();
          },
        };
      },
    };

    const llm: LLMProvider = {
      name: "fake-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async complete(request): Promise<LlmCompletion> {
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: "llm-started" as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "fake-llm",
          timestamp,
          model: request.model,
        });
        events.push({
          id: "llm-completed" as ProviderEventId,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "fake-llm",
          timestamp,
          text: "Your appointment is confirmed.",
          toolCalls: [],
          usage: { inputTokens: 14, outputTokens: 6, cachedTokens: 3 },
        });
        events.close();
        return { events, async cancel() {} };
      },
    };

    let ttsRequestVoice: string | undefined;
    const tts: TextToSpeechProvider = {
      name: "fake-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: { ...CAPABILITIES, voices: ["fake-tts-voice"] },
      async synthesize(request: TtsSynthesisRequest) {
        ttsRequestVoice = request.voice;
        const events = new AsyncQueue<TtsEvent>();
        const audio = createMediaEvent({
          id: "tts-audio" as never,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "fake-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 20,
            frameCount: 320,
            bytes: new Uint8Array(640),
          },
        });
        const committed = createMediaEvent({
          id: "tts-committed" as never,
          type: "media.audio.committed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "fake-tts",
          durationMs: 20,
          frameCount: 320,
          sequenceRange: [1, 1],
          chunkIds: [audio.id],
        });
        events.push(audio as OutputAudioChunk);
        events.push(committed);
        events.close();
        return { events, async cancel() {} };
      },
    };

    const telephony: TelephonyProvider = {
      name: "fake-telephony",
      kind: "telephony",
      version: "1.0.0",
      capabilities: CAPABILITIES,
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

    let releaseTapCallback!: () => void;
    let signalTapCallbackStarted!: () => void;
    let signalTapDrained!: (summary: AudioTapSummary) => void;
    const tapCallbackGate = new Promise<void>((resolve) => {
      releaseTapCallback = resolve;
    });
    const tapCallbackStarted = new Promise<void>((resolve) => {
      signalTapCallbackStarted = resolve;
    });
    const tapDrained = new Promise<AudioTapSummary>((resolve) => {
      signalTapDrained = resolve;
    });
    let firstTapCallback = true;
    class Recorder {
      readonly frames: AudioTapFrame[] = [];
      drainedSessionId: SessionId | undefined;

      async onFrame(frame: AudioTapFrame): Promise<void> {
        this.frames.push(frame);
        if (firstTapCallback) {
          firstTapCallback = false;
          signalTapCallbackStarted();
          await tapCallbackGate;
        }
      }

      onDrained(context: AudioTapDrainContext): void {
        this.drainedSessionId = context.sessionId;
        signalTapDrained(context.summary);
      }
    }
    const recorder = new Recorder();

    const agent = createVoiceAgent({
      prompt: "You schedule appointments for a doctor",
      models: { stt: "universal-3-6-pro", llm: "fake-llm-model", tts: "fake-tts-model" },
      providers: { telephony, stt, llm, tts },
      runtime: TEST_RUNTIME_DEFAULTS,
      audioTap: recorder,
    });
    expect(agent.prompt).toBe("You schedule appointments for a doctor");
    expect(agent.providers).toEqual({
      telephony: "fake-telephony",
      stt: "fake-stt",
      llm: "fake-llm",
      tts: "fake-tts",
    });

    const session = await agent.start({
      callHandle,
      channel: "simulated",
      ttsVoice: "fake-tts-voice",
      turnProfile: "accuracy",
    });
    const run = session.run;
    const observed = (async () => {
      const events: string[] = [];
      for await (const event of run) {
        events.push(event.kind === "turn_completed" ? `${event.kind}:${event.status}` : event.kind);
      }
      return events;
    })();

    inbound.push(
      createMediaEvent({
        id: "stream-started" as never,
        type: "media.stream.started",
        sessionId: run.sessionId,
        sequence: 1,
        direction: "input",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        format: PCM16_16K_MONO,
      }),
    );
    await sttOpen;
    expect(sttTurnProfile).toBe("accuracy");
    const timestamp = nowTimestamp();
    transcripts.push({
      id: "stt-final" as ProviderEventId,
      type: "stt.final",
      direction: "input",
      sessionId: run.sessionId,
      sequence: 1,
      provider: "fake-stt",
      text: "Book me an appointment.",
      startTimestamp: timestamp,
      endTimestamp: timestamp,
    });
    transcripts.push({
      id: "stt-endpoint" as ProviderEventId,
      type: "stt.endpoint",
      direction: "input",
      sessionId: run.sessionId,
      sequence: 2,
      provider: "fake-stt",
      reason: "provider",
      timestamp,
    });
    await committedSent;
    await tapCallbackStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    inbound.push(
      createMediaEvent({
        id: "stream-ended" as never,
        type: "media.stream.ended",
        sessionId: run.sessionId,
        sequence: 2,
        direction: "input",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 20,
        reason: "completed",
        durationMs: 20,
      }),
    );

    const result = await run;
    const eventKinds = await observed;
    expect(result.turnsHandled).toBe(1);
    expect(result.turnsFailed).toBe(0);
    expect(ttsRequestVoice).toBe("fake-tts-voice");
    expect(result.audioTap).toMatchObject({ enabled: true, droppedFrames: 0 });
    expect(eventKinds).toContain("transcript_delta");
    expect(eventKinds).toContain("audio_output");
    expect(eventKinds.at(-1)).toBe("call_ended");
    expect(sent.length).toBeGreaterThan(0);
    expect(closeReasons).toEqual(["completed"]);
    const finalSession = await session.finalSession;
    const framesDeliveredAtFinalSession = recorder.frames.length;
    releaseTapCallback();
    const drainedSummary = await tapDrained;
    expect(finalSession.audioTap).toMatchObject({ enabled: true, droppedFrames: 0 });
    expect(finalSession.usage.entries).toContainEqual(
      expect.objectContaining({
        kind: "llm",
        provider: "fake-llm",
        model: "fake-llm-model",
        modelSource: "request",
        metrics: {
          requestCount: { status: "measured", source: "runtime", unit: "requests", value: 1 },
          inputTokens: { status: "reported", source: "provider", unit: "tokens", value: 14 },
          outputTokens: { status: "reported", source: "provider", unit: "tokens", value: 6 },
          cachedTokens: { status: "reported", source: "provider", unit: "tokens", value: 3 },
        },
      }),
    );
    expect(finalSession.usage.entries).toContainEqual(
      expect.objectContaining({
        kind: "tts",
        provider: "fake-tts",
        model: "fake-tts-model",
        modelSource: "request",
      }),
    );
    expect(drainedSummary).toMatchObject({ enabled: true, callbackErrors: 0 });
    expect(recorder.drainedSessionId).toBe(session.sessionId);
    expect(framesDeliveredAtFinalSession).toBe(1);
    expect(recorder.frames.map((frame) => frame.type)).toEqual(["audio", "playout"]);

    await agent.stop();
  });

  it("does not carry Cartesia control prefixes across runtime sentence flushes", async () => {
    const capabilityEvaluationTimeMs = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(capabilityEvaluationTimeMs);
    const inbound = new AsyncQueue<InboundMediaEvent>();
    const transcripts = new AsyncQueue<TranscriptEvent>();
    let resolveSttOpen!: () => void;
    const sttOpen = new Promise<void>((resolve) => {
      resolveSttOpen = resolve;
    });
    let resolveLlmStarted!: () => void;
    const llmStarted = new Promise<void>((resolve) => {
      resolveLlmStarted = resolve;
    });
    let resolveTtsOpened!: (opened: boolean) => void;
    const ttsOpenResult = new Promise<boolean>((resolve) => {
      resolveTtsOpened = resolve;
    });
    let resolveCommitted!: () => void;
    const committedSent = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
    const boundaryTool = defineTool<{ readonly ignored?: boolean }, { readonly ok: boolean }>({
      id: "cartesia_control_boundary",
      name: "cartesia_control_boundary",
      description: "Creates a TTS boundary for the test.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["ok"] },
      async execute() {
        return { ok: true };
      },
    });
    const callHandle: CallHandle = {
      callId: "cartesia-control-call" as CallId,
      events: inbound,
      async send(event) {
        if (event.type === "media.audio.committed") resolveCommitted();
        return true;
      },
      async clear() {},
      async close() {
        inbound.close();
      },
      async confirmPlayout() {
        return true;
      },
    };
    const stt: SpeechToTextProvider = {
      name: "fake-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async open(): Promise<SttStream> {
        resolveSttOpen();
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
    let llmCompletionCount = 0;
    const llm: LLMProvider = {
      name: "fake-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async complete(request): Promise<LlmCompletion> {
        llmCompletionCount += 1;
        resolveLlmStarted();
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: "cartesia-control-llm-started" as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "fake-llm",
          timestamp,
          model: request.model,
        });
        if (llmCompletionCount === 1) {
          const call = {
            callRef: "cartesia-control-boundary-call",
            toolName: "cartesia_control_boundary" as never,
            input: {},
          };
          events.push({
            id: "cartesia-control-tool-call" as ProviderEventId,
            type: "llm.tool_call",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            provider: "fake-llm",
            timestamp,
            call,
          });
          events.push({
            id: "cartesia-control-llm-completed" as ProviderEventId,
            type: "llm.completed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 3,
            provider: "fake-llm",
            timestamp,
            text: "Dr.",
            toolCalls: [call],
          });
        } else {
          events.push({
            id: "cartesia-control-llm-continuation" as ProviderEventId,
            type: "llm.completed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            provider: "fake-llm",
            timestamp,
            text: " Smith is here.",
            toolCalls: [],
          });
        }
        events.close();
        return { events, async cancel() {} };
      },
    };
    const socket = new AutoAcknowledgingCartesiaSocket();
    const cartesia = createCartesiaTtsProvider({
      apiKey: "test",
      modelId: "sonic-3.6",
      voiceId: "cartesia-test-voice",
      generationConfig: { speed: 1 },
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const tts = new Proxy(cartesia, {
      get(target, property) {
        if (property === "openSession") {
          return async (request: Parameters<typeof cartesia.openSession>[0]) => {
            try {
              const session = await cartesia.openSession(request);
              resolveTtsOpened(true);
              return session;
            } catch (error) {
              resolveTtsOpened(false);
              throw error;
            }
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const telephony: TelephonyProvider = {
      name: "fake-telephony",
      kind: "telephony",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async dial() {
        throw new Error("not used");
      },
      async accept() {
        throw new Error("not used");
      },
      async hangup() {},
    };
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      models: { stt: "fake-stt-model", llm: "fake-llm-model" },
      providers: { telephony, stt, llm, tts },
      tools: [boundaryTool],
      providerCapabilitySnapshots: [
        createProviderCapabilitySnapshot({
          provider: "cartesia",
          source: "https://docs.cartesia.ai/api-reference/voices/get",
          fetchedAt: new Date(capabilityEvaluationTimeMs - 1_000).toISOString(),
          validUntil: new Date(capabilityEvaluationTimeMs + 250).toISOString(),
          facts: [
            {
              feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
              scope: "voice",
              model: "sonic-3.6",
              voice: "cartesia-test-voice",
              status: "supported",
            },
            {
              feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceIsPro,
              scope: "voice",
              voice: "cartesia-test-voice",
              status: "supported",
              value: false,
            },
          ],
        }),
      ],
      runtime: TEST_RUNTIME_DEFAULTS,
    });
    try {
      const managedSession = await agent.start({
        callHandle,
        channel: "simulated",
        ttsTextControls: [{ type: "spell", match: "Dr. Smith" }],
      });
      wallClock.mockReturnValue(capabilityEvaluationTimeMs + 1_000);
      const run = managedSession.run;
      const observed = (async () => {
        for await (const _event of run) {
          void _event;
        }
      })();
      inbound.push(
        createMediaEvent({
          id: "cartesia-control-stream-started" as never,
          type: "media.stream.started",
          sessionId: run.sessionId,
          sequence: 1,
          direction: "input",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          format: PCM16_16K_MONO,
        }),
      );
      await sttOpen;
      const timestamp = nowTimestamp();
      transcripts.push({
        id: "cartesia-control-stt-final" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: run.sessionId,
        sequence: 1,
        provider: "fake-stt",
        text: "How should I say this?",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      transcripts.push({
        id: "cartesia-control-stt-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: run.sessionId,
        sequence: 2,
        provider: "fake-stt",
        reason: "provider",
        timestamp,
      });
      await llmStarted;
      await expect(ttsOpenResult).resolves.toBe(true);
      await committedSent;
      inbound.push(
        createMediaEvent({
          id: "cartesia-control-stream-ended" as never,
          type: "media.stream.ended",
          sessionId: run.sessionId,
          sequence: 2,
          direction: "input",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 20,
          reason: "completed",
          durationMs: 20,
        }),
      );
      const result = await run;
      await observed;

      const transcriptsSent = socket.sent
        .map((serialized) => JSON.parse(serialized) as Record<string, unknown>)
        .map((request) => request.transcript)
        .filter((text): text is string => typeof text === "string" && text.length > 0);
      expect(result.turnsFailed).toBe(0);
      expect(transcriptsSent.join("")).toBe("Dr. Smith is here.");
      expect(transcriptsSent).not.toContain("<spell>Dr. Smith</spell>");
    } finally {
      wallClock.mockRestore();
      await agent.stop();
    }
  });

  it("retains usage when managed cleanup races a late successful terminal write", async () => {
    vi.useFakeTimers();
    const baseStore = createInMemoryDurableRuntimeStore();
    let releaseTerminalWrite!: () => void;
    let signalTerminalWriteStarted!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    const terminalWriteStarted = new Promise<void>((resolve) => {
      signalTerminalWriteStarted = resolve;
    });
    let signalTerminalWriteSettled!: () => void;
    const terminalWriteSettled = new Promise<void>((resolve) => {
      signalTerminalWriteSettled = resolve;
    });
    const durableStore: DurableRuntimeStore = {
      ...baseStore,
      async runSessionTransaction<T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        let terminalUpdateSeen = false;
        try {
          return await baseStore.runSessionTransaction(sessionId, lease, async (tx) => {
            const transaction: DurableSessionTransaction = {
              ...tx,
              async updateSession(id, updater) {
                const current = await tx.getSession(id);
                if (!current) return tx.updateSession(id, updater);
                const updated = updater(current);
                if (isTerminalSession(updated.session)) {
                  terminalUpdateSeen = true;
                  signalTerminalWriteStarted();
                  await terminalWriteGate;
                }
                return tx.updateSession(id, () => updated);
              },
            };
            return operation(transaction);
          });
        } finally {
          if (terminalUpdateSeen) signalTerminalWriteSettled();
        }
      },
    };
    const endEvents: SessionEndEvent[] = [];
    const traces: RuntimeSessionTrace[] = [];
    let resolveEndEvent!: (event: SessionEndEvent) => void;
    const endEvent = new Promise<SessionEndEvent>((resolve) => {
      resolveEndEvent = resolve;
    });
    let resolveTrace!: (trace: RuntimeSessionTrace) => void;
    const traceEvent = new Promise<RuntimeSessionTrace>((resolve) => {
      resolveTrace = resolve;
    });
    let signalTerminalCommit!: () => void;
    const terminalCommit = new Promise<void>((resolve) => {
      signalTerminalCommit = resolve;
    });
    const harness = createLifecycleHarness({
      runtime: {
        durableStore,
        durablePolicy: { criticalWriteTimeoutMs: 10_000 },
        onSessionEnd: (event) => {
          endEvents.push(event);
          resolveEndEvent(event);
        },
        sessionMetricsRecorder: {
          record() {},
          onTurn() {},
          onSessionTrace: (trace) => {
            traces.push(trace);
            resolveTrace(trace);
          },
        },
      },
      completeLlm: async (request) => {
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: "late-usage-llm-started" as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "lifecycle-llm",
          timestamp,
          model: request.model,
        });
        events.push({
          id: "late-usage-llm-completed" as ProviderEventId,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "lifecycle-llm",
          timestamp,
          text: "",
          toolCalls: [],
          usage: { inputTokens: 14, outputTokens: 6 },
        });
        events.close();
        return { events, async cancel() {} };
      },
      onSttCommit: signalTerminalCommit,
    });

    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      let signalTurnCompleted!: () => void;
      const turnCompleted = new Promise<void>((resolve) => {
        signalTurnCompleted = resolve;
      });
      const observed = (async () => {
        for await (const event of session.run) {
          if (event.kind === "turn_completed") signalTurnCompleted();
        }
      })();
      void observed.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      const timestamp = nowTimestamp();
      harness.transcripts.push({
        id: "late-usage-stt-final" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 1,
        provider: "lifecycle-stt",
        text: "Confirm my appointment.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      harness.transcripts.push({
        id: "late-usage-stt-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 2,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp,
      });
      await turnCompleted;
      harness.inbound.push(streamEndedEvent(session.sessionId));
      await terminalCommit;
      const terminalTimestamp = nowTimestamp();
      harness.transcripts.push({
        id: "late-usage-terminal-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 3,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp: terminalTimestamp,
      });
      await terminalWriteStarted;
      await vi.advanceTimersByTimeAsync(5_000);
      await session.run.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(5_000);
      releaseTerminalWrite();
      await terminalWriteSettled;
      const [event, trace] = await Promise.all([endEvent, traceEvent]);
      const llmUsage = event.usage?.entries.find((entry) => entry.kind === "llm");

      expect(endEvents).toHaveLength(1);
      expect(traces).toHaveLength(1);
      expect(llmUsage?.metrics.inputTokens).toMatchObject({ status: "reported", value: 14 });
      expect(trace.usage).toBe(event.usage);
    } finally {
      releaseTerminalWrite();
      await harness.agent.stop().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("rejects missing credentials before creating a built-in provider", () => {
    const names = [
      "DEEPGRAM_API_KEY",
      "OPENAI_API_KEY",
      "CARTESIA_API_KEY",
      "CARTESIA_VOICE_ID",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      expect(() =>
        createVoiceAgent({
          prompt: "Answer appointment questions.",
          providers: {
            telephony: { provider: "web-client-audio" },
            stt: { provider: "deepgram" },
            llm: { provider: "openai" },
            tts: { provider: "cartesia", voiceId: "voice" },
          },
        }),
      ).toThrow(/DEEPGRAM_API_KEY/);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects whitespace configuration and does not fall back from an explicit empty key", () => {
    expect(() => createVoiceAgent({ prompt: "   " } as CreateVoiceAgentOptions)).toThrow(
      /prompt must be a non-empty string/,
    );

    const previous = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = "environment-key";
    try {
      expect(() =>
        createVoiceAgent({
          prompt: "Answer appointment questions.",
          providers: {
            telephony: { provider: "web-client-audio" },
            stt: { provider: "deepgram", apiKey: "" },
            llm: { provider: "openai", apiKey: "test" },
            tts: { provider: "cartesia", apiKey: "test", voiceId: "voice" },
          },
        }),
      ).toThrow(/deepgram apiKey must be a non-empty string/);
    } finally {
      if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
      else process.env.DEEPGRAM_API_KEY = previous;
    }
  });

  it("validates the optional audio-tap drain callback", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {} as never,
        audioTap: { onFrame: () => undefined, onDrained: 1 } as never,
      }),
    ).toThrow(/audioTap\.onDrained must be a function/u);
  });

  it("resolves built-in credentials and the TTS voice from environment variables", () => {
    const names = [
      "DEEPGRAM_API_KEY",
      "SARVAM_API_KEY",
      "ELEVENLABS_API_KEY",
      "ASSEMBLYAI_API_KEY",
      "SONIOX_API_KEY",
      "OPENAI_API_KEY",
      "CARTESIA_API_KEY",
      "CARTESIA_VOICE_ID",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const [index, name] of names.entries()) process.env[name] = `test-secret-${index}`;
    try {
      const agent = createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram" },
          llm: { provider: "openai" },
          tts: { provider: "cartesia" },
        },
      });
      expect(agent.providers).toEqual({
        telephony: "web-client-audio",
        stt: "deepgram",
        llm: "openai-responses",
        tts: "cartesia",
      });
      expect(JSON.stringify(agent)).not.toContain("test-secret");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("accepts explicit credentials for every built-in stage", () => {
    const names = [
      "DEEPGRAM_API_KEY",
      "SARVAM_API_KEY",
      "ELEVENLABS_API_KEY",
      "ASSEMBLYAI_API_KEY",
      "SONIOX_API_KEY",
      "OPENAI_API_KEY",
      "CARTESIA_API_KEY",
      "CARTESIA_VOICE_ID",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      const agent = createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "cartesia",
            apiKey: "cartesia-explicit",
            voiceId: "cartesia-voice-explicit",
          },
        },
      });
      expect(agent.providers).toEqual({
        telephony: "web-client-audio",
        stt: "deepgram",
        llm: "openai-responses",
        tts: "cartesia",
      });
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("resolves Sarvam Bulbul v3 TTS with an explicit voice and language", () => {
    const agent = createVoiceAgent({
      prompt: "Answer appointment questions.",
      providers: {
        telephony: { provider: "web-client-audio" },
        stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
        llm: { provider: "openai", apiKey: "openai-explicit" },
        tts: {
          provider: "sarvam",
          apiKey: "sarvam-explicit",
          model: "bulbul:v3",
          voiceId: "ishita",
          language: "hi-IN",
        },
      },
    });
    expect(agent.providers).toEqual({
      telephony: "web-client-audio",
      stt: "deepgram",
      llm: "openai-responses",
      tts: "sarvam-tts",
    });
    expect(JSON.stringify(agent)).not.toContain("sarvam-explicit");
  });

  it("resolves Sarvam Bulbul v4 Flash with a caller-selected persona", () => {
    const agent = createVoiceAgent({
      prompt: "Answer appointment questions.",
      providers: {
        telephony: { provider: "web-client-audio" },
        stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
        llm: { provider: "openai", apiKey: "openai-explicit" },
        tts: {
          provider: "sarvam",
          apiKey: "sarvam-explicit",
          model: "bulbul:v4-flash",
          voiceId: "simran_en_customer",
          language: "en-IN",
        },
      },
    });

    expect(agent.providers).toEqual({
      telephony: "web-client-audio",
      stt: "deepgram",
      llm: "openai-responses",
      tts: "sarvam-tts",
    });
    expect(JSON.stringify(agent)).not.toContain("sarvam-explicit");
  });

  it("requires an explicit persona for managed Bulbul v4 setup", () => {
    const previousVoice = process.env.SARVAM_TTS_VOICE_ID;
    delete process.env.SARVAM_TTS_VOICE_ID;
    try {
      expect(() =>
        createVoiceAgent({
          prompt: "Answer appointment questions.",
          providers: {
            telephony: { provider: "web-client-audio" },
            stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
            llm: { provider: "openai", apiKey: "openai-explicit" },
            tts: {
              provider: "sarvam",
              apiKey: "sarvam-explicit",
              model: "bulbul:v4-flash",
              language: "en-IN",
            },
          },
        }),
      ).toThrow(/models\.ttsVoice or SARVAM_TTS_VOICE_ID/u);
    } finally {
      if (previousVoice === undefined) delete process.env.SARVAM_TTS_VOICE_ID;
      else process.env.SARVAM_TTS_VOICE_ID = previousVoice;
    }
  });

  it("requires an explicit persona for an injected Bulbul v4 provider instance", () => {
    const provider = createSarvamTtsProvider({
      apiKey: "sarvam-explicit",
      modelId: "bulbul:v4-flash",
      language: "en-IN",
      webSocketFactory: () => {
        throw new Error("provider must not open during agent setup");
      },
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: provider,
        },
      }),
    ).toThrow(/voice/u);
  });

  it("requires explicit language for the effective managed Bulbul v4 model", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "sarvam",
            apiKey: "sarvam-explicit",
            model: "bulbul:v4-flash",
            voiceId: "simran_en_customer",
          },
        },
      }),
    ).toThrow(/caller-selected language/u);

    const v3Provider = createSarvamTtsProvider({ apiKey: "sarvam-explicit" });
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: v3Provider,
        },
        models: { tts: "bulbul:v4-flash", ttsVoice: "simran_en_customer" },
      }),
    ).toThrow(/caller-selected language/u);
  });

  it("rejects an unsupported configured Sarvam language during managed setup", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "sarvam",
            apiKey: "sarvam-explicit",
            model: "bulbul:v4-flash",
            voiceId: "simran_en_customer",
            language: "as-IN",
          },
        },
      }),
    ).toThrow(/language is invalid/u);
  });

  it.each([
    { model: "sonic-3.6", language: "not-a-language", field: "language" },
    { model: "sonic-3.5", language: "or", field: "language" },
    { model: "sonic-3.5", language: "en-US", field: "locale" },
  ])(
    "rejects unsupported Cartesia $field for $model before managed setup",
    ({ model, language, field }) => {
      expect(() =>
        createVoiceAgent({
          prompt: "Answer appointment questions.",
          models: { tts: model },
          providers: {
            telephony: { provider: "web-client-audio" },
            stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
            llm: { provider: "openai", apiKey: "openai-explicit" },
            tts: {
              provider: "cartesia",
              apiKey: "cartesia-explicit",
              voiceId: "cartesia-voice-explicit",
              ...(field === "locale" ? { locale: language } : { language }),
            },
          },
        }),
      ).toThrow(/Cartesia.*(language|locale)/u);
    },
  );

  it("accepts a documented Cartesia language and locale for Sonic 3.6", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        models: { tts: "sonic-3.6" },
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "cartesia",
            apiKey: "cartesia-explicit",
            voiceId: "cartesia-voice-explicit",
            locale: "hi-IN",
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects an inherited v3 short-name voice for the managed v4 model", () => {
    const previousVoice = process.env.SARVAM_TTS_VOICE_ID;
    process.env.SARVAM_TTS_VOICE_ID = "shubh";
    try {
      expect(() =>
        createVoiceAgent({
          prompt: "Answer appointment questions.",
          providers: {
            telephony: { provider: "web-client-audio" },
            stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
            llm: { provider: "openai", apiKey: "openai-explicit" },
            tts: {
              provider: "sarvam",
              apiKey: "sarvam-explicit",
              model: "bulbul:v4-flash",
              language: "en-IN",
            },
          },
        }),
      ).toThrow(/sarvam-tts does not support voice shubh/);
    } finally {
      if (previousVoice === undefined) delete process.env.SARVAM_TTS_VOICE_ID;
      else process.env.SARVAM_TTS_VOICE_ID = previousVoice;
    }
  });

  it("resolves a managed Sarvam Bulbul v4 REST provider without native streaming", () => {
    const agent = createVoiceAgent({
      prompt: "Answer appointment questions.",
      providers: {
        telephony: { provider: "web-client-audio" },
        stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
        llm: { provider: "openai", apiKey: "openai-explicit" },
        tts: {
          provider: "sarvam",
          transport: "rest",
          apiKey: "sarvam-explicit",
          model: "bulbul:v4-flash",
          voiceId: "simran_en_customer",
          language: "en-IN",
        },
      },
    });

    expect(agent.providers.tts).toBe("sarvam-tts");
  });

  it("rejects a v4 persona when the managed Sarvam model is v3", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "sarvam",
            apiKey: "sarvam-explicit",
            model: "bulbul:v3",
            voiceId: "simran_en_customer",
          },
        },
      }),
    ).toThrow(/sarvam-tts does not support voice simran_en_customer/);
  });

  it("rejects an unlisted caller-provided V4 persona during agent validation", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "sarvam",
            apiKey: "sarvam-explicit",
            model: "bulbul:v4-flash",
            voiceId: "future_en_customer",
            language: "en-IN",
          },
        },
      }),
    ).toThrow(/sarvam-tts does not support voice future_en_customer/);
  });

  it("rejects a v4 persona against a constructed Sarvam v3 provider", () => {
    const tts = createSarvamTtsProvider({
      apiKey: "sarvam-explicit",
      modelId: "bulbul:v3",
      voiceId: "shubh",
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts,
        },
        models: { ttsVoice: "simran_en_customer" },
      }),
    ).toThrow(/sarvam-tts does not support voice simran_en_customer/);
  });

  it("rejects a constructed v4 persona when the agent overrides the provider to v3", () => {
    const tts = createSarvamTtsProvider({
      apiKey: "sarvam-explicit",
      modelId: "bulbul:v4-flash",
      voiceId: "simran_en_customer",
      language: "en-IN",
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts,
        },
        models: { tts: "bulbul:v3" },
      }),
    ).toThrow(/model overrides must also select a voice/);
  });

  it("requires a new persona when a configured Sarvam model is overridden", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "sarvam",
            apiKey: "sarvam-explicit",
            model: "bulbul:v3",
            voiceId: "shubh",
          },
        },
        models: { tts: "bulbul:v4-flash" },
      }),
    ).toThrow(/model overrides must also select a voice/);
  });

  it("requires a persona when a configured Sarvam voice inherits the default model", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: { provider: "sarvam", apiKey: "sarvam-explicit", voiceId: "shubh" },
        },
        models: { tts: "bulbul:v4-flash" },
      }),
    ).toThrow(/model overrides must also select a voice/);
  });

  it("requires a persona when a Sarvam provider is wrapped by TTS failover", () => {
    const primary = createSarvamTtsProvider({
      apiKey: "sarvam-explicit",
      modelId: "bulbul:v3",
      voiceId: "shubh",
    });
    const fallback: TextToSpeechProvider = {
      name: "fallback-tts",
      kind: "tts",
      version: "1.0.0",
      configuredLanguage: "en-IN",
      capabilities: { ...CAPABILITIES, models: ["fallback-model"], voices: ["fallback-voice"] },
      async synthesize() {
        throw new Error("not reached");
      },
    };
    const tts = createTtsFailoverProvider({ primary, fallback });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts,
        },
        models: { tts: "bulbul:v4-flash" },
      }),
    ).toThrow(/model overrides must also select a voice/);
  });

  it("rejects a constructed provider voice rejected by its dynamic catalog", () => {
    const tts: TextToSpeechProvider = {
      name: "dynamic-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: { ...CAPABILITIES, models: ["dynamic-model"] },
      configuredModel: "dynamic-model",
      configuredVoice: "rejected-voice",
      supportsVoice: () => false,
      async synthesize() {
        throw new Error("not reached");
      },
    };

    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts,
        },
      }),
    ).toThrow(/dynamic-tts does not support voice rejected-voice/);
  });

  it("requires a new voice when a constructed Sarvam model is overridden", () => {
    const tts = createSarvamTtsProvider({
      apiKey: "sarvam-explicit",
      modelId: "bulbul:v3",
      voiceId: "shubh",
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts,
        },
        models: { tts: "bulbul:v4-flash" },
      }),
    ).toThrow(/model overrides must also select a voice/);
  });

  it("rejects a blank managed Sarvam persona", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
          llm: { provider: "openai", apiKey: "openai-explicit" },
          tts: {
            provider: "sarvam",
            apiKey: "sarvam-explicit",
            model: "bulbul:v4-flash",
            voiceId: " \t",
          },
        },
      }),
    ).toThrow(/models\.ttsVoice or SARVAM_TTS_VOICE_ID must be a non-empty string/);
  });

  it("does not overwrite defaults on a constructed TTS provider", async () => {
    let capturedRequest: TtsSynthesisRequest | undefined;
    const constructedTts: TextToSpeechProvider = {
      name: "constructed-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async synthesize(request) {
        capturedRequest = request;
        const events = new AsyncQueue<TtsEvent>();
        const audio = createMediaEvent({
          id: "constructed-tts-audio" as never,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "constructed-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 20,
            frameCount: 320,
            bytes: new Uint8Array(640),
          },
        });
        events.push(audio as OutputAudioChunk);
        events.push(
          createMediaEvent({
            id: "constructed-tts-committed" as never,
            type: "media.audio.committed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            direction: "output",
            timestamp: nowTimestamp(),
            monotonicOffsetMs: 0,
            provider: "constructed-tts",
            durationMs: 20,
            frameCount: 320,
            sequenceRange: [1, 1],
            chunkIds: [audio.id],
          }),
        );
        events.close();
        return { events, async cancel() {} } satisfies TtsStream;
      },
    };
    const harness = createLifecycleHarness({
      ttsProvider: constructedTts,
      providerCapabilitySnapshots: [
        createProviderCapabilitySnapshot({
          provider: "constructed-tts",
          source: "https://provider.example/capabilities",
          fetchedAt: new Date(Date.now() - 1_000).toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          facts: [],
        }),
        createProviderCapabilitySnapshot({
          provider: "unrelated-provider",
          source: "https://provider.example/capabilities",
          fetchedAt: new Date(Date.now() - 1_000).toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          facts: [],
        }),
      ],
      completeLlm: async (request) => {
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: "constructed-llm-started" as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "lifecycle-llm",
          timestamp,
          model: request.model,
        });
        events.push({
          id: "constructed-llm-completed" as ProviderEventId,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "lifecycle-llm",
          timestamp,
          text: "Constructed provider defaults.",
          toolCalls: [],
        });
        events.close();
        return { events, async cancel() {} };
      },
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const observed = collectVoiceEvents(session.run);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      const timestamp = nowTimestamp();
      harness.transcripts.push({
        id: "constructed-transcript" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 1,
        provider: "lifecycle-stt",
        text: "Use the constructed provider.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      harness.transcripts.push({
        id: "constructed-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 2,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp,
      });
      await harness.committed;
      harness.inbound.push(streamEndedEvent(session.sessionId));
      await session.run;
      await observed;

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest).not.toHaveProperty("model");
      expect(capturedRequest).not.toHaveProperty("voice");
      expect(
        capturedRequest?.providerCapabilitySnapshots?.map((snapshot) => snapshot.provider),
      ).toEqual(["constructed-tts"]);
    } finally {
      await harness.agent.stop();
    }
  });

  it("resolves the Groq Chat Completions provider from environment credentials", () => {
    const names = [
      "DEEPGRAM_API_KEY",
      "GROQ_API_KEY",
      "CARTESIA_API_KEY",
      "CARTESIA_VOICE_ID",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const [index, name] of names.entries()) process.env[name] = `groq-test-secret-${index}`;
    try {
      const agent = createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram" },
          llm: { provider: "groq" },
          tts: { provider: "cartesia" },
        },
      });
      expect(agent.providers).toEqual({
        telephony: "web-client-audio",
        stt: "deepgram",
        llm: "groq-chat-completions",
        tts: "cartesia",
      });
      expect(JSON.stringify(agent)).not.toContain("groq-test-secret");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("resolves Cartesia Ink STT from environment credentials and preserves its mode", () => {
    const names = ["CARTESIA_API_KEY", "GROQ_API_KEY", "CARTESIA_VOICE_ID"] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const [index, name] of names.entries()) process.env[name] = `cartesia-stt-test-${index}`;
    try {
      const agent = createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "cartesia", mode: "auto" },
          llm: { provider: "groq" },
          tts: { provider: "cartesia" },
        },
        models: { stt: "ink-2" },
      });
      expect(agent.providers).toEqual({
        telephony: "web-client-audio",
        stt: "cartesia-stt",
        llm: "groq-chat-completions",
        tts: "cartesia",
      });
      expect(JSON.stringify(agent)).not.toContain("cartesia-stt-test");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("validates Groq model selection against its dated catalog", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "test" },
          llm: { provider: "groq", apiKey: "test", model: "not-a-groq-model" },
          tts: { provider: "cartesia", apiKey: "test", voiceId: "voice" },
        },
      }),
    ).toThrow(/groq-chat-completions does not support model not-a-groq-model/);
  });

  it("rejects unsupported configured models before a session starts", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: { provider: "deepgram", apiKey: "test", model: "not-a-real-model" },
          llm: { provider: "openai", apiKey: "test" },
          tts: { provider: "cartesia", apiKey: "test", voiceId: "voice" },
        },
      }),
    ).toThrow(/deepgram does not support model not-a-real-model/);
  });

  it("allows an explicitly opted-in unknown STT model", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: { provider: "web-client-audio" },
          stt: {
            provider: "deepgram",
            apiKey: "test",
            model: "future-model",
            allowUnknownModel: true,
          },
          llm: { provider: "openai", apiKey: "test" },
          tts: { provider: "cartesia", apiKey: "test", voiceId: "voice" },
        },
      }),
    ).not.toThrow();
  });

  it("allows a constructed TTS provider's explicitly opted-in unknown model", () => {
    const ttsProviders = [
      createCartesiaTtsProvider({
        apiKey: "cartesia-explicit",
        modelId: "future-cartesia-model",
        allowUnknownModel: true,
        voiceId: "cartesia-voice",
      }),
      createElevenLabsTtsProvider({
        apiKey: "elevenlabs-explicit",
        modelId: "future-elevenlabs-model",
        allowUnknownModel: true,
        voiceId: "elevenlabs-voice",
      }),
    ];

    for (const tts of ttsProviders) {
      expect(() =>
        createVoiceAgent({
          prompt: "Answer appointment questions.",
          providers: {
            telephony: { provider: "web-client-audio" },
            stt: { provider: "deepgram", apiKey: "deepgram-explicit" },
            llm: { provider: "openai", apiKey: "openai-explicit" },
            tts,
          },
        }),
      ).not.toThrow();
    }
  });

  it("allows an explicitly opted-in model for a custom OpenAI-compatible endpoint", () => {
    const base = {
      prompt: "Answer appointment questions.",
      providers: {
        telephony: { provider: "web-client-audio" as const },
        stt: { provider: "deepgram" as const, apiKey: "test" },
        llm: {
          provider: "openai" as const,
          apiKey: "test",
          url: "http://localhost:9000/v1/responses",
          model: "local-model",
        },
        tts: { provider: "cartesia" as const, apiKey: "test", voiceId: "voice" },
      },
    };
    expect(() => createVoiceAgent(base)).toThrow(
      /openai-responses does not support model local-model/,
    );
    expect(() =>
      createVoiceAgent({
        ...base,
        providers: {
          ...base.providers,
          llm: { ...base.providers.llm, allowUnknownModel: true },
        },
      }),
    ).not.toThrow();
  });

  it("forwards an explicitly opted-in custom model to the managed Groq provider", async () => {
    const inbound = new AsyncQueue<InboundMediaEvent>();
    const transcripts = new AsyncQueue<TranscriptEvent>();
    const sent: OutputMediaEvent[] = [];
    let resolveCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
    let resolveFetch!: (body: Readonly<Record<string, unknown>>) => void;
    const fetchCalled = new Promise<Readonly<Record<string, unknown>>>((resolve) => {
      resolveFetch = resolve;
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Readonly<Record<string, unknown>>;
      resolveFetch(body);
      return new Response(
        'data: {"choices":[{"delta":{"content":"The appointment is confirmed."}}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    };

    const callHandle: CallHandle = {
      callId: "managed-groq-call" as CallId,
      events: inbound,
      async send(event) {
        sent.push(event);
        if (event.type === "media.audio.committed") resolveCommitted();
        return true;
      },
      async clear() {},
      async close() {
        inbound.close();
      },
      async confirmPlayout() {
        return true;
      },
    };
    const stt: SpeechToTextProvider = {
      name: "managed-groq-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      configuredModel: "managed-groq-stt-model",
      async open() {
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
    const tts: TextToSpeechProvider = {
      name: "managed-groq-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      configuredModel: "managed-groq-tts-model",
      async synthesize(request) {
        const events = new AsyncQueue<TtsEvent>();
        const audio = createMediaEvent({
          id: "managed-groq-audio" as never,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "managed-groq-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 20,
            frameCount: 320,
            bytes: new Uint8Array(640),
          },
        });
        events.push(audio as OutputAudioChunk);
        events.push(
          createMediaEvent({
            id: "managed-groq-committed" as never,
            type: "media.audio.committed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            direction: "output",
            timestamp: nowTimestamp(),
            monotonicOffsetMs: 20,
            provider: "managed-groq-tts",
            durationMs: 20,
            frameCount: 320,
            sequenceRange: [1, 1],
            chunkIds: [audio.id],
          }),
        );
        events.close();
        return { events, async cancel() {} };
      },
    };
    const telephony: TelephonyProvider = {
      name: "managed-groq-telephony",
      kind: "telephony",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async dial() {
        throw new Error("dial should not run");
      },
      async accept() {
        throw new Error("accept should not run");
      },
      async hangup() {},
    };
    const agent = createVoiceAgent({
      prompt: "Confirm the appointment.",
      providers: {
        telephony,
        stt,
        llm: {
          provider: "groq",
          apiKey: "test",
          url: "http://localhost:9000/v1/chat/completions",
          model: "custom-compatible-model",
          allowUnknownModel: true,
        },
        tts,
      },
      runtime: TEST_RUNTIME_DEFAULTS,
    });

    try {
      const session = await agent.start({ callHandle, channel: "simulated" });
      const run = session.run;
      const completion = run.catch(() => undefined);
      inbound.push(
        createMediaEvent({
          id: "managed-groq-started" as never,
          type: "media.stream.started",
          sessionId: run.sessionId,
          sequence: 1,
          direction: "input",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          format: PCM16_16K_MONO,
        }),
      );
      inbound.push(
        createMediaEvent({
          id: "managed-groq-input-audio" as never,
          type: "media.audio.chunk",
          sessionId: run.sessionId,
          sequence: 2,
          direction: "input",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 20,
            frameCount: 320,
            bytes: new Uint8Array(640),
          },
        }),
      );
      const timestamp = nowTimestamp();
      transcripts.push({
        id: "managed-groq-final" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: run.sessionId,
        sequence: 1,
        provider: "managed-groq-stt",
        text: "Book the appointment.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      transcripts.push({
        id: "managed-groq-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: run.sessionId,
        sequence: 2,
        provider: "managed-groq-stt",
        reason: "provider",
        timestamp,
      });

      const body = await Promise.race([
        fetchCalled,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("managed Groq request was not made")), 5_000),
        ),
      ]);
      expect(body.model).toBe("custom-compatible-model");
      expect(body.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Book the appointment." }),
        ]),
      );
      await committed;
      inbound.push(
        createMediaEvent({
          id: "managed-groq-ended" as never,
          type: "media.stream.ended",
          sessionId: run.sessionId,
          sequence: 3,
          direction: "input",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 20,
          reason: "completed",
          durationMs: 20,
        }),
      );
      await run;
      await completion;
      expect(sent.some((event) => event.type === "media.audio.committed")).toBe(true);
      const finalSession = await session.finalSession;
      expect(finalSession.usage.entries).toContainEqual(
        expect.objectContaining({
          kind: "llm",
          provider: "groq-chat-completions",
          model: "custom-compatible-model",
          modelSource: "configured",
        }),
      );
      expect(finalSession.usage.entries).toContainEqual(
        expect.objectContaining({
          kind: "stt",
          provider: "managed-groq-stt",
          model: "managed-groq-stt-model",
          modelSource: "configured",
          metrics: {
            audioMsSent: {
              status: "measured",
              source: "runtime",
              unit: "milliseconds",
              value: 20,
            },
          },
        }),
      );
      expect(finalSession.usage.entries).toContainEqual(
        expect.objectContaining({
          kind: "tts",
          provider: "managed-groq-tts",
          model: "managed-groq-tts-model",
          modelSource: "configured",
        }),
      );
      await agent.stop();
    } finally {
      globalThis.fetch = previousFetch;
      await agent.stop().catch(() => undefined);
    }
  });

  it("validates custom provider capabilities and voices at agent creation", () => {
    expect(() =>
      createLifecycleHarness({
        models: { ttsVoice: "voice-b" },
        ttsCapabilities: { ...CAPABILITIES, voices: ["voice-a"] },
      }),
    ).toThrow(/lifecycle-tts does not support voice voice-b/);

    expect(() =>
      createLifecycleHarness({
        ttsCapabilities: {
          ...CAPABILITIES,
          cancellation: { ...CAPABILITIES.cancellation, request: false },
        },
      }),
    ).toThrow(/cancellation\.unsupported/);
  });

  it("rejects malformed custom provider capabilities as configuration errors", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: {
            name: "broken-telephony",
            kind: "telephony",
            version: "1.0.0",
            capabilities: {},
            async dial() {
              throw new Error("not used");
            },
            async accept() {
              throw new Error("not used");
            },
            async hangup() {},
          } as never,
          stt: { provider: "deepgram", apiKey: "test" },
          llm: { provider: "openai", apiKey: "test" },
          tts: { provider: "cartesia", apiKey: "test", voiceId: "test" },
        },
      }),
    ).toThrow(/telephony provider capabilities are malformed/);

    expect(() =>
      createLifecycleHarness({
        ttsCapabilities: { ...CAPABILITIES, timestamps: "false" as never },
      }),
    ).toThrow(/tts provider capabilities are malformed/);

    expect(() =>
      createLifecycleHarness({
        ttsProvider: {
          name: "malformed-model-source-tts",
          kind: "tts",
          version: "1.0.0",
          capabilities: CAPABILITIES,
          configuredModelSource: "guessed" as never,
          async synthesize() {
            throw new Error("not used");
          },
        },
      }),
    ).toThrow(/configuredModelSource is malformed/);
  });

  it("rejects a malformed call handle before starting the runtime", async () => {
    const agent = createVoiceAgent({
      prompt: "Answer appointment questions.",
      providers: {
        telephony: {
          name: "fake-telephony",
          kind: "telephony",
          version: "1.0.0",
          capabilities: CAPABILITIES,
          async dial() {
            throw new Error("not used");
          },
          async accept() {
            throw new Error("not used");
          },
          async hangup() {},
        },
        stt: {
          name: "fake-stt",
          kind: "stt",
          version: "1.0.0",
          capabilities: CAPABILITIES,
          async open() {
            throw new Error("not used");
          },
        },
        llm: {
          name: "fake-llm",
          kind: "llm",
          version: "1.0.0",
          capabilities: CAPABILITIES,
          async complete() {
            throw new Error("not used");
          },
        },
        tts: {
          name: "fake-tts",
          kind: "tts",
          version: "1.0.0",
          capabilities: CAPABILITIES,
          async synthesize() {
            throw new Error("not used");
          },
        },
      },
    });

    await expect(
      agent.start({ callHandle: {} as CallHandle, channel: "simulated" }),
    ).rejects.toThrow(/callHandle must include/);
  });

  it("rejects a non-callable optional endInput method during startup", async () => {
    const harness = createLifecycleHarness({
      callHandleFactory: (baseCallHandle) => ({
        ...baseCallHandle,
        endInput: "not callable" as never,
      }),
    });
    try {
      await expect(
        harness.agent.start({
          callHandle: harness.callHandle,
          channel: "simulated",
        }),
      ).rejects.toThrow(/optional endInput and remoteHangup must have valid shapes/);
    } finally {
      await harness.agent.stop();
    }
  });

  it("rejects malformed run options before starting a session", async () => {
    const harness = createLifecycleHarness();
    try {
      await expect(
        harness.agent.start({
          callHandle: harness.callHandle,
          channel: "invalid" as never,
        }),
      ).rejects.toThrow(/channel must be/);
      await expect(
        harness.agent.start({
          callHandle: harness.callHandle,
          signal: {} as AbortSignal,
        }),
      ).rejects.toThrow(/signal must be an AbortSignal/);
      await expect(
        harness.agent.start({
          callHandle: harness.callHandle,
          streamStallTimeoutMs: 0,
        }),
      ).rejects.toThrow(/streamStallTimeoutMs must be/);
      await expect(
        harness.agent.start({
          callHandle: async () => harness.callHandle,
          channel: "simulated",
        }),
      ).rejects.toThrow(/call is required when callHandle is a factory/);
    } finally {
      await harness.agent.stop();
    }
  });

  it("creates a call-handle factory with the authoritative runtime session", async () => {
    const harness = createLifecycleHarness();
    const timestamp = nowTimestamp();
    const call: Call = {
      id: harness.callHandle.callId,
      provider: "lifecycle-telephony",
      direction: "inbound",
      from: "caller",
      to: "voice-agent",
      status: "connected",
      mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
      createdAt: timestamp,
      startedAt: timestamp,
    };
    let factoryContext: VoiceAgentCallHandleContext | undefined;
    try {
      const session = await harness.agent.start({
        callHandle: async (context) => {
          factoryContext = context;
          return harness.callHandle;
        },
        call,
        channel: "simulated",
      });
      expect(factoryContext?.sessionId).toBe(session.sessionId);
      expect(factoryContext?.call).toEqual(call);
      expect(factoryContext?.call).not.toBe(call);
      expect(Object.isFrozen(factoryContext?.call)).toBe(true);
      expect(Object.isFrozen(factoryContext?.call.mediaTransport)).toBe(true);
      expect(factoryContext?.channel).toBe("simulated");

      const observed = collectVoiceEvents(session.run);
      harness.inbound.push(streamStartedEvent(factoryContext!.sessionId));
      await harness.sttOpened;
      harness.inbound.close();
      await expect(session.run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
      const events = await observed;
      expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "remote_hangup" });
    } finally {
      await harness.agent.stop();
    }
  });

  it("persists per-session variables and application context", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const harness = createLifecycleHarness({ runtime: { durableStore } });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
        variables: { caseId: "case-123" },
        metadata: { source: "release-test" },
        memoryUserId: "user-123" as never,
        organizationId: "org-123" as never,
        workflowId: "workflow-123" as never,
      });
      const run = session.run;
      void run.catch(() => undefined);
      const stored = await durableStore.sessions.get(session.sessionId);
      expect(stored?.session).toMatchObject({
        state: { variables: { caseId: "case-123" } },
        metadata: {
          source: "release-test",
          memoryUserId: "user-123",
          organizationId: "org-123",
          workflowId: "workflow-123",
        },
      });

      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      harness.inbound.close();
      await expect(run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
    } finally {
      await harness.agent.stop();
    }
  });

  it("validates every call status branch before accepting the handle", async () => {
    const timestamp = nowTimestamp();
    const base = {
      id: "lifecycle-call" as CallId,
      provider: "lifecycle-telephony",
      direction: "inbound" as const,
      from: "caller",
      to: "voice-agent",
      mediaTransport: { kind: "websocket" as const, format: PCM16_16K_MONO },
      createdAt: timestamp,
    };
    const validCalls = [
      { ...base, status: "created" as const },
      { ...base, status: "ringing" as const },
      { ...base, status: "connected" as const, startedAt: timestamp },
      { ...base, status: "active" as const, startedAt: timestamp },
      { ...base, status: "held" as const, startedAt: timestamp },
      { ...base, status: "ended" as const, startedAt: timestamp, endedAt: timestamp },
      {
        ...base,
        status: "failed" as const,
        endedAt: timestamp,
        error: {
          name: "ProviderError" as const,
          code: "provider.upstream_failed",
          category: "provider" as const,
          message: "upstream failed",
          retriable: true,
        },
      },
    ];
    for (const call of validCalls) {
      const harness = createLifecycleHarness();
      try {
        const session = await harness.agent.start({
          callHandle: harness.callHandle,
          call,
          channel: "simulated",
        });
        await harness.agent.stop();
        expect(session.sessionId).toBeTruthy();
      } finally {
        await harness.agent.stop();
      }
    }

    const malformedCalls = [
      { ...base, provider: 42 },
      { ...base, direction: "sideways" },
      { ...base, status: "unknown" },
      {
        ...base,
        mediaTransport: { kind: "websocket", format: { ...PCM16_16K_MONO, channels: 3 } },
      },
      { ...base, status: "connected", startedAt: undefined },
      { ...base, status: "ended", startedAt: timestamp },
      { ...base, status: "failed", endedAt: timestamp },
    ];
    for (const call of malformedCalls) {
      const nextHarness = createLifecycleHarness();
      await expect(
        nextHarness.agent.start({
          callHandle: nextHarness.callHandle,
          call: call as never,
          channel: "simulated",
        }),
      ).rejects.toMatchObject({ code: "voice_runtime.invalid_call" });
      expect(nextHarness.closeReasons).toEqual([]);
      await nextHarness.agent.stop();
    }
  });

  it("passes an immutable sanitized call snapshot across the factory boundary", async () => {
    const harness = createLifecycleHarness();
    const timestamp = nowTimestamp();
    const metadata = { nested: { requestId: "request-1" } };
    const call: Call = {
      id: harness.callHandle.callId,
      provider: "lifecycle-telephony",
      direction: "inbound",
      from: "caller",
      to: "voice-agent",
      status: "connected",
      mediaTransport: {
        kind: "websocket",
        format: PCM16_16K_MONO,
        metadata: { transport: "test" },
      },
      metadata,
      createdAt: timestamp,
      startedAt: timestamp,
      ignoredExtension: "not forwarded",
    } as Call & { readonly ignoredExtension: string };
    let snapshot: VoiceAgentCallHandleContext["call"] | undefined;
    try {
      const session = await harness.agent.start({
        call: call as Call,
        callHandle: (context) => {
          snapshot = context.call;
          (metadata.nested as { requestId: string }).requestId = "changed-after-copy";
          return harness.callHandle;
        },
        channel: "simulated",
      });
      expect(snapshot).toBeDefined();
      expect(snapshot).not.toBe(call);
      expect(snapshot).toMatchObject({
        id: call.id,
        metadata: { nested: { requestId: "request-1" } },
        mediaTransport: { metadata: { transport: "test" } },
      });
      expect("ignoredExtension" in snapshot!).toBe(false);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot!.metadata)).toBe(true);
      expect(Object.isFrozen(snapshot!.metadata!.nested)).toBe(true);
      expect(Object.isFrozen(snapshot!.mediaTransport)).toBe(true);
      expect(Object.isFrozen(snapshot!.mediaTransport.metadata)).toBe(true);
      await harness.inbound.close();
      await expect(session.run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
    } finally {
      await harness.agent.stop();
    }
  });

  it("rejects hostile call descriptors, cycles, and bounded-value violations", async () => {
    const makeCall = (harness: LifecycleHarness): Call => ({
      id: harness.callHandle.callId,
      provider: "lifecycle-telephony",
      direction: "inbound",
      from: "caller",
      to: "voice-agent",
      status: "connected",
      mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
      createdAt: nowTimestamp(),
      startedAt: nowTimestamp(),
    });
    const cases: Array<(call: Call) => unknown> = [
      (call) => {
        Object.defineProperty(call, "provider", {
          configurable: true,
          get() {
            throw new Error("getter must not run");
          },
        });
        return call;
      },
      (call) => {
        const metadata: { self?: unknown } = {};
        metadata.self = metadata;
        return { ...call, metadata };
      },
      (call) => ({ ...call, from: "🙂".repeat(2049) }),
      (call) => ({
        ...call,
        metadata: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`field${index}`, "x".repeat(4096)]),
        ),
      }),
      (call) => ({
        ...call,
        mediaTransport: { kind: "websocket", format: { ...PCM16_16K_MONO, encoding: "mulaw" } },
      }),
    ];
    for (const mutate of cases) {
      const harness = createLifecycleHarness();
      const call = mutate(makeCall(harness));
      await expect(
        harness.agent.start({ callHandle: harness.callHandle, call: call as never }),
      ).rejects.toMatchObject({ code: "voice_runtime.invalid_call" });
      expect(harness.closeReasons).toEqual([]);
      await harness.agent.stop();
    }

    const proxyHarness = createLifecycleHarness();
    const proxy = new Proxy(makeCall(proxyHarness), {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    });
    await expect(
      proxyHarness.agent.start({ callHandle: proxyHarness.callHandle, call: proxy }),
    ).rejects.toMatchObject({ code: "voice_runtime.invalid_call" });
    await proxyHarness.agent.stop();
  });

  it("rejects a custom provider missing its required operation", () => {
    expect(() =>
      createVoiceAgent({
        prompt: "Answer appointment questions.",
        providers: {
          telephony: {
            name: "broken-telephony",
            kind: "telephony",
            version: "1.0.0",
            capabilities: CAPABILITIES,
            async accept() {
              throw new Error("not used");
            },
            async hangup() {},
          } as never,
          stt: { provider: "deepgram", apiKey: "test" },
          llm: { provider: "openai", apiKey: "test" },
          tts: { provider: "cartesia", apiKey: "test", voiceId: "test" },
        },
      }),
    ).toThrow(/telephony provider must implement dial/);
  });

  it("reports a remote transport end as the terminal call event", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const observed = collectVoiceEvents(session.run);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      harness.inbound.close();

      await expect(session.run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
      const events = await observed;
      expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "remote_hangup" });
    } finally {
      await harness.agent.stop();
    }
  });

  it("cancels a running session through the public AbortSignal", async () => {
    const harness = createLifecycleHarness();
    const controller = new AbortController();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
        signal: controller.signal,
      });
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      controller.abort();

      await expect(run).rejects.toMatchObject({ category: "cancelled" });
      expect(harness.closeReasons).toEqual(["cancelled"]);
      await expect(session.finalSession).resolves.toMatchObject({
        status: "cancelled",
        cancelReason: "caller_hangup",
        terminalSource: "caller_abort",
      });
    } finally {
      await harness.agent.stop();
    }
  });

  it("stops and finalizes through the public session handle", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;

      await session.stop();
      await expect(run).rejects.toMatchObject({ category: "cancelled" });
      expect(harness.closeReasons).toEqual(["cancelled"]);
      await expect(session.finalSession).resolves.toMatchObject({
        id: session.sessionId,
        callId: harness.callHandle.callId,
        status: "cancelled",
        terminalSource: "operator_stop",
      });
      await expect(session.stop()).resolves.toBeUndefined();
    } finally {
      await harness.agent.stop();
    }
  });

  it("finalizes cleanly through a real WebClientAudioCallHandle after stop", async () => {
    const harness = createLifecycleHarness();
    const server = new WebSocketServer({ port: 0 });
    let resolveServerSocket!: (socket: WebSocket) => void;
    const serverSocketPromise = new Promise<WebSocket>((resolve) => {
      resolveServerSocket = resolve;
    });
    server.once("connection", resolveServerSocket);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected WebSocket address");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    let sessionEndedResolve!: () => void;
    const sessionEnded = new Promise<void>((resolve) => {
      sessionEndedResolve = resolve;
    });
    client.on("message", (raw) => {
      try {
        if ((JSON.parse(raw.toString()) as { type?: string }).type === "session.ended") {
          sessionEndedResolve();
        }
      } catch {}
    });
    let session: Awaited<ReturnType<typeof harness.agent.start>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      const timestamp = nowTimestamp();
      const call: Call = {
        id: "real_web_audio_call" as CallId,
        provider: "web-client-audio",
        direction: "inbound",
        from: "browser",
        to: "agent",
        status: "connected",
        mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
        createdAt: timestamp,
        startedAt: timestamp,
      };
      session = await harness.agent.start({
        call,
        channel: "web_audio",
        callHandle: async ({ sessionId }) =>
          new WebClientAudioCallHandle({
            socket: await serverSocketPromise,
            callId: call.id,
            sessionId,
          }),
      });
      const run = session.run;
      void run.catch(() => undefined);
      client.send(
        JSON.stringify({
          type: "session.start",
          protocolVersion: 1,
          mode: "continuous",
          clientPlatform: "test",
          audioFormat: PCM16_16K_MONO,
        }),
      );
      await harness.sttOpened;

      await session.stop();
      await sessionEnded;
      await expect(run).rejects.toMatchObject({ category: "cancelled" });
      await expect(session.finalSession).resolves.toMatchObject({ status: "cancelled" });
      await expect(harness.agent.healthCheck()).resolves.toMatchObject({ ok: true });
    } finally {
      client.terminate();
      await session?.stop().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.agent.stop();
    }
  });

  it("completes and finalizes through the public session handle", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const inputEndReasons: string[] = [];
      harness.callHandle.endInput = async (reason) => {
        inputEndReasons.push(reason);
        harness.inbound.push(streamEndedEvent(session.sessionId));
      };
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;

      const completing = session.complete();
      expect(session.complete()).toBe(completing);
      await expect(completing).resolves.toMatchObject({
        id: session.sessionId,
        callId: harness.callHandle.callId,
        status: "completed",
        terminalSource: "normal_completion",
      });
      await expect(run).resolves.toMatchObject({
        terminalReason: "completed",
        terminalSource: "normal_completion",
      });
      expect(inputEndReasons).toEqual(["completed"]);
      expect(harness.closeReasons).toEqual(["completed"]);
      await expect(session.finalSession).resolves.toMatchObject({ status: "completed" });
    } finally {
      await harness.agent.stop();
    }
  });

  it("lets a concurrent stop determine the persisted and final transport reason", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const inputEndReasons: string[] = [];
      let resolveInputEndStarted!: () => void;
      const inputEndStarted = new Promise<void>((resolve) => {
        resolveInputEndStarted = resolve;
      });
      harness.callHandle.endInput = async (reason) => {
        inputEndReasons.push(reason);
        resolveInputEndStarted();
        await new Promise<void>(() => undefined);
      };
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;

      const completing = session.complete();
      await inputEndStarted;
      const stopping = session.stop();
      const [terminal] = await Promise.all([completing, stopping]);
      expect(terminal).toMatchObject({ status: "cancelled", terminalSource: "operator_stop" });
      await expect(run).rejects.toMatchObject({ category: "cancelled" });
      expect(inputEndReasons).toEqual(["completed"]);
      expect(harness.closeReasons).toEqual(["cancelled"]);
      await expect(session.finalSession).resolves.toMatchObject({
        status: "cancelled",
        terminalSource: "operator_stop",
      });
    } finally {
      await harness.agent.stop();
    }
  });

  it("does not end transport input when stop wins before completion starts it", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      let inputEndCalls = 0;
      harness.callHandle.endInput = async () => {
        inputEndCalls += 1;
      };
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;

      const completing = session.complete();
      const stopping = session.stop();
      const [terminal] = await Promise.all([completing, stopping]);

      expect(terminal).toMatchObject({ status: "cancelled", terminalSource: "operator_stop" });
      await expect(run).rejects.toMatchObject({ category: "cancelled" });
      expect(inputEndCalls).toBe(0);
      expect(harness.closeReasons).toEqual(["cancelled"]);
    } finally {
      await harness.agent.stop();
    }
  });

  it("fails completion with a persisted timeout when transport input shutdown stalls", async () => {
    vi.useFakeTimers();
    const harness = createLifecycleHarness();
    let resolveInputEndStarted!: () => void;
    const inputEndStarted = new Promise<void>((resolve) => {
      resolveInputEndStarted = resolve;
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      harness.callHandle.endInput = async () => {
        resolveInputEndStarted();
        await new Promise<void>(() => undefined);
      };
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;

      const completing = session.complete();
      await inputEndStarted;

      const completionResult = expect(completing).resolves.toMatchObject({
        status: "failed",
        terminalSource: "run_timeout",
        error: { code: "voice_runtime.end_input_timeout" },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await completionResult;
      await expect(run).rejects.toMatchObject({
        category: "timeout",
        code: "voice_runtime.end_input_timeout",
      });
      expect(harness.closeReasons).toEqual(["timeout"]);
    } finally {
      vi.useRealTimers();
      await harness.agent.stop();
    }
  }, 10_000);

  it("records remote hangup while final output is awaiting playout after complete", async () => {
    let resolveRemoteHangup!: () => void;
    const remoteHangup = new Promise<void>((resolve) => {
      resolveRemoteHangup = resolve;
    });
    let sessionId!: SessionId;
    let resolvePlayoutStarted!: () => void;
    const playoutStarted = new Promise<void>((resolve) => {
      resolvePlayoutStarted = resolve;
    });
    let harness!: LifecycleHarness;
    harness = createLifecycleHarness({
      ttsConfiguredModel: "lifecycle-implicit-model",
      ttsConfiguredModelSource: "not_reported",
      completeLlm: async (request) => {
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: "hangup-llm-started" as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "lifecycle-llm",
          timestamp,
          model: request.model,
        });
        events.push({
          id: "hangup-llm-completed" as ProviderEventId,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "lifecycle-llm",
          timestamp,
          text: "Your request is complete.",
          toolCalls: [],
        });
        events.close();
        return { events, async cancel() {} };
      },
      synthesizeTts: async (request) => {
        const events = new AsyncQueue<TtsEvent>();
        const audio = createMediaEvent({
          id: "hangup-tts-audio" as never,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "lifecycle-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 20,
            frameCount: 320,
            bytes: new Uint8Array(640),
          },
        });
        events.push(audio as OutputAudioChunk);
        events.push(
          createMediaEvent({
            id: "hangup-tts-committed" as never,
            type: "media.audio.committed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            direction: "output",
            timestamp: nowTimestamp(),
            monotonicOffsetMs: 20,
            provider: "lifecycle-tts",
            durationMs: 20,
            frameCount: 320,
            sequenceRange: [1, 1],
            chunkIds: [audio.id],
          }),
        );
        events.close();
        return { events, async cancel() {} };
      },
      callHandleFactory: (baseCallHandle) => ({
        ...baseCallHandle,
        remoteHangup,
        async endInput(reason) {
          expect(reason).toBe("completed");
          harness.inbound.push(streamEndedEvent(sessionId));
        },
        async confirmPlayout() {
          resolvePlayoutStarted();
          await remoteHangup;
          return false;
        },
      }),
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      sessionId = session.sessionId;
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      const timestamp = nowTimestamp();
      harness.transcripts.push({
        id: "hangup-stt-final" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 1,
        provider: "lifecycle-stt",
        text: "Please complete this request.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      harness.transcripts.push({
        id: "hangup-stt-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 2,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp,
      });

      const completing = session.complete();
      await playoutStarted;
      resolveRemoteHangup();

      await expect(completing).resolves.toMatchObject({
        status: "cancelled",
        terminalSource: "remote_transport",
      });
      await expect(run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
      expect(harness.closeReasons).toEqual(["cancelled"]);
      const finalSession = await session.finalSession;
      expect(finalSession).toMatchObject({
        status: "cancelled",
        cancelReason: "transport_lost",
        terminalSource: "remote_transport",
      });
      expect(finalSession.usage.entries).toContainEqual(
        expect.objectContaining({
          kind: "tts",
          provider: "lifecycle-tts",
          model: "lifecycle-implicit-model",
          modelSource: "not_reported",
        }),
      );
    } finally {
      resolveRemoteHangup();
      await harness.agent.stop();
    }
  });

  it("records a remote hangup while the run is still waiting for caller media", async () => {
    let resolveRemoteHangup!: () => void;
    const remoteHangup = new Promise<void>((resolve) => {
      resolveRemoteHangup = resolve;
    });
    const harness = createLifecycleHarness({
      callHandleFactory: (baseCallHandle) => ({ ...baseCallHandle, remoteHangup }),
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const run = session.run;
      void run.catch(() => undefined);
      await harness.sttOpened;

      resolveRemoteHangup();

      await expect(run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
      await expect(session.finalSession).resolves.toMatchObject({
        status: "cancelled",
        cancelReason: "transport_lost",
        terminalSource: "remote_transport",
      });
      expect(harness.closeReasons).toEqual(["cancelled"]);
    } finally {
      resolveRemoteHangup();
      await harness.agent.stop();
    }
  });

  it("finalizes a remote hangup before any consumer claims the run", async () => {
    let resolveRemoteHangup!: () => void;
    const remoteHangup = new Promise<void>((resolve) => {
      resolveRemoteHangup = resolve;
    });
    const harness = createLifecycleHarness({
      callHandleFactory: (baseCallHandle) => ({ ...baseCallHandle, remoteHangup }),
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });

      resolveRemoteHangup();

      await expect(session.finalSession).resolves.toMatchObject({
        status: "cancelled",
        cancelReason: "transport_lost",
        terminalSource: "remote_transport",
      });
      await expect(session.complete()).resolves.toMatchObject({
        status: "cancelled",
        cancelReason: "transport_lost",
        terminalSource: "remote_transport",
      });
      await expect(session.run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
      expect(harness.closeReasons).toEqual(["cancelled"]);
    } finally {
      resolveRemoteHangup();
      await harness.agent.stop();
    }
  });

  it("finalizes a caller abort after start returns but before the run is claimed", async () => {
    const events: SessionEndEvent[] = [];
    const traces: RuntimeSessionTrace[] = [];
    const controller = new AbortController();
    const harness = createLifecycleHarness({
      runtime: {
        onSessionEnd: (event) => {
          events.push(event);
        },
        sessionMetricsRecorder: {
          record() {},
          onTurn() {},
          onSessionTrace: (trace) => traces.push(trace),
        },
      },
    });

    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
        signal: controller.signal,
      });
      controller.abort();

      const finalizationStatus = await Promise.race([
        session.finalSession.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
      ]);
      expect(finalizationStatus).toBe("settled");

      const finalSession = await session.finalSession;

      expect(finalSession).toMatchObject({
        status: "cancelled",
        cancelReason: "caller_hangup",
        terminalSource: "caller_abort",
      });
      expect(harness.closeReasons).toEqual(["cancelled"]);
      expect(events).toHaveLength(1);
      expect(traces).toHaveLength(1);
      expect(finalSession.usage).toEqual({ entries: [] });
      expect(events[0]?.usage).toBe(finalSession.usage);
      expect(traces[0]?.usage).toBe(events[0]?.usage);
    } finally {
      await harness.agent.stop();
    }
  });

  it("finalizes lease loss after start returns but before the run is claimed", async () => {
    vi.useFakeTimers();
    const durableStore = createInMemoryDurableRuntimeStore();
    vi.spyOn(durableStore.leases, "renew").mockResolvedValue(null);
    const events: SessionEndEvent[] = [];
    const traces: RuntimeSessionTrace[] = [];
    const harness = createLifecycleHarness({
      runtime: {
        durableStore,
        durablePolicy: { leaseHeartbeatMs: 1 },
        onSessionEnd: (event) => {
          events.push(event);
        },
        sessionMetricsRecorder: {
          record() {},
          onTurn() {},
          onSessionTrace: (trace) => traces.push(trace),
        },
      },
    });

    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(events).toHaveLength(1);
      const finalSession = await session.finalSession;

      expect(finalSession).toMatchObject({
        status: "cancelled",
        cancelReason: "transport_lost",
        terminalSource: "remote_transport",
      });
      expect(harness.closeReasons).toEqual(["cancelled"]);
      expect(events).toHaveLength(1);
      expect(traces).toHaveLength(1);
      expect(finalSession.usage).toEqual({ entries: [] });
      expect(events[0]?.usage).toBe(finalSession.usage);
      expect(traces[0]?.usage).toBe(events[0]?.usage);
    } finally {
      await harness.agent.stop();
      vi.useRealTimers();
    }
  });

  it("signals an empty deferred-session drain after finalSession settles", async () => {
    let resolveDrain!: (context: AudioTapDrainContext) => void;
    const drained = new Promise<AudioTapDrainContext>((resolve) => {
      resolveDrain = resolve;
    });
    let finalSessionSettled = false;
    let drainObservedFinalSession = false;
    class Recorder {
      drainedSessionId: SessionId | undefined;

      onFrame(): void {}

      onDrained(context: AudioTapDrainContext): void {
        this.drainedSessionId = context.sessionId;
        drainObservedFinalSession = finalSessionSettled;
        resolveDrain(context);
      }
    }
    const recorder = new Recorder();
    const harness = createLifecycleHarness({ audioTap: recorder });

    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      void session.finalSession.then(() => {
        finalSessionSettled = true;
      });

      await session.stop();
      await expect(session.finalSession).resolves.toMatchObject({
        id: session.sessionId,
        status: "cancelled",
      });
      const context = await drained;

      expect(context.sessionId).toBe(session.sessionId);
      expect(recorder.drainedSessionId).toBe(session.sessionId);
      expect(context.summary).toMatchObject({
        enabled: true,
        droppedFrames: 0,
        droppedEvents: 0,
        callbackErrors: 0,
      });
      expect(drainObservedFinalSession).toBe(true);
    } finally {
      await harness.agent.stop();
    }
  });

  it("cancels the managed session when event iteration is broken", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const iteration = (async () => {
        for await (const event of session.run) {
          if (event.kind === "turn_started") break;
        }
      })();
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      const timestamp = nowTimestamp();
      harness.transcripts.push({
        id: "break-transcript" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 1,
        provider: "lifecycle-stt",
        text: "Stop streaming events.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      harness.transcripts.push({
        id: "break-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 2,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp,
      });
      await iteration;
      await expect(session.run).rejects.toMatchObject({ category: "cancelled" });
      expect(harness.closeReasons).toEqual(["cancelled"]);
    } finally {
      await harness.agent.stop();
    }
  });

  it("drains active runs before stopping the managed runtime", async () => {
    const harness = createLifecycleHarness();
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;

      await harness.agent.stop();
      await expect(run).rejects.toMatchObject({ category: "cancelled" });
      expect(harness.closeReasons).toEqual(["cancelled"]);
      await expect(harness.agent.stop()).resolves.toBeUndefined();
      await expect(
        harness.agent.start({ callHandle: harness.callHandle, channel: "simulated" }),
      ).rejects.toThrow(/Voice agent has been stopped/);
    } finally {
      await harness.agent.stop();
    }
  });

  it("normalizes provider startup failures and still ends the call", async () => {
    const harness = createLifecycleHarness({
      openStt: async () => {
        throw new Error("STT unavailable");
      },
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const observed = collectVoiceEvents(session.run);

      await expect(session.run).rejects.toMatchObject({
        name: "InternalError",
        code: "stt.open_failed",
      });
      const events = await observed;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "error",
            error: expect.objectContaining({ code: "stt.open_failed" }),
          }),
          expect.objectContaining({ kind: "call_ended", reason: "failed" }),
        ]),
      );
      expect(harness.closeReasons).toEqual(["error"]);
    } finally {
      await harness.agent.stop();
    }
  });

  it("keeps cleanup failure visible instead of reporting a false successful run", async () => {
    const harness = createLifecycleHarness({
      closeCall: async () => {
        throw new Error("call transport refused close");
      },
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const observed = collectVoiceEvents(session.run);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      harness.inbound.close();

      await expect(session.run).rejects.toMatchObject({
        code: "voice_runtime.finalization_failed",
        metadata: {
          degraded: true,
          callClosed: false,
          sessionEnded: true,
          cleanupErrors: [
            expect.objectContaining({
              stage: "call.close",
            }),
          ],
        },
      });
      const events = await observed;
      expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "remote_hangup" });
      await expect(session.finalSession).resolves.toMatchObject({
        id: session.sessionId,
        status: "cancelled",
        terminalSource: "remote_transport",
      });
      await expect(harness.agent.healthCheck()).resolves.toMatchObject({
        ok: false,
        checks: {
          cleanup: {
            details: {
              degraded: true,
            },
          },
        },
      });
    } finally {
      await harness.agent.stop();
    }
  });

  it("rejects finalSession at the shutdown deadline when an in-flight memory write ignores abort", async () => {
    vi.useFakeTimers();
    let resolveMemoryWriteStarted!: () => void;
    const memoryWriteStarted = new Promise<void>((resolve) => {
      resolveMemoryWriteStarted = resolve;
    });
    const memory: Memory = {
      name: "hanging-memory",
      version: "1.0.0",
      capabilities: {
        search: { exact: true, vector: false, hybrid: false },
        write: { explicit: true, implicit: true, sessionQuota: true },
        retention: { ttl: true, policy: false },
        purge: { perEntry: true, perScope: true, tenant: true },
      },
      async get() {
        return null;
      },
      async put<T>(): Promise<MemoryEntry<T>> {
        resolveMemoryWriteStarted();
        return await new Promise<MemoryEntry<T>>(() => undefined);
      },
      async list() {
        return [];
      },
      async delete() {
        return false;
      },
      async deleteAll() {
        return 0;
      },
      async deleteForUser() {
        return 0;
      },
    };
    const harness = createLifecycleHarness({
      runtime: { ...TEST_RUNTIME_DEFAULTS, memory },
      memoryPolicy: { enabled: true, scopes: ["session"] },
      completeLlm: async (request) => {
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: "hang-memory-llm-started" as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "lifecycle-llm",
          timestamp,
          model: request.model,
        });
        events.push({
          id: "hang-memory-llm-completed" as ProviderEventId,
          type: "llm.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 2,
          provider: "lifecycle-llm",
          timestamp,
          text: "",
          toolCalls: [],
        });
        events.close();
        return { events, async cancel() {} };
      },
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const run = session.run;
      void run.catch(() => undefined);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      const timestamp = nowTimestamp();
      harness.transcripts.push({
        id: "hang-memory-stt-final" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 1,
        provider: "lifecycle-stt",
        text: "Remember this interaction.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      harness.transcripts.push({
        id: "hang-memory-stt-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 2,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp,
      });
      await memoryWriteStarted;

      const finalSession = expect(session.finalSession).rejects.toMatchObject({
        code: "voice_runtime.shutdown_failed",
        metadata: {
          degraded: true,
          timedOut: true,
          lateCleanupPending: true,
          finalizationStarted: false,
        },
      });
      const callStop = expect(session.stop()).rejects.toMatchObject({
        code: "voice_runtime.shutdown_failed",
        metadata: { timedOut: true, lateCleanupPending: true },
      });
      const shutdown = expect(harness.agent.stop()).rejects.toMatchObject({
        code: "voice_runtime.shutdown_failed",
        metadata: { timedOut: true, lateCleanupPending: true },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([callStop, shutdown, finalSession]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("executes a configured tool through the public managed pipeline", async () => {
    let executionCount = 0;
    const tool = defineTool<{ readonly date: string }, { readonly booked: boolean }>({
      id: "book_appointment",
      name: "book_appointment",
      description: "Books an appointment for a requested date.",
      inputSchema: { type: "object", required: ["date"] },
      outputSchema: { type: "object", required: ["booked"] },
      async execute(input) {
        executionCount += 1;
        expect(input.date).toBe("tomorrow");
        return { booked: true };
      },
    });
    let completionCount = 0;
    const harness = createLifecycleHarness({
      tools: [tool],
      completeLlm: async (request) => {
        completionCount += 1;
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        events.push({
          id: `tool-started-${completionCount}` as ProviderEventId,
          type: "llm.started",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          provider: "lifecycle-llm",
          timestamp,
          model: request.model,
        });
        if (completionCount === 1) {
          const call = {
            callRef: "book-appointment-call",
            toolName: "book_appointment" as never,
            input: { date: "tomorrow" },
          };
          events.push({
            id: "tool-call" as ProviderEventId,
            type: "llm.tool_call",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            provider: "lifecycle-llm",
            timestamp,
            call,
          });
          events.push({
            id: "tool-completed" as ProviderEventId,
            type: "llm.completed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 3,
            provider: "lifecycle-llm",
            timestamp,
            text: "",
            toolCalls: [call],
          });
        } else {
          events.push({
            id: "final-completed" as ProviderEventId,
            type: "llm.completed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            provider: "lifecycle-llm",
            timestamp,
            text: "Your appointment is booked.",
            toolCalls: [],
          });
        }
        events.close();
        return { events, async cancel() {} };
      },
      synthesizeTts: async (request) => {
        const events = new AsyncQueue<TtsEvent>();
        const audio = createMediaEvent({
          id: "tool-audio" as never,
          type: "media.audio.chunk",
          sessionId: request.sessionId,
          turnId: request.turnId,
          sequence: 1,
          direction: "output",
          timestamp: nowTimestamp(),
          monotonicOffsetMs: 0,
          provider: "lifecycle-tts",
          audio: {
            format: PCM16_16K_MONO,
            durationMs: 20,
            frameCount: 320,
            bytes: new Uint8Array(640),
          },
        });
        events.push(audio as OutputAudioChunk);
        events.push(
          createMediaEvent({
            id: "tool-committed" as never,
            type: "media.audio.committed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            direction: "output",
            timestamp: nowTimestamp(),
            monotonicOffsetMs: 0,
            provider: "lifecycle-tts",
            durationMs: 20,
            frameCount: 320,
            sequenceRange: [1, 1],
            chunkIds: [audio.id],
          }),
        );
        events.close();
        return { events, async cancel() {} } satisfies TtsStream;
      },
    });
    try {
      const session = await harness.agent.start({
        callHandle: harness.callHandle,
        channel: "simulated",
      });
      const observed = collectVoiceEvents(session.run);
      harness.inbound.push(streamStartedEvent(session.sessionId));
      await harness.sttOpened;
      const timestamp = nowTimestamp();
      harness.transcripts.push({
        id: "tool-transcript" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 1,
        provider: "lifecycle-stt",
        text: "Book me an appointment for tomorrow.",
        startTimestamp: timestamp,
        endTimestamp: timestamp,
      });
      harness.transcripts.push({
        id: "tool-endpoint" as ProviderEventId,
        type: "stt.endpoint",
        direction: "input",
        sessionId: session.sessionId,
        sequence: 2,
        provider: "lifecycle-stt",
        reason: "provider",
        timestamp,
      });
      await harness.committed;
      harness.inbound.push(
        createMediaEvent({
          id: "tool-ended" as never,
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

      const [result, events] = await Promise.all([session.run, observed]);
      expect(result.turnsHandled).toBe(1);
      expect(executionCount).toBe(1);
      expect(completionCount).toBe(2);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "tool_call", toolName: "book_appointment" }),
          expect.objectContaining({
            kind: "tool_result",
            output: { booked: true },
            status: "succeeded",
          }),
        ]),
      );
      expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "completed" });
    } finally {
      await harness.agent.stop();
    }
  });
});

interface LifecycleHarness {
  readonly agent: ReturnType<typeof createVoiceAgent>;
  readonly callHandle: CallHandle;
  readonly inbound: AsyncQueue<InboundMediaEvent>;
  readonly transcripts: AsyncQueue<TranscriptEvent>;
  readonly sttOpened: Promise<void>;
  readonly committed: Promise<void>;
  readonly closeReasons: string[];
}

interface LifecycleHarnessOptions {
  readonly audioTap?: AudioTapOptions;
  readonly runtime?: RuntimeOptions;
  readonly models?: VoiceAgentModels;
  readonly ttsProvider?: TextToSpeechProvider;
  readonly providerCapabilitySnapshots?: readonly ProviderCapabilitySnapshot[];
  readonly ttsCapabilities?: ProviderCapabilities;
  readonly ttsConfiguredModel?: string;
  readonly ttsConfiguredModelSource?: "configured" | "not_reported";
  readonly closeCall?: (reason: Parameters<CallHandle["close"]>[0]) => Promise<void>;
  readonly openStt?: () => Promise<SttStream>;
  readonly completeLlm?: (
    request: Parameters<LLMProvider["complete"]>[0],
  ) => Promise<LlmCompletion>;
  readonly onSttCommit?: () => void;
  readonly synthesizeTts?: (request: TtsSynthesisRequest) => Promise<TtsStream>;
  readonly tools?: readonly ToolDefinition<any, any>[];
  readonly memoryPolicy?: AgentMemoryPolicy;
  readonly callHandleFactory?: (baseCallHandle: CallHandle) => CallHandle;
}

function createLifecycleHarness(options: LifecycleHarnessOptions = {}): LifecycleHarness {
  const inbound = new AsyncQueue<InboundMediaEvent>();
  const transcripts = new AsyncQueue<TranscriptEvent>();
  const closeReasons: string[] = [];
  let resolveSttOpened!: () => void;
  const sttOpened = new Promise<void>((resolve) => {
    resolveSttOpened = resolve;
  });
  let resolveCommitted!: () => void;
  const committed = new Promise<void>((resolve) => {
    resolveCommitted = resolve;
  });
  const sent: OutputMediaEvent[] = [];
  const baseCallHandle: CallHandle = {
    callId: "lifecycle-call" as CallId,
    events: inbound,
    async send(event) {
      sent.push(event);
      if (event.type === "media.audio.committed") resolveCommitted();
      return true;
    },
    async clear() {},
    async close(reason) {
      closeReasons.push(reason);
      await options.closeCall?.(reason);
      inbound.close();
    },
  };
  const callHandle = options.callHandleFactory?.(baseCallHandle) ?? baseCallHandle;
  const stt: SpeechToTextProvider = {
    name: "lifecycle-stt",
    kind: "stt",
    version: "1.0.0",
    capabilities: CAPABILITIES,
    async open() {
      if (options.openStt) return options.openStt();
      resolveSttOpened();
      return {
        events: transcripts,
        async sendAudio() {},
        async commit() {
          options.onSttCommit?.();
        },
        async close() {
          transcripts.close();
        },
      };
    },
  };
  const llm: LLMProvider = {
    name: "lifecycle-llm",
    kind: "llm",
    version: "1.0.0",
    capabilities: CAPABILITIES,
    async complete(request) {
      if (options.completeLlm) return options.completeLlm(request);
      throw new Error("LLM should not run in lifecycle tests");
    },
  };
  const tts: TextToSpeechProvider = options.ttsProvider ?? {
    name: "lifecycle-tts",
    kind: "tts",
    version: "1.0.0",
    capabilities: options.ttsCapabilities ?? CAPABILITIES,
    ...(options.ttsConfiguredModel !== undefined
      ? { configuredModel: options.ttsConfiguredModel }
      : {}),
    ...(options.ttsConfiguredModelSource !== undefined
      ? { configuredModelSource: options.ttsConfiguredModelSource }
      : {}),
    async synthesize(request) {
      if (options.synthesizeTts) return options.synthesizeTts(request);
      throw new Error("TTS should not run in lifecycle tests");
    },
  };
  const telephony: TelephonyProvider = {
    name: "lifecycle-telephony",
    kind: "telephony",
    version: "1.0.0",
    capabilities: CAPABILITIES,
    async dial() {
      throw new Error("dial should not run in lifecycle tests");
    },
    async accept() {
      throw new Error("accept should not run in lifecycle tests");
    },
    async hangup() {},
  };
  const runtime: RuntimeOptions = {
    ...TEST_RUNTIME_DEFAULTS,
    ...options.runtime,
    durablePolicy: {
      ...TEST_RUNTIME_DEFAULTS.durablePolicy,
      ...(options.runtime?.durablePolicy ?? {}),
    },
  };
  return {
    agent: createVoiceAgent({
      prompt: "Handle lifecycle tests.",
      ...(options.models ? { models: options.models } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.memoryPolicy ? { memoryPolicy: options.memoryPolicy } : {}),
      ...(options.audioTap ? { audioTap: options.audioTap } : {}),
      ...(options.providerCapabilitySnapshots !== undefined
        ? { providerCapabilitySnapshots: options.providerCapabilitySnapshots }
        : {}),
      runtime,
      providers: { telephony, stt, llm, tts },
    }),
    callHandle,
    inbound,
    transcripts,
    sttOpened,
    committed,
    closeReasons,
  };
}

function streamStartedEvent(sessionId: SessionId): InboundMediaEvent {
  return createMediaEvent({
    id: "lifecycle-started" as never,
    type: "media.stream.started",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    format: PCM16_16K_MONO,
  });
}

function streamEndedEvent(sessionId: SessionId): InboundMediaEvent {
  return createMediaEvent({
    id: "lifecycle-ended" as never,
    type: "media.stream.ended",
    sessionId,
    sequence: 2,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 20,
    reason: "completed",
    durationMs: 20,
  });
}

async function collectVoiceEvents(run: AsyncIterable<VoiceEvent>): Promise<VoiceEvent[]> {
  const events: VoiceEvent[] = [];
  try {
    for await (const event of run) events.push(event);
  } catch {}
  return events;
}
