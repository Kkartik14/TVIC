import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
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
      additionalVoices: ["voice-a", "voice-b", "fallback-voice", "another-voice"],
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
  it.each(["WebSocket", "REST", "HTTP stream"] as const)(
    "requires an account snapshot for the configured voice before %s connects",
    async (route) => {
      const webSocketFactory = vi.fn(() => {
        throw new Error("socket should not be created");
      });
      let fetchCalls = 0;
      const fetchImpl: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
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

      await expect(
        provider.synthesize({ ...requestWithoutCapabilitySnapshot(), text: "Hello", stream: true }),
      ).rejects.toThrow(/snapshot_missing/u);
      expect(webSocketFactory).not.toHaveBeenCalled();
      expect(fetchCalls).toBe(0);
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
    "rejects speaker boost without a fresh capability snapshot before %s sends a request",
    async (route) => {
      const webSocketFactory = vi.fn(() => {
        throw new Error("socket should not be created");
      });
      const fetchImpl = vi.fn(async () => {
        throw new Error("HTTP request should not be sent");
      });
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

      await expect(
        provider.synthesize({
          ...requestWithoutCapabilitySnapshot(),
          text: "Hello",
          stream: true,
        }),
      ).rejects.toThrow(/snapshot_missing/u);
      expect(webSocketFactory).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("requires a voice locale fact before sending an explicitly configured language", async () => {
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
      provider.synthesize({ ...requestWithoutCapabilitySnapshot(), text: "Hello", stream: true }),
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
    "requires a capability snapshot for per-call %s selection",
    async (_field, selection) => {
      const webSocketFactory = vi.fn(() => {
        throw new Error("socket should not be created");
      });
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test",
        voiceId: "voice",
        modelId: "eleven_flash_v2_5",
        webSocketFactory,
      });

      await expect(
        provider.openSession({ ...requestWithoutCapabilitySnapshot(), ...selection }),
      ).rejects.toThrow(/snapshot_missing/u);
      expect(webSocketFactory).not.toHaveBeenCalled();
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

  it.each([
    [
      "websocket",
      () =>
        new ElevenLabsTtsProvider({ apiKey: "test", voiceId: "voice", enableSsmlParsing: true }),
    ],
    [
      "REST",
      () =>
        new ElevenLabsTtsRestProvider({
          apiKey: "test",
          voiceId: "voice",
          enableSsmlParsing: true,
        }),
    ],
    [
      "HTTP stream",
      () =>
        new ElevenLabsTtsHttpStreamProvider({
          apiKey: "test",
          voiceId: "voice",
          enableSsmlParsing: true,
        }),
    ],
    [
      "multi-context",
      () =>
        new ElevenLabsMultiContextProvider({
          apiKey: "test",
          voiceId: "voice",
          enableSsmlParsing: true,
        }),
    ],
  ])("rejects SSML parsing during %s provider construction", (_route, createProvider) => {
    expect(createProvider).toThrow(/SSML parsing is disabled/);
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
    const language =
      !model.startsWith("eleven_v3") && model !== "eleven_multilingual_v2" ? "en" : undefined;
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
    expect(provider.configuredLanguage).toBe(
      !model.startsWith("eleven_v3") && model !== "eleven_multilingual_v2" ? "en" : undefined,
    );

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
    if (model.startsWith("eleven_v3")) {
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
    expect(provider.usageAccounting).toEqual({ reportsTextCharacters: true });
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
      stability: 0.4,
      similarityBoost: 0.7,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      ...request,
      speed: 1.2,
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({ model: "custom-model", voice: "voice" }),
      ],
    });
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

  it("ignores empty audio fields and still commits when the final marker arrives", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({ audio: "" });
    socket.receive({ audio: "", isFinal: true });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "media.audio.committed" },
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
