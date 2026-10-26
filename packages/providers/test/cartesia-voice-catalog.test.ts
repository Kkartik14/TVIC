import { describe, expect, it, vi } from "vitest";

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

  it("accepts active voices when Cartesia omits the optional professional-tier fact", async () => {
    const snapshot = await fetchCartesiaVoiceCatalogSnapshot({
      apiKey: "cartesia-test-key",
      voiceIds: ["voice-with-unknown-tier"],
      nowMs: 10_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: "voice-with-unknown-tier", status: "active" }), {
          status: 200,
        }),
    });

    expect(snapshot.voices).toEqual([{ id: "voice-with-unknown-tier", status: "active" }]);
  });

  it("records a missing voice without failing the rest of the snapshot", async () => {
    const snapshot = await fetchCartesiaVoiceCatalogSnapshot({
      apiKey: "cartesia-test-key",
      voiceIds: ["voice-missing", "voice-present"],
      fetchImpl: async (input) => {
        const id = new URL(String(input)).pathname.split("/").at(-1);
        if (id === "voice-missing") return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ id, status: "active", is_pro: false }), {
          status: 200,
        });
      },
    });

    expect(snapshot.voices).toEqual([
      { id: "voice-missing", status: "missing" },
      { id: "voice-present", status: "active", isPro: false },
    ]);
  });

  it("reports authentication failures with an auth error code", async () => {
    await expect(
      fetchCartesiaVoiceCatalogSnapshot({
        apiKey: "cartesia-test-key",
        voiceIds: ["voice-one"],
        fetchImpl: async () => new Response(null, { status: 401 }),
      }),
    ).rejects.toMatchObject({
      code: "provider.auth_failed",
      provider: "cartesia",
      metadata: { status: 401 },
    });
  });

  it("aborts all catalog requests when the caller signal is aborted", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const pending = fetchCartesiaVoiceCatalogSnapshot({
      apiKey: "cartesia-test-key",
      voiceIds: ["voice-one"],
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      provider: "cartesia",
    });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("limits concurrent lookups and aborts pending requests when the deadline expires", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximumActive = 0;
    let aborted = 0;
    try {
      const pending = fetchCartesiaVoiceCatalogSnapshot({
        apiKey: "cartesia-test-key",
        voiceIds: Array.from({ length: 8 }, (_, index) => `voice-${index}`),
        fetchImpl: async (_input, init) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                active -= 1;
                aborted += 1;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      });
      const result = await Promise.race([
        pending.then(
          () => "resolved",
          () => "rejected",
        ),
        vi.advanceTimersByTimeAsync(10_000).then(() => "deadline_elapsed"),
      ]);

      expect(result).toBe("rejected");
      await expect(pending).rejects.toMatchObject({
        code: "provider.transport_timeout",
        provider: "cartesia",
        retriable: true,
      });
      expect(maximumActive).toBe(5);
      expect(active).toBe(0);
      expect(aborted).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts other lookups when a provider request fails", async () => {
    let requests = 0;
    let aborted = 0;
    const pending = fetchCartesiaVoiceCatalogSnapshot({
      apiKey: "cartesia-test-key",
      voiceIds: ["voice-fail", ...Array.from({ length: 6 }, (_, index) => `voice-${index}`)],
      fetchImpl: async (_input, init) => {
        requests += 1;
        if (requests === 1) throw new Error("network failure");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted += 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: "cartesia",
      retriable: true,
    });
    expect(requests).toBe(5);
    expect(aborted).toBe(4);
  });
});
