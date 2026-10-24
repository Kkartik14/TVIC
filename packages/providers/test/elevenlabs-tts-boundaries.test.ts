import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  createSpeechControlCatalogSnapshot,
  type SessionId,
  type Timestamp,
  type TtsSessionOpenRequest,
  type TtsSynthesisRequest,
  type TurnId,
} from "@tvic/core";

import { ElevenLabsTtsProvider, ElevenLabsTtsStream } from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";

const request: TtsSessionOpenRequest = {
  sessionId: "elevenlabs-session" as SessionId,
  turnId: "elevenlabs-turn" as TurnId,
  format: PCM16_16K_MONO,
  timestamps: true,
};

const fixedClock = {
  now(): Timestamp {
    return "2026-09-24T00:00:00.000Z" as Timestamp;
  },
};

const speakerBoostVoiceFact = {
  provider: "elevenlabs",
  control: "tts.voice",
  scope: { type: "account" as const, model: "eleven_flash_v2", voice: "voice" },
  status: "supported" as const,
  mutability: "call" as const,
  source: "https://elevenlabs.io/docs/api-reference/voices/search",
  verifiedAt: "2026-10-25",
};

function dialogueVoiceCatalog(model: string, voices: readonly string[]) {
  return createSpeechControlCatalogSnapshot(
    voices.map((voice) => ({
      provider: "elevenlabs",
      control: "tts.voice",
      scope: { type: "account" as const, model, voice },
      status: "supported" as const,
      mutability: "provider" as const,
      source: "https://elevenlabs.io/docs/api-reference/voices/search",
      verifiedAt: "2026-10-25",
    })),
    { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
  );
}

function supportedSpeakerBoostCatalog(model: string, voice = "voice") {
  return createSpeechControlCatalogSnapshot(
    [
      {
        ...speakerBoostVoiceFact,
        scope: { type: "account" as const, model, voice },
      },
      {
        provider: "elevenlabs",
        control: "tts.speaker_boost",
        scope: { type: "model" as const, model },
        status: "supported" as const,
        mutability: "call" as const,
        source: "https://elevenlabs.io/docs/api-reference/models/list",
        verifiedAt: "2026-10-25",
      },
    ],
    { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
  );
}

describe("ElevenLabs TTS boundaries", () => {
  it("declares model-aware request language and speed support", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
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
    expect(provider.supportsVoice("  ")).toBe(false);
  });

  it("declares request-level normalization and pronunciation dictionary support", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
    });
    const selection = {
      model: "eleven_flash_v2_5",
      voice: "voice",
      textNormalization: "on",
      pronunciationDictionaries: [{ id: "dictionary", version: "v2" }],
      speechControlCatalog: createSpeechControlCatalogSnapshot(
        [
          {
            provider: "elevenlabs",
            control: "tts.text_normalization.forced",
            scope: { type: "account", model: "eleven_flash_v2_5" },
            status: "supported",
            mutability: "call",
            source: "https://elevenlabs.io/docs/api-reference/user/subscription/get",
            verifiedAt: "2026-10-25",
          },
          {
            provider: "elevenlabs",
            control: "tts.voice",
            scope: { type: "account", model: "eleven_flash_v2_5", voice: "voice" },
            status: "supported",
            mutability: "provider",
            source: "https://elevenlabs.io/docs/api-reference/voices/search",
            verifiedAt: "2026-10-25",
          },
        ],
        { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
      ),
    } as const;

    expect(
      provider.supportsTtsTextNormalization("on", {
        model: selection.model,
        voice: selection.voice,
        textNormalization: selection.textNormalization,
        pronunciationDictionaries: selection.pronunciationDictionaries,
      }),
    ).toBe(false);
    expect(provider.supportsTtsTextNormalization("on", selection)).toBe(true);
    expect(
      provider.supportsTtsTextNormalization({ mode: "locale", locale: "hi-IN" }, selection),
    ).toBe(false);
    expect(
      provider.supportsTtsPronunciationDictionaries(selection.pronunciationDictionaries, selection),
    ).toBe(true);
    expect(provider.supportsTtsSelection(selection)).toBe(true);
  });

  it("preflights voice syntax and dialogue registration against the selected model", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-a",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
    });

    expect(provider.supportsVoice("voice-b", "eleven_v3")).toBe(true);
    expect(provider.supportsVoice("voice-unlisted", "eleven_v3")).toBe(false);
    expect(provider.supportsVoice("voice\u0001bad", "eleven_v3")).toBe(false);
    expect(provider.supportsVoice("voice\u0001bad", "eleven_flash_v2_5")).toBe(false);
  });

  it("rejects an unlisted secondary dialogue voice before opening the socket", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-a",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });
    const snapshot = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "elevenlabs",
          control: "tts.voice",
          scope: { type: "account", model: "eleven_v3", voice: "voice-a" },
          status: "supported",
          mutability: "provider",
          source: "https://elevenlabs.io/docs/api-reference/voices/search",
          verifiedAt: "2026-10-25",
        },
      ],
      { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
    );

    await expect(
      provider.openSession({ ...request, model: "eleven_v3", speechControlCatalog: snapshot }),
    ).rejects.toThrow(/account voice catalog unknown for voice voice-b/u);
    expect(socketCalls).toBe(0);
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

  it("uses request-level text normalization and dictionaries over configured values", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2",
      applyTextNormalization: "off",
      pronunciationDictionaryLocators: [{ id: "configured-dictionary", versionId: "v1" }],
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      ...request,
      model: "eleven_flash_v2",
      textNormalization: "on",
      pronunciationDictionaries: [{ id: "call-dictionary", version: "v2" }],
    });

    expect(new URL(openedUrl).searchParams.get("apply_text_normalization")).toBe("on");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        pronunciation_dictionary_locators: [{ id: "call-dictionary", version_id: "v2" }],
      }),
    );
    await session.cancel();
  });

  it("rejects forced v2.5 normalization without an Enterprise account snapshot", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...request, model: "eleven_flash_v2_5", textNormalization: "on" }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(socketCalls).toBe(0);
  });

  it("preflights configured forced normalization against the account snapshot", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      applyTextNormalization: "on",
    });
    const nonEnterpriseSnapshot = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "elevenlabs",
          control: "tts.text_normalization.forced",
          scope: { type: "account", model: "eleven_flash_v2_5" },
          status: "unsupported",
          mutability: "call",
          source: "https://elevenlabs.io/docs/api-reference/user/subscription/get",
          verifiedAt: "2026-10-25",
        },
      ],
      { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
    );

    expect(
      provider.supportsTtsSelection({
        model: "eleven_flash_v2_5",
        voice: "voice",
        speechControlCatalog: nonEnterpriseSnapshot,
      }),
    ).toBe(false);
  });

  it("preflights configured pronunciation dictionary references", () => {
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      pronunciationDictionaryLocators: [{ id: "invalid\ndictionary" }],
    });

    expect(provider.supportsTtsSelection({ model: "eleven_flash_v2", voice: "voice" })).toBe(false);
  });

  it("serializes forced v2.5 normalization with a supported account snapshot", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    const enterpriseSnapshot = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "elevenlabs",
          control: "tts.text_normalization.forced",
          scope: { type: "account", model: "eleven_flash_v2_5" },
          status: "supported",
          mutability: "call",
          source: "https://elevenlabs.io/docs/api-reference/user/subscription/get",
          verifiedAt: "2026-10-25",
        },
        {
          provider: "elevenlabs",
          control: "tts.voice",
          scope: { type: "account", model: "eleven_flash_v2_5", voice: "voice" },
          status: "supported",
          mutability: "provider",
          source: "https://elevenlabs.io/docs/api-reference/voices/search",
          verifiedAt: "2026-10-25",
        },
      ],
      { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
    );

    const session = await provider.openSession({
      ...request,
      model: "eleven_flash_v2_5",
      textNormalization: "on",
      speechControlCatalog: enterpriseSnapshot,
    });

    expect(new URL(openedUrl).searchParams.get("apply_text_normalization")).toBe("on");
    await session.cancel();
  });

  it("rejects locale normalization before opening a connection", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({
        ...request,
        textNormalization: { mode: "locale", locale: "hi-IN" },
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(socketCalls).toBe(0);
  });

  it("rejects unsupported locale normalization and malformed dictionaries before connecting", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({
        ...request,
        textNormalization: { mode: "locale", locale: "hi-IN" },
      }),
    ).rejects.toMatchObject({
      code: "provider.invalid_request",
    });
    await expect(
      provider.openSession({
        ...request,
        pronunciationDictionaries: [{ id: "dictionary\nbad" }],
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(socketCalls).toBe(0);
  });

  it("rejects SSML parsing during provider construction", () => {
    let socketCalls = 0;
    expect(
      () =>
        new ElevenLabsTtsProvider({
          apiKey: "test",
          voiceId: "voice",
          modelId: "eleven_flash_v2_5",
          enableSsmlParsing: true,
          webSocketFactory: () => {
            socketCalls += 1;
            return new FakeSocket() as never;
          },
        }),
    ).toThrow(/SSML parsing is disabled/u);
    expect(socketCalls).toBe(0);
  });

  it.each([
    {
      status: "unsupported",
      facts: [
        speakerBoostVoiceFact,
        {
          provider: "elevenlabs",
          control: "tts.speaker_boost",
          scope: { type: "model" as const, model: "eleven_flash_v2_5" },
          status: "unsupported" as const,
          mutability: "call" as const,
          source: "https://elevenlabs.io/docs/api-reference/models/list",
          verifiedAt: "2026-10-25",
        },
      ],
      fetchedAt: "2026-10-24T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
    },
    {
      status: "unknown",
      facts: [speakerBoostVoiceFact],
      fetchedAt: "2026-10-24T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
    },
    {
      status: "expired",
      facts: [
        speakerBoostVoiceFact,
        {
          provider: "elevenlabs",
          control: "tts.speaker_boost",
          scope: { type: "model" as const, model: "eleven_flash_v2_5" },
          status: "supported" as const,
          mutability: "call" as const,
          source: "https://elevenlabs.io/docs/api-reference/models/list",
          verifiedAt: "2026-10-25",
        },
      ],
      fetchedAt: "2020-01-01T00:00:00.000Z",
      validUntil: "2020-01-02T00:00:00.000Z",
    },
  ])(
    "rejects explicit speaker boost when its model catalog fact is $status",
    async ({ status, facts, fetchedAt, validUntil }) => {
      let socketCalls = 0;
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2",
        useSpeakerBoost: true,
        webSocketFactory: () => {
          socketCalls += 1;
          return new FakeSocket() as never;
        },
      });
      const speechControlCatalog = createSpeechControlCatalogSnapshot(facts, {
        fetchedAt,
        validUntil,
      });

      await expect(provider.openSession({ ...request, speechControlCatalog })).rejects.toThrow(
        status === "expired" ? /catalog expired/u : /speaker boost catalog/u,
      );
      expect(socketCalls).toBe(0);
    },
  );

  it("accepts disabled SSML parsing on the dialogue route", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v3",
      dialogueVoices: ["voice"],
      enableSsmlParsing: false,
      webSocketFactory: () => socket as never,
    });

    const session = await provider.openSession({ ...request, model: "eleven_v3" });
    await session.sendText("Hello.");
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      inputs: [{ text: "Hello.", voice_id: "voice" }],
    });
    await session.cancel();
  });

  it.each(["eleven_v3", "eleven_v4"])(
    "sends bracketed caller text unchanged on %s dialogue",
    async (model) => {
      const socket = new FakeSocket();
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: model,
        dialogueVoices: ["voice"],
        webSocketFactory: () => socket as never,
      });
      const session = await provider.openSession({ ...request, model });
      const before = socket.sent.length;

      await session.sendText("The caller wrote [laughs].");
      await session.sendDialogueTurn("Please read [laughs] as text.");
      const sent = socket.sent.slice(before).map((payload) => JSON.parse(payload));
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ inputs: [{ text: "The caller wrote [laughs]." }] });
      expect(sent[1]).toMatchObject({ inputs: [{ text: "Please read [laughs] as text." }] });
      await session.cancel();
    },
  );

  it("rejects typed text parts before the WebSocket route opens", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      webSocketFactory: () => {
        socketCalls += 1;
        throw new Error("connection should not open");
      },
    });
    const synthesisRequest = {
      ...request,
      text: "A7B9",
      stream: false,
      textParts: [{ type: "spell", text: "A7B9" }],
    } satisfies TtsSynthesisRequest;

    await expect(provider.synthesize(synthesisRequest)).rejects.toMatchObject({
      code: "provider.invalid_request",
    });
    expect(socketCalls).toBe(0);
  });

  it("requires an account snapshot for a request-level voice before opening the WebSocket", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "configured-voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...request, voice: "account-custom-voice" }),
    ).rejects.toThrow(/requires a current account voice catalog/u);
    expect(socketCalls).toBe(0);
  });

  it("rejects an expired account voice snapshot before opening the WebSocket", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "configured-voice",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });
    const expiredCatalog = createSpeechControlCatalogSnapshot([], {
      fetchedAt: "2020-01-01T00:00:00.000Z",
      validUntil: "2020-01-02T00:00:00.000Z",
    });

    await expect(
      provider.openSession({
        ...request,
        voice: "account-custom-voice",
        speechControlCatalog: expiredCatalog,
      }),
    ).rejects.toThrow(/catalog expired/u);
    expect(socketCalls).toBe(0);
  });

  it("routes request voices through a custom WebSocket URL or rejects a fixed route", async () => {
    let openedUrl = "";
    const routed = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      url: "wss://proxy.example/v1/text-to-speech/:voice_id/stream-input",
      webSocketFactory: (url) => {
        openedUrl = url;
        return new FakeSocket() as never;
      },
    });

    const session = await routed.openSession({
      ...request,
      voice: "voice-per-call",
      speechControlCatalog: accountVoiceCatalog("voice-per-call"),
    });
    expect(new URL(openedUrl).pathname).toBe("/v1/text-to-speech/voice-per-call/stream-input");
    await session.cancel();

    let socketCalls = 0;
    const fixed = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      url: "wss://proxy.example/v1/text-to-speech/voice-configured/stream-input",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      fixed.openSession({
        ...request,
        voice: "voice-per-call",
        speechControlCatalog: accountVoiceCatalog("voice-per-call"),
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
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

  it("rejects language configuration for multilingual v2 before opening", async () => {
    let socketCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_multilingual_v2",
      language: "hi",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openSession(request)).rejects.toThrow(
      /language_code is not supported by eleven_multilingual_v2/,
    );
    expect(socketCalls).toBe(0);
  });

  it.each(PROVIDER_CATALOG.elevenlabs.models)("opens every catalog model: %s", async (model) => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: model,
      ...(model !== "eleven_multilingual_v2" ? { language: "en" } : {}),
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });
    expect(provider.configuredModel).toBe(model);
    expect(provider.configuredVoice).toBe("voice");
    expect(provider.configuredLanguage).toBe(model !== "eleven_multilingual_v2" ? "en" : undefined);

    const session = await provider.openSession(request);
    const url = new URL(openedUrl);
    expect(url.searchParams.get("model_id")).toBe(model);
    if (model.startsWith("eleven_v3") || model.startsWith("eleven_v4")) {
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
    socket.receive({ is_final_audio_for_turn: true });
    await session.sendText(" Continue the same session.");
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

  it("allows an explicitly configured unknown model and preserves URL/config fields", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "custom-model",
      allowUnknownModel: true,
      stability: 0.4,
      similarityBoost: 0.7,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession({ ...request, speed: 1.2 });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("model_id")).toBe("custom-model");
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
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

  it("passes documented regular WebSocket controls without changing the shared PCM contract", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_flash_v2",
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
      speechControlCatalog: supportedSpeakerBoostCatalog("eleven_flash_v2"),
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

    const session = await provider.openSession({
      ...request,
      model: "eleven_v3",
      speechControlCatalog: dialogueVoiceCatalog("eleven_v3", ["voice-a", "voice-b"]),
    });
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
    for (const [providerOptions, requestOverride] of [
      [{}, { speed: 1.1 }],
      [{ similarityBoost: 0.7 }, {}],
      [{ useSpeakerBoost: true }, {}],
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
        code: PROVIDER_NAMES.elevenlabs + ".tts.error",
      });
      expect(factoryCalls).toBe(0);
    }
  });

  it.each([
    ["empty voice", { voice: "" }],
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
      code: PROVIDER_NAMES.elevenlabs + ".tts.error",
    });
    expect(factoryCalls).toBe(0);
  });

  it.each([
    ["invalid base64", "%%%="],
    ["empty audio", ""],
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
    await expect(completedIterator.next()).resolves.toMatchObject({
      value: { type: "media.audio.committed" },
      done: false,
    });
    await expect(completedIterator.next()).resolves.toMatchObject({ done: true });
  });

  it("does not treat a dialogue per-turn marker as regular-session completion", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({
      audio: Buffer.from([0, 0]).toString("base64"),
      is_final_audio_for_turn: true,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "media.audio.chunk" },
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

function accountVoiceCatalog(...voices: readonly string[]) {
  return createSpeechControlCatalogSnapshot(
    voices.map((voice) => ({
      provider: "elevenlabs",
      control: "tts.voice",
      scope: { type: "account" as const, voice },
      status: "supported" as const,
      mutability: "call" as const,
      source: "https://elevenlabs.io/docs/api-reference/voices/search",
      verifiedAt: "2026-10-25",
    })),
    { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z" },
  );
}

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

  on(event: "message" | "close" | "error", handler: (value?: never) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (value?: unknown) => void);
    this.#handlers.set(event, handlers);
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
