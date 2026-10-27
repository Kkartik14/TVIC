import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  createProviderCapabilitySnapshot,
  type SessionId,
  type Timestamp,
  type TtsSessionOpenRequest,
  type TtsUsageReporter,
  type TurnId,
} from "@tvic/core";

import {
  ElevenLabsMultiContextProvider,
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsProvider,
  ElevenLabsTtsRestProvider,
  ElevenLabsTtsStream,
  ELEVENLABS_CAPABILITY_FEATURES,
} from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";
import { elevenLabsCapabilitySnapshot } from "./elevenlabs-capability-fixtures.js";

const request: TtsSessionOpenRequest = {
  sessionId: "elevenlabs-session" as SessionId,
  turnId: "elevenlabs-turn" as TurnId,
  format: PCM16_16K_MONO,
  timestamps: true,
  providerCapabilitySnapshots: [
    elevenLabsCapabilitySnapshot({
      model: "eleven_flash_v2_5",
      additionalModels: PROVIDER_CATALOG.elevenlabs.models,
      voice: "voice",
      additionalVoices: [
        "voice-a",
        "voice-b",
        "fallback-voice",
        "another-voice",
        "voice-per-call",
        "dialogue-free-form",
      ],
      language: "en",
    }),
  ],
};

function requestWithoutCapabilitySnapshot(): TtsSessionOpenRequest {
  const requestWithoutSnapshot = { ...request };
  delete requestWithoutSnapshot.providerCapabilitySnapshots;
  return requestWithoutSnapshot;
}

const fixedClock = {
  now(): Timestamp {
    return "2026-09-24T00:00:00.000Z" as Timestamp;
  },
};

