import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type Timestamp,
  type TtsSessionOpenRequest,
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

  it("omits the unsupported language code for multilingual v2", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_multilingual_v2",
      language: "hi",
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession({ ...request, language: "hi" });
    expect(new URL(openedUrl).searchParams.has("language_code")).toBe(false);
    await session.cancel();
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
    const session = await provider.openSession({ ...request, speed: 1.2 });
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
      enableSsmlParsing: true,
      seed: 42,
      inactivityTimeoutSeconds: 30,
      pronunciationDictionaryLocators: [{ id: "dict", versionId: "v1" }],
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession(request);
    const url = new URL(openedUrl);
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.get("auto_mode")).toBe("false");
    expect(url.searchParams.get("apply_text_normalization")).toBe("on");
    expect(url.searchParams.get("enable_logging")).toBe("false");
    expect(url.searchParams.get("enable_ssml_parsing")).toBe("true");
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
