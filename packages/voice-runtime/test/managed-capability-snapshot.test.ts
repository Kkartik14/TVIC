import { describe, expect, it, vi } from "vitest";

import {
  createProviderCapabilitySnapshot,
  createVoiceAgent,
  PCM16_16K_MONO,
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

  it("does not require a snapshot for the existing configured voice default", async () => {
    const agent = createVoiceAgent({ prompt: "Answer the caller.", providers: providers() });

    try {
      await expect(agent.start({ callHandle: testCallHandle() })).resolves.toHaveProperty(
        "sessionId",
      );
    } finally {
      await agent.stop();
    }
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
