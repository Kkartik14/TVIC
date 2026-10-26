import { describe, expect, it, vi } from "vitest";
import { providerError, TVIC_ERROR_CODES, TvicThrowableError } from "@tvic/core";
import {
  ELEVENLABS_CAPABILITY_FEATURES,
  createCartesiaTtsProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsProvider,
  createSarvamTtsProvider,
  createTtsFailoverProvider,
} from "@tvic/providers";

import {
  createProviderCapabilitySnapshot,
  createVoiceAgent,
  PCM16_16K_MONO,
  nowTimestamp,
  type Call,
  type LLMProvider,
  type CallHandle,
  type CallId,
  type ProviderCapabilities,
  type ProviderCapabilityFact,
  type SpeechToTextProvider,
  type TelephonyProvider,
  type TextToSpeechProvider,
} from "../src/index.js";

const capabilities = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

function providers(): {
  readonly telephony: TelephonyProvider;
  readonly stt: SpeechToTextProvider;
  readonly llm: LLMProvider;
  readonly tts: TextToSpeechProvider;
} {
  return {
    telephony: {
      name: "test-telephony",
      kind: "telephony",
      version: "1.0.0",
      capabilities,
      async dial() {
        throw new Error("not used");
      },
      async accept() {
        throw new Error("not used");
      },
      async hangup() {},
    },
    stt: {
      name: "test-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities,
      async open() {
        throw new Error("not used");
      },
    },
    llm: {
      name: "test-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities,
      async complete() {
        throw new Error("not used");
      },
    },
    tts: {
      name: "test-account-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: { ...capabilities, voiceSelection: "account_snapshot" },
      configuredModel: "model-a",
      configuredVoice: "voice-a",
      async synthesize() {
        throw new Error("not used");
      },
    },
  };
}

function withMappedAccountFallback(tts: TextToSpeechProvider): TextToSpeechProvider {
  return {
    ...tts,
    capabilities: {
      ...tts.capabilities,
      voiceSnapshotProviders: ["test-account-tts", "test-fallback-tts"],
      ttsVoiceMappings: [
        {
          requestedModel: "model-a",
          requestedVoice: "voice-a",
          provider: "test-fallback-tts",
          model: "fallback-model",
          voice: "voice-b",
        },
      ],
    },
  };
}

function voiceSnapshot(status: "supported" | "unsupported", validUntil: string, voice = "voice-a") {
  return selectedVoiceSnapshot("test-account-tts", "model-a", voice, status, validUntil);
}

function accountVoiceSnapshot(status: "supported" | "unsupported", validUntil: string) {
  const now = new Date();
  const fetchedAt = new Date(
    Math.min(now.getTime() - 1_000, Date.parse(validUntil) - 1_000),
  ).toISOString();
  return createProviderCapabilitySnapshot({
    provider: "test-account-tts",
    source: "https://provider.example/voices",
    fetchedAt,
    validUntil,
    facts: [
      {
        feature: "tts.voice.available",
        scope: "voice",
        voice: "voice-a",
        status,
      },
      {
        feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceCategory,
        scope: "voice",
        voice: "voice-a",
        status: "supported",
        value: "premade",
      },
    ],
  });
}

function selectedVoiceSnapshot(
  provider: string,
  model: string,
  voice: string,
  status: "supported" | "unsupported",
  validUntil: string,
) {
  const now = new Date();
  const fetchedAt = new Date(
    Math.min(now.getTime() - 1_000, Date.parse(validUntil) - 1_000),
  ).toISOString();
  return createProviderCapabilitySnapshot({
    provider,
    source: "https://provider.example/voices",
    fetchedAt,
    validUntil,
    facts: [
      {
        feature: "tts.voice.available",
        scope: "voice",
        model,
        voice,
        status,
      },
    ],
  });
}

function professionalVoiceSnapshot(
  value: boolean,
  validUntil = new Date(Date.now() + 60_000).toISOString(),
) {
  const fetchedAt = new Date(Date.now() - 1_000).toISOString();
  return createProviderCapabilitySnapshot({
    provider: "test-account-tts",
    source: "https://provider.example/voices",
    fetchedAt,
    validUntil,
    facts: [
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "model-a",
        voice: "voice-a",
        status: "supported",
      },
      {
        feature: "tts.voice.isPro",
        scope: "voice",
        status: "supported",
        voice: "voice-a",
        value,
      },
    ],
  });
}

