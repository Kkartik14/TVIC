import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type Timestamp,
  type TtsEvent,
  type TtsSynthesisRequest,
  type TtsUsageReporter,
  type TurnId,
} from "@tvic/core";

import {
  ElevenLabsTtsProvider,
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsRestProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsRestProvider,
} from "../src/index.js";
import { elevenLabsCapabilitySnapshot } from "./elevenlabs-capability-fixtures.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";

const request: TtsSynthesisRequest = {
  sessionId: "elevenlabs-http-session" as SessionId,
  turnId: "elevenlabs-http-turn" as TurnId,
  format: PCM16_16K_MONO,
  text: "Hello from TVIC.",
  model: "eleven_flash_v2_5",
  stream: true,
  providerCapabilitySnapshots: [
    elevenLabsCapabilitySnapshot({
      model: "eleven_flash_v2_5",
      additionalModels: PROVIDER_CATALOG.elevenlabs.models,
      voice: "voice-http-usage",
      additionalVoices: [
        "voice",
        "voice-rest",
        "voice-stream",
        "fallback-voice",
        "voice-a",
        "voice-b",
        "voice-per-call",
        "voice-free-form",
      ],
      language: "en",
    }),
  ],
};

const fixedClock = {
  now(): Timestamp {
    return "2026-09-25T00:00:00.000Z" as Timestamp;
  },
};

function usageReporter(
  observations: Array<{ field: string; status: string; value?: number; reason?: string }>,
  textCharacters?: number[],
): TtsUsageReporter {
  return {
    report(observation) {
      observations.push(observation);
    },
    beginOperation(input) {
      return {
        report(value) {
          observations.push({ ...input, status: "reported", value });
        },
        notReported(reason) {
          observations.push({ ...input, status: "not_reported", reason });
        },
        finish() {},
      };
    },
    reportTextCharacters(value) {
      textCharacters?.push(value);
    },
  };
}

