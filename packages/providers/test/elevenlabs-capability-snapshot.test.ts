import { describe, expect, it, vi } from "vitest";

import { loadElevenLabsCapabilitySnapshot } from "../src/index.js";

const timestamps = {
  fetchedAt: "2026-10-25T00:00:00.000Z",
  validUntil: "2026-10-26T00:00:00.000Z",
};

describe("loadElevenLabsCapabilitySnapshot", () => {
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