function cartesiaVoiceClassSnapshot(isProfessional: boolean) {
  return createProviderCapabilitySnapshot({
    provider: "cartesia",
    source: "https://docs.cartesia.ai/api-reference/voices/get",
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    facts: [
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        voice: "voice-a",
        status: "supported",
      },
      {
        feature: "tts.voice.isPro",
        scope: "voice",
        status: "supported",
        voice: "voice-a",
        value: isProfessional,
      },
    ],
  });
}

function modelCapabilitySnapshot(
  availability: "supported" | "unsupported" | "unknown",
  textToSpeech: "supported" | "unsupported" | "unknown",
  validUntil = new Date(Date.now() + 60_000).toISOString(),
) {
  return createProviderCapabilitySnapshot({
    provider: "test-account-tts",
    source: "https://provider.example/models",
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    validUntil,
    facts: [
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "model-a",
        voice: "voice-a",
        status: "supported",
      },
      {
        feature: "tts.model.available",
        scope: "model",
        model: "model-a",
        status: availability,
      },
      {
        feature: "tts.model.canDoTextToSpeech",
        scope: "model",
        model: "model-a",
        status: textToSpeech,
        ...(textToSpeech !== "unknown" ? { value: textToSpeech === "supported" } : {}),
      },
    ],
  });
}

function elevenLabsVoiceSnapshot(normalization: "supported" | "unsupported") {
  return createProviderCapabilitySnapshot({
    provider: "elevenlabs",
    source: "https://provider.example/models",
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    facts: [
      {
        feature: "tts.model.available",
        scope: "model",
        model: "eleven_flash_v2_5",
        status: "supported",
      },
      {
        feature: "tts.model.canDoTextToSpeech",
        scope: "model",
        model: "eleven_flash_v2_5",
        status: "supported",
        value: true,
      },
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "eleven_flash_v2_5",
        voice: "voice-a",
        status: "supported",
      },
      {
        feature: "tts.normalization.forced",
        scope: "account",
        status: normalization,
      },
    ],
  });
}

function elevenLabsSnapshot(facts: readonly ProviderCapabilityFact[]) {
  return createProviderCapabilitySnapshot({
    provider: "elevenlabs",
    source: "https://provider.example/capabilities",
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    facts,
  });
}

function testCallHandle(): CallHandle {
  return {
    callId: "snapshot-test-call" as CallId,
    events: { async *[Symbol.asyncIterator]() {} },
    async send() {
      return true;
    },
    async clear() {},
    async close() {},
  };
}

function testCall(): Call {
  const timestamp = nowTimestamp();
  return {
    id: "snapshot-test-call" as CallId,
    provider: "test-telephony",
    direction: "inbound",
    from: "caller",
    to: "voice-agent",
    status: "connected",
    mediaTransport: { kind: "websocket", format: PCM16_16K_MONO },
    createdAt: timestamp,
    startedAt: timestamp,
  };
}

