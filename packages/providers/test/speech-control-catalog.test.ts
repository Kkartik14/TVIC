import { describe, expect, it, vi } from "vitest";

import { querySpeechControlCatalog } from "@tvic/core";
import {
  loadCartesiaVoiceControlSnapshot,
  loadElevenLabsSpeechControlSnapshot,
} from "../src/speech-control-catalog.js";

describe("provider speech-control snapshots", () => {
  it("loads Cartesia PVC and language facts with the provider API version", async () => {
    const fetcher = vi.fn(
      async (..._args: unknown[]) =>
        new Response(
          JSON.stringify({
            id: "voice-custom-1",
            is_pro: true,
            accents: [{ locale: "hi-IN" }, { locale: "en-IN" }],
          }),
          { status: 200 },
        ),
    );

    const snapshot = await loadCartesiaVoiceControlSnapshot({
      apiKey: "fixture-key",
      voiceId: "voice-custom-1",
      fetch: fetcher,
      now: () => new Date("2026-10-24T10:00:00.000Z"),
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.cartesia.ai/voices/voice-custom-1");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer fixture-key",
        "Cartesia-Version": "2026-08-14",
      },
    });
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "cartesia",
          control: "tts.speed",
          model: "sonic-3.6",
          voice: "voice-custom-1",
        },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "unsupported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "cartesia",
          control: "tts.language",
          model: "sonic-3.6",
          voice: "voice-custom-1",
        },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported", fact: { languages: ["hi-IN", "en-IN"] } });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("leaves PVC speed capability unknown when the provider omits is_pro", async () => {
    const snapshot = await loadCartesiaVoiceControlSnapshot({
      apiKey: "fixture-key",
      voiceId: "voice-unknown",
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "voice-unknown", accents: [] }), { status: 200 }),
      ),
      now: () => new Date("2026-10-24T10:00:00.000Z"),
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "cartesia",
          control: "tts.speed",
          model: "sonic-3.6",
          voice: "voice-unknown",
        },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toEqual({ status: "unknown" });
  });

  it("loads ElevenLabs model flags and requested account voices from setup APIs", async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/models") {
        return new Response(
          JSON.stringify([
            {
              model_id: "eleven_multilingual_v2",
              can_do_text_to_speech: true,
              can_use_style: false,
              can_use_speaker_boost: true,
              serves_pro_voices: true,
              maximum_text_length_per_request: 10_000,
            },
            { model_id: "model-no-tts", can_do_text_to_speech: false },
          ]),
          { status: 200 },
        );
      }
      if (url.pathname === "/v2/voices") {
        expect(url.searchParams.getAll("voice_ids")).toEqual(["account-voice-1", "missing-voice"]);
        expect(url.searchParams.get("page_size")).toBe("100");
        expect(init?.headers).toMatchObject({
          "xi-api-key": "fixture-key",
          Accept: "application/json",
        });
        return new Response(
          JSON.stringify({
            voices: [
              {
                voice_id: "account-voice-1",
                verified_languages: [
                  { language: "hi", locale: "hi-IN", model_id: "eleven_multilingual_v2" },
                  { language: "en", locale: "en-US", model_id: "another-model" },
                ],
                samples: [{ sample_id: "private-sample-metadata" }],
              },
            ],
            has_more: false,
            next_page_token: null,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected catalog URL: ${url.pathname}`);
    });

    const snapshot = await loadElevenLabsSpeechControlSnapshot({
      apiKey: "fixture-key",
      modelIds: ["eleven_multilingual_v2", "model-no-tts"],
      voiceIds: ["account-voice-1", "missing-voice"],
      fetch: fetcher,
      now: () => new Date("2026-10-24T10:00:00.000Z"),
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.elevenlabs.io/v1/models");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { "xi-api-key": "fixture-key", Accept: "application/json" },
    });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.model", model: "eleven_multilingual_v2" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.style", model: "eleven_multilingual_v2" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "unsupported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.speaker_boost", model: "eleven_multilingual_v2" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.pro_voice", model: "eleven_multilingual_v2" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.model", model: "model-no-tts" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "unsupported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "elevenlabs",
          control: "tts.voice",
          model: "eleven_multilingual_v2",
          voice: "account-voice-1",
        },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.voice", voice: "missing-voice" },
        "2026-10-24T10:00:01.000Z",
      ).status,
    ).toBe("unknown");
    expect(
      querySpeechControlCatalog(
        snapshot,
        {
          provider: "elevenlabs",
          control: "tts.language",
          model: "eleven_multilingual_v2",
          voice: "account-voice-1",
        },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported", fact: { languages: ["hi-IN"] } });
    expect(JSON.stringify(snapshot)).not.toContain("private-sample-metadata");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("marks a requested ElevenLabs model absent from the provider catalog as unsupported", async () => {
    const snapshot = await loadElevenLabsSpeechControlSnapshot({
      apiKey: "fixture-key",
      modelIds: ["unlisted-model"],
      voiceIds: ["account-voice"],
      fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        return url.pathname === "/v1/models"
          ? new Response("[]", { status: 200 })
          : new Response(JSON.stringify({ voices: [], has_more: false }), { status: 200 });
      }),
      now: () => new Date("2026-10-24T10:00:00.000Z"),
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.model", model: "unlisted-model" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "unsupported" });
  });

  it("fails the snapshot load when a requested model omits its TTS capability flag", async () => {
    const load = loadElevenLabsSpeechControlSnapshot({
      apiKey: "fixture-key",
      modelIds: ["model-without-tts-flag"],
      voiceIds: ["account-voice"],
      fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        return url.pathname === "/v1/models"
          ? new Response(JSON.stringify([{ model_id: "model-without-tts-flag" }]), {
              status: 200,
            })
          : new Response(JSON.stringify({ voices: [], has_more: false }), { status: 200 });
      }),
      now: () => new Date("2026-10-24T10:00:00.000Z"),
    });

    await expect(load).rejects.toThrow(/omitted can_do_text_to_speech/u);
  });

  it("does not mistake unrelated built-in voices for requested account voices", async () => {
    const snapshot = await loadElevenLabsSpeechControlSnapshot({
      apiKey: "fixture-key",
      modelIds: ["eleven_multilingual_v2"],
      voiceIds: ["account-voice"],
      fetch: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        return url.pathname === "/v1/models"
          ? new Response(
              JSON.stringify([{ model_id: "eleven_multilingual_v2", can_do_text_to_speech: true }]),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({
                voices: [
                  { voice_id: "account-voice", verified_languages: [] },
                  { voice_id: "built-in-voice", verified_languages: [] },
                ],
                has_more: true,
                next_page_token: "another-page",
              }),
              { status: 200 },
            );
      }),
      now: () => new Date("2026-10-24T10:00:00.000Z"),
    });

    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.voice", voice: "account-voice" },
        "2026-10-24T10:00:01.000Z",
      ),
    ).toMatchObject({ status: "supported" });
    expect(
      querySpeechControlCatalog(
        snapshot,
        { provider: "elevenlabs", control: "tts.voice", voice: "built-in-voice" },
        "2026-10-24T10:00:01.000Z",
      ).status,
    ).toBe("unknown");
  });
});