describe("ElevenLabs complete HTTP TTS", () => {
  it.each([
    ["REST", createElevenLabsTtsRestProvider],
    ["HTTP streaming", createElevenLabsTtsHttpStreamProvider],
  ])("counts caller text for %s synthesis", async (_transport, createProvider) => {
    const textCharacters: number[] = [];
    const provider = createProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-http-usage",
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });

    await provider.synthesize({
      ...request,
      text: "A🌟",
      usageReporter: usageReporter([], textCharacters),
    });

    expect(textCharacters).toEqual([2]);
    expect(provider.usageAccounting).toEqual({
      reportsTextCharacters: true,
      usesRequestModelForUsage: true,
    });
  });

  it("counts dialogue input text but excludes surrounding context", async () => {
    const textCharacters: number[] = [];
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-http-usage",
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });

    await provider.synthesizeDialogue({
      sessionId: request.sessionId,
      turnId: request.turnId,
      format: request.format,
      model: "eleven_v3",
      inputs: [
        { text: "Hi", voiceId: "voice-http-usage" },
        { text: "🌟", voiceId: "voice-http-usage" },
      ],
      previousText: "Context before.",
      futureText: "Context after.",
      stream: false,
      usageReporter: usageReporter([], textCharacters),
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({ model: "eleven_v3", voice: "voice-http-usage" }),
      ],
    });

    expect(textCharacters).toEqual([3]);
  });

  it("counts a valid REST text attempt when the request fails", async () => {
    const textCharacters: number[] = [];
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-http-usage",
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    });

    await expect(
      provider.synthesize({
        ...request,
        text: "A🌟",
        usageReporter: usageReporter([], textCharacters),
      }),
    ).rejects.toBeDefined();

    expect(textCharacters).toEqual([2]);
  });

  it("preserves Dialogue audio tags in REST and HTTP-stream requests", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    };
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_v3",
        voiceId: "voice-rest",
        fetchImpl,
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_v3",
        voiceId: "voice-stream",
        fetchImpl,
      }),
    ];

    for (const provider of providers) {
      await provider.synthesize({ ...request, model: "eleven_v3", text: "[whispers]Hello" });
    }
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.inputs).toEqual([{ text: "[whispers]Hello", voice_id: "voice-rest" }]);
    expect(requestBodies[1]?.inputs).toEqual([
      { text: "[whispers]Hello", voice_id: "voice-stream" },
    ]);
  });

  it("preserves SSML-shaped text with dictionaries in REST and HTTP-stream requests", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    };
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_flash_v2_5",
        voiceId: "voice-rest",
        pronunciationDictionaryLocators: [{ id: "dictionary", versionId: "version" }],
        fetchImpl,
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_flash_v2_5",
        voiceId: "voice-stream",
        pronunciationDictionaryLocators: [{ id: "dictionary", versionId: "version" }],
        fetchImpl,
      }),
    ];

    const text = '<phoneme alphabet="ipa" ph="həˈloʊ">hello</phoneme>';
    for (const provider of providers) {
      await provider.synthesize({ ...request, text });
    }
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.text).toBe(text);
    expect(requestBodies[1]?.text).toBe(text);
  });

  it("treats empty configured languages as unset on REST and HTTP-stream", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const createFetch = (): typeof fetch => async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    };
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        modelId: "eleven_flash_v2_5",
        language: "",
        fetchImpl: createFetch(),
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_flash_v2_5",
        language: "",
        fetchImpl: createFetch(),
      }),
    ];

    for (const provider of providers) {
      expect(provider.configuredLanguage).toBeUndefined();
      expect(provider.supportsTtsSelection?.({})).toBe(true);
      await collectEvents(await provider.synthesize(request));
    }

    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !Object.hasOwn(body, "language_code"))).toBe(true);
  });

  it("uses the same unsupported-voice error code on WebSocket, REST, and HTTP-stream", async () => {
    const websocket = new ElevenLabsTtsProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      modelId: "eleven_flash_v2_5",
    });
    const rest = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      modelId: "eleven_flash_v2_5",
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });
    const httpStream = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      modelId: "eleven_flash_v2_5",
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });

    const outcomes = await Promise.all([
      websocket.openSession({ ...request, voice: "." }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      rest.synthesize({ ...request, voice: "." }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      httpStream.synthesize({ ...request, voice: "." }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
    ]);

    expect(outcomes).toEqual(Array(3).fill(TVIC_ERROR_CODES.providerVoiceUnsupported));
  });

  it("declares model-aware language and speed support on both HTTP routes", () => {
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        modelId: "eleven_flash_v2_5",
        knownVoiceIds: ["voice-per-call"],
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_flash_v2_5",
        knownVoiceIds: ["voice-per-call"],
      }),
    ];
    const configuredOnly = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
    });

    expect(configuredOnly.supportsVoice("voice-per-call")).toBe(true);

    for (const provider of providers) {
      expect(provider.supportsTtsLanguage("hi-IN")).toBe(true);
      expect(provider.supportsTtsLanguage("or-IN")).toBe(false);
      expect(provider.supportsTtsLanguage("hi-IN", "eleven_flash_v2")).toBe(false);
      expect(provider.supportsTtsSpeed(0.7)).toBe(true);
      expect(provider.supportsTtsSpeed(1.2)).toBe(true);
      expect(provider.supportsTtsSpeed(1.21)).toBe(false);
      expect(provider.supportsTtsSpeed(1, "eleven_v3")).toBe(false);
      expect(provider.supportsTtsSelection({ model: "bogus" })).toBe(false);
      expect(provider.supportsVoice("voice-per-call")).toBe(true);
      expect(provider.supportsVoice("  ")).toBe(false);
      expect(provider.supportsVoice("voice\u0001bad")).toBe(false);
      expect(provider.supportsVoice("v".repeat(257))).toBe(false);
    }
    expect(providers[0]?.capabilities.models).toContain("eleven_v4");
    expect(providers[0]?.capabilities.models).not.toContain("eleven_v4_turbo");
    expect(providers[1]?.capabilities.models).not.toContain("eleven_v4");
    expect(providers[1]?.capabilities.models).not.toContain("eleven_v4_turbo");
  });

  it("validates the configured language against a per-call model override on every transport", async () => {
    const websocket = new ElevenLabsTtsProvider({
      apiKey: "eleven-secret",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "hi-IN",
    });
    const rest = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "hi-IN",
      fetchImpl: async () => {
        throw new Error("unsupported language must fail before fetch");
      },
    });
    const httpStream = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      language: "hi-IN",
      fetchImpl: async () => {
        throw new Error("unsupported language must fail before fetch");
      },
    });
    const selection = { model: "eleven_flash_v2" };
    expect(websocket.supportsTtsSelection(selection)).toBe(false);
    expect(rest.supportsTtsSelection(selection)).toBe(false);
    expect(httpStream.supportsTtsSelection(selection)).toBe(false);

    const outcomes = await Promise.all([
      websocket.openSession({ ...request, ...selection }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      rest.synthesize({ ...request, ...selection }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      httpStream.synthesize({ ...request, ...selection }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
    ]);

    expect(outcomes).toEqual(Array(3).fill(TVIC_ERROR_CODES.ttsLanguageUnsupported));
  });

  it("uses the same language and speed validation codes on WebSocket, REST, and HTTP-stream", async () => {
    const websocket = new ElevenLabsTtsProvider({
      apiKey: "eleven-secret",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
    });
    const rest = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });
    const httpStream = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice",
      modelId: "eleven_flash_v2_5",
      fetchImpl: async () => new Response(new Uint8Array([1, 2]), { status: 200 }),
    });
    const languageOutcomes = await Promise.all([
      websocket.openSession({ ...request, model: "eleven_flash_v2", language: "hi-IN" }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      rest.synthesize({ ...request, model: "eleven_flash_v2", language: "hi-IN" }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      httpStream.synthesize({ ...request, model: "eleven_flash_v2", language: "hi-IN" }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
    ]);
    expect(languageOutcomes).toEqual(Array(3).fill(TVIC_ERROR_CODES.ttsLanguageUnsupported));

    const speedOutcomes = await Promise.all([
      websocket.openSession({ ...request, model: "eleven_flash_v2_5", speed: 1.21 }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      rest.synthesize({ ...request, model: "eleven_flash_v2_5", speed: 1.21 }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      httpStream.synthesize({ ...request, model: "eleven_flash_v2_5", speed: 1.21 }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
    ]);
    expect(speedOutcomes).toEqual(Array(3).fill(TVIC_ERROR_CODES.providerInvalidRequest));

    const modelSpeedOutcomes = await Promise.all([
      websocket.openSession({ ...request, model: "eleven_v3", speed: 1 }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      rest.synthesizeSpeech({ ...request, model: "eleven_v3", speed: 1 }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
      httpStream.synthesizeSpeech({ ...request, model: "eleven_v3", speed: 1 }).then(
        () => undefined,
        (error: { code?: string }) => error.code,
      ),
    ]);
    expect(modelSpeedOutcomes).toEqual(Array(3).fill(TVIC_ERROR_CODES.providerInvalidRequest));
  });

  it("routes opted-in unlisted v4 model families through dialogue on both HTTP transports", async () => {
    const urls: string[] = [];
    const createFetch = (): typeof fetch => async (input) => {
      urls.push(String(input));
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    };
    const rest = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      modelId: "eleven_v4_host_custom",
      allowUnknownModel: true,
      fetchImpl: createFetch(),
    });
    const httpStream = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      modelId: "eleven_v4_host_custom",
      allowUnknownModel: true,
      fetchImpl: createFetch(),
    });

    for (const provider of [rest, httpStream]) {
      expect(provider.supportsTtsSelection({})).toBe(true);
      await collectEvents(
        await provider.synthesize({
          ...request,
          model: "eleven_v4_host_custom",
          providerCapabilitySnapshots: [
            elevenLabsCapabilitySnapshot({
              model: "eleven_v4_host_custom",
              voice: "voice-rest",
              additionalVoices: ["voice-stream"],
            }),
          ],
        }),
      );
    }

    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes("/v1/text-to-dialogue"))).toBe(true);
    expect(urls.some((url) => url.includes("/v1/text-to-dialogue/stream"))).toBe(true);
  });

  it("checks a per-call voice against the selected model route", () => {
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "dialogue-default",
      modelId: "eleven_v3",
      dialogueVoices: ["dialogue-default", "dialogue-only"],
    });

    expect(provider.supportsVoice("dialogue-only")).toBe(true);
    expect(provider.supportsVoice("dialogue-only", "eleven_flash_v2_5")).toBe(true);
    expect(provider.supportsVoice("regular-provider-managed", "eleven_flash_v2_5")).toBe(true);
    expect(provider.supportsTtsSelection({ model: "eleven_flash_v2_5" })).toBe(false);
    expect(provider.supportsTtsSelection({ model: "eleven_v3" })).toBe(true);
  });

  it("rejects whitespace-only REST voice IDs consistently with supportsVoice", async () => {
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      modelId: "eleven_flash_v2_5",
    });

    expect(provider.supportsVoice("  ")).toBe(false);
    await expect(provider.synthesize({ ...request, voice: "  " })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerVoiceUnsupported,
    });
  });

  it("allows unknown HTTP models only when the provider opts into them", () => {
    const restricted = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
    });
    const permissive = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      allowUnknownModel: true,
    });

    expect(restricted.supportsTtsSelection({ model: "host-model" })).toBe(false);
    expect(permissive.supportsTtsSelection({ model: "host-model" })).toBe(true);
  });

  it("uses request-level language in REST and HTTP-stream speech bodies", async () => {
    const languages: Array<string | undefined> = [];
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        modelId: "eleven_flash_v2_5",
        language: "en-US",
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { language_code?: string };
          languages.push(body.language_code);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_flash_v2_5",
        language: "en-US",
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { language_code?: string };
          languages.push(body.language_code);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
    ];

    for (const provider of providers) {
      await collectEvents(await provider.synthesize({ ...request, language: "hi-IN" }));
    }

    expect(languages).toEqual(["hi", "hi"]);
  });

  it("rejects a language for multilingual v2 on REST and HTTP-stream instead of dropping language_code", async () => {
    let fetchCalls = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchCalls += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "content-type": "audio/pcm" },
      });
    };
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        modelId: "eleven_multilingual_v2",
        fetchImpl,
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_multilingual_v2",
        fetchImpl,
      }),
    ];

    for (const provider of providers) {
      const callsBefore = fetchCalls;
      expect(provider.supportsTtsLanguage("hi")).toBe(false);
      expect(provider.supportsTtsSelection({ language: "hi-IN" })).toBe(false);
      await expect(
        provider.synthesize({ ...request, model: "eleven_multilingual_v2", language: "hi-IN" }),
      ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.ttsLanguageUnsupported });
      expect(fetchCalls).toBe(callsBefore);
      await collectEvents(
        await provider.synthesize({ ...request, model: "eleven_multilingual_v2" }),
      );
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !Object.hasOwn(body, "language_code"))).toBe(true);
  });

  it("exposes its effective configured model and voice for failover", () => {
    for (const provider of [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_flash_v2_5",
        voiceId: "voice-rest",
        language: "en",
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        modelId: "eleven_flash_v2_5",
        voiceId: "voice-stream",
        language: "en",
      }),
    ]) {
      expect(provider.configuredModel).toBe("eleven_flash_v2_5");
      expect(provider.configuredVoice).toMatch(/^voice-/u);
      expect(provider.configuredLanguage).toBe("en");
    }
  });

  it("sends the documented regular TTS request and normalizes raw PCM", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    let url = "";
    let init: RequestInit | undefined;
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      language: "en",
      stability: 0.4,
      similarityBoost: 0.7,
      useSpeakerBoost: true,
      seed: 42,
      enableLogging: false,
      clock: fixedClock,
      fetchImpl: async (input, requestInit) => {
        url = String(input);
        init = requestInit;
        return new Response(pcm, { status: 200, headers: { "content-type": "audio/pcm" } });
      },
    });

    const events = await collectEvents(
      await provider.synthesize({
        ...request,
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({
            model: "eleven_flash_v2_5",
            voice: "voice-rest",
            language: "en",
            speakerBoost: true,
          }),
        ],
      }),
    );
    const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const parsedUrl = new URL(url);

    expect(parsedUrl.pathname).toBe("/v1/text-to-speech/voice-rest");
    expect(parsedUrl.searchParams.get("output_format")).toBe("pcm_16000");
    expect(parsedUrl.searchParams.get("enable_logging")).toBe("false");
    expect(init?.headers).toMatchObject({
      "xi-api-key": "eleven-secret",
      Accept: "audio/pcm",
      "Content-Type": "application/json",
    });
    expect(parsedBody).toEqual({
      text: request.text,
      model_id: "eleven_flash_v2_5",
      language_code: "en",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.7,
        use_speaker_boost: true,
      },
      seed: 42,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "media.audio.chunk",
      provider: PROVIDER_NAMES.elevenlabs,
      audio: { bytes: pcm, format: PCM16_16K_MONO, frameCount: 2 },
      metadata: { elevenlabs: { transport: "rest", protocol: "tts" } },
    });
    expect(events[1]).toMatchObject({
      type: "media.audio.committed",
      provider: PROVIDER_NAMES.elevenlabs,
      frameCount: 2,
      chunkIds: [expect.any(String)],
    });
  });

  it("uses the request voice in REST and HTTP-stream endpoint paths", async () => {
    const paths: string[] = [];
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-configured",
        knownVoiceIds: ["voice-per-call"],
        fetchImpl: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-configured",
        knownVoiceIds: ["voice-per-call"],
        fetchImpl: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-configured",
        fetchImpl: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
    ];

    await collectEvents(await providers[0]!.synthesize({ ...request, voice: "voice-per-call" }));
    await collectEvents(await providers[1]!.synthesize({ ...request, voice: "voice-per-call" }));
    await collectEvents(await providers[2]!.synthesize({ ...request, voice: "voice-free-form" }));

    expect(paths).toEqual([
      "/v1/text-to-speech/voice-per-call",
      "/v1/text-to-speech/voice-per-call/stream",
      "/v1/text-to-speech/voice-free-form",
    ]);
  });

  it("routes request voices through custom endpoints or rejects an unrouteable override", async () => {
    let templatedPath = "";
    const templated = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      knownVoiceIds: ["voice-per-call"],
      url: "https://proxy.example/v1/text-to-speech/:voice_id",
      fetchImpl: async (input) => {
        templatedPath = new URL(String(input)).pathname;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await collectEvents(await templated.synthesize({ ...request, voice: "voice-per-call" }));

    expect(templatedPath).toBe("/v1/text-to-speech/voice-per-call");
    expect(templated.supportsVoice("voice-per-call")).toBe(true);

    let fixedEndpointCalls = 0;
    const fixed = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      knownVoiceIds: ["voice-per-call"],
      url: "https://proxy.example/v1/text-to-speech/voice-configured",
      fetchImpl: async () => {
        fixedEndpointCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    expect(fixed.supportsVoice("voice-per-call")).toBe(false);
    await expect(fixed.synthesize({ ...request, voice: "voice-per-call" })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    expect(fixedEndpointCalls).toBe(0);
  });

  it("replaces each voice placeholder in a custom REST endpoint", async () => {
    let path = "";
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      knownVoiceIds: ["voice-per-call"],
      url: "https://proxy.example/:voice_id/text-to-speech/:voice_id",
      fetchImpl: async (input) => {
        path = new URL(String(input)).pathname;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await collectEvents(await provider.synthesize({ ...request, voice: "voice-per-call" }));

    expect(path).toBe("/voice-per-call/text-to-speech/voice-per-call");
  });

  it("reports the provider character-cost header for standard HTTP Convert", async () => {
    const observations: Array<{ field: string; status: string; value?: number; reason?: string }> =
      [];
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "character-cost": "17" },
        }),
    });

    await provider.synthesize({ ...request, usageReporter: usageReporter(observations) });

    expect(observations).toContainEqual(
      expect.objectContaining({
        field: "providerCharacterCount",
        status: "reported",
        value: 17,
      }),
    );
  });

  it.each([
    ["absent", undefined, "absent"],
    ["invalid", "17.5", "invalid"],
  ])("marks a %s character-cost header as unavailable", async (_label, header, reason) => {
    const observations: Array<{ field: string; status: string; value?: number; reason?: string }> =
      [];
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: header === undefined ? {} : { "character-cost": header },
        }),
    });

    await provider.synthesize({ ...request, usageReporter: usageReporter(observations) });

    expect(observations).toContainEqual(
      expect.objectContaining({
        field: "providerCharacterCount",
        status: "not_reported",
        reason,
      }),
    );
  });

  it("does not apply the standard Convert header metric to HTTP streaming", async () => {
    const observations: Array<{ field: string; status: string; value?: number; reason?: string }> =
      [];
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "character-cost": "17" },
        }),
    });

    await provider.synthesize({ ...request, usageReporter: usageReporter(observations) });

    expect(observations).toEqual([]);
  });

  it("does not apply the standard Convert header metric to Text-to-Dialogue", async () => {
    const observations: Array<{ field: string; status: string; value?: number; reason?: string }> =
      [];
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "character-cost": "17" },
        }),
    });

    await provider.synthesizeDialogue({
      sessionId: request.sessionId,
      turnId: request.turnId,
      format: request.format,
      model: "eleven_v3",
      inputs: [{ text: "Hello.", voiceId: "voice-rest" }],
      stream: false,
      usageReporter: usageReporter(observations),
      providerCapabilitySnapshots: [
        elevenLabsCapabilitySnapshot({ model: "eleven_v3", voice: "voice-rest" }),
      ],
    });

    expect(observations).toEqual([]);
  });

  it("supports timestamped REST output and emits character alignment", async () => {
    const pcm = new Uint8Array([7, 8, 9, 10]);
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(
          "/v1/text-to-speech/voice-rest/with-timestamps",
        );
        expect(new URL(String(input)).searchParams.get("output_format")).toBe("pcm_16000");
        expect(init?.headers).toMatchObject({ Accept: "application/json" });
        return new Response(
          JSON.stringify({
            audio_base64: Buffer.from(pcm).toString("base64"),
            alignment: {
              characters: ["h", "i"],
              character_start_times_seconds: [0, 0.01],
              character_end_times_seconds: [0.01, 0.02],
            },
          }),
          { status: 200 },
        );
      },
    });

    const events = await collectEvents(
      await provider.synthesize({ ...request, text: "hi", timestamps: true }),
    );
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      type: "tts.alignment",
      tokens: ["h", "i"],
      startMs: [0, 10],
      endMs: [10, 20],
    });
  });

  it("supports explicit Text-to-Dialogue requests and preserves every voice input", async () => {
    let body: Record<string, unknown> | undefined;
    let path = "";
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "fallback-voice",
      dialogueVoices: ["fallback-voice", "voice-a", "voice-b"],
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([11, 12]), { status: 200 });
      },
    });

    const events = await collectEvents(
      await provider.synthesizeDialogue({
        sessionId: request.sessionId,
        turnId: request.turnId,
        format: request.format,
        model: "eleven_v3",
        stream: false,
        inputs: [
          { text: "Hello.", voiceId: "voice-a" },
          { text: "Hi there.", voiceId: "voice-b" },
        ],
        previousText: "Before.",
        futureText: "After.",
        previousRequestIds: ["request-before"],
        nextRequestIds: ["request-after"],
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({
            model: "eleven_v3",
            voice: "voice-a",
            additionalVoices: ["voice-b"],
          }),
        ],
      }),
    );

    expect(path).toBe("/v1/text-to-dialogue");
    expect(body).toEqual({
      inputs: [
        { text: "Hello.", voice_id: "voice-a" },
        { text: "Hi there.", voice_id: "voice-b" },
      ],
      model_id: "eleven_v3",
      settings: { stability: 0.5 },
      previous_text: "Before.",
      future_text: "After.",
      previous_request_ids: ["request-before"],
      next_request_ids: ["request-after"],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ metadata: { elevenlabs: { protocol: "dialogue" } } });
  });

  it("sends the configured Dialogue model when the request omits model", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-a",
      modelId: "eleven_v3_conversational",
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    const {
      model: _model,
      providerCapabilitySnapshots: _snapshots,
      ...requestWithoutModel
    } = request;
    await provider.synthesize(requestWithoutModel);

    expect(body?.model_id).toBe("eleven_v3_conversational");
  });

  it.each([
    ["REST", createElevenLabsTtsRestProvider],
    ["HTTP stream", createElevenLabsTtsHttpStreamProvider],
  ] as const)(
    "defaults %s dialogue to eleven_v3 when configured for speech",
    async (_name, create) => {
      let body: Record<string, unknown> | undefined;
      const provider = create({
        apiKey: "eleven-secret",
        voiceId: "voice-a",
        modelId: "eleven_flash_v2_5",
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      });

      await collectEvents(
        await provider.synthesizeDialogue({
          sessionId: request.sessionId,
          turnId: request.turnId,
          format: request.format,
          stream: false,
          inputs: [{ text: "Hello.", voiceId: "voice-a" }],
        }),
      );

      expect(body?.model_id).toBe("eleven_v3");
    },
  );

  it.each([
    ["eleven_v3", true],
    ["eleven_flash_v2_5", false],
  ] as const)(
    "checks defaulted dialogue against model-scoped %s snapshot facts",
    async (snapshotModel, shouldSucceed) => {
      let body: Record<string, unknown> | undefined;
      let fetchCalls = 0;
      const provider = createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-a",
        modelId: "eleven_flash_v2_5",
        fetchImpl: async (_input, init) => {
          fetchCalls += 1;
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      });
      const dialogueRequest = {
        sessionId: request.sessionId,
        turnId: request.turnId,
        format: request.format,
        stream: false,
        inputs: [{ text: "Hello.", voiceId: "voice-a" }],
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({ model: snapshotModel, voice: "voice-a" }),
        ],
      } as const;

      if (shouldSucceed) {
        await collectEvents(await provider.synthesizeDialogue(dialogueRequest));
        expect(body?.model_id).toBe("eleven_v3");
        expect(fetchCalls).toBe(1);
      } else {
        await expect(provider.synthesizeDialogue(dialogueRequest)).rejects.toThrow(/fact_missing/u);
        expect(fetchCalls).toBe(0);
      }
    },
  );

  it.each([
    ["REST", createElevenLabsTtsRestProvider],
    ["HTTP stream", createElevenLabsTtsHttpStreamProvider],
  ] as const)("rejects a speech model for %s dialogue before fetch", async (_name, create) => {
    let fetchCalls = 0;
    const provider = create({
      apiKey: "eleven-secret",
      voiceId: "voice-a",
      modelId: "eleven_flash_v2_5",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await expect(
      provider.synthesizeDialogue({
        sessionId: request.sessionId,
        turnId: request.turnId,
        format: request.format,
        model: "eleven_flash_v2_5",
        stream: false,
        inputs: [{ text: "Hello.", voiceId: "voice-a" }],
      }),
    ).rejects.toThrow("Text-to-Dialogue requires an eleven_v3 model");
    expect(fetchCalls).toBe(0);
  });

  it("routes eleven_v4 through the Text-to-Dialogue REST endpoint", async () => {
    let path = "";
    let body: Record<string, unknown> | undefined;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      modelId: "eleven_v4",
      similarityBoost: 0.73,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        path = url.pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await provider.synthesize({
      sessionId: request.sessionId,
      turnId: request.turnId,
      format: request.format,
      text: "Hello.",
      stream: true,
    });

    expect(path).toBe("/v1/text-to-dialogue");
    expect(body).toMatchObject({
      inputs: [{ text: "Hello.", voice_id: "voice-rest" }],
      model_id: "eleven_v4",
      settings: { stability: 0.5, similarity: 0.73 },
    });
  });

  it("uses its configured dialogue model on HTTP-stream when the request omits one", async () => {
    let path = "";
    let body: Record<string, unknown> | undefined;
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      modelId: "eleven_v3_conversational",
      dialogueVoices: ["voice-stream"],
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        path = url.pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });
    const { model: _model, ...requestWithoutModel } = request;
    void _model;

    const stream = await provider.synthesize(requestWithoutModel);
    await stream.cancel();

    expect(path).toBe("/v1/text-to-dialogue/stream");
    expect(body).toMatchObject({
      inputs: [{ text: request.text, voice_id: "voice-stream" }],
      model_id: "eleven_v3_conversational",
    });
  });

  it("rejects eleven_v4_turbo on REST before making an HTTP request", async () => {
    let fetchCalls = 0;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      modelId: "eleven_v4_turbo",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await expect(
      provider.synthesize({ ...request, model: "eleven_v4_turbo" }),
    ).rejects.toMatchObject({
      provider: "elevenlabs",
      message: expect.stringMatching(/not supported by the REST transport/u),
    });
    expect(fetchCalls).toBe(0);
  });

  it.each(["eleven_v4", "eleven_v4_turbo"])(
    "rejects %s on HTTP-stream before making a request",
    async (model) => {
      let fetchCalls = 0;
      const provider = new ElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: model,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      });

      await expect(provider.synthesize({ ...request, model })).rejects.toMatchObject({
        provider: "elevenlabs",
        message: expect.stringMatching(/not supported by the HTTP-stream transport/u),
      });
      expect(fetchCalls).toBe(0);
    },
  );

  it("rejects speed for eleven_v4 before making an HTTP request", async () => {
    const model = "eleven_v4";
    let fetchCalls = 0;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      modelId: model,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await expect(provider.synthesize({ ...request, model, speed: 1.1 })).rejects.toThrow(
      /speed is not supported/,
    );
    expect(fetchCalls).toBe(0);
  });

  it("rejects speed on the direct v3 speech route before making an HTTP request", async () => {
    let fetchCalls = 0;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await expect(
      provider.synthesizeSpeech({ ...request, model: "eleven_v3", speed: 1.1 }),
    ).rejects.toThrow(/speed is not supported/);
    expect(fetchCalls).toBe(0);
  });

  it.each([
    [401, TVIC_ERROR_CODES.providerAuthFailed, false, false],
    [422, TVIC_ERROR_CODES.providerInvalidRequest, false, false],
    [429, TVIC_ERROR_CODES.providerRateLimited, true, false],
    [500, TVIC_ERROR_CODES.providerUpstreamFailed, false, true],
  ] as const)(
    "maps HTTP %s to the canonical provider error",
    async (status, code, retriable, outcomeUnknown) => {
      const provider = createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ detail: { status: "upstream_code", message: "failure" } }),
            {
              status,
            },
          ),
      });

      await expect(provider.synthesize(request)).rejects.toMatchObject({
        code,
        provider: PROVIDER_NAMES.elevenlabs,
        retriable,
        metadata: {
          httpStatus: status,
          ...(outcomeUnknown ? { outcomeUnknown: true } : { providerCode: "upstream_code" }),
        },
      });
    },
  );

  it.each([
    ["REST", createElevenLabsTtsRestProvider],
    ["HTTP streaming", createElevenLabsTtsHttpStreamProvider],
  ] as const)(
    "maps an ElevenLabs %s voice_not_found 404 to a voice rejection and keeps invalid_uid as invalid request",
    async (_name, create) => {
      const notFound = create({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              detail: {
                type: "not_found",
                code: "voice_not_found",
                message: "A voice with voice_id 'Zq7nXk2LmPw9RtYb4HcV' was not found.",
                status: "voice_not_found",
                request_id: "ff5b176d8b6b29b53ffa01156a0a6e1d",
              },
            }),
            { status: 404 },
          ),
      });
      await expect(notFound.synthesize(request)).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerVoiceUnsupported,
        category: "provider",
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
        message: "A voice with voice_id 'Zq7nXk2LmPw9RtYb4HcV' was not found.",
        metadata: { httpStatus: 404, providerCode: "voice_not_found" },
      });

      const invalidUid = create({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              detail: {
                type: "invalid_request",
                code: "bad_request",
                message: "An invalid ID has been received for voice: 'nonexistent-voice'.",
                status: "invalid_uid",
                request_id: "c01c8d0e363dba6cb94ee1af8805ef86",
              },
            }),
            { status: 400 },
          ),
      });
      await expect(invalidUid.synthesize(request)).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerInvalidRequest,
        metadata: { httpStatus: 400, providerCode: "invalid_uid" },
      });
    },
  );

  it.each([408, 409, 500, 503])(
    "does not let provider quota wording override ambiguous HTTP %s",
    async (status) => {
      const provider = createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        fetchImpl: async () =>
          new Response(JSON.stringify({ detail: { message: "quota exceeded" } }), { status }),
      });

      await expect(provider.synthesize(request)).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerUpstreamFailed,
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
        metadata: { httpStatus: status, outcomeUnknown: true },
      });
    },
  );

  it("classifies an HTTP-stream 503 without waiting for its stalled diagnostics body", async () => {
    let bodyCancelled = false;
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 503 },
        ),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      retriable: false,
      metadata: { httpStatus: 503, outcomeUnknown: true },
    });
    expect(bodyCancelled).toBe(true);
  });

  it("rejects unsupported output, malformed PCM, and provider-limit violations before leaking audio", async () => {
    let calls = 0;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () => {
        calls += 1;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });

    await expect(
      provider.synthesize({
        ...request,
        format: { encoding: "pcm_s16le", sampleRateHz: 8_000, channels: 1 },
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    await expect(
      provider.synthesize({ ...request, text: "x".repeat(40_001), model: "eleven_flash_v2_5" }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: "elevenlabs.tts.error",
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    });
    expect(calls).toBe(1);
  });
});

