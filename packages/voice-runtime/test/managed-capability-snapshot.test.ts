import { describe, expect, it, vi } from "vitest";

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

function accountCapabilitySnapshot(
  provider: string,
  feature: string,
  status: "supported" | "unsupported" | "unknown",
) {
  return createProviderCapabilitySnapshot({
    provider,
    source: "https://provider.example/account",
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    facts: [{ feature, scope: "account", status }],
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
  it("rejects missing, unsupported, and expired voice snapshots before a call starts", async () => {
    const providerSet = providers();
    const options = {
      prompt: "Answer the caller.",
      providers: providerSet,
    };

    await expect(
      createVoiceAgent(options).start({ callHandle: testCallHandle(), ttsVoice: "voice-a" }),
    ).rejects.toThrow(/snapshot_missing/);
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
        selectedVoiceSnapshot(
          "test-fallback-tts",
          "model-a",
          "voice-a",
          "supported",
          validUntil,
        ),
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
    const options = { prompt: "Answer the caller.", providers: providers() };
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
      await expect(supportedSnapshotAgent.start({ callHandle: testCallHandle() })).resolves.toHaveProperty(
        "sessionId",
      );
    } finally {
      await supportedSnapshotAgent.stop();
    }
  });

  it.each([
    ["turnProfiles", { model: "model-a", profiles: "latency" }],
    ["ttsTextControls", { model: "model-a", controls: "spell" }],
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
