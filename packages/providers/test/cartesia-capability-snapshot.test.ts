import { describe, expect, it, vi } from "vitest";

import { loadCartesiaCapabilitySnapshot } from "../src/index.js";

describe("loadCartesiaCapabilitySnapshot", () => {
  it("loads bounded voice facts out of call without retaining voice content", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            id: "voice-1",
            status: "active",
            is_pro: true,
            accents: [{ locale: "hi-IN" }, { locale: "en-IN" }],
            name: "private voice name",
            description: "private voice description",
            preview_file_url: "https://provider.example/preview.wav",
          }),
          { status: 200 },
        ),
    );

    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["sonic-3.6"],
      voiceIds: ["voice-1"],
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.cartesia.ai/voices/voice-1");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer cartesia-secret",
      "Cartesia-Version": expect.any(String),
    });
    expect(snapshot.facts).toEqual([
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "supported",
        voice: "voice-1",
      },
      {
        feature: "tts.voice.isPro",
        scope: "voice",
        status: "supported",
        voice: "voice-1",
        value: true,
      },
      {
        feature: "tts.voice.accentLocales",
        scope: "voice",
        status: "supported",
        voice: "voice-1",
        value: ["hi-IN", "en-IN"],
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private voice");
    expect(JSON.stringify(snapshot)).not.toContain("preview.wav");
    expect(JSON.stringify(snapshot)).not.toContain("cartesia-secret");
  });

  it("keeps missing voice facts unknown instead of treating them as false", async () => {
    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["sonic-3.6"],
      voiceIds: ["voice-1"],
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "voice-1", status: "active", accents: [] }), {
            status: 200,
          }),
      ),
    });

    expect(snapshot.facts).toEqual([
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "supported",
        voice: "voice-1",
      },
      { feature: "tts.voice.isPro", scope: "voice", status: "unknown", voice: "voice-1" },
      { feature: "tts.voice.accentLocales", scope: "voice", status: "unknown", voice: "voice-1" },
    ]);
  });

  it("rejects an oversized voice response before building a snapshot", async () => {
    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds: ["voice-1"],
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                id: "voice-1",
                status: "active",
                description: "x".repeat(2_000_000),
              }),
              { status: 200 },
            ),
        ),
      }),
    ).rejects.toThrow(/invalid voice capability response/);
  });

  it("marks archived voices unavailable and unknown status values as unknown", async () => {
    const responses = [
      { id: "voice-1", status: "archived", is_pro: false, accents: [{ locale: "en-US" }] },
      { id: "voice-2", status: "future-status", is_pro: false, accents: [{ locale: "en-US" }] },
    ];
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
    );

    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["sonic-3.6"],
      voiceIds: ["voice-1", "voice-2"],
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl,
    });

    expect(snapshot.facts.filter((fact) => fact.feature === "tts.voice.available")).toEqual([
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "unsupported",
        voice: "voice-1",
      },
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "unknown",
        voice: "voice-2",
      },
    ]);
  });

  it("rejects an unexpected voice identity and bounds requested voice IDs", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "different-voice", is_pro: false, accents: [] }), {
          status: 200,
        }),
    );

    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds: ["voice-1"],
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        fetchImpl,
      }),
    ).rejects.toThrow(/voice response/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds: Array.from({ length: 101 }, (_, index) => `voice-${index}`),
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        fetchImpl,
      }),
    ).rejects.toThrow(/at most/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["model-a", "model-b"],
        voiceIds: Array.from({ length: 65 }, (_, index) => `voice-${index}`),
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        fetchImpl,
      }),
    ).rejects.toThrow(/voice\/model pairs/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
