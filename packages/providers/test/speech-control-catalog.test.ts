import { describe, expect, it, vi } from "vitest";

import { querySpeechControlCatalog } from "@tvic/core";
import { loadCartesiaVoiceControlSnapshot } from "../src/speech-control-catalog.js";

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
});
