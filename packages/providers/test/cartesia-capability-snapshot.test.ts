import { describe, expect, it, vi } from "vitest";

import { loadCartesiaCapabilitySnapshot } from "../src/index.js";

describe("loadCartesiaCapabilitySnapshot", () => {
  it("cancels a non-OK response body before returning the HTTP error", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 429 },
        ),
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
    ).rejects.toMatchObject({ code: "provider.rate_limited", retriable: true });
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it("classifies a body-read transport failure as a retriable upstream error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.error(new TypeError("socket reset while reading"));
            },
          }),
          { status: 200 },
        ),
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
    ).rejects.toMatchObject({ code: "provider.upstream_failed", retriable: true });
  });

  it.each([
    [408, "provider.upstream_failed"],
    [429, "provider.rate_limited"],
  ] as const)("classifies setup-time HTTP %i as a retriable error", async (status, code) => {
    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds: ["voice-1"],
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        fetchImpl: vi.fn(async () => new Response("{}", { status })),
      }),
    ).rejects.toMatchObject({
      code,
      retriable: true,
      metadata: { httpStatus: status },
    });
  });

  it("aborts sibling voice requests on the first batch failure and preserves its HTTP error", async () => {
    const seenSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const voiceId = String(input).split("/").at(-1);
        const signal = init?.signal;
        if (signal instanceof AbortSignal) seenSignals.push(signal);
        if (voiceId === "voice-2") return new Response(null, { status: 401 });
        return new Promise<Response>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );

    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds: ["voice-1", "voice-2", "voice-3", "voice-4"],
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        timeoutMs: 1_000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "provider.auth_failed",
      retriable: false,
      metadata: { httpStatus: 401 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(seenSignals).toHaveLength(4);
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
  }, 2_000);

  it("cancels a sibling response body that stalls after headers", async () => {
    let bodyCancelled = false;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const voiceId = String(input).split("/").at(-1);
      if (voiceId === "voice-2") return new Response(null, { status: 429 });
      return new Response(
        new ReadableStream({
          start() {},
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 200 },
      );
    });

    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds: ["voice-1", "voice-2"],
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        timeoutMs: 1_000,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "provider.rate_limited", metadata: { httpStatus: 429 } });
    await Promise.resolve();
    expect(bodyCancelled).toBe(true);
  }, 2_000);

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
        loadCartesiaCapabilitySnapshot({
          apiKey: "cartesia-secret",
          modelIds: ["sonic-3.6"],
          voiceIds: ["voice-1"],
          fetchedAt: "2026-10-25T00:00:00.000Z",
          validUntil: "2026-10-26T00:00:00.000Z",
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
        loadCartesiaCapabilitySnapshot({
          apiKey: "cartesia-secret",
          modelIds: ["sonic-3.6"],
          voiceIds: ["voice-1"],
          fetchedAt: "2026-10-25T00:00:00.000Z",
          validUntil: "2026-10-26T00:00:00.000Z",
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

  it("loads voice IDs with bounded concurrency and preserves request order", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const voiceIds = Array.from({ length: 7 }, (_, index) => `voice-${index + 1}`);
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeRequests -= 1;
      const voiceId = new URL(String(input)).pathname.split("/").at(-1);
      return new Response(JSON.stringify({ id: voiceId, status: "active" }), { status: 200 });
    });

    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["sonic-3.6"],
      voiceIds,
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl,
    });

    expect(maxActiveRequests).toBeGreaterThan(1);
    expect(maxActiveRequests).toBeLessThanOrEqual(4);
    expect(
      snapshot.facts
        .filter((fact) => fact.feature === "tts.voice.available")
        .map((fact) => fact.voice),
    ).toEqual(voiceIds);
  });

  it("canonicalizes valid accent locales and leaves malformed locale responses unknown", async () => {
    const responses: unknown[] = [
      { id: "voice-valid-locale", status: "active", accents: [{ locale: "EN-us" }] },
      { id: "voice-invalid-locale", status: "active", accents: [{ locale: "en_US" }] },
    ];
    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["sonic-3.6"],
      voiceIds: ["voice-valid-locale", "voice-invalid-locale"],
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      ),
    });

    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.accentLocales",
      scope: "voice",
      voice: "voice-valid-locale",
      status: "supported",
      value: ["en-US"],
    });
    expect(snapshot.facts).toContainEqual({
      feature: "tts.voice.accentLocales",
      scope: "voice",
      voice: "voice-invalid-locale",
      status: "unknown",
    });
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

  it("keeps voice availability unknown for a model outside the dated catalog", async () => {
    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["future-cartesia-model"],
      voiceIds: ["voice-1"],
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "voice-1", status: "active" }), { status: 200 }),
      ),
    });

    expect(snapshot.facts[0]).toEqual({
      feature: "tts.voice.available",
      scope: "voice",
      model: "future-cartesia-model",
      status: "unknown",
      voice: "voice-1",
    });
  });

  it("keeps oversized accent metadata unknown without discarding other voice facts", async () => {
    const snapshot = await loadCartesiaCapabilitySnapshot({
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
              is_pro: true,
              accents: Array.from({ length: 65 }, (_, index) => ({ locale: `locale-${index}` })),
            }),
            { status: 200 },
          ),
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
      {
        feature: "tts.voice.isPro",
        scope: "voice",
        status: "supported",
        voice: "voice-1",
        value: true,
      },
      { feature: "tts.voice.accentLocales", scope: "voice", voice: "voice-1", status: "unknown" },
    ]);
  });

  it("uses the requested ID snapshot after the first provider response is pending", async () => {
    let releaseFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let isFirstRequest = true;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (isFirstRequest) {
        isFirstRequest = false;
        await firstRequest;
      }
      const id = new URL(String(input)).pathname.split("/").at(-1);
      return new Response(JSON.stringify({ id, status: "active", is_pro: false, accents: [] }), {
        status: 200,
      });
    });
    const voiceIds = ["voice-1"];
    const modelIds = ["sonic-3.6"];
    const loading = loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds,
      voiceIds,
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl,
    });

    voiceIds.push("voice-2");
    modelIds.push("injected-model");
    releaseFirstRequest();
    const snapshot = await loading;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(snapshot.facts.filter((fact) => fact.feature === "tts.voice.available")).toEqual([
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "supported",
        voice: "voice-1",
      },
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
    ).rejects.toThrow(/exceeded its size limit/);
  });

  it("rejects a snapshot whose aggregate voice responses exceed the byte budget", async () => {
    const voiceIds = Array.from({ length: 18 }, (_, index) => `voice-${index + 1}`);
    let tailRequestsInFlight = 0;
    let maximumTailRequestsInFlight = 0;
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const id = new URL(String(input)).pathname.split("/").at(-1);
      if (Number(id?.slice("voice-".length)) > 16) {
        tailRequestsInFlight += 1;
        maximumTailRequestsInFlight = Math.max(maximumTailRequestsInFlight, tailRequestsInFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        tailRequestsInFlight -= 1;
      }
      return new Response(
        JSON.stringify({ id, status: "active", description: "x".repeat(900_000) }),
        { status: 200 },
      );
    });

    await expect(
      loadCartesiaCapabilitySnapshot({
        apiKey: "cartesia-secret",
        modelIds: ["sonic-3.6"],
        voiceIds,
        fetchedAt: "2026-10-25T00:00:00.000Z",
        validUntil: "2026-10-26T00:00:00.000Z",
        fetchImpl,
      }),
    ).rejects.toThrow(/aggregate response byte limit/);
    expect(maximumTailRequestsInFlight).toBe(1);
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

  it("rejects dot-segment voice IDs before building a request path", async () => {
    for (const voiceId of [".", ".."] as const) {
      const fetchImpl = vi.fn();
      await expect(
        loadCartesiaCapabilitySnapshot({
          apiKey: "cartesia-secret",
          modelIds: ["sonic-3.6"],
          voiceIds: [voiceId],
          fetchedAt: "2026-10-25T00:00:00.000Z",
          validUntil: "2026-10-26T00:00:00.000Z",
          fetchImpl,
        }),
      ).rejects.toThrow("Cartesia capability snapshot voice ID is invalid");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("records a voice missing from the account as unavailable without failing the snapshot", async () => {
    const snapshot = await loadCartesiaCapabilitySnapshot({
      apiKey: "cartesia-secret",
      modelIds: ["sonic-3.6"],
      voiceIds: ["voice-missing", "voice-present"],
      fetchedAt: "2026-10-25T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      fetchImpl: vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const id = new URL(String(input)).pathname.split("/").at(-1);
        if (id === "voice-missing") return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ id, status: "active", is_pro: false }), {
          status: 200,
        });
      }),
    });

    expect(snapshot.facts).toEqual([
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "unsupported",
        voice: "voice-missing",
      },
      { feature: "tts.voice.isPro", scope: "voice", status: "unknown", voice: "voice-missing" },
      {
        feature: "tts.voice.accentLocales",
        scope: "voice",
        status: "unknown",
        voice: "voice-missing",
      },
      {
        feature: "tts.voice.available",
        scope: "voice",
        model: "sonic-3.6",
        status: "supported",
        voice: "voice-present",
      },
      {
        feature: "tts.voice.isPro",
        scope: "voice",
        status: "supported",
        value: false,
        voice: "voice-present",
      },
      {
        feature: "tts.voice.accentLocales",
        scope: "voice",
        status: "unknown",
        voice: "voice-present",
      },
    ]);
  });
});
