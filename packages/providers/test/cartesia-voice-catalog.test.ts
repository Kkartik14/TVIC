import { describe, expect, it } from "vitest";

import { fetchCartesiaVoiceCatalogSnapshot } from "../src/cartesia-voice-catalog.js";

describe("Cartesia voice catalog snapshot", () => {
  it("loads requested voice facts with an explicit expiry", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const snapshot = await fetchCartesiaVoiceCatalogSnapshot({
      apiKey: "cartesia-test-key",
      voiceIds: ["voice/one", "voice-two"],
      nowMs: 10_000,
      ttlMs: 60_000,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        const id = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!);
        return new Response(
          JSON.stringify({
            id,
            status: "active",
            is_pro: id === "voice-two",
            accents: id === "voice/one" ? [{ locale: "hi-IN" }] : undefined,
          }),
          { status: 200 },
        );
      },
    });

    expect(snapshot.fetchedAtMs).toBe(10_000);
    expect(snapshot.expiresAtMs).toBe(70_000);
    expect(snapshot.voices).toEqual([
      { id: "voice/one", status: "active", isPro: false, locales: ["hi-IN"] },
      { id: "voice-two", status: "active", isPro: true },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://api.cartesia.ai/voices/voice%2Fone");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer cartesia-test-key");
    expect(requests[0]?.headers.get("cartesia-version")).toBe("2026-08-14");
  });

  it("rejects malformed provider voice facts without including payload content", async () => {
    await expect(
      fetchCartesiaVoiceCatalogSnapshot({
        apiKey: "cartesia-test-key",
        voiceIds: ["requested-voice"],
        fetchImpl: async () =>
          new Response(JSON.stringify({ id: "other-voice", status: "active", is_pro: false }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: "cartesia",
    });
  });
});
