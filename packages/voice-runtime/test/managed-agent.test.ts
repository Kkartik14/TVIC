import { describe, expect, it } from "vitest";

import {
  AsyncQueue,
  createMediaEvent,
  createInMemoryDurableRuntimeStore,
  createVoiceAgent,
  defineTool,
  nowTimestamp,
  PCM16_16K_MONO,
  type CallHandle,
  type CallId,
  type Call,
  type CreateVoiceAgentOptions,
  type InboundMediaEvent,
  type LLMProvider,
  type LlmCompletion,
  type LlmStreamEvent,
  type OutputAudioChunk,
  type OutputMediaEvent,
  type ProviderCapabilities,
  type ProviderEventId,
  type RuntimeOptions,
  type SessionId,
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
} from "../src/index.js";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

describe("managed voice agent", () => {
  it("runs the public prompt-first facade through the complete fake pipeline", async () => {
    const inbound = new AsyncQueue<InboundMediaEvent>();
    const transcripts = new AsyncQueue<TranscriptEvent>();
    let resolveSttOpen!: () => void;
    const sttOpen = new Promise<void>((resolve) => {
      resolveSttOpen = resolve;
    });
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
      capabilities: CAPABILITIES,
      async open(): Promise<SttStream> {
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
        });
        events.close();
        return { events, async cancel() {} };
      },
    };

    const tts: TextToSpeechProvider = {
      name: "fake-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async synthesize(request: TtsSynthesisRequest) {
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

    const agent = createVoiceAgent({
      prompt: "You schedule appointments for Dr. Kartik.",
      models: { stt: "fake-stt-model", llm: "fake-llm-model", tts: "fake-tts-model" },
      providers: { telephony, stt, llm, tts },
    });
    expect(agent.prompt).toBe("You schedule appointments for Dr. Kartik.");
    expect(agent.providers).toEqual({
      telephony: "fake-telephony",
      stt: "fake-stt",
      llm: "fake-llm",
      tts: "fake-tts",
    });

    const session = await agent.start({ callHandle, channel: "simulated" });
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
    expect(eventKinds).toContain("transcript_delta");
    expect(eventKinds).toContain("audio_output");
    expect(eventKinds.at(-1)).toBe("call_ended");
    expect(sent.length).toBeGreaterThan(0);
    expect(closeReasons).toEqual(["completed"]);

    await agent.stop();
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
          expect.objectContaining({ kind: "tool_result", output: { booked: true } }),
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
  readonly runtime?: RuntimeOptions;
  readonly models?: VoiceAgentModels;
  readonly ttsCapabilities?: ProviderCapabilities;
  readonly closeCall?: (reason: Parameters<CallHandle["close"]>[0]) => Promise<void>;
  readonly openStt?: () => Promise<SttStream>;
  readonly completeLlm?: (
    request: Parameters<LLMProvider["complete"]>[0],
  ) => Promise<LlmCompletion>;
  readonly synthesizeTts?: (request: TtsSynthesisRequest) => Promise<TtsStream>;
  readonly tools?: readonly ToolDefinition<any, any>[];
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
  const callHandle: CallHandle = {
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
        async commit() {},
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
  const tts: TextToSpeechProvider = {
    name: "lifecycle-tts",
    kind: "tts",
    version: "1.0.0",
    capabilities: options.ttsCapabilities ?? CAPABILITIES,
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
  return {
    agent: createVoiceAgent({
      prompt: "Handle lifecycle tests.",
      ...(options.models ? { models: options.models } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.runtime ? { runtime: options.runtime } : {}),
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

async function collectVoiceEvents(run: AsyncIterable<VoiceEvent>): Promise<VoiceEvent[]> {
  const events: VoiceEvent[] = [];
  try {
    for await (const event of run) events.push(event);
  } catch {
    // The managed Promise rejects for remote hangup, cancellation, and a raw
    // provider failure after the terminal event has already been delivered.
    // The fixture is interested in that ordered event prefix.
  }
  return events;
}
