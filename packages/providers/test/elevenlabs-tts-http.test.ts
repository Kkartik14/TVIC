import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  createSpeechControlCatalogSnapshot,
  type SessionId,
  type Timestamp,
  type TtsEvent,
  type TtsSynthesisRequest,
  type TtsUsageReporter,
  type TurnId,
} from "@tvic/core";

import {
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsRestProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsRestProvider,
} from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";

const request: TtsSynthesisRequest = {
  sessionId: "elevenlabs-http-session" as SessionId,
  turnId: "elevenlabs-http-turn" as TurnId,
  format: PCM16_16K_MONO,
  text: "Hello from TVIC.",
  model: "eleven_flash_v2_5",
  stream: true,
};

const fixedClock = {
  now(): Timestamp {
    return "2026-09-25T00:00:00.000Z" as Timestamp;
  },
};

function usageReporter(
  observations: Array<{ field: string; status: string; value?: number; reason?: string }>,
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
    reportTextCharacters() {},
  };
}

describe("ElevenLabs complete HTTP TTS", () => {
  it("rejects SSML parsing before either HTTP provider is created", () => {
    const options = { apiKey: "test", voiceId: "voice-id", enableSsmlParsing: true };
    expect(() => createElevenLabsTtsRestProvider(options)).toThrow(/SSML parsing is disabled/u);
    expect(() => createElevenLabsTtsHttpStreamProvider(options)).toThrow(
      /SSML parsing is disabled/u,
    );
  });

  it("rejects typed text parts before either HTTP route sends a request", async () => {
    let fetchCalls = 0;
    const options = {
      apiKey: "elevenlabs-test-key",
      voiceId: "voice-id",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("HTTP request should not be sent");
      },
    };
    const synthesisRequest = {
      ...request,
      textParts: [{ type: "spell", text: "A7B9" }],
    } satisfies TtsSynthesisRequest;

    await expect(
      createElevenLabsTtsRestProvider(options).synthesize(synthesisRequest),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    await expect(
      createElevenLabsTtsHttpStreamProvider(options).synthesize(synthesisRequest),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    expect(fetchCalls).toBe(0);
  });

  it.each(["REST", "HTTP-stream"] as const)(
    "rejects typed text parts through direct %s speech and dialogue helpers",
    async (transport) => {
      let fetchCalls = 0;
      const options = {
        apiKey: "elevenlabs-test-key",
        voiceId: "voice-id",
        modelId: "eleven_v3",
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("HTTP request should not be sent");
        },
      };
      const provider =
        transport === "REST"
          ? createElevenLabsTtsRestProvider(options)
          : createElevenLabsTtsHttpStreamProvider(options);
      const textParts = [{ type: "spell", text: "A7B9" }] as const;

      await expect(provider.synthesizeSpeech({ ...request, textParts })).rejects.toMatchObject({
        code: TVIC_ERROR_CODES.providerInvalidRequest,
      });
      await expect(
        provider.synthesizeDialogue({
          ...request,
          textParts,
          inputs: [{ text: "Hello", voiceId: "voice-id" }],
        }),
      ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
      expect(fetchCalls).toBe(0);
    },
  );

  it.each(["REST", "HTTP-stream"] as const)(
    "rejects unknown or expired voice snapshots through direct %s helpers",
    async (transport) => {
      let fetchCalls = 0;
      const providerOptions = {
        apiKey: "elevenlabs-test-key",
        voiceId: "voice-id",
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("HTTP request should not be sent");
        },
      };
      const provider =
        transport === "REST"
          ? createElevenLabsTtsRestProvider(providerOptions)
          : createElevenLabsTtsHttpStreamProvider(providerOptions);
      const expiredCatalog = createSpeechControlCatalogSnapshot([], {
        fetchedAt: "2020-01-01T00:00:00.000Z",
        validUntil: "2020-01-02T00:00:00.000Z",
      });
      const currentUnknownCatalog = createSpeechControlCatalogSnapshot([], {
        fetchedAt: "2020-01-01T00:00:00.000Z",
        validUntil: "2099-01-02T00:00:00.000Z",
      });
      const requestWithExpiredCatalog = {
        ...request,
        speechControlCatalog: expiredCatalog,
        voice: "account-custom-voice",
      };

      await expect(provider.synthesizeSpeech(requestWithExpiredCatalog)).rejects.toThrow(
        /catalog expired/u,
      );
      await expect(
        provider.synthesizeSpeech({
          ...requestWithExpiredCatalog,
          speechControlCatalog: currentUnknownCatalog,
        }),
      ).rejects.toThrow(/catalog unknown/u);
      await expect(
        provider.synthesizeDialogue({
          ...requestWithExpiredCatalog,
          model: "eleven_v3",
          inputs: [{ text: "Hello", voiceId: "account-custom-voice" }],
        }),
      ).rejects.toThrow(/catalog expired/u);
      await expect(
        provider.synthesizeDialogue({
          ...requestWithExpiredCatalog,
          model: "eleven_v3",
          speechControlCatalog: currentUnknownCatalog,
          inputs: [{ text: "Hello", voiceId: "account-custom-voice" }],
        }),
      ).rejects.toThrow(/catalog unknown/u);
      expect(fetchCalls).toBe(0);
    },
  );

  it.each(["REST", "HTTP-stream"] as const)(
    "rejects bracket text before the %s route sends a request",
    async (transport) => {
      let fetchCalls = 0;
      const options = {
        apiKey: "elevenlabs-test-key",
        voiceId: "voice-id",
        modelId: "eleven_v3",
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("HTTP request should not be sent");
        },
      };
      const provider =
        transport === "REST"
          ? createElevenLabsTtsRestProvider(options)
          : createElevenLabsTtsHttpStreamProvider(options);

      await expect(
        provider.synthesize({ ...request, model: "eleven_v3", text: "[laughs]" }),
      ).rejects.toThrow(/square brackets/u);
      await expect(
        provider.synthesizeDialogue({
          ...request,
          model: "eleven_v3",
          inputs: [{ text: "[laughs]", voiceId: "voice-id" }],
        }),
      ).rejects.toThrow(/square brackets/u);
      expect(fetchCalls).toBe(0);
    },
  );

  it.each(["REST", "HTTP-stream"] as const)(
    "requires an account voice snapshot before the %s routes send custom voice IDs",
    async (transport) => {
      let fetchCalls = 0;
      const options = {
        apiKey: "elevenlabs-test-key",
        voiceId: "configured-voice",
        modelId: "eleven_flash_v2_5",
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("HTTP request should not be sent");
        },
      };
      const provider =
        transport === "REST"
          ? createElevenLabsTtsRestProvider(options)
          : createElevenLabsTtsHttpStreamProvider(options);

      await expect(
        provider.synthesizeSpeech({ ...request, voice: "account-custom-voice" }),
      ).rejects.toThrow(/requires a current account voice catalog/u);
      await expect(
        provider.synthesizeDialogue({
          ...request,
          model: "eleven_v3",
          inputs: [{ text: "Hello.", voiceId: "account-custom-voice" }],
        }),
      ).rejects.toThrow(/requires a current account voice catalog/u);
      expect(fetchCalls).toBe(0);
    },
  );

  it("sends every route-supported catalog model through REST and HTTP-stream", async () => {
    const routes = [
      {
        name: "REST",
        models: PROVIDER_CATALOG.elevenlabs.models.filter((model) => model !== "eleven_v4_turbo"),
        create: (modelId: string, fetchImpl: typeof fetch) =>
          new ElevenLabsTtsRestProvider({
            apiKey: "eleven-secret",
            voiceId: "voice-rest",
            modelId,
            fetchImpl,
          }),
        dialoguePath: "/v1/text-to-dialogue",
      },
      {
        name: "HTTP-stream",
        models: PROVIDER_CATALOG.elevenlabs.models.filter(
          (model) => model !== "eleven_v4" && model !== "eleven_v4_turbo",
        ),
        create: (modelId: string, fetchImpl: typeof fetch) =>
          new ElevenLabsTtsHttpStreamProvider({
            apiKey: "eleven-secret",
            voiceId: "voice-stream",
            modelId,
            fetchImpl,
          }),
        dialoguePath: "/v1/text-to-dialogue/stream",
      },
    ];

    for (const route of routes) {
      const models = route.models;
      expect(
        route.create(models[0] ?? "", async () => new Response(new Uint8Array([1, 2]))).capabilities
          .models,
      ).toEqual(models);

      for (const model of models) {
        let path = "";
        let body: Record<string, unknown> | undefined;
        const provider = route.create(model, async (input, init) => {
          path = new URL(String(input)).pathname;
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        });

        await collectEvents(await provider.synthesize({ ...request, model, text: "Hello." }));

        expect(body?.model_id).toBe(model);
        expect(path).toBe(
          model.startsWith("eleven_v3") || model.startsWith("eleven_v4")
            ? route.dialoguePath
            : `/v1/text-to-speech/${route.name === "REST" ? "voice-rest" : "voice-stream"}${route.name === "REST" ? "" : "/stream"}`,
        );
      }
    }
  });

  it("declares model-aware language and speed support on both HTTP routes", () => {
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        modelId: "eleven_flash_v2_5",
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_flash_v2_5",
      }),
    ];

    for (const provider of providers) {
      expect(provider.supportsTtsLanguage("hi-IN")).toBe(true);
      expect(provider.supportsTtsLanguage("or-IN")).toBe(false);
      expect(provider.supportsTtsLanguage("hi-IN", "eleven_flash_v2")).toBe(false);
      expect(provider.supportsTtsSpeed(0.7)).toBe(true);
      expect(provider.supportsTtsSpeed(1.2)).toBe(true);
      expect(provider.supportsTtsSpeed(1.21)).toBe(false);
      expect(provider.supportsTtsSpeed(1, "eleven_v3")).toBe(false);
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

  it("uses request-level language in REST and HTTP-stream speech bodies", async () => {
    const bodies: Array<{ language_code?: string; voice_settings?: { speed?: number } }> = [];
    const providers = [
      createElevenLabsTtsRestProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-rest",
        modelId: "eleven_flash_v2_5",
        language: "en-US",
        fetchImpl: async (_input, init) => {
          bodies.push(
            JSON.parse(String(init?.body)) as {
              language_code?: string;
              voice_settings?: { speed?: number };
            },
          );
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_flash_v2_5",
        language: "en-US",
        fetchImpl: async (_input, init) => {
          bodies.push(
            JSON.parse(String(init?.body)) as {
              language_code?: string;
              voice_settings?: { speed?: number };
            },
          );
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
    ];

    for (const provider of providers) {
      await collectEvents(await provider.synthesize({ ...request, language: "hi-IN", speed: 1.1 }));
    }

    expect(bodies).toEqual([
      expect.objectContaining({
        language_code: "hi",
        voice_settings: expect.objectContaining({ speed: 1.1 }),
      }),
      expect.objectContaining({
        language_code: "hi",
        voice_settings: expect.objectContaining({ speed: 1.1 }),
      }),
    ]);
  });

  it("rejects a request language for multilingual v2 before REST or HTTP-stream requests", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([1, 2]), { status: 200 });
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
      await expect(
        provider.synthesize({ ...request, model: "eleven_multilingual_v2", language: "hi-IN" }),
      ).rejects.toThrow(/language_code is not supported by eleven_multilingual_v2/);
    }
    expect(fetchCalls).toBe(0);
  });

  it("rejects language on multilingual v2 before REST or HTTP-stream requests", async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
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
        language: "hi",
        fetchImpl,
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-stream",
        modelId: "eleven_multilingual_v2",
        language: "hi",
        fetchImpl,
      }),
    ];

    for (const provider of providers) {
      await expect(
        provider.synthesize({ ...request, model: "eleven_multilingual_v2" }),
      ).rejects.toThrow(/language_code is not supported by eleven_multilingual_v2/);
    }
    expect(fetchCalls).toBe(0);
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

    const events = await collectEvents(await provider.synthesize(request));
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
        fetchImpl: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
      createElevenLabsTtsHttpStreamProvider({
        apiKey: "eleven-secret",
        voiceId: "voice-configured",
        fetchImpl: async (input) => {
          paths.push(new URL(String(input)).pathname);
          return new Response(new Uint8Array([1, 2]), { status: 200 });
        },
      }),
    ];

    for (const provider of providers) {
      await collectEvents(
        await provider.synthesize({
          ...request,
          voice: "voice-per-call",
          speechControlCatalog: accountVoiceCatalog("voice-per-call"),
        }),
      );
    }

    expect(paths).toEqual([
      "/v1/text-to-speech/voice-per-call",
      "/v1/text-to-speech/voice-per-call/stream",
    ]);
  });

  it("routes request voices through custom endpoints or rejects an unrouteable override", async () => {
    let templatedPath = "";
    const templated = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      url: "https://proxy.example/v1/text-to-speech/:voice_id",
      fetchImpl: async (input) => {
        templatedPath = new URL(String(input)).pathname;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await collectEvents(
      await templated.synthesize({
        ...request,
        voice: "voice-per-call",
        speechControlCatalog: accountVoiceCatalog("voice-per-call"),
      }),
    );

    expect(templatedPath).toBe("/v1/text-to-speech/voice-per-call");

    let fixedEndpointCalls = 0;
    const fixed = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-configured",
      url: "https://proxy.example/v1/text-to-speech/voice-configured",
      fetchImpl: async () => {
        fixedEndpointCalls += 1;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await expect(
      fixed.synthesize({
        ...request,
        voice: "voice-per-call",
        speechControlCatalog: accountVoiceCatalog("voice-per-call"),
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    expect(fixedEndpointCalls).toBe(0);
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
        speechControlCatalog: accountVoiceCatalog("voice-a", "voice-b"),
        previousText: "Before.",
        futureText: "After.",
        previousRequestIds: ["request-before"],
        nextRequestIds: ["request-after"],
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

  it("routes eleven_v4 through the Text-to-Dialogue REST endpoint", async () => {
    let path = "";
    let body: Record<string, unknown> | undefined;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      modelId: "eleven_v4",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        path = url.pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([1, 2]), { status: 200 });
      },
    });

    await provider.synthesize({ ...request, model: "eleven_v4", text: "Hello." });

    expect(path).toBe("/v1/text-to-dialogue");
    expect(body).toMatchObject({
      inputs: [{ text: "Hello.", voice_id: "voice-rest" }],
      model_id: "eleven_v4",
      settings: { stability: 0.5, similarity_boost: 0.8 },
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

    await expect(provider.synthesize({ ...request, model: "eleven_v4_turbo" })).rejects.toThrow(
      /not supported by the REST transport/,
    );
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

      await expect(provider.synthesize({ ...request, model })).rejects.toThrow(
        /not supported by the HTTP-stream transport/,
      );
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