describe("ElevenLabs TTS boundaries", () => {
  it("declares model-aware request language and speed support", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      knownVoiceIds: ["voice-per-call"],
    });

    expect(provider.supportsTtsLanguage("hi-IN")).toBe(true);
    expect(provider.supportsTtsLanguage("fil-PH", "eleven_v3")).toBe(true);
    expect(provider.supportsTtsLanguage("ast-ES", "eleven_v3")).toBe(true);
    expect(provider.supportsTtsLanguage("or-IN")).toBe(false);
    expect(provider.supportsTtsLanguage("hi-IN", "eleven_flash_v2")).toBe(false);
    expect(provider.supportsTtsLanguage("hi-IN", "eleven_v3")).toBe(true);
    expect(provider.supportsTtsSpeed(0.7)).toBe(true);
    expect(provider.supportsTtsSpeed(1.2)).toBe(true);
    expect(provider.supportsTtsSpeed(1.21)).toBe(false);
    expect(provider.supportsTtsSpeed(1, "eleven_v3")).toBe(false);
    expect(provider.supportsVoice("voice-per-call")).toBe(true);
    expect(provider.supportsVoice("voice-unknown")).toBe(false);
    expect(provider.supportsVoice("  ")).toBe(false);
  });

  it("accepts every language code currently listed for v4", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v4",
    });
    // ElevenLabs describes this as "90+ languages, including" these codes;
    // an omitted code alone is not evidence that v4 does not support it.
    const documentedV4Languages = [
      "af",
      "ar",
      "hy",
      "as",
      "ast",
      "az",
      "be",
      "bn",
      "bs",
      "bg",
      "my",
      "yue",
      "ca",
      "ceb",
      "hr",
      "cs",
      "da",
      "nl",
      "en",
      "et",
      "fil",
      "fi",
      "fr",
      "gl",
      "ka",
      "de",
      "el",
      "gu",
      "ha",
      "he",
      "hi",
      "hu",
      "is",
      "id",
      "ga",
      "it",
      "ja",
      "jv",
      "kn",
      "kk",
      "ko",
      "ky",
      "lv",
      "ln",
      "lt",
      "lb",
      "mk",
      "ms",
      "ml",
      "mt",
      "zh",
      "mi",
      "mr",
      "mn",
      "ne",
      "no",
      "oc",
      "or",
      "ps",
      "fa",
      "pl",
      "pt",
      "pa",
      "ro",
      "ru",
      "sr",
      "sd",
      "sk",
      "sl",
      "so",
      "es",
      "sw",
      "sv",
      "tg",
      "ta",
      "te",
      "th",
      "tr",
      "uk",
      "ur",
      "uz",
      "vi",
      "cy",
      "yo",
    ];

    for (const language of documentedV4Languages) {
      expect(provider.supportsTtsLanguage(language), language).toBe(true);
    }
  });

  it("keeps valid language tags available on the expanding v3 and v4 model families", () => {
    const provider = new ElevenLabsTtsProvider({ apiKey: "test", voiceId: "voice" });

    expect(provider.supportsTtsLanguage("sah-RU", "eleven_v3")).toBe(true);
    expect(provider.supportsTtsLanguage("sah-RU", "eleven_v4")).toBe(true);
    expect(provider.supportsTtsLanguage("---", "eleven_v4")).toBe(false);
    expect(provider.supportsTtsLanguage("sah-RU", "eleven_flash_v2_5")).toBe(false);
  });

  it.each(["nb-NO", "nn-NO"])("maps %s to ElevenLabs' Norwegian code", async (language) => {
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });

    expect(provider.supportsTtsLanguage(language)).toBe(true);
    const session = await provider.openSession({ ...request, language });
    expect(new URL(openedUrl).searchParams.get("language_code")).toBe("no");
    await session.cancel();
  });

  it("allows legacy free-form ElevenLabs voice IDs when no voice catalog is configured", () => {
    const provider = new ElevenLabsTtsProvider({ apiKey: "test", voiceId: "voice-configured" });

    expect(provider.supportsVoice("voice-configured")).toBe(true);
    expect(provider.supportsVoice("voice-missing")).toBe(true);
  });

  it("rejects an undeclared ElevenLabs voice when an explicit catalog is configured", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      knownVoiceIds: ["voice-registered"],
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...request, voice: "voice-missing" }),
    ).rejects.toMatchObject({
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    });
    expect(factoryCalls).toBe(0);
  });

  it("sends an undeclared dialogue voice when no dialogue voice catalog is configured", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      modelId: "eleven_v3",
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    expect(provider.supportsVoice("dialogue-free-form", "eleven_v3")).toBe(true);
    const session = await provider.openSession({
      ...request,
      model: "eleven_v3",
      voice: "dialogue-free-form",
    });
    expect(openedUrl).toContain("eleven_v3");
    await session.cancel();
  });

  it("preflights regular and dialogue voices against the selected protocol", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-a",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
    });

    expect(provider.supportsVoice("voice-b", "eleven_flash_v2_5")).toBe(true);
    expect(provider.supportsVoice("voice-unlisted", "eleven_flash_v2_5")).toBe(true);
    expect(provider.supportsVoice("voice-b", "eleven_v3")).toBe(true);
    expect(provider.supportsVoice("voice-unlisted", "eleven_v3")).toBe(false);
    expect(provider.supportsVoice("voice\u0001bad", "eleven_v3")).toBe(false);
    expect(provider.supportsVoice("voice\u0001bad", "eleven_flash_v2_5")).toBe(false);
    expect(provider.supportsTtsSelection?.({ model: "eleven_flash_v2_5" })).toBe(false);
  });

  it("rejects dialogue voice catalogs for a per-call regular TTS model", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-a",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
    });

    expect(provider.supportsTtsSelection({ model: "eleven_flash_v2_5" })).toBe(false);
    expect(provider.supportsTtsSelection({ model: "eleven_v3" })).toBe(true);
  });

  it.each([".", "..", "v".repeat(257)])("rejects unsafe ElevenLabs voice id %s", (voiceId) => {
    const provider = new ElevenLabsTtsProvider({ apiKey: "test", voiceId: "voice" });

    expect(provider.supportsVoice(voiceId)).toBe(false);
  });

  it("uses the request language over configured language and maps it to the provider code", async () => {
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "en-US",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });

    const session = await provider.openSession({ ...request, language: "hi-IN" });

    expect(new URL(openedUrl).searchParams.get("language_code")).toBe("hi");
    await session.cancel();
  });

  it("treats an empty configured language as unset in preflight and WebSocket requests", async () => {
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });

    expect(provider.configuredLanguage).toBeUndefined();
    expect(provider.supportsTtsSelection?.({})).toBe(true);
    const session = await provider.openSession({ ...request, model: "eleven_flash_v2_5" });

    expect(new URL(openedUrl).searchParams.has("language_code")).toBe(false);
    await session.cancel();
  });

  it("treats an empty request language as the configured language", async () => {
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "en-US",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });
    const session = await provider.openSession({ ...request, language: "" });

    expect(new URL(openedUrl).searchParams.get("language_code")).toBe("en");
    await session.cancel();
  });

  it("routes request voices through a custom WebSocket URL or rejects a fixed route", async () => {
    let openedUrl = "";
    const routed = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      knownVoiceIds: ["voice-per-call"],
      url: "wss://proxy.example/v1/text-to-speech/:voice_id/stream-input",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });

    const session = await routed.openSession({ ...request, voice: "voice-per-call" });
    expect(new URL(openedUrl).pathname).toBe("/v1/text-to-speech/voice-per-call/stream-input");
    expect(routed.supportsVoice("voice-per-call")).toBe(true);
    await session.cancel();

    let socketCalls = 0;
    const fixed = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      knownVoiceIds: ["voice-per-call"],
      url: "wss://proxy.example/v1/text-to-speech/voice-configured/stream-input",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    expect(fixed.supportsVoice("voice-per-call")).toBe(false);
    await expect(fixed.openSession({ ...request, voice: "voice-per-call" })).rejects.toMatchObject({
      code: "provider.invalid_request",
    });
    expect(socketCalls).toBe(0);
  });

  it("preserves provider-specific three-letter language codes", async () => {
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v3",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });

    const session = await provider.openSession({ ...request, language: "fil-PH" });

    expect(new URL(openedUrl).searchParams.get("language_code")).toBe("fil");
    await session.cancel();
  });

  it("retains Turbo v2 models and records their deprecated status", () => {
    expect(PROVIDER_CATALOG.elevenlabs.models).toEqual(
      expect.arrayContaining(["eleven_turbo_v2", "eleven_turbo_v2_5"]),
    );
    expect(PROVIDER_CATALOG.elevenlabs.deprecatedModels).toEqual([
      "eleven_turbo_v2_5",
      "eleven_turbo_v2",
    ]);
  });

  it("routes Eleven v4 Turbo through Text-to-Dialogue", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v4_turbo",
      allowUnknownModel: true,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession(request);

    expect(new URL(openedUrl).pathname).toBe("/v1/text-to-dialogue/stream-input");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({ voices: ["voice"] }),
    );
    await session.cancel();
  });

  it("rejects a request language for multilingual v2 instead of dropping language_code", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_multilingual_v2",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    expect(provider.supportsTtsLanguage("hi")).toBe(false);
    expect(provider.supportsTtsSelection({ language: "hi" })).toBe(false);
    await expect(provider.openSession({ ...request, language: "hi" })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.ttsLanguageUnsupported,
    });
    expect(factoryCalls).toBe(0);
  });

  it.each(["WebSocket", "REST", "HTTP stream"] as const)(
    "keeps configured voice setup usable without a capability snapshot on %s",
    async (route) => {
      const socket = new FakeSocket();
      const webSocketFactory = vi.fn(() => socket as never);
      let fetchCalls = 0;
      const fetchImpl: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-type": "audio/pcm" },
        });
      };
      const provider =
        route === "WebSocket"
          ? new ElevenLabsTtsProvider({
              apiKey: "test",
              voiceId: "voice",
              modelId: "eleven_flash_v2_5",
              webSocketFactory,
            })
          : route === "REST"
            ? new ElevenLabsTtsRestProvider({
                apiKey: "test",
                voiceId: "voice",
                modelId: "eleven_flash_v2_5",
                fetchImpl,
              })
            : new ElevenLabsTtsHttpStreamProvider({
                apiKey: "test",
                voiceId: "voice",
                modelId: "eleven_flash_v2_5",
                fetchImpl,
              });

      const stream = await provider.synthesize({
        ...requestWithoutCapabilitySnapshot(),
        text: "Hello",
        stream: true,
        timestamps: false,
      });
      expect(webSocketFactory).toHaveBeenCalledTimes(route === "WebSocket" ? 1 : 0);
      expect(fetchCalls).toBe(route === "WebSocket" ? 0 : 1);
      await stream.cancel();
    },
  );

  it("opens the configured voice with a fresh supporting snapshot", async () => {
    const socket = new FakeSocket();
    const webSocketFactory = vi.fn(() => socket as never);
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory,
    });

    const session = await provider.openSession({
      ...request,
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({ model: "eleven_flash_v2_5", voice: "voice" }),
      ],
    });

    expect(webSocketFactory).toHaveBeenCalledOnce();
    await session.cancel();
  });

  it("does not treat a model-independent professional voice fact as model availability", async () => {
    const webSocketFactory = vi.fn(() => {
      throw new Error("socket should not be created");
    });
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "professional-voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory,
    });
    const now = Date.now();
    const snapshot = createProviderCapabilitySnapshot({
      provider: PROVIDER_NAMES.elevenlabs,
      source: "https://provider.example/capabilities",
      fetchedAt: new Date(now - 1_000).toISOString(),
      validUntil: new Date(now + 60_000).toISOString(),
      facts: [
        {
          feature: PROVIDER_CAPABILITY_FEATURES.ttsModelAvailable,
          scope: "model",
          model: "eleven_flash_v2_5",
          status: "supported",
        },
        {
          feature: PROVIDER_CAPABILITY_FEATURES.ttsModelCanDoTextToSpeech,
          scope: "model",
          model: "eleven_flash_v2_5",
          status: "supported",
          value: true,
        },
        {
          feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceCategory,
          scope: "voice",
          voice: "professional-voice",
          status: "supported",
          value: "professional",
        },
        {
          feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
          scope: "voice",
          voice: "professional-voice",
          status: "supported",
        },
      ],
    });

    await expect(
      provider.openSession({ ...request, providerCapabilitySnapshots: [snapshot] }),
    ).rejects.toThrow(/cannot use voice professional-voice.*fact_missing/u);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("does not treat a model-independent premade voice fact as model availability", async () => {
    const webSocketFactory = vi.fn(() => {
      throw new Error("socket should not be created");
    });
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "premade-voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory,
    });
    const now = Date.now();
    const snapshot = createProviderCapabilitySnapshot({
      provider: PROVIDER_NAMES.elevenlabs,
      source: "https://provider.example/capabilities",
      fetchedAt: new Date(now - 1_000).toISOString(),
      validUntil: new Date(now + 60_000).toISOString(),
      facts: [
        {
          feature: PROVIDER_CAPABILITY_FEATURES.ttsModelAvailable,
          scope: "model",
          model: "eleven_flash_v2_5",
          status: "supported",
        },
        {
          feature: PROVIDER_CAPABILITY_FEATURES.ttsModelCanDoTextToSpeech,
          scope: "model",
          model: "eleven_flash_v2_5",
          status: "supported",
          value: true,
        },
        {
          feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceCategory,
          scope: "voice",
          voice: "premade-voice",
          status: "supported",
          value: "premade",
        },
        {
          feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
          scope: "voice",
          voice: "premade-voice",
          status: "supported",
        },
      ],
    });

    await expect(
      provider.openSession({ ...request, providerCapabilitySnapshots: [snapshot] }),
    ).rejects.toThrow(/cannot use voice premade-voice.*fact_missing/u);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });
  it.each(["eleven_flash_v2_5", "eleven_turbo_v2_5"])(
    "requires an account snapshot before enabling normalization on %s",
    (model) => {
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: model,
        applyTextNormalization: "on",
      });

      expect(provider.requiredCapabilityQueries).toEqual([
        {
          provider: PROVIDER_NAMES.elevenlabs,
          feature: "tts.model.available",
          scope: "model",
          model,
        },
        {
          provider: PROVIDER_NAMES.elevenlabs,
          feature: "tts.model.canDoTextToSpeech",
          scope: "model",
          model,
        },
        {
          provider: PROVIDER_NAMES.elevenlabs,
          feature: "tts.normalization.forced",
          scope: "account",
        },
      ]);
    },
  );

  it.each(["auto", "off"] as const)(
    "checks account model facts when normalization is %s",
    (normalization) => {
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        applyTextNormalization: normalization,
      });

      expect(provider.requiredCapabilityQueries).toEqual([
        {
          provider: PROVIDER_NAMES.elevenlabs,
          feature: "tts.model.available",
          scope: "model",
          model: "eleven_flash_v2_5",
        },
        {
          provider: PROVIDER_NAMES.elevenlabs,
          feature: "tts.model.canDoTextToSpeech",
          scope: "model",
          model: "eleven_flash_v2_5",
        },
      ]);
    },
  );

  it("declares model facts required by speaker boost on every TTS route", () => {
    const providers = [
      new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        useSpeakerBoost: true,
      }),
      new ElevenLabsTtsRestProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        useSpeakerBoost: true,
      }),
      new ElevenLabsTtsHttpStreamProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        useSpeakerBoost: true,
      }),
      new ElevenLabsMultiContextProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        useSpeakerBoost: true,
      }),
    ];

    for (const provider of providers) {
      expect(provider.requiredCapabilityQueries).toContainEqual({
        provider: PROVIDER_NAMES.elevenlabs,
        feature: "tts.model.canUseSpeakerBoost",
        scope: "model",
        model: "eleven_flash_v2_5",
        expectedBooleanValue: true,
      });
    }
  });

  it.each(["websocket", "REST", "HTTP stream"] as const)(
    "allows configured speaker boost when optional snapshots are omitted on %s",
    async (route) => {
      const socket = new FakeSocket();
      const webSocketFactory = vi.fn(() => socket as never);
      const fetchImpl = vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2]), {
            status: 200,
            headers: { "content-type": "audio/pcm" },
          }),
      );
      const provider =
        route === "websocket"
          ? new ElevenLabsTtsProvider({
              apiKey: "test",
              voiceId: "voice",
              modelId: "eleven_flash_v2_5",
              useSpeakerBoost: true,
              webSocketFactory,
            })
          : route === "REST"
            ? new ElevenLabsTtsRestProvider({
                apiKey: "test",
                voiceId: "voice",
                modelId: "eleven_flash_v2_5",
                useSpeakerBoost: true,
                fetchImpl,
              })
            : new ElevenLabsTtsHttpStreamProvider({
                apiKey: "test",
                voiceId: "voice",
                modelId: "eleven_flash_v2_5",
                useSpeakerBoost: true,
                fetchImpl,
              });

      const stream = await provider.synthesize({
        ...requestWithoutCapabilitySnapshot(),
        text: "Hello",
        stream: true,
        timestamps: false,
      });
      expect(webSocketFactory).toHaveBeenCalledTimes(route === "websocket" ? 1 : 0);
      expect(fetchImpl).toHaveBeenCalledTimes(route === "websocket" ? 0 : 1);
      await stream.cancel();
    },
  );

  it("allows configured language when optional voice locale snapshots are omitted", async () => {
    const socket = new FakeSocket();
    const webSocketFactory = vi.fn(() => socket as never);
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "en",
      webSocketFactory,
    });

    const session = await provider.openSession(requestWithoutCapabilitySnapshot());
    expect(webSocketFactory).toHaveBeenCalledOnce();
    await session.cancel();
  });

  it("checks configured language when an empty snapshot list is supplied", async () => {
    const webSocketFactory = vi.fn(() => {
      throw new Error("socket should not be created");
    });
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "en",
      webSocketFactory,
    });

    await expect(
      provider.synthesize({
        ...request,
        providerCapabilitySnapshots: [],
        text: "Hello",
        stream: true,
      }),
    ).rejects.toThrow(/snapshot_missing/u);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("requires an account fact before forcing text normalization", async () => {
    const webSocketFactory = vi.fn(() => {
      throw new Error("socket should not be created");
    });
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      applyTextNormalization: "on",
      webSocketFactory,
    });

    await expect(
      provider.openSession({
        ...request,
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({ model: "eleven_flash_v2_5", voice: "voice" }),
        ],
      }),
    ).rejects.toThrow(/tts\.normalization\.forced.*fact_missing/u);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("rejects speaker boost when the selected model snapshot disables it", async () => {
    const webSocketFactory = vi.fn(() => {
      throw new Error("socket should not be created");
    });
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      useSpeakerBoost: true,
      webSocketFactory,
    });

    await expect(
      provider.openSession({
        ...request,
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({
            model: "eleven_flash_v2_5",
            voice: "voice",
            speakerBoost: true,
            speakerBoostSupported: false,
          }),
        ],
      }),
    ).rejects.toThrow(/tts\.model\.canUseSpeakerBoost value true.*value_false/u);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["model", { model: "eleven_turbo_v2_5" }],
    ["voice", { voice: "another-voice" }],
  ] as const)(
    "allows per-call %s selection when optional snapshots are omitted",
    async (_field, selection) => {
      const socket = new FakeSocket();
      const webSocketFactory = vi.fn(() => socket as never);
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        webSocketFactory,
      });

      const session = await provider.openSession({
        ...requestWithoutCapabilitySnapshot(),
        ...selection,
      });
      expect(webSocketFactory).toHaveBeenCalledOnce();
      await session.cancel();
    },
  );

  it("checks dialogue model availability without requiring regular TTS capability", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v3",
    });

    expect(provider.requiredCapabilityQueries).toEqual([
      {
        provider: PROVIDER_NAMES.elevenlabs,
        feature: "tts.model.available",
        scope: "model",
        model: "eleven_v3",
      },
    ]);
  });

  it("sends an explicit SSML opt-in on the regular WebSocket and preserves text exactly", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      enableSsmlParsing: true,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    const session = await provider.openSession(request);
    const sentCount = socket.sent.length;

    const text = '<speak>hello <break time="1s" /> &amp; goodbye</speak>';
    await session.sendText(text);
    expect(new URL(openedUrl).searchParams.get("enable_ssml_parsing")).toBe("true");
    expect(JSON.parse(socket.sent[sentCount] ?? "{}")).toMatchObject({ text });
    await session.cancel();
  });

  it("sends an explicit SSML opt-in on multi-context and preserves text exactly", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsMultiContextProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      enableSsmlParsing: true,
      clock: fixedClock,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    const connection = await provider.openConnection();
    const context = await connection.openContext({
      contextId: "ssml",
      sessionId: request.sessionId,
      turnId: request.turnId,
      format: PCM16_16K_MONO,
      voice: "voice",
      providerCapabilitySnapshots: request.providerCapabilitySnapshots!,
    });
    const sentCount = socket.sent.length;

    const text = '<speak>hello <break time="1s" /> &amp; goodbye</speak>';
    await context.sendText(text);
    expect(new URL(openedUrl).searchParams.get("enable_ssml_parsing")).toBe("true");
    expect(JSON.parse(socket.sent[sentCount] ?? "{}")).toEqual({ context_id: "ssml", text });
    await connection.close();
  });

  it("rejects an SSML opt-in on the HTTP providers, which cannot send it", () => {
    for (const Provider of [ElevenLabsTtsRestProvider, ElevenLabsTtsHttpStreamProvider]) {
      expect(
        () => new Provider({ apiKey: "test", voiceId: "voice", enableSsmlParsing: true }),
      ).toThrow(/only supported by the ElevenLabs WebSocket routes/);
      expect(
        () => new Provider({ apiKey: "test", voiceId: "voice", enableSsmlParsing: false }),
      ).not.toThrow();
    }
  });

  it.each([
    [
      "websocket",
      () =>
        new ElevenLabsTtsProvider({
          apiKey: "test",
          voiceId: "voice",
          modelId: "eleven_multilingual_v2",
          language: "hi-IN",
        }),
    ],
    [
      "REST",
      () =>
        new ElevenLabsTtsRestProvider({
          apiKey: "test",
          voiceId: "voice",
          modelId: "eleven_multilingual_v2",
          language: "hi-IN",
        }),
    ],
    [
      "HTTP stream",
      () =>
        new ElevenLabsTtsHttpStreamProvider({
          apiKey: "test",
          voiceId: "voice",
          modelId: "eleven_multilingual_v2",
          language: "hi-IN",
        }),
    ],
    [
      "multi-context",
      () =>
        new ElevenLabsMultiContextProvider({ apiKey: "test", voiceId: "voice", language: "hi-IN" }),
    ],
  ])(
    "rejects explicit language for multilingual v2 during %s construction",
    (_route, createProvider) => {
      expect(createProvider).toThrow(/language_code is not supported by eleven_multilingual_v2/);
    },
  );

  it.each(PROVIDER_CATALOG.elevenlabs.models)("opens every catalog model: %s", async (model) => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const dialogue = model.startsWith("eleven_v3") || model.startsWith("eleven_v4");
    const language = !dialogue && model !== "eleven_multilingual_v2" ? "en" : undefined;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: model,
      ...(language !== undefined ? { language } : {}),
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    expect(provider.configuredModel).toBe(model);
    expect(provider.configuredVoice).toBe("voice");
    expect(provider.configuredLanguage).toBe(language);

    const session = await provider.openSession({
      ...request,
      ...(language !== undefined
        ? {
            providerCapabilitySnapshots: [
              elevenLabsCapabilitySnapshot({ model, voice: "voice", language }),
            ],
          }
        : {}),
    });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("model_id")).toBe(model);
    if (dialogue) {
      expect(url.pathname).toBe("/v1/text-to-dialogue/stream-input");
      expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
        expect.objectContaining({ voices: ["voice"] }),
      );
    } else {
      expect(url.pathname).toContain("/v1/text-to-speech/voice/stream-input");
      expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(expect.objectContaining({ text: " " }));
    }
    await session.cancel();
  });

  it.each([
    ["eleven_v3", 5_000],
    ["eleven_v4", 10_000],
    ["eleven_multilingual_v2", 10_000],
    ["eleven_flash_v2_5", 40_000],
    ["eleven_turbo_v2_5", 40_000],
  ] as const)("enforces the %s character limit", async (model, limit) => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: model,
      webSocketFactory: () => new FakeSocket() as never,
    });
    const session = await provider.openSession(request);

    await expect(session.sendText("x".repeat(limit))).resolves.toBeUndefined();
    await expect(session.sendText("x")).rejects.toMatchObject({
      code: PROVIDER_NAMES.elevenlabs + ".tts.error",
    });
    await session.cancel();
  });

  it("counts caller text once and excludes regular WebSocket protocol spaces", async () => {
    const socket = new FakeSocket();
    const reported: number[] = [];
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters(codePoints) {
        reported.push(codePoints);
      },
    };
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession({ ...request, usageReporter });

    await session.sendText("A🌟");
    await session.flush();
    await session.finish();

    expect(reported).toEqual([2]);
    expect(provider.usageAccounting).toEqual({
      reportsTextCharacters: true,
      usesRequestModelForUsage: true,
    });
  });

  it("counts accepted caller text before a provider write that fails", async () => {
    const socket = new FakeSocket();
    const reported: number[] = [];
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters(codePoints) {
        reported.push(codePoints);
      },
    };
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession({ ...request, usageReporter });
    socket.readyState = WebSocket.CLOSED;

    await expect(session.sendText("A🌟")).rejects.toBeDefined();

    expect(reported).toEqual([2]);
  });

  it("counts one-shot caller text when the WebSocket connection fails", async () => {
    const socket = new FakeSocket();
    socket.readyState = WebSocket.CONNECTING;
    const reported: number[] = [];
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters(codePoints) {
        reported.push(codePoints);
      },
    };
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => {
        queueMicrotask(() => socket.fail(new Error("connection failed")));
        return socket as never;
      },
    });

    await expect(
      provider.synthesize({
        ...request,
        text: "A🌟",
        stream: true,
        usageReporter,
      }),
    ).rejects.toBeDefined();

    expect(reported).toEqual([2]);
  });

  it("counts one-shot caller text when the WebSocket connection is cancelled", async () => {
    const socket = new FakeSocket();
    const reported: number[] = [];
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters(codePoints) {
        reported.push(codePoints);
      },
    };
    const controller = new AbortController();
    controller.abort();
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => socket as never,
    });

    await expect(
      provider.synthesize({
        ...request,
        text: "A🌟",
        stream: true,
        signal: controller.signal,
        usageReporter,
      }),
    ).rejects.toBeDefined();

    expect(reported).toEqual([2]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("counts one-shot text before the stream rejects its model character limit", async () => {
    const reported: number[] = [];
    const usageReporter: TtsUsageReporter = {
      report() {},
      beginOperation() {
        return { report() {}, notReported() {}, finish() {} };
      },
      reportTextCharacters(codePoints) {
        reported.push(codePoints);
      },
    };
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => new FakeSocket() as never,
    });

    await expect(
      provider.synthesize({
        ...request,
        text: "x".repeat(40_001),
        stream: true,
        usageReporter,
      }),
    ).rejects.toMatchObject({ code: `${PROVIDER_NAMES.elevenlabs}.tts.error` });

    expect(reported).toEqual([40_001]);
  });

  it("uses the Text-to-Dialogue protocol for v3 final markers and snake_case alignment", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v3_conversational",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession(request);
    const iterator = session.events[Symbol.asyncIterator]();

    await session.sendText("A short conversational turn.");
    await session.flush();
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      inputs: [{ text: "A short conversational turn.", voice_id: "voice" }],
    });
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({ flush: true });

    socket.receive({
      audio: Buffer.from([0, 0]).toString("base64"),
      alignment: {
        chars: ["A"],
        char_start_times_ms: [0],
        char_durations_ms: [40],
      },
    });
    socket.receive({ audio: "", is_final_audio_for_turn: true });
    await session.sendText(" Continue the same session.");
    socket.receive({ audio: "", is_final_audio_for_turn: true });
    await session.finish();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ close_socket: true });
    socket.receive({ is_final: true });

    const events = [
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
    ].map((step) => step.value);
    expect(events).toEqual([
      expect.objectContaining({ type: "tts.flush.completed" }),
      expect.objectContaining({ type: "media.audio.chunk" }),
      expect.objectContaining({
        type: "tts.alignment",
        startMs: [0],
        endMs: [40],
      }),
      expect.objectContaining({ type: "media.audio.committed" }),
      undefined,
    ]);
  });

  it("rejects an unsupported model before connecting", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...request, model: "not-in-the-catalog" }),
    ).rejects.toMatchObject({
      category: "validation",
      code: "provider.model_unsupported",
    });
    expect(factoryCalls).toBe(0);
  });

  it("rejects a language setting when a request selects multilingual v2", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "hi-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...request, model: "eleven_multilingual_v2" }),
    ).rejects.toThrow(/language_code is not supported by eleven_multilingual_v2/);
    expect(factoryCalls).toBe(0);
  });

  it("allows an explicitly configured unknown model and preserves URL/config fields", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "custom-model",
      allowUnknownModel: true,
      language: "en-US",
      stability: 0.4,
      similarityBoost: 0.7,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    expect(provider.supportsTtsLanguage("en-US")).toBe(true);
    expect(provider.supportsTtsSpeed(1.2)).toBe(true);
    const session = await provider.openSession({
      ...request,
      speed: 1.2,
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({ model: "custom-model", voice: "voice", language: "en" }),
      ],
    });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("model_id")).toBe("custom-model");
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.get("sync_alignment")).toBe("true");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      text: " ",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.7,
        speed: 1.2,
      },
    });
    await session.cancel();
  });

  it("accepts a request language for an opted-in unknown model at selection and open", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "custom-model",
      allowUnknownModel: true,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    expect(provider.supportsTtsLanguage("hi-IN", "custom-model")).toBe(true);
    const session = await provider.openSession({
      ...request,
      model: "custom-model",
      language: "hi-IN",
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({ model: "custom-model", voice: "voice" }),
      ],
    });

    expect(new URL(openedUrl).searchParams.get("language_code")).toBe("hi");
    await session.cancel();
  });

  it("passes documented regular WebSocket controls without changing the shared PCM contract", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "en",
      useSpeakerBoost: true,
      autoMode: false,
      chunkLengthSchedule: [50, 100, 160],
      applyTextNormalization: "on",
      enableLogging: false,
      enableSsmlParsing: false,
      seed: 42,
      inactivityTimeoutSeconds: 30,
      pronunciationDictionaryLocators: [{ id: "dict", versionId: "v1" }],
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      ...request,
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({
          model: "eleven_flash_v2_5",
          voice: "voice",
          language: "en",
          speakerBoost: true,
          forcedNormalization: true,
        }),
      ],
    });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.get("auto_mode")).toBe("false");
    expect(url.searchParams.get("apply_text_normalization")).toBe("on");
    expect(url.searchParams.get("enable_logging")).toBe("false");
    expect(url.searchParams.get("enable_ssml_parsing")).toBe("false");
    expect(url.searchParams.get("seed")).toBe("42");
    expect(url.searchParams.get("inactivity_timeout")).toBe("30");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        voice_settings: expect.objectContaining({ use_speaker_boost: true }),
        generation_config: { chunk_length_schedule: [50, 100, 160] },
        pronunciation_dictionary_locators: [{ id: "dict", version_id: "v1" }],
      }),
    );

    await session.sendText("A complete sentence.", { tryTriggerGeneration: true });
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      text: "A complete sentence.",
      try_trigger_generation: true,
    });
    await session.sendText("", { tryTriggerGeneration: true });
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({
      text: " ",
      try_trigger_generation: true,
    });
    await session.cancel();
  });

  it.each(["websocket", "multi-context"] as const)(
    "does not preserve SSML parsing from a custom %s URL",
    async (route) => {
      const socket = new FakeSocket();
      let openedUrl = "";
      if (route === "websocket") {
        const provider = new ElevenLabsTtsProvider({
          apiKey: "test",
          voiceId: "voice",
          url: "wss://example.test/stream?enable_ssml_parsing=true&apply_text_normalization=on",
          webSocketFactory: (url) => {
            openedUrl = url;
            return socket as never;
          },
        });
        const session = await provider.openSession(request);
        await session.cancel();
      } else {
        const provider = new ElevenLabsMultiContextProvider({
          apiKey: "test",
          voiceId: "voice",
          url: "wss://example.test/stream?enable_ssml_parsing=true&apply_text_normalization=on",
          webSocketFactory: (url) => {
            openedUrl = url;
            return socket as never;
          },
        });
        const connection = await provider.openConnection();
        await connection.close();
      }

      expect(new URL(openedUrl).searchParams.get("enable_ssml_parsing")).toBe("false");
      expect(new URL(openedUrl).searchParams.has("apply_text_normalization")).toBe(false);
    },
  );

  it("does not preserve SSML parsing from a custom HTTP URL", async () => {
    let requestedUrl = "";
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "test",
      voiceId: "voice",
      url: "https://example.test/tts?enable_ssml_parsing=true&apply_text_normalization=on",
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(new Uint8Array([0, 0]), { status: 200 });
      },
    });

    await provider.synthesize({
      ...request,
      timestamps: false,
      text: "Hello",
      stream: false,
    });

    expect(new URL(requestedUrl).searchParams.has("enable_ssml_parsing")).toBe(false);
    expect(new URL(requestedUrl).searchParams.has("apply_text_normalization")).toBe(false);
  });

  it("keeps dictionary configuration explicit while removing SSML URL overrides", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2",
      url: "wss://example.test/stream?enable_ssml_parsing=true",
      pronunciationDictionaryLocators: [{ id: "dictionary", versionId: "version" }],
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    const session = await provider.openSession(request);

    expect(new URL(openedUrl).searchParams.has("enable_ssml_parsing")).toBe(false);
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      pronunciation_dictionary_locators: [{ id: "dictionary", version_id: "version" }],
    });
    await session.cancel();
  });

  it("enables regular WebSocket auto mode without a chunk schedule", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      autoMode: true,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession(request);
    expect(new URL(openedUrl).searchParams.get("auto_mode")).toBe("true");
    await session.cancel();
  });

  it("supports registered multi-speaker v3 turns and dialogue keep-alive", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-a",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
      webSocketFactory: () => socket as never,
    });

    const session = await provider.openSession({ ...request, model: "eleven_v3" });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        voices: ["voice-a", "voice-b"],
        voice_settings: { stability: 0.5 },
      }),
    );
    await session.sendText("Speaker A starts the conversation.");
    await session.sendDialogueTurn("Speaker B answers the conversation.", {
      voiceId: "voice-b",
      newTurn: true,
    });
    await session.keepAlive();
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      inputs: [{ text: "Speaker A starts the conversation.", voice_id: "voice-a" }],
    });
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({
      inputs: [
        { text: "Speaker B answers the conversation.", voice_id: "voice-b", new_turn: true },
      ],
    });
    expect(JSON.parse(socket.sent[3] ?? "{}")).toEqual({ keep_alive: true });
    await session.cancel();
  });

  it("checks every registered WebSocket dialogue voice against supplied snapshots", async () => {
    const socket = new FakeSocket();
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-a",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
      webSocketFactory: () => {
        factoryCalls += 1;
        return socket as never;
      },
    });

    await expect(
      provider.openSession({
        ...request,
        model: "eleven_v3",
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({ model: "eleven_v3", voice: "voice-a" }),
        ],
      }),
    ).rejects.toMatchObject({ provider: PROVIDER_NAMES.elevenlabs });
    expect(factoryCalls).toBe(0);
  });

  it("preserves square-bracket text on the ElevenLabs dialogue route", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v3",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession({ ...request, model: "eleven_v3" });
    const sentCount = socket.sent.length;

    await session.sendText("[whispers]Hello");
    await session.sendText("[whispers");
    expect(JSON.parse(socket.sent[sentCount] ?? "{}")).toEqual({
      inputs: [{ text: "[whispers]Hello", voice_id: "voice" }],
    });
    expect(JSON.parse(socket.sent[sentCount + 1] ?? "{}")).toEqual({
      inputs: [{ text: "[whispers", voice_id: "voice" }],
    });
    await session.cancel();
  });

  it("preserves SSML-shaped text when pronunciation dictionaries are configured", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      pronunciationDictionaryLocators: [{ id: "dictionary", versionId: "version" }],
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession(request);
    const sentCount = socket.sent.length;

    const text = '<phoneme alphabet="ipa" ph="həˈloʊ">hello</phoneme>';
    await session.sendText(text);
    expect(JSON.parse(socket.sent[sentCount] ?? "{}")).toMatchObject({
      text,
    });
    await session.cancel();
  });

  it.each([
    [
      "multiple conversational voices",
      { model: "eleven_v3_conversational", dialogueVoices: ["a", "b"] },
    ],
    ["multiple v4 Turbo voices", { model: "eleven_v4_turbo", dialogueVoices: ["voice", "b"] }],
    ["dialogue auto mode", { model: "eleven_v3_conversational", autoMode: true }],
    ["out-of-range seed", { model: "eleven_flash_v2_5", seed: 4_294_967_296 }],
  ] as const)("rejects invalid documented option: %s", async (_name, override) => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
      ...override,
    });

    await expect(provider.openSession({ ...request, model: override.model })).rejects.toMatchObject(
      {
        code: PROVIDER_NAMES.elevenlabs + ".tts.error",
      },
    );
    expect(factoryCalls).toBe(0);
  });

  it("uses the protocol-specific seed bounds", async () => {
    const regular = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      seed: 0,
      webSocketFactory: () => new FakeSocket() as never,
    });
    await expect(regular.openSession(request)).resolves.toBeDefined();

    const dialogue = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v3",
      seed: 0,
      webSocketFactory: () => new FakeSocket() as never,
    });
    await expect(dialogue.openSession(request)).rejects.toMatchObject({
      code: PROVIDER_NAMES.elevenlabs + ".tts.error",
    });
  });

  it("rejects v3-incompatible speed, similarity, and speaker controls before connecting", async () => {
    for (const [providerOptions, requestOverride, expectedCode] of [
      [{}, { speed: 1.1 }, TVIC_ERROR_CODES.providerInvalidRequest],
      [{ similarityBoost: 0.7 }, {}, PROVIDER_NAMES.elevenlabs + ".tts.error"],
      [{ useSpeakerBoost: true }, {}, PROVIDER_NAMES.elevenlabs + ".tts.error"],
    ] as const) {
      let factoryCalls = 0;
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_v3",
        webSocketFactory: () => {
          factoryCalls += 1;
          return new FakeSocket() as never;
        },
        ...providerOptions,
      });

      await expect(
        provider.openSession({ ...request, model: "eleven_v3", ...requestOverride }),
      ).rejects.toMatchObject({
        code: expectedCode,
      });
      expect(factoryCalls).toBe(0);
    }
  });

  it.each([
    ["speed below provider range", { speed: 0.69 }],
    ["speed above provider range", { speed: 1.21 }],
  ])("%s is rejected before connecting", async (_name, override) => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openSession({ ...request, ...override })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    expect(factoryCalls).toBe(0);
  });

  it("uses the unsupported-voice error code for an empty voice before connecting", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openSession({ ...request, voice: "" })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerVoiceUnsupported,
    });
    expect(factoryCalls).toBe(0);
  });

  it.each([
    ["invalid base64", "%%%="],
    ["odd-byte PCM", Buffer.from([1]).toString("base64")],
  ])("fails closed on %s", async (_name, audio) => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const next = session.events[Symbol.asyncIterator]().next();

    socket.receive({ audio });

    await expect(next).rejects.toMatchObject({
      code: PROVIDER_NAMES.elevenlabs + ".tts.error",
      category: "provider",
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("ignores empty audio fields and does not commit a turn without audio", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({ audio: "", is_final_audio_for_turn: false });
    socket.receive({
      audio: "",
      is_final_audio_for_turn: true,
      alignment: {
        chars: ["h"],
        char_start_times_ms: [0],
        char_durations_ms: [20],
      },
    });
    socket.receive({ audio: "", isFinal: true });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "tts.alignment", tokens: ["h"] },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects invalid alignment and unknown state-bearing messages", async () => {
    for (const message of [
      { alignment: { chars: ["x"], charStartTimesMs: [-1], charDurationsMs: [10] } },
      { alignment: { chars: "x", charStartTimesMs: [0], charDurationsMs: [10] } },
      { type: "heartbeat" },
    ]) {
      const socket = new FakeSocket();
      const session = new ElevenLabsTtsStream(socket as never, request, {
        clock: fixedClock,
        stability: 0.5,
        similarityBoost: 0.8,
      });
      const next = session.events[Symbol.asyncIterator]().next();

      socket.receive(message);

      await expect(next).rejects.toMatchObject({
        code: PROVIDER_NAMES.elevenlabs + ".tts.error",
      });
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }
  });

  it("preserves provider errors that include a numeric code", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const next = session.events[Symbol.asyncIterator]().next();

    socket.receive({ code: 1008, error: "voice is unavailable", message: "check voice access" });

    await expect(next).rejects.toMatchObject({
      code: `${PROVIDER_NAMES.elevenlabs}.tts.error`,
      message: "voice is unavailable",
      metadata: { providerCode: 1008 },
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("does not claim completion until isFinal and fails on unexpected EOF", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({ audio: Buffer.from([0, 0]).toString("base64") });
    const chunk = await iterator.next();
    expect(chunk.value).toMatchObject({ type: "media.audio.chunk" });
    socket.close();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "tts.transport.unexpected_eof",
    });

    const completedSocket = new FakeSocket();
    const completed = new ElevenLabsTtsStream(completedSocket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const completedIterator = completed.events[Symbol.asyncIterator]();
    completedSocket.receive({ isFinal: true });
    await expect(completedIterator.next()).resolves.toMatchObject({ done: true });
  });

  it("commits Text-to-Dialogue turn audio without completing the session", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(
      socket as never,
      {
        ...requestWithoutCapabilitySnapshot(),
        model: "eleven_v3_conversational",
        voice: "voice",
      },
      {
        clock: fixedClock,
        modelId: "eleven_v3_conversational",
        protocol: "dialogue",
        voice: "voice",
        voices: ["voice"],
        stability: 0.5,
        similarityBoost: 0.8,
      },
    );
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({
      audio: Buffer.from([0, 0]).toString("base64"),
      is_final_audio_for_turn: true,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "media.audio.chunk" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        type: "media.audio.committed",
        chunkIds: [expect.any(String)],
      }),
      done: false,
    });
    socket.close();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "tts.transport.unexpected_eof",
    });
  });

  it("accepts ElevenLabs nullable streaming markers", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({
      audio: Buffer.from([0, 0]).toString("base64"),
      isFinal: null,
      alignment: null,
      normalizedAlignment: null,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "media.audio.chunk" },
      done: false,
    });

    socket.receive({
      audio: null,
      isFinal: true,
      alignment: null,
      normalizedAlignment: null,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "media.audio.committed" },
      done: false,
    });
  });

  it("enforces the lifetime output-byte ceiling", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const chunk = Buffer.alloc(524_288).toString("base64");
    for (let index = 0; index < 21; index += 1) {
      socket.receive({ audio: chunk });
    }

    const iterator = session.events[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "provider.stream_buffer_overflow",
      provider: PROVIDER_NAMES.elevenlabs,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});

class FakeSocket {
  readonly sent: string[] = [];
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close");
  }

  fail(error: Error): void {
    this.#emit("error", error);
  }

  on(event: "message" | "close" | "error", handler: (value?: never) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (value?: unknown) => void);
    this.#handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (value?: never) => void): this {
    const registered = this.#handlers.get(event);
    if (registered) {
      this.#handlers.set(
        event,
        registered.filter((candidate) => candidate !== handler),
      );
    }
    return this;
  }

  receive(message: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(value);
    }
  }
}