describe("ElevenLabs chunked HTTP TTS", () => {
  it("streams raw PCM across arbitrary byte boundaries and commits once", async () => {
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      clock: fixedClock,
      fetchImpl: async (input) => {
        expect(new URL(String(input)).pathname).toBe("/v1/text-to-speech/voice-stream/stream");
        return new Response(chunkedStream(new Uint8Array([1, 2, 3, 4]), [1, 3]), {
          status: 200,
        });
      },
    });

    const events = await collectEvents(await provider.synthesize(request));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ audio: { bytes: new Uint8Array([1, 2]) } });
    expect(events[1]).toMatchObject({ audio: { bytes: new Uint8Array([3, 4]) } });
    expect(events[2]).toMatchObject({
      type: "media.audio.committed",
      frameCount: 2,
      metadata: { elevenlabs: { transport: "http-stream" } },
    });
  });

  it("parses timestamped JSON objects split across network chunks", async () => {
    const first = JSON.stringify({
      audio_base64: Buffer.from([1, 2]).toString("base64"),
      alignment: {
        characters: ["a"],
        character_start_times_seconds: [0],
        character_end_times_seconds: [0.01],
      },
    });
    const second = JSON.stringify({ audio_base64: Buffer.from([3, 4]).toString("base64") });
    const encoded = new TextEncoder().encode(first + second);
    const provider = new ElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      clock: fixedClock,
      fetchImpl: async (input) => {
        expect(new URL(String(input)).pathname).toBe(
          "/v1/text-to-speech/voice-stream/stream/with-timestamps",
        );
        return new Response(chunkedStream(encoded, [2, 7, first.length + 1]), { status: 200 });
      },
    });

    const events = await collectEvents(await provider.synthesize({ ...request, timestamps: true }));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ audio: { bytes: new Uint8Array([1, 2]) } });
    expect(events[1]).toMatchObject({ type: "tts.alignment", tokens: ["a"] });
    expect(events[2]).toMatchObject({ audio: { bytes: new Uint8Array([3, 4]) } });
    expect(events[3]).toMatchObject({ type: "media.audio.committed", frameCount: 2 });
  });

  it("supports timestamped Dialogue HTTP streaming", async () => {
    let path = "";
    const response = JSON.stringify({ audio_base64: Buffer.from([5, 6]).toString("base64") });
    const provider = new ElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-a",
      clock: fixedClock,
      fetchImpl: async (input) => {
        path = new URL(String(input)).pathname;
        return new Response(new TextEncoder().encode(response), { status: 200 });
      },
    });

    const events = await collectEvents(
      await provider.synthesizeDialogue({
        sessionId: request.sessionId,
        turnId: request.turnId,
        format: request.format,
        model: "eleven_v3",
        stream: true,
        timestamps: true,
        inputs: [{ text: "Hello", voiceId: "voice-a" }],
        providerCapabilitySnapshots: [
          elevenLabsCapabilitySnapshot({ model: "eleven_v3", voice: "voice-a" }),
        ],
      }),
    );
    expect(path).toBe("/v1/text-to-dialogue/stream/with-timestamps");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "media.audio.chunk" });
    expect(events[1]).toMatchObject({ type: "media.audio.committed" });
  });

  it("cancels a pending output consumer without hanging it", async () => {
    const provider = new ElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
          }),
          { status: 200 },
        ),
    });
    const stream = await provider.synthesize(request);
    const pending = stream.events[Symbol.asyncIterator]().next();
    await stream.cancel();
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("fails a timed stream on truncated JSON instead of returning partial audio", async () => {
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      fetchImpl: async () =>
        new Response(new TextEncoder().encode('{"audio_base64":"AQI='), { status: 200 }),
    });
    await expect(
      collectEvents(await provider.synthesize({ ...request, timestamps: true })),
    ).rejects.toMatchObject({
      code: "elevenlabs.tts.error",
      provider: PROVIDER_NAMES.elevenlabs,
    });
  });
});

async function collectEvents(stream: {
  readonly events: AsyncIterable<TtsEvent>;
}): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

function chunkedStream(bytes: Uint8Array, ends: readonly number[]): ReadableStream<Uint8Array> {
  const boundaries = [...ends].filter((end) => end > 0 && end <= bytes.byteLength);
  if (boundaries.at(-1) !== bytes.byteLength) boundaries.push(bytes.byteLength);
  let start = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const end = boundaries.shift();
      if (end === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(start, end));
      start = end;
    },
  });
}
