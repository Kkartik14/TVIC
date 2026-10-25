import { describe, expect, it, vi } from "vitest";

import { loadElevenLabsCapabilitySnapshot } from "../src/index.js";

const timestamps = {
  fetchedAt: "2026-10-25T00:00:00.000Z",
  validUntil: "2026-10-26T00:00:00.000Z",
};

describe("loadElevenLabsCapabilitySnapshot", () => {
  it.each(["fetch", "body"] as const)(
    "bounds a stalled %s with the capability snapshot deadline",
    async (stage) => {
      const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (stage === "fetch") {
          await new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      });

      await expect(
        loadElevenLabsCapabilitySnapshot({
          apiKey: "elevenlabs-secret",
          modelIds: ["eleven_flash_v2_5"],
          ...timestamps,
          timeoutMs: 25,
          fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "provider.transport_timeout", category: "timeout" });
    },
    1_000,
  );

  it.each(["fetch", "body"] as const)(
    "preserves cancellation when the %s read is aborted",
    async (stage) => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => {
        if (stage === "fetch") {
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response(
          new ReadableStream({
            start(stream) {
              controller.abort();
              stream.error(new DOMException("Aborted", "AbortError"));
            },
          }),
          { status: 200 },
        );
      });

      await expect(
        loadElevenLabsCapabilitySnapshot({
          apiKey: "elevenlabs-secret",
          modelIds: ["eleven_flash_v2_5"],
          ...timestamps,
          signal: controller.signal,
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        code: "provider.connection_cancelled",
        category: "cancelled",
        retriable: false,
      });
    },
  );

  it("stores only requested model, voice, locale, and normalization facts", async () => {
    const responses: unknown[] = [
      [
        {
          model_id: "eleven_flash_v2_5",
          can_do_text_to_speech: true,
          can_use_style: true,
          can_use_speaker_boost: false,
          serves_pro_voices: true,
          languages: [{ language_id: "hi", name: "Hindi" }],
          description: "discard this model description",
        },
        {
          model_id: "unrequested-model",
          can_use_style: false,
          description: "discard this model too",
        },
      ],
      {
        voices: [
          {
            voice_id: "voice-1",
            category: "professional",
            verified_languages: [
              { language: "Hindi", model_id: "eleven_flash_v2_5", locale: "hi-IN" },
            ],
            samples: [{ sample_id: "private-sample" }],
            preview_url: "https://provider.example/preview.wav",
            description: "discard this voice description",
          },
          { voice_id: "unrequested-voice", category: "generated" },
        ],
        has_more: false,
      },
      { tier: "enterprise", character_count: 1234, currency: "usd" },
    ];
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );

    const snapshot = await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      voiceIds: ["voice-1"],
      forcedNormalizationModelIds: ["eleven_flash_v2_5"],
      ...timestamps,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const calls = fetchImpl.mock.calls;
    expect(calls.map(([input]) => String(input))).toEqual([
      "https://api.elevenlabs.io/v1/models",
      "https://api.elevenlabs.io/v2/voices?page_size=100&voice_ids=voice-1",
      "https://api.elevenlabs.io/v1/user/subscription",
    ]);
    expect(
      calls.every(
        ([, init]) =>
          init?.headers && new Headers(init.headers).get("xi-api-key") === "elevenlabs-secret",
      ),
    ).toBe(true);
    expect(snapshot.facts).toEqual([
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
        feature: "tts.model.canUseStyle",
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
        feature: "tts.model.servesProfessionalVoices",
        scope: "model",
        model: "eleven_flash_v2_5",
        status: "supported",
        value: true,
      },
      {
        feature: "tts.voice.category",
        scope: "voice",
        voice: "voice-1",
        status: "supported",
        value: "professional",
      },
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "eleven_flash_v2_5",
        voice: "voice-1",
        status: "supported",
      },
      {
        feature: "tts.voice.verifiedLocales",
        scope: "voice",
        model: "eleven_flash_v2_5",
        voice: "voice-1",
        status: "supported",
        value: ["hi-IN"],
      },
      { feature: "tts.normalization.forced", scope: "account", status: "supported" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private-sample");
    expect(JSON.stringify(snapshot)).not.toContain("preview.wav");
    expect(JSON.stringify(snapshot)).not.toContain("description");
    expect(JSON.stringify(snapshot)).not.toContain("character_count");
    expect(JSON.stringify(snapshot)).not.toContain("currency");
    expect(JSON.stringify(snapshot)).not.toContain("elevenlabs-secret");
  });

  it("keeps absent flags and unrecognized categories unknown", async () => {
    const responses: unknown[] = [
      [{ model_id: "eleven_flash_v2_5", can_use_style: true }],
      {
        voices: [{ voice_id: "voice-1", category: "future-category", verified_languages: [] }],
      },
    ];
    const snapshot = await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      voiceIds: ["voice-1"],
      ...timestamps,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      ),
    });

    expect(snapshot.facts).toContainEqual({
      feature: "tts.model.canDoTextToSpeech",
      scope: "model",
      model: "eleven_flash_v2_5",
      status: "unknown",
    });
    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.category",
      scope: "voice",
      voice: "voice-1",
      status: "unknown",
    });
    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.verifiedLocales",
      scope: "voice",
      model: "eleven_flash_v2_5",
      voice: "voice-1",
      status: "unknown",
    });
  });

  it("bounds verified locales after selecting the requested model", async () => {
    const responses: unknown[] = [
      [{ model_id: "eleven_flash_v2_5", can_do_text_to_speech: true }],
      {
        voices: [
          {
            voice_id: "voice-1",
            category: "premade",
            verified_languages: [
              ...Array.from({ length: 65 }, (_, index) => ({
                model_id: `other-model-${index}`,
                locale: `x-${index}`,
              })),
              { model_id: "eleven_flash_v2_5", locale: "hi-IN" },
            ],
          },
        ],
        has_more: false,
      },
    ];
    const snapshot = await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      voiceIds: ["voice-1"],
      ...timestamps,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      ),
    });

    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.verifiedLocales",
      scope: "voice",
      model: "eleven_flash_v2_5",
      voice: "voice-1",
      status: "supported",
      value: ["hi-IN"],
    });
  });

  it("uses validated ID snapshots after the first catalog request is pending", async () => {
    let releaseModels!: () => void;
    const modelResponse = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    const modelIds = ["eleven_flash_v2_5"];
    const voiceIds = ["voice-1"];
    const forcedNormalizationModelIds = ["eleven_flash_v2_5"];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        await modelResponse;
        return new Response(
          JSON.stringify([{ model_id: "eleven_flash_v2_5", can_do_text_to_speech: true }]),
          { status: 200 },
        );
      }
      if (url.includes("/v2/voices")) {
        return new Response(
          JSON.stringify({
            voices: [
              {
                voice_id: "voice-1",
                category: "premade",
                verified_languages: [{ model_id: "eleven_flash_v2_5", locale: "en-US" }],
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ tier: "enterprise" }), { status: 200 });
    });
    const loading = loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds,
      voiceIds,
      forcedNormalizationModelIds,
      ...timestamps,
      fetchImpl,
    });

    modelIds.push("injected-model");
    voiceIds.push("injected-voice");
    forcedNormalizationModelIds.splice(0);
    releaseModels();
    const snapshot = await loading;

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.elevenlabs.io/v1/models",
      "https://api.elevenlabs.io/v2/voices?page_size=100&voice_ids=voice-1",
      "https://api.elevenlabs.io/v1/user/subscription",
    ]);
    expect(snapshot.facts.filter((fact) => fact.feature === "tts.model.available")).toEqual([
      {
        feature: "tts.model.available",
        scope: "model",
        model: "eleven_flash_v2_5",
        status: "supported",
      },
    ]);
    expect(snapshot.facts).toContainEqual({
      feature: "tts.normalization.forced",
      scope: "account",
      status: "supported",
    });
  });

  it("marks a model without regular text-to-speech as unsupported", async () => {
    const snapshot = await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      ...timestamps,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ model_id: "eleven_flash_v2_5", can_do_text_to_speech: false }]),
            { status: 200 },
          ),
      ),
    });

    expect(snapshot.facts).toContainEqual({
      feature: "tts.model.canDoTextToSpeech",
      scope: "model",
      model: "eleven_flash_v2_5",
      status: "unsupported",
      value: false,
    });
  });

  it("does not query subscription unless forced normalization is requested", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      ...timestamps,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects professional voices for models without entitlement and marks absent IDs unsupported", async () => {
    const responses: unknown[] = [
      [{ model_id: "eleven_flash_v2_5", serves_pro_voices: false }],
      {
        voices: [{ voice_id: "voice-1", category: "professional", verified_languages: [] }],
        has_more: false,
      },
    ];
    const snapshot = await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      voiceIds: ["voice-1", "voice-missing"],
      ...timestamps,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      ),
    });

    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.available",
      scope: "voice",
      model: "eleven_flash_v2_5",
      voice: "voice-1",
      status: "unsupported",
    });
    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.available",
      scope: "voice",
      model: "eleven_flash_v2_5",
      voice: "voice-missing",
      status: "unsupported",
    });
  });

  it("keeps normalization support unknown for unknown account tiers", async () => {
    const responses: unknown[] = [[], { tier: "future-enterprise-tier" }];
    const snapshot = await loadElevenLabsCapabilitySnapshot({
      apiKey: "elevenlabs-secret",
      modelIds: ["eleven_flash_v2_5"],
      forcedNormalizationModelIds: ["eleven_flash_v2_5"],
      ...timestamps,
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      ),
    });

    expect(snapshot.facts).toContainEqual({
      feature: "tts.normalization.forced",
      scope: "account",
      status: "unknown",
    });
  });

  it("validates requested model/voice bounds before making a request", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    await expect(
      loadElevenLabsCapabilitySnapshot({
        apiKey: "elevenlabs-secret",
        modelIds: Array.from({ length: 17 }, (_, index) => `model-${index}`),
        ...timestamps,
        fetchImpl,
      }),
    ).rejects.toThrow(/at most/);
    await expect(
      loadElevenLabsCapabilitySnapshot({
        apiKey: "elevenlabs-secret",
        modelIds: ["model-a", "model-b"],
        voiceIds: Array.from({ length: 65 }, (_, index) => `voice-${index}`),
        ...timestamps,
        fetchImpl,
      }),
    ).rejects.toThrow(/voice\/model pairs/);
    await expect(
      loadElevenLabsCapabilitySnapshot({
        apiKey: "elevenlabs-secret",
        modelIds: ["eleven_flash_v2_5"],
        voiceIds: Array.from({ length: 101 }, (_, index) => `voice-${index}`),
        ...timestamps,
        fetchImpl,
      }),
    ).rejects.toThrow(/at most/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
