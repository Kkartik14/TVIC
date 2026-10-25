import { describe, expect, it } from "vitest";

import {
  createProviderCapabilitySnapshot,
  createVoiceAgent,
  PCM16_16K_MONO,
  type LLMProvider,
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

function voiceSnapshot(status: "supported" | "unsupported", validUntil: string) {
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
        model: "model-a",
        voice: "voice-a",
        status,
      },
    ],
  });
}

describe("managed account voice capability preflight", () => {
  it("rejects missing, unsupported, and expired voice snapshots during agent creation", async () => {
    const providerSet = providers();
    const options = {
      prompt: "Answer the caller.",
      providers: providerSet,
    };

    expect(() => createVoiceAgent(options)).toThrow(/capability snapshot/);
    expect(() =>
      createVoiceAgent({
        ...options,
        providerCapabilitySnapshots: [
          voiceSnapshot("unsupported", new Date(Date.now() + 60_000).toISOString()),
        ],
      }),
    ).toThrow(/unsupported/);
    expect(() =>
      createVoiceAgent({
        ...options,
        providerCapabilitySnapshots: [
          voiceSnapshot("supported", new Date(Date.now() - 1_000).toISOString()),
        ],
      }),
    ).toThrow(/expired/);
  });

  it("accepts a fresh snapshot for the exact selected model and voice", async () => {
    const agent = createVoiceAgent({
      prompt: "Answer the caller.",
      providers: providers(),
      providerCapabilitySnapshots: [
        voiceSnapshot("supported", new Date(Date.now() + 60_000).toISOString()),
      ],
    });

    await agent.stop();
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
    (transport) => {
      const providerSet = providers();

      expect(() =>
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
        }),
      ).toThrow(/capability snapshot/);
    },
  );
});