describe("managed account voice capability preflight", () => {
  it("accepts the declared Sarvam and ElevenLabs base-language failover", () => {
    const providerSet = providers();
    const tts = createTtsFailoverProvider({
      primary: createSarvamTtsProvider({
        apiKey: "sarvam-test",
        modelId: "bulbul:v3",
        language: "en-IN",
        voiceId: "shubh",
      }),
      fallback: createElevenLabsTtsHttpStreamProvider({
        apiKey: "elevenlabs-test",
        modelId: "eleven_flash_v2_5",
        language: "en",
        voiceId: "elevenlabs-test-voice",
      }),
      languageMatch: "base-language",
      fallbackVoiceMappings: [
        {
          requestedModel: "bulbul:v3",
          requestedVoice: "shubh",
          model: "eleven_flash_v2_5",
          voice: "elevenlabs-test-voice",
        },
      ],
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        providers: { ...providerSet, tts },
      }),
    ).not.toThrow();
  });

  it("rejects an ElevenLabs v3 model override when its configured seed is invalid for Dialogue", () => {
    const providerSet = providers();
    const tts = createElevenLabsTtsProvider({
      apiKey: "elevenlabs-test",
      modelId: "eleven_flash_v2_5",
      voiceId: "elevenlabs-test-voice",
      seed: 0,
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        models: { tts: "eleven_v3", ttsVoice: "elevenlabs-test-voice" },
        providers: { ...providerSet, tts },
      }),
    ).toThrow(/cannot use its configured options with selected model eleven_v3/u);
  });

  it("rejects a Cartesia model override that cannot use configured text normalization", () => {
    const providerSet = providers();
    const tts = createCartesiaTtsProvider({
      apiKey: "cartesia-test",
      modelId: "sonic-3.6",
      voiceId: "cartesia-test-voice",
      normalization: "auto",
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        models: { tts: "sonic-3.5", ttsVoice: "cartesia-test-voice" },
        providers: { ...providerSet, tts },
      }),
    ).toThrow(/cannot use its configured options with selected model sonic-3.5/u);
  });

  it("rejects a Sarvam WebSocket V4 selection when V3 temperature is configured", () => {
    const providerSet = providers();
    const tts = createSarvamTtsProvider({
      apiKey: "sarvam-test",
      modelId: "bulbul:v3",
      voiceId: "shubh",
      language: "en-IN",
      temperature: 0.5,
    });

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        models: { tts: "bulbul:v4-flash", ttsVoice: "simran_en_customer" },
        providers: { ...providerSet, tts },
      }),
    ).toThrow(/cannot use its configured options with selected model bulbul:v4-flash/u);
  });

  it("accepts a model-independent account voice fact for a non-professional voice", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providerSet,
      providerCapabilitySnapshots: [
        accountVoiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("rejects sparse top-level capability snapshot lists during configuration", () => {
    const sparseSnapshots = Array(1);

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        providers: providers(),
        providerCapabilitySnapshots: sparseSnapshots as never,
      }),
    ).toThrow(/snapshot 0 is invalid.*must be an object/i);
  });

  it("keeps configured voices usable without snapshots and enforces supplied unsupported or expired facts", async () => {
    const providerSet = providers();
    const options = {
      prompt: "Answer the caller.",
      providers: providerSet,
    };

    const compatibleAgent = createVoiceAgent(options);
    try {
      const session = await compatibleAgent.start({
        callHandle: testCallHandle(),
        ttsVoice: "voice-a",
      });
      await session.stop();
    } finally {
      await compatibleAgent.stop();
    }

    await expect(
      createVoiceAgent({
        ...options,
        providerCapabilitySnapshots: [
          voiceSnapshot("unsupported", new Date(Date.now() + 60_000).toISOString()),
        ],
      }).start({ callHandle: testCallHandle(), ttsVoice: "voice-a" }),
    ).rejects.toThrow(/unsupported/);
    await expect(
      createVoiceAgent({
        ...options,
        providerCapabilitySnapshots: [
          voiceSnapshot("supported", new Date(Date.now() - 1_000).toISOString()),
        ],
      }).start({ callHandle: testCallHandle(), ttsVoice: "voice-a" }),
    ).rejects.toThrow(/snapshot_expired/);
  });

  it("rejects a snapshot that expires between agent creation and call start", async () => {
    vi.useFakeTimers();
    const createdAt = Date.parse("2026-10-26T10:00:00.000Z");
    vi.setSystemTime(createdAt);
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(createdAt + 1_000).toISOString()),
      ],
    });

    try {
      vi.setSystemTime(createdAt + 1_000);
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(
        /snapshot_expired/u,
      );
    } finally {
      await agent.stop();
      vi.useRealTimers();
    }
  });

  it("refreshes capability snapshots through the per-start loader", async () => {
    const loader = vi.fn(
      async ({ provider, model, voice }: { provider: string; model?: string; voice?: string }) => {
        expect(provider).toBe("test-account-tts");
        expect(model).toBe("model-a");
        expect(voice).toBe("voice-a");
        return [voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString())];
      },
    );
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() - 1_000).toISOString()),
      ],
      loadProviderCapabilitySnapshots: loader,
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      expect(loader).toHaveBeenCalledOnce();
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("wraps snapshot loader failures as configuration errors", async () => {
    let callHandleCreated = false;
    const loaderError = new Error("snapshot service unavailable");
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      loadProviderCapabilitySnapshots: async () => {
        throw loaderError;
      },
    });
    let startError: unknown;

    try {
      try {
        await agent.start({
          callHandle: () => {
            callHandleCreated = true;
            return testCallHandle();
          },
        });
      } catch (error) {
        startError = error;
      }
      expect(startError).toMatchObject({
        code: "voice_runtime.invalid_config",
        message: expect.stringContaining("snapshot service unavailable"),
      });
      expect(startError).toBeInstanceOf(TvicThrowableError);
      expect((startError as Error).cause).toBe(loaderError);
      expect(callHandleCreated).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  it("preserves TVIC loader errors so hosts can observe retryability", async () => {
    const rateLimit = providerError(
      TVIC_ERROR_CODES.providerRateLimited,
      "Cartesia capability rate limited",
      { provider: "cartesia" },
    );
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      loadProviderCapabilitySnapshots: async () => {
        throw rateLimit;
      },
    });
    let startError: unknown;

    try {
      try {
        await agent.start({ callHandle: testCallHandle() });
      } catch (error) {
        startError = error;
      }
      expect(startError).toBe(rateLimit);
      expect(startError).toMatchObject({
        code: TVIC_ERROR_CODES.providerRateLimited,
        category: "provider",
        retriable: true,
      });
    } finally {
      await agent.stop();
    }
  });

  it("rejects a snapshot loader that returns undefined as a configuration error", async () => {
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      loadProviderCapabilitySnapshots: (() => undefined) as never,
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toMatchObject({
        code: "voice_runtime.invalid_config",
        message: expect.stringContaining("must return a snapshot array"),
      });
    } finally {
      await agent.stop();
    }
  });

  it("bounds snapshot loading by the startup timeout and aborts the loader signal", async () => {
    let loaderSignal: AbortSignal | undefined;
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      loadProviderCapabilitySnapshots: ({ signal }) => {
        loaderSignal = signal;
        return new Promise<readonly ReturnType<typeof voiceSnapshot>[]>(() => {});
      },
    });

    try {
      await expect(
        agent.start({ callHandle: testCallHandle(), startupTimeoutMs: 20 }),
      ).rejects.toMatchObject({ code: "voice_runtime.start_timeout" });
      expect(loaderSignal?.aborted).toBe(true);
    } finally {
      await agent.stop();
    }
  });

  it("cancels a pending snapshot load when the agent is stopped", async () => {
    let loaderSignal: AbortSignal | undefined;
    let signalLoaderStarted!: () => void;
    const loaderStarted = new Promise<void>((resolve) => {
      signalLoaderStarted = resolve;
    });
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      loadProviderCapabilitySnapshots: ({ signal }) => {
        loaderSignal = signal;
        signalLoaderStarted();
        return new Promise<readonly ReturnType<typeof voiceSnapshot>[]>(() => {});
      },
    });
    const startPromise = agent.start({
      callHandle: testCallHandle(),
      startupTimeoutMs: 10_000,
    });

    await loaderStarted;
    await agent.stop();
    await expect(startPromise).rejects.toMatchObject({
      code: "voice_runtime.start_cancelled",
    });
    expect(loaderSignal?.aborted).toBe(true);
  });

  it("resolves adapter-declared account requirements before creating a call handle", async () => {
    const providerSet = providers();
    const tts = {
      ...providerSet.tts,
      requiredCapabilityQueries: [
        {
          provider: "test-account-tts",
          feature: "tts.normalization.forced",
          scope: "account",
        },
      ],
    } as const;
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [],
    });
    let callHandleCreated = false;

    try {
      await expect(
        agent.start({
          callHandle: async () => {
            callHandleCreated = true;
            return testCallHandle();
          },
          call: testCall(),
        }),
      ).rejects.toThrow(/snapshot_missing/);
      expect(callHandleCreated).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  it("checks account model availability and TTS support before creating a call handle", async () => {
    const providerSet = providers();
    const queries = ["tts.model.available", "tts.model.canDoTextToSpeech"].map((feature) => ({
      provider: "test-account-tts",
      feature,
      scope: "model" as const,
      model: "model-a",
    }));
    const tts = { ...providerSet.tts, requiredCapabilityQueries: queries };
    const options = {
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
    };

    for (const modelSnapshot of [
      modelCapabilitySnapshot("unsupported", "supported"),
      modelCapabilitySnapshot("supported", "unsupported"),
      modelCapabilitySnapshot("supported", "unknown"),
      modelCapabilitySnapshot("supported", "supported", new Date(Date.now() - 1).toISOString()),
    ]) {
      const agent = createVoiceAgent({
        ...options,
        providerCapabilitySnapshots: [modelSnapshot],
      });
      let callHandleCreated = false;
      try {
        await expect(
          agent.start({
            callHandle: async () => {
              callHandleCreated = true;
              return testCallHandle();
            },
            call: testCall(),
          }),
        ).rejects.toThrow(/unsupported|unknown|snapshot_expired/);
        expect(callHandleCreated).toBe(false);
      } finally {
        await agent.stop();
      }
    }
  });

  it("requires verified non-professional voice facts for adapters with voice speed constraints", async () => {
    const providerSet = providers();
    const tts = {
      ...providerSet.tts,
      requiredTtsVoiceCapabilities: [{ feature: "tts.voice.isPro", expectedBooleanValue: false }],
    } as const;
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [],
    });
    let callHandleCreated = false;

    try {
      await expect(
        agent.start({
          callHandle: async () => {
            callHandleCreated = true;
            return testCallHandle();
          },
          call: testCall(),
        }),
      ).rejects.toThrow(/snapshot_missing/);
      expect(callHandleCreated).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  it("rejects a professional voice when the configured adapter speed is incompatible", async () => {
    const providerSet = providers();
    const tts = {
      ...providerSet.tts,
      requiredTtsVoiceCapabilities: [{ feature: "tts.voice.isPro", expectedBooleanValue: false }],
    } as const;
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [professionalVoiceSnapshot(true)],
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(/value_true/);
    } finally {
      await agent.stop();
    }
  });

  it("checks the Cartesia professional voice fact before starting configured speed", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: {
        ...providerSet,
        tts: {
          provider: "cartesia",
          apiKey: "test",
          model: "sonic-3.6",
          voiceId: "voice-a",
          generationConfig: { speed: 1 },
        },
      },
      providerCapabilitySnapshots: [cartesiaVoiceClassSnapshot(true)],
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(/value_true/);
    } finally {
      await agent.stop();
    }
  });

  it("checks fallback voice requirements against the mapped fallback voice", async () => {
    const providerSet = providers();
    const tts = withMappedAccountFallback({
      ...providerSet.tts,
      requiredTtsVoiceCapabilities: [
        {
          provider: "test-fallback-tts",
          feature: "tts.voice.isPro",
          expectedBooleanValue: false,
          voiceSource: "mapped",
        },
      ],
    });
    const fallbackVoiceSnapshot = createProviderCapabilitySnapshot({
      provider: "test-fallback-tts",
      source: "https://provider.example/voices",
      fetchedAt: new Date(Date.now() - 1_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      facts: [
        {
          feature: "tts.voice.available",
          scope: "voice",
          model: "fallback-model",
          voice: "voice-b",
          status: "supported",
        },
        {
          feature: "tts.voice.isPro",
          scope: "voice",
          status: "supported",
          model: "fallback-model",
          voice: "voice-b",
          value: false,
        },
      ],
    });
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
        fallbackVoiceSnapshot,
      ],
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("requires an Enterprise snapshot before enabling ElevenLabs normalization", async () => {
    const providerSet = providers();
    const options = {
      prompt: "Answer the caller.",
      providers: {
        ...providerSet,
        tts: {
          provider: "elevenlabs" as const,
          apiKey: "test",
          model: "eleven_flash_v2_5",
          voiceId: "voice-a",
          applyTextNormalization: "on" as const,
        },
      },
      providerCapabilitySnapshots: [],
    };

    await expect(createVoiceAgent(options).start({ callHandle: testCallHandle() })).rejects.toThrow(
      /snapshot_missing/,
    );

    const agent = createVoiceAgent({
      ...options,
      providerCapabilitySnapshots: [elevenLabsVoiceSnapshot("supported")],
    });
    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      await session.stop();
    } finally {
      await agent.stop();
    }

    const nonEnterpriseAgent = createVoiceAgent({
      ...options,
      providerCapabilitySnapshots: [elevenLabsVoiceSnapshot("unsupported")],
    });
    try {
      await expect(nonEnterpriseAgent.start({ callHandle: testCallHandle() })).rejects.toThrow(
        /unsupported/,
      );
    } finally {
      await nonEnterpriseAgent.stop();
    }
  });

  it("accepts a fresh snapshot for the exact selected model and voice", async () => {
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle(), ttsVoice: "voice-a" });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("checks the effective ElevenLabs model when a provider instance is overridden", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: {
        ...providerSet,
        tts: createElevenLabsTtsProvider({
          apiKey: "test",
          modelId: "eleven_flash_v2_5",
          voiceId: "voice-a",
        }),
      },
      models: { tts: "eleven_turbo_v2_5", ttsVoice: "voice-a" },
      providerCapabilitySnapshots: [
        elevenLabsSnapshot([
          {
            feature: "tts.model.available",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
          },
          {
            feature: "tts.model.canDoTextToSpeech",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: true,
          },
          {
            feature: "tts.voice.available",
            scope: "voice",
            model: "eleven_turbo_v2_5",
            voice: "voice-a",
            status: "supported",
          },
        ]),
      ],
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(
        /tts\.model\.available.*fact_missing/,
      );
    } finally {
      await agent.stop();
    }
  });

  it("rejects ElevenLabs speaker boost when the selected model snapshot disables it", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: {
        ...providerSet,
        tts: createElevenLabsTtsProvider({
          apiKey: "test",
          modelId: "eleven_v3",
          voiceId: "voice-a",
          useSpeakerBoost: true,
        }),
      },
      models: { tts: "eleven_flash_v2_5", ttsVoice: "voice-a" },
      providerCapabilitySnapshots: [
        elevenLabsSnapshot([
          {
            feature: "tts.model.available",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
          },
          {
            feature: "tts.model.canDoTextToSpeech",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: true,
          },
          {
            feature: "tts.model.canUseSpeakerBoost",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: false,
          },
          {
            feature: "tts.voice.available",
            scope: "voice",
            model: "eleven_flash_v2_5",
            voice: "voice-a",
            status: "supported",
          },
        ]),
      ],
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(
        /tts\.model\.canUseSpeakerBoost.*value_false/,
      );
    } finally {
      await agent.stop();
    }
  });

  it("rejects a selected ElevenLabs model that cannot use its configured language", () => {
    const providerSet = providers();

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        providers: {
          ...providerSet,
          tts: createElevenLabsTtsProvider({
            apiKey: "test",
            modelId: "eleven_flash_v2_5",
            voiceId: "voice-a",
            language: "en",
          }),
        },
        models: { tts: "eleven_multilingual_v2", ttsVoice: "voice-a" },
      }),
    ).toThrow(/configured options.*eleven_multilingual_v2/);
  });

  it("checks the mapped ElevenLabs fallback model before creating a session", async () => {
    const providerSet = providers();
    const primary = {
      ...providerSet.tts,
      name: "primary-tts",
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
      capabilities: { ...capabilities, models: ["primary-model"], voices: ["primary-voice"] },
    };
    const tts = createTtsFailoverProvider({
      primary,
      fallback: createElevenLabsTtsProvider({
        apiKey: "test",
        modelId: "eleven_v3",
        voiceId: "fallback-voice",
        useSpeakerBoost: true,
      }),
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "eleven_flash_v2_5",
          voice: "fallback-voice",
        },
      ],
    });
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [
        elevenLabsSnapshot([
          {
            feature: "tts.model.available",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
          },
          {
            feature: "tts.model.canDoTextToSpeech",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: true,
          },
          {
            feature: "tts.model.canUseSpeakerBoost",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: false,
          },
          {
            feature: "tts.voice.available",
            scope: "voice",
            model: "eleven_flash_v2_5",
            voice: "fallback-voice",
            status: "supported",
          },
        ]),
      ],
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(
        /tts\.model\.canUseSpeakerBoost.*value_false/,
      );
    } finally {
      await agent.stop();
    }
  });

  it("checks a mapped fallback voice against the fallback provider language", async () => {
    const providerSet = providers();
    const primary: TextToSpeechProvider = {
      name: "primary-tts",
      kind: "tts",
      version: "1.0.0",
      configuredModel: "primary-model",
      configuredVoice: "primary-voice",
      configuredLanguage: "en-US",
      capabilities: {
        ...capabilities,
        models: ["primary-model"],
        voices: ["primary-voice"],
        languages: ["en-US"],
      },
      async synthesize() {
        throw new Error("not used");
      },
    };
    const fallback: TextToSpeechProvider = {
      name: "fallback-tts",
      kind: "tts",
      version: "1.0.0",
      configuredModel: "fallback-model",
      configuredVoice: "fallback-voice",
      configuredLanguage: "en-GB",
      capabilities: {
        ...capabilities,
        models: ["fallback-model"],
        voices: ["fallback-voice"],
        languages: ["en-GB"],
      },
      requiredTtsVoiceCapabilities: [
        {
          provider: "fallback-tts",
          feature: "tts.voice.verifiedLocales",
          modelSource: "selected",
          configuredLanguageMustBeVerified: true,
        },
      ],
      async synthesize() {
        throw new Error("not used");
      },
    };
    const tts = createTtsFailoverProvider({
      primary,
      fallback,
      languageMatch: "base-language",
      fallbackVoiceMappings: [
        {
          requestedModel: "primary-model",
          requestedVoice: "primary-voice",
          model: "fallback-model",
          voice: "fallback-voice",
        },
      ],
    });
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [
        createProviderCapabilitySnapshot({
          provider: "fallback-tts",
          source: "https://example.com/capabilities",
          fetchedAt: new Date(Date.now() - 1_000).toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          facts: [
            {
              feature: "tts.voice.verifiedLocales",
              scope: "voice",
              model: "fallback-model",
              voice: "fallback-voice",
              status: "supported",
              value: ["en-GB"],
            },
          ],
        }),
      ],
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("rejects ElevenLabs language outside the selected voice's verified locales", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: {
        ...providerSet,
        tts: createElevenLabsTtsProvider({
          apiKey: "test",
          modelId: "eleven_flash_v2_5",
          voiceId: "voice-a",
          language: "hi-IN",
        }),
      },
      providerCapabilitySnapshots: [
        elevenLabsSnapshot([
          {
            feature: "tts.model.available",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
          },
          {
            feature: "tts.model.canDoTextToSpeech",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: true,
          },
          {
            feature: "tts.voice.available",
            scope: "voice",
            model: "eleven_flash_v2_5",
            voice: "voice-a",
            status: "supported",
          },
          {
            feature: "tts.voice.verifiedLocales",
            scope: "voice",
            model: "eleven_flash_v2_5",
            voice: "voice-a",
            status: "supported",
            value: ["en-US"],
          },
        ]),
      ],
    });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).rejects.toThrow(
        /configured language is not verified for voice voice-a/,
      );
    } finally {
      await agent.stop();
    }
  });

  it("matches a base language against the voice's verified regional locale", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: {
        ...providerSet,
        tts: createElevenLabsTtsProvider({
          apiKey: "test",
          modelId: "eleven_flash_v2_5",
          voiceId: "voice-a",
          language: "hi",
        }),
      },
      providerCapabilitySnapshots: [
        elevenLabsSnapshot([
          {
            feature: "tts.model.available",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
          },
          {
            feature: "tts.model.canDoTextToSpeech",
            scope: "model",
            model: "eleven_flash_v2_5",
            status: "supported",
            value: true,
          },
          {
            feature: "tts.voice.available",
            scope: "voice",
            model: "eleven_flash_v2_5",
            voice: "voice-a",
            status: "supported",
          },
          {
            feature: "tts.voice.verifiedLocales",
            scope: "voice",
            model: "eleven_flash_v2_5",
            voice: "voice-a",
            status: "supported",
            value: ["hi-IN"],
          },
        ]),
      ],
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("validates the per-call voice override instead of the configured default", async () => {
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });

    try {
      await expect(
        agent.start({ callHandle: testCallHandle(), ttsVoice: "voice-b" }),
      ).rejects.toThrow(/fact_missing/);
    } finally {
      await agent.stop();
    }
  });

  it("checks a mapped account-backed fallback with its declared model and voice", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts: withMappedAccountFallback(providerSet.tts) },
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
        selectedVoiceSnapshot(
          "test-fallback-tts",
          "fallback-model",
          "voice-b",
          "supported",
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ],
    });

    try {
      const session = await agent.start({
        callHandle: testCallHandle(),
        ttsVoice: "voice-a",
      });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("validates the configured voice when another voice has a fallback mapping", async () => {
    const providerSet = providers();
    const tts = {
      ...providerSet.tts,
      capabilities: {
        ...providerSet.tts.capabilities,
        voiceSnapshotProviders: ["test-account-tts", "test-fallback-tts"],
        ttsVoiceMappings: [
          {
            requestedModel: "model-a",
            requestedVoice: "voice-b",
            provider: "test-fallback-tts",
            model: "fallback-model",
            voice: "voice-c",
          },
        ],
      },
    };
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", validUntil),
        selectedVoiceSnapshot("test-fallback-tts", "model-a", "voice-a", "supported", validUntil),
      ],
    });

    try {
      const session = await agent.start({ callHandle: testCallHandle() });
      await session.stop();
    } finally {
      await agent.stop();
    }
  });

  it("rejects a missing mapped fallback snapshot before creating the call handle", async () => {
    const providerSet = providers();
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts: withMappedAccountFallback(providerSet.tts) },
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });
    let callHandleCreated = false;

    try {
      await expect(
        agent.start({
          callHandle: async () => {
            callHandleCreated = true;
            return testCallHandle();
          },
          ttsVoice: "voice-a",
        }),
      ).rejects.toThrow(/snapshot_missing/);
      expect(callHandleCreated).toBe(false);
    } finally {
      await agent.stop();
    }
  });

  it("does not reuse a voice fact recorded for a different model", async () => {
    const providerSet = providers();
    const tts = { ...providerSet.tts, configuredModel: "model-b" };
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });

    await expect(
      agent.start({ callHandle: testCallHandle(), ttsVoice: "voice-a" }),
    ).rejects.toThrow(/fact_missing/);
  });

  it("rejects a snapshot voice that another provider constraint does not support", () => {
    const providerSet = providers();
    const constrainedTts = {
      ...providerSet.tts,
      supportsVoice: () => false,
    };

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        providers: { ...providerSet, tts: constrainedTts },
        providerCapabilitySnapshots: [
          voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
        ],
      }),
    ).toThrow(/does not support voice/);
  });

  it.each(["rest", "http-stream"] as const)(
    "requires an account snapshot for the managed ElevenLabs %s route",
    async (transport) => {
      const providerSet = providers();

      await expect(
        createVoiceAgent({
          prompt: "Answer the caller.",
          providers: {
            ...providerSet,
            tts: {
              provider: "elevenlabs",
              apiKey: "test-key",
              model: "eleven_flash_v2_5",
              voiceId: "provider-managed-voice",
              transport,
            },
          },
          providerCapabilitySnapshots: [],
        }).start({ callHandle: testCallHandle(), ttsVoice: "provider-managed-voice" }),
      ).rejects.toThrow(/snapshot_missing/);
    },
  );

  it("rechecks snapshot expiry at call start before session attachment", async () => {
    const providerSet = providers();
    const initialNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(initialNow);
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providerSet,
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(initialNow + 60_000).toISOString()),
      ],
    });
    now.mockReturnValue(initialNow + 60_000);
    try {
      await expect(
        agent.start({ callHandle: testCallHandle(), ttsVoice: "voice-a" }),
      ).rejects.toThrow(/snapshot_expired/);
    } finally {
      now.mockRestore();
      await agent.stop();
    }
  });

  it("requires a fresh snapshot for the configured account-backed voice", async () => {
    const options = {
      prompt: "Answer the caller.",
      providers: providers(),
      providerCapabilitySnapshots: [],
    };
    const missingSnapshotAgent = createVoiceAgent(options);
    await expect(missingSnapshotAgent.start({ callHandle: testCallHandle() })).rejects.toThrow(
      /snapshot_missing/,
    );
    await missingSnapshotAgent.stop();

    const supportedSnapshotAgent = createVoiceAgent({
      ...options,
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });
    try {
      await expect(
        supportedSnapshotAgent.start({ callHandle: testCallHandle() }),
      ).resolves.toHaveProperty("sessionId");
    } finally {
      await supportedSnapshotAgent.stop();
    }
  });

  it.each([
    ["turnProfiles", { model: "model-a", profiles: "latency" }],
    ["ttsTextControls", { model: "model-a", controls: "spell" }],
    ["ttsSpeedRanges", { model: "model-a", min: 1.2, max: 0.7 }],
  ] as const)("rejects malformed %s capability declarations", (field, declaration) => {
    const providerSet = providers();
    const malformedTts = {
      ...providerSet.tts,
      capabilities: { ...capabilities, [field]: [declaration] },
    } as unknown as TextToSpeechProvider;

    expect(() =>
      createVoiceAgent({
        prompt: "Answer the caller.",
        providers: { ...providerSet, tts: malformedTts },
      }),
    ).toThrow(/capabilities are malformed/);
  });

  it("rejects a per-call voice override when the adapter declares no voice selection support", async () => {
    const providerSet = providers();
    const tts = { ...providerSet.tts, capabilities };
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: { ...providerSet, tts },
    });

    await expect(
      agent.start({ callHandle: testCallHandle(), ttsVoice: "voice-b" }),
    ).rejects.toThrow(/does not declare support for per-call voice selection/);
  });
});
