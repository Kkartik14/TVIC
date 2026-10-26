import { describe, expect, it, vi } from "vitest";

import {
  evaluateProviderCompatibility,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type Timestamp,
  type TtsEvent,
  type TtsSynthesisRequest,
  type TurnId,
} from "@tvic/core";

import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  SARVAM_TTS_V4_FLASH_MODEL,
  SARVAM_TTS_V4_FLASH_VOICES,
  SarvamTtsHttpStream,
  SarvamTtsHttpStreamProvider,
  SarvamTtsRestProvider,
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
} from "../src/index.js";
import { SarvamWavStreamDecoder } from "../src/sarvam-tts-wav.js";
import { toSarvamTtsLanguageCode } from "../src/sarvam-tts-model.js";
import { decodeSarvamTtsAudioWithFormat } from "../src/sarvam-tts-audio.js";
import {
  assertSarvamTtsJsonStructureBounded,
  readBoundedResponseText,
} from "../src/sarvam-tts-http-response.js";

const request: TtsSynthesisRequest = {
  sessionId: "sarvam-http-session" as SessionId,
  turnId: "sarvam-http-turn" as TurnId,
  format: PCM16_16K_MONO,
  text: "Hello from TVIC.",
  stream: true,
};

const fixedClock = {
  now(): Timestamp {
    return "2026-09-25T00:00:00.000Z" as Timestamp;
  },
};

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timeout" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
      new Promise<{ readonly status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Sarvam Bulbul v3 REST TTS adapter", () => {
  it("does not allocate one Buffer per fragmented response byte", async () => {
    const text = "x".repeat(4_096);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === text.length) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(text.charCodeAt(offset)));
        offset += 1;
      },
    });
    const bufferFrom = vi.spyOn(Buffer, "from");

    try {
      await expect(readBoundedResponseText(new Response(body), text.length)).resolves.toBe(text);
      expect(bufferFrom.mock.calls.length).toBeLessThan(3);
    } finally {
      bufferFrom.mockRestore();
    }
  });

  it("rejects response bodies that exceed the fragment-work bound", async () => {
    const fragmentLimit = 65_537;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === fragmentLimit) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(120));
        offset += 1;
      },
    });

    await expect(readBoundedResponseText(new Response(body), fragmentLimit)).rejects.toThrow(
      /fragment limit/u,
    );
  });

  it("ignores JSON syntax characters inside escaped string values", () => {
    expect(() =>
      assertSarvamTtsJsonStructureBounded(
        '{"audios":["YQ=="],"request_id":"id, with \\\"quotes\\\" and []{}"}',
      ),
    ).not.toThrow();
  });

  it("ignores structural punctuation and escaped quotes in large JSON string values", () => {
    const payload = `${"[]{}:, ".repeat(2_000)}${String.fromCharCode(92, 34).repeat(2_000)}`;
    const body = JSON.stringify({ audios: [payload] });

    expect(() => assertSarvamTtsJsonStructureBounded(body)).not.toThrow();
  });

  it("rejects overlong V4 personas before either HTTP transport starts", async () => {
    let fetchCalls = 0;
    for (const voiceId of ["v".repeat(257)]) {
      const options = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
        voiceId,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("unexpected", { status: 500 });
        },
      };
      const rest = createSarvamTtsRestProvider(options);
      const stream = createSarvamTtsHttpStreamProvider(options);

      await expect(rest.synthesize(request)).rejects.toMatchObject({
        code: "provider.voice_unsupported",
      });
      await expect(stream.synthesize(request)).rejects.toMatchObject({
        code: "provider.voice_unsupported",
      });
    }
    expect(fetchCalls).toBe(0);
  });

  it("rejects a V4 persona outside the verified catalog before either HTTP transport starts", async () => {
    let fetchCalls = 0;
    const options = {
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      language: "en-IN",
      voiceId: "future_en_customer",
      fetchImpl: async (_input: string | URL | Request, _init?: RequestInit) => {
        fetchCalls += 1;
        return new Response("unexpected", { status: 500 });
      },
    };

    await expect(createSarvamTtsRestProvider(options).synthesize(request)).rejects.toMatchObject({
      code: "provider.voice_unsupported",
    });
    await expect(
      createSarvamTtsHttpStreamProvider(options).synthesize(request),
    ).rejects.toMatchObject({ code: "provider.voice_unsupported" });

    expect(fetchCalls).toBe(0);
  });

  it("sends the documented JSON request and decodes base64 WAV JSON into TVIC events", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    let url = "";
    let headers: unknown;
    let body: Record<string, unknown> | undefined;
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      language: "hi-IN",
      voiceId: "ishita",
      pace: 1.2,
      temperature: 0.7,
      pronunciationDictionaryId: "dict-1",
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        url = String(input);
        headers = init?.headers;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            request_id: "rest-request-1",
            audios: [Buffer.from(makeWav(pcm)).toString("base64")],
          }),
          { status: 200 },
        );
      },
    });

    const stream = await provider.synthesize({
      ...request,
      language: "ta-IN",
      speed: 1.4,
    });
    const events = await collectEvents(stream);

    expect(url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(headers).toMatchObject({
      "api-subscription-key": "sarvam-secret",
      "Content-Type": "application/json",
    });
    expect(body).toEqual({
      text: request.text,
      language_code: "ta-IN",
      speaker: "ishita",
      model: "bulbul:v3",
      pace: 1.4,
      temperature: 0.7,
      speech_sample_rate: 16_000,
      output_audio_codec: "wav",
      dict_id: "dict-1",
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "media.audio.chunk",
      provider: PROVIDER_NAMES.sarvamTts,
      audio: { bytes: pcm, format: PCM16_16K_MONO, frameCount: 2 },
      metadata: { sarvam: { wireFormat: "wav" } },
    });
    expect(events[1]).toMatchObject({
      type: "media.audio.committed",
      provider: PROVIDER_NAMES.sarvamTts,
      frameCount: 2,
      chunkIds: [expect.any(String)],
      metadata: {
        sarvam: { transport: "rest", requestId: "rest-request-1", wireFormat: "wav" },
      },
    });
  });

  it("keeps decoded WAV PCM as a view until the emitted event takes ownership", () => {
    const pcm = Uint8Array.from({ length: 8_192 }, (_, index) => index % 256);
    const wavBase64 = Buffer.from(makeWav(pcm)).toString("base64");
    const from = vi.spyOn(Buffer, "from");

    try {
      const decoded = decodeSarvamTtsAudioWithFormat(wavBase64, 16_384, true);
      const decodeCall = from.mock.calls.findIndex(([value]) => value === wavBase64);
      const decodedStorage = from.mock.results[decodeCall]?.value as Buffer | undefined;
      const fullPayloadCopies = from.mock.calls.filter(
        ([value]) => ArrayBuffer.isView(value) && value.byteLength >= pcm.byteLength,
      );

      expect(decodedStorage).toBeDefined();
      expect(decoded.bytes.buffer === decodedStorage?.buffer).toBe(true);
      expect(decoded.bytes.byteOffset).toBe((decodedStorage?.byteOffset ?? 0) + 44);
      expect(decoded.bytes.byteLength).toBe(pcm.byteLength);
      expect(fullPayloadCopies).toHaveLength(0);
    } finally {
      from.mockRestore();
    }
  });

  it.each([
    [401, TVIC_ERROR_CODES.providerAuthFailed, false, false],
    [422, TVIC_ERROR_CODES.providerInvalidRequest, false, false],
    [404, TVIC_ERROR_CODES.providerInvalidRequest, false, false],
    [408, TVIC_ERROR_CODES.providerUpstreamFailed, false, true],
    [409, TVIC_ERROR_CODES.providerUpstreamFailed, false, true],
    [429, TVIC_ERROR_CODES.providerRateLimited, true, false],
    [500, TVIC_ERROR_CODES.providerUpstreamFailed, false, true],
  ] as const)(
    "maps REST HTTP %s to the canonical provider error",
    async (status, code, retriable, outcomeUnknown) => {
      const provider = createSarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        clock: fixedClock,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { code: "upstream_code", message: "failure" } }), {
            status,
          }),
      });

      await expect(provider.synthesize(request)).rejects.toMatchObject({
        code,
        provider: PROVIDER_NAMES.sarvamTts,
        retriable,
        metadata: {
          httpStatus: status,
          ...(outcomeUnknown ? { outcomeUnknown: true } : { providerCode: "upstream_code" }),
        },
      });
    },
  );

  it.each([
    ["fetch", async () => Promise.reject(new Error("connection reset after dispatch"))],
    [
      "response body",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("response body connection reset"));
            },
          }),
          { status: 200 },
        ),
    ],
  ] as const)(
    "marks a %s transport failure as an unknown synthesis outcome",
    async (_phase, fetchImpl) => {
      const provider = createSarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        fetchImpl: fetchImpl as typeof fetch,
      });

      await expect(provider.synthesize(request)).rejects.toMatchObject({
        retriable: false,
        metadata: { outcomeUnknown: true },
      });
    },
  );

  it("bounds a REST request that never receives response headers", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const provider = createSarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        requestTimeoutMs: 50,
        responseIdleTimeoutMs: 200,
        fetchImpl: async (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
              once: true,
            });
          });
        },
      });
      const pending = settleWithin(provider.synthesize(request), 60);

      await vi.advanceTimersByTimeAsync(60);
      const result = await pending;
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("REST request did not reject on timeout");
      expect(result.reason).toMatchObject({
        code: TVIC_ERROR_CODES.providerTransportTimeout,
        retriable: false,
        metadata: { timeoutPhase: "request", timeoutMs: 50, outcomeUnknown: true },
      });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["REST", createSarvamTtsRestProvider],
    ["HTTP stream", createSarvamTtsHttpStreamProvider],
  ] as const)(
    "uses the request deadline, not response-idle, before %s headers arrive",
    async (transport, createProvider) => {
      vi.useFakeTimers();
      try {
        let requestSignal: AbortSignal | undefined;
        const provider = createProvider({
          apiKey: "sarvam-secret",
          requestTimeoutMs: 100,
          responseIdleTimeoutMs: 25,
          fetchImpl: async (_input, init) => {
            requestSignal = init?.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
              requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
                once: true,
              });
            });
          },
        });
        const pending = settleWithin(provider.synthesize(request), 150);

        await vi.advanceTimersByTimeAsync(50);
        expect(requestSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(50);

        const result = await pending;
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error(`${transport} request did not reject on timeout`);
        }
        expect(result.reason).toMatchObject({
          code: TVIC_ERROR_CODES.providerTransportTimeout,
          retriable: false,
          metadata: { timeoutPhase: "request", timeoutMs: 100, outcomeUnknown: true },
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds a REST response body that stops making progress", async () => {
    vi.useFakeTimers();
    try {
      let markBodyRead!: () => void;
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });
      const provider = createSarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        requestTimeoutMs: 500,
        responseIdleTimeoutMs: 40,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                markBodyRead();
                controller.enqueue(new TextEncoder().encode("{"));
              },
            }),
            { status: 200 },
          ),
      });
      const pending = settleWithin(provider.synthesize(request), 50);
      await bodyRead;
      await vi.advanceTimersByTimeAsync(50);

      const result = await pending;
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("REST body did not reject on timeout");
      expect(result.reason).toMatchObject({
        code: TVIC_ERROR_CODES.providerTransportTimeout,
        retriable: false,
        metadata: { timeoutPhase: "response_idle", timeoutMs: 40, outcomeUnknown: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails an HTTP stream instead of silently closing when its body stalls", async () => {
    vi.useFakeTimers();
    try {
      let markBodyRead!: () => void;
      const bodyRead = new Promise<void>((resolve) => {
        markBodyRead = resolve;
      });
      const provider = createSarvamTtsHttpStreamProvider({
        apiKey: "sarvam-secret",
        requestTimeoutMs: 500,
        responseIdleTimeoutMs: 40,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {
                markBodyRead();
              },
            }),
            { status: 200 },
          ),
      });
      const stream = await provider.synthesize(request);
      const pending = settleWithin(stream.events[Symbol.asyncIterator]().next(), 50);
      await bodyRead;
      await vi.advanceTimersByTimeAsync(50);

      const result = await pending;
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("HTTP stream did not reject on timeout");
      expect(result.reason).toMatchObject({
        code: TVIC_ERROR_CODES.providerTransportTimeout,
        retriable: false,
        metadata: { timeoutPhase: "response_idle", timeoutMs: 40, outcomeUnknown: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle deadline as REST response bytes arrive and clears timers on completion", async () => {
    vi.useFakeTimers();
    try {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      });
      const payload = new TextEncoder().encode(
        JSON.stringify({
          audios: [Buffer.from(makeWav(new Uint8Array([1, 2, 3, 4]))).toString("base64")],
        }),
      );
      const split = Math.floor(payload.byteLength / 2);
      const provider = createSarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        requestTimeoutMs: 500,
        responseIdleTimeoutMs: 40,
        fetchImpl: async () => new Response(body, { status: 200 }),
      });
      const pending = settleWithin(provider.synthesize(request), 100);
      setTimeout(() => bodyController.enqueue(payload.subarray(0, split)), 30);
      setTimeout(() => {
        bodyController.enqueue(payload.subarray(split));
        bodyController.close();
      }, 60);

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw new Error("REST response did not complete");
      await expect(collectEvents(result.value)).resolves.toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not truncate a long HTTP stream while response chunks keep arriving", async () => {
    vi.useFakeTimers();
    try {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
        },
      });
      const wav = makeWav(new Uint8Array([1, 2, 3, 4]));
      const split = Math.floor(wav.byteLength / 2);
      const provider = createSarvamTtsHttpStreamProvider({
        apiKey: "sarvam-secret",
        requestTimeoutMs: 500,
        responseIdleTimeoutMs: 40,
        fetchImpl: async () => new Response(body, { status: 200 }),
      });
      const stream = await provider.synthesize(request);
      const pending = settleWithin(collectEvents(stream), 100);
      setTimeout(() => bodyController.enqueue(wav.subarray(0, split)), 30);
      setTimeout(() => {
        bodyController.enqueue(wav.subarray(split));
        bodyController.close();
      }, 60);

      await vi.advanceTimersByTimeAsync(30);
      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") throw new Error("HTTP stream stopped despite progress");
      expect(result.value).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid HTTP deadline settings at provider construction", () => {
    for (const createProvider of [createSarvamTtsRestProvider, createSarvamTtsHttpStreamProvider]) {
      for (const option of ["requestTimeoutMs", "responseIdleTimeoutMs"] as const) {
        for (const value of [0, 1.5, 2_147_483_648]) {
          expect(() => createProvider({ apiKey: "sarvam-secret", [option]: value })).toThrow(
            /must be an integer/u,
          );
        }
      }
    }
  });

  it("rejects an unsupported configured language at provider construction", () => {
    for (const createProvider of [createSarvamTtsRestProvider, createSarvamTtsHttpStreamProvider]) {
      expect(() => createProvider({ apiKey: "sarvam-secret", language: "as-IN" })).toThrow(
        /language is invalid/u,
      );
    }
  });

  it.each([
    [
      429,
      "rate_limit_exceeded_error",
      "quota exceeded",
      TVIC_ERROR_CODES.providerRateLimited,
      true,
    ],
    [
      503,
      "rate_limit_exceeded_error",
      "quota exceeded",
      TVIC_ERROR_CODES.providerUpstreamFailed,
      false,
    ],
    [
      429,
      "insufficient_quota_error",
      "rate limit exceeded",
      TVIC_ERROR_CODES.providerQuotaExceeded,
      false,
    ],
    [429, "unknown_provider_error", "quota exceeded", TVIC_ERROR_CODES.providerRateLimited, true],
  ] as const)(
    "classifies structured Sarvam error codes without overriding ambiguous HTTP %s status (%s)",
    async (status, providerCode, message, code, retriable) => {
      const provider = createSarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { code: providerCode, message } }), { status }),
      });

      await expect(provider.synthesize(request)).rejects.toMatchObject({
        code,
        retriable,
        metadata: {
          httpStatus: status,
          ...(status >= 500 ? { outcomeUnknown: true } : { providerCode }),
        },
      });
    },
  );

  it("keeps an HTTP-stream 503 outcome unknown even when the body says rate-limited", async () => {
    const provider = createSarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "rate_limit_exceeded_error" } }), {
          status: 503,
        }),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      retriable: false,
      metadata: { httpStatus: 503, outcomeUnknown: true },
    });
  });

  it.each([
    ["REST", createSarvamTtsRestProvider],
    ["HTTP stream", createSarvamTtsHttpStreamProvider],
  ] as const)(
    "keeps a received 429 status when the %s error body stalls",
    async (_name, createProvider) => {
      vi.useFakeTimers();
      try {
        let markBodyRead!: () => void;
        const bodyRead = new Promise<void>((resolve) => {
          markBodyRead = resolve;
        });
        const provider = createProvider({
          apiKey: "sarvam-secret",
          requestTimeoutMs: 60_000,
          responseIdleTimeoutMs: 30_000,
          fetchImpl: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  markBodyRead();
                  controller.enqueue(new TextEncoder().encode('{"error":'));
                },
              }),
              { status: 429 },
            ),
        });
        const pending = settleWithin(provider.synthesize(request), 100);
        await bodyRead;
        await vi.advanceTimersByTimeAsync(100);

        const result = await pending;
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") throw new Error("429 response did not reject");
        expect(result.reason).toMatchObject({
          code: TVIC_ERROR_CODES.providerRateLimited,
          retriable: true,
          metadata: { httpStatus: 429 },
        });
        expect(result.reason).not.toHaveProperty("metadata.outcomeUnknown");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("classifies exhausted provider credits as a canonical quota condition", async () => {
    const provider = createSarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "No credits available." }), {
          status: 402,
        }),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerQuotaExceeded,
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
      metadata: { httpStatus: 402 },
    });
  });

  it("treats an unclassified HTTP 402 as permanent quota exhaustion", async () => {
    const provider = createSarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () => new Response("payment required", { status: 402 }),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerQuotaExceeded,
      retriable: false,
      metadata: { httpStatus: 402 },
    });
  });

  it("does not classify quota wording on an HTTP 500 as a safe quota rejection", async () => {
    const provider = createSarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "temporary quota service failure" }), {
          status: 500,
        }),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerUpstreamFailed,
      retriable: false,
      metadata: { httpStatus: 500, outcomeUnknown: true },
    });
  });

  it("fails closed for malformed REST audio and enforces its 2,500-character limit", async () => {
    let calls = 0;
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ audios: ["not-base64"] }), { status: 200 });
      },
    });

    await expect(
      provider.synthesize({ ...request, text: "x".repeat(2_501) }),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerProtocolInvalid,
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    });
    expect(calls).toBe(1);
  });

  it("rejects unframed PCM when the REST contract requests WAV", async () => {
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(JSON.stringify({ audios: [Buffer.from([0, 0]).toString("base64")] }), {
          status: 200,
        }),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerProtocolInvalid,
      retriable: false,
    });
  });

  it("normalizes REST transport failures and response-body disconnects", async () => {
    const transportFailure = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () => {
        throw new Error("socket reset");
      },
    });
    await expect(transportFailure.synthesize(request)).rejects.toMatchObject({
      code: "sarvam.tts.error",
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    });

    const bodyFailure = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"audios":['));
              controller.error(new Error("connection closed while reading response"));
            },
          }),
          { status: 200 },
        ),
    });
    await expect(bodyFailure.synthesize(request)).rejects.toMatchObject({
      code: "sarvam.tts.error",
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    });
  });

  it("maps caller cancellation while REST headers are pending", async () => {
    const controller = new AbortController();
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const pending = provider.synthesize({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("maps caller cancellation while the REST response body is pending", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        resolveReadStarted();
        signal?.addEventListener(
          "abort",
          () => streamController.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    });
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(body, { status: 200 });
      },
    });
    const pending = provider.synthesize({ ...request, signal: controller.signal });
    await readStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("enforces the bounded REST response body before parsing untrusted data", async () => {
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(new Uint8Array(16 * 1024 * 1024 + 1), {
          status: 200,
        }),
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerProtocolInvalid,
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("rejects structurally oversized REST JSON before materializing its arrays", async () => {
    const body = `{"audios":[${Array.from({ length: 600 }, () => '""').join(",")}]}`;
    const provider = createSarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    const parse = vi.spyOn(JSON, "parse");
    let parseCalls = -1;
    try {
      await expect(provider.synthesize(request)).rejects.toThrow(/complexity|structure/u);
      parseCalls = parse.mock.calls.length;
    } finally {
      parse.mockRestore();
    }
    expect(parseCalls).toBe(0);
  });
});

describe("Sarvam Bulbul v4 Flash HTTP adapters", () => {
  it.each(["rest", "http-stream"] as const)(
    "%s synthesizes every verified V4 persona with every supported V4 language",
    async (transport) => {
      const pcm = new Uint8Array([21, 22, 23, 24]);
      const languages = SARVAM_TTS_LANGUAGES;
      let pairs = 0;

      for (const voice of SARVAM_TTS_V4_FLASH_VOICES) {
        for (const language of languages) {
          let body: Record<string, unknown> | undefined;
          const options = {
            apiKey: "sarvam-secret",
            modelId: SARVAM_TTS_V4_FLASH_MODEL,
            fetchImpl: async (
              _input: Parameters<typeof fetch>[0],
              init?: Parameters<typeof fetch>[1],
            ) => {
              body = JSON.parse(String(init?.body)) as Record<string, unknown>;
              const wav = makeWav(pcm);
              return transport === "rest"
                ? new Response(JSON.stringify({ audios: [Buffer.from(wav).toString("base64")] }), {
                    status: 200,
                  })
                : new Response(chunkedStream(wav, [12, 44]), { status: 200 });
            },
          };
          const provider =
            transport === "rest"
              ? new SarvamTtsRestProvider(options)
              : new SarvamTtsHttpStreamProvider(options);

          await collectEvents(
            await provider.synthesize({
              ...request,
              model: SARVAM_TTS_V4_FLASH_MODEL,
              voice,
              language,
            }),
          );
          expect(body).toMatchObject({
            model: SARVAM_TTS_V4_FLASH_MODEL,
            speaker: voice,
            language_code: toSarvamTtsLanguageCode(language),
          });
          pairs += 1;
        }
      }

      expect(pairs).toBe(SARVAM_TTS_V4_FLASH_VOICES.length * languages.length);
    },
    30_000,
  );

  it.each(["rest", "http-stream"] as const)(
    "%s declares required V4 voice and recognizes the catalog language pairing",
    (transport) => {
      const options = { apiKey: "sarvam-secret", modelId: SARVAM_TTS_V4_FLASH_MODEL };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(options)
          : new SarvamTtsHttpStreamProvider(options);

      expect(provider.requiresTtsVoiceForModel()).toBe(true);
      expect(
        provider.supportsTtsLanguage("en-IN", SARVAM_TTS_V4_FLASH_MODEL, "simran_en_customer"),
      ).toBe(true);
      expect(
        provider.supportsTtsLanguage("hi-IN", SARVAM_TTS_V4_FLASH_MODEL, "simran_en_customer"),
      ).toBe(true);
    },
  );

  it("declare required language and supported speed for the selected V4 voice", () => {
    const rest = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      voiceId: "simran_en_customer",
      language: "en-IN",
    });
    const httpStream = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      modelId: SARVAM_TTS_V4_FLASH_MODEL,
      voiceId: "simran_en_customer",
      language: "en-IN",
    });

    for (const provider of [rest, httpStream]) {
      expect(provider.requiresTtsLanguageForModel()).toBe(true);
      expect(provider.supportsTtsLanguage("en-IN")).toBe(true);
      expect(provider.supportsTtsLanguage("hi-IN")).toBe(true);
      expect(provider.supportsTtsSpeed(0.5)).toBe(true);
      expect(provider.supportsTtsSpeed(2.0)).toBe(true);
      expect(provider.supportsTtsSpeed(2.01)).toBe(false);
    }
  });

  it("accepts documented V4 language codes without a matching persona prefix", () => {
    for (const provider of [
      new SarvamTtsRestProvider({ apiKey: "sarvam-secret", modelId: SARVAM_TTS_V4_FLASH_MODEL }),
      new SarvamTtsHttpStreamProvider({
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
      }),
    ]) {
      expect(
        provider.supportsTtsLanguage("ml-IN", SARVAM_TTS_V4_FLASH_MODEL, "simran_en_customer"),
      ).toBe(true);
      expect(
        provider.supportsTtsLanguage("or-IN", SARVAM_TTS_V4_FLASH_MODEL, "simran_en_customer"),
      ).toBe(true);
    }
  });

  it.each(["rest", "http-stream"] as const)(
    "%s accepts a run-level cross-language compatibility selection",
    (transport) => {
      const options = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(options)
          : new SarvamTtsHttpStreamProvider(options);

      expect(provider.supportsLanguage("en-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(true);
      expect(provider.supportsLanguage("hi-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
      expect(provider.capabilities.languages).toEqual(["en-IN"]);
      expect(
        evaluateProviderCompatibility(provider, {
          kind: "tts",
          model: SARVAM_TTS_V4_FLASH_MODEL,
          language: "hi-IN",
          voice: "simran_en_customer",
        }),
      ).toEqual({ compatible: true, issues: [] });
    },
  );

  it.each(["rest", "http-stream"] as const)(
    "%s rejects a host-disallowed V4 voice-language pair before fetch",
    async (transport) => {
      let fetchCalls = 0;
      const providerOptions = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        voiceLanguages: { simran_en_customer: ["hi-IN"] as const },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 200 });
        },
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(providerOptions)
          : new SarvamTtsHttpStreamProvider(providerOptions);

      await expect(
        provider.synthesize({
          ...request,
          model: SARVAM_TTS_V4_FLASH_MODEL,
          voice: "simran_en_customer",
          language: "en-IN",
        }),
      ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.ttsLanguageUnsupported });
      expect(fetchCalls).toBe(0);
    },
  );

  it.each(["rest", "http-stream"] as const)(
    "%s accepts a run-level language for a V4 model override",
    async (transport) => {
      let fetchCalls = 0;
      const providerOptions = {
        apiKey: "sarvam-secret",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 200 });
        },
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(providerOptions)
          : new SarvamTtsHttpStreamProvider(providerOptions);

      await expect(
        provider.synthesize({
          ...request,
          model: SARVAM_TTS_V4_FLASH_MODEL,
          voice: "simran_en_customer",
          language: "en-IN",
        }),
      ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerProtocolInvalid });
      expect(fetchCalls).toBe(1);
    },
  );

  it("excludes the unverified Assamese language from every configured V4 adapter", () => {
    for (const provider of [
      new SarvamTtsRestProvider({
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
      }),
      new SarvamTtsHttpStreamProvider({
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
      }),
    ]) {
      expect(provider.supportsLanguage("as-IN", SARVAM_TTS_V4_FLASH_MODEL)).toBe(false);
    }
  });

  it.each(["rest", "http-stream"] as const)(
    "rejects the unverified Assamese language before %s fetch",
    async (transport) => {
      let fetchCalls = 0;
      const providerOptions = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "as-IN",
        voiceId: "simran_en_customer",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(null, { status: 200 });
        },
      };
      expect(() =>
        transport === "rest"
          ? new SarvamTtsRestProvider(providerOptions)
          : new SarvamTtsHttpStreamProvider(providerOptions),
      ).toThrow(/language is invalid/u);
      expect(fetchCalls).toBe(0);
    },
  );

  it.each(["rest", "http-stream"] as const)(
    "passes the caller-selected model and persona through %s",
    async (transport) => {
      const pcm = new Uint8Array([21, 22, 23, 24]);
      let body: Record<string, unknown> | undefined;
      const providerOptions = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
        voiceId: "simran_en_customer",
        fetchImpl: async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const wav = makeWav(pcm);
          return transport === "rest"
            ? new Response(JSON.stringify({ audios: [Buffer.from(wav).toString("base64")] }), {
                status: 200,
              })
            : new Response(chunkedStream(wav), { status: 200 });
        },
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(providerOptions)
          : new SarvamTtsHttpStreamProvider(providerOptions);

      await collectEvents(
        await provider.synthesize({
          ...request,
          model: SARVAM_TTS_V4_FLASH_MODEL,
          voice: "simran_en_customer",
        }),
      );

      expect(body).toMatchObject({
        model: SARVAM_TTS_V4_FLASH_MODEL,
        speaker: "simran_en_customer",
      });
      expect(body).not.toHaveProperty("temperature");
    },
  );

  it.each([
    ["aparna_hi_customer", "en-IN"],
    ["shubh_hi_customer", "en-IN"],
    ["shubh_hi_ecomm", "en-IN"],
    ["simran_en_customer", "hi-IN"],
  ] as const)(
    "sends cross-language V4 persona %s with language %s through REST and HTTP streaming",
    async (voice, language) => {
      const pcm = new Uint8Array([21, 22, 23, 24]);
      for (const transport of ["rest", "http-stream"] as const) {
        let body: Record<string, unknown> | undefined;
        const options = {
          apiKey: "sarvam-secret",
          modelId: SARVAM_TTS_V4_FLASH_MODEL,
          fetchImpl: async (
            _input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            const wav = makeWav(pcm);
            return transport === "rest"
              ? new Response(JSON.stringify({ audios: [Buffer.from(wav).toString("base64")] }), {
                  status: 200,
                })
              : new Response(chunkedStream(wav), { status: 200 });
          },
        };
        const provider =
          transport === "rest"
            ? new SarvamTtsRestProvider(options)
            : new SarvamTtsHttpStreamProvider(options);

        await collectEvents(
          await provider.synthesize({
            ...request,
            model: SARVAM_TTS_V4_FLASH_MODEL,
            voice,
            language,
          }),
        );

        expect(body).toMatchObject({
          model: SARVAM_TTS_V4_FLASH_MODEL,
          speaker: voice,
          language_code: language,
        });
      }
    },
  );

  it.each(["rest", "http-stream"] as const)(
    "%s sends an explicitly configured V4 temperature",
    async (transport) => {
      const pcm = new Uint8Array([21, 22, 23, 24]);
      let body: Record<string, unknown> | undefined;
      const providerOptions = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
        voiceId: "simran_en_customer",
        temperature: 0.7,
        fetchImpl: async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const wav = makeWav(pcm);
          return transport === "rest"
            ? new Response(JSON.stringify({ audios: [Buffer.from(wav).toString("base64")] }), {
                status: 200,
              })
            : new Response(chunkedStream(wav), { status: 200 });
        },
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(providerOptions)
          : new SarvamTtsHttpStreamProvider(providerOptions);

      await collectEvents(
        await provider.synthesize({
          ...request,
          model: SARVAM_TTS_V4_FLASH_MODEL,
          voice: "simran_en_customer",
        }),
      );
      expect(body).toMatchObject({
        model: SARVAM_TTS_V4_FLASH_MODEL,
        temperature: 0.7,
      });
    },
  );

  it.each(["rest", "http-stream"] as const)(
    "%s rejects an out-of-range V4 temperature before making a request",
    async (transport) => {
      for (const temperature of [0, 1.01]) {
        let fetchCalls = 0;
        const providerOptions = {
          apiKey: "sarvam-secret",
          modelId: SARVAM_TTS_V4_FLASH_MODEL,
          language: "en-IN",
          voiceId: "simran_en_customer",
          temperature,
          fetchImpl: async () => {
            fetchCalls += 1;
            return new Response("unexpected", { status: 500 });
          },
        };
        const provider =
          transport === "rest"
            ? new SarvamTtsRestProvider(providerOptions)
            : new SarvamTtsHttpStreamProvider(providerOptions);

        await expect(
          provider.synthesize({
            ...request,
            model: SARVAM_TTS_V4_FLASH_MODEL,
            voice: "simran_en_customer",
          }),
        ).rejects.toThrow("Sarvam Bulbul temperature must be between 0.01 and 1");
        expect(fetchCalls).toBe(0);
      }
    },
  );

  it.each(["rest", "http-stream"] as const)(
    "requires a caller-selected v4 persona before %s starts",
    async (transport) => {
      let fetchCalls = 0;
      const providerOptions = {
        apiKey: "sarvam-secret",
        modelId: SARVAM_TTS_V4_FLASH_MODEL,
        language: "en-IN",
        fetchImpl: async (_input: Parameters<typeof fetch>[0]) => {
          fetchCalls += 1;
          return new Response("unexpected", { status: 500 });
        },
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(providerOptions)
          : new SarvamTtsHttpStreamProvider(providerOptions);

      await expect(
        provider.synthesize({ ...request, model: SARVAM_TTS_V4_FLASH_MODEL }),
      ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerVoiceUnsupported });
      expect(fetchCalls).toBe(0);
    },
  );
});

describe("Sarvam Bulbul v3 HTTP stream TTS adapter", () => {
  it("decodes a maximum-length header with fragmented zero-length metadata chunks", () => {
    const pcm = new Uint8Array([5, 6, 7, 8]);
    const wav = makeWavWithEmptyJunkChunks(pcm, 8_186);
    const decoder = new SarvamWavStreamDecoder();
    const decoded: Uint8Array[] = [];

    for (let offset = 0; offset < wav.byteLength; offset += 1) {
      decoded.push(...decoder.push(wav.subarray(offset, offset + 1)));
    }
    decoder.finish();

    expect(Buffer.concat(decoded.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(pcm));
  });

  it("ignores oversized trailing bytes after a finite WAV data chunk", () => {
    const pcm = new Uint8Array([5, 6]);
    const wavWithTrailingBytes = Buffer.concat([
      Buffer.from(makeWav(pcm)),
      Buffer.alloc(8 * 1024 * 1024),
    ]);
    const decoder = new SarvamWavStreamDecoder();

    const decoded = decoder.push(wavWithTrailingBytes);
    decoder.finish();

    expect(Buffer.concat(decoded.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(pcm));
  });

  it("rejects HTTP-stream startup when a response arrives after caller cancellation", async () => {
    const controller = new AbortController();
    let resolveResponse!: (response: Response) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () => {
        markFetchStarted();
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });
      },
    });

    const pending = provider.synthesize({ ...request, signal: controller.signal });
    await fetchStarted;
    controller.abort();
    resolveResponse(new Response(makeWav(new Uint8Array([1, 2])), { status: 200 }));

    await expect(pending).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("streams binary WAV data as audio events before closing the request", async () => {
    const pcm = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const wav = makeWav(pcm, true);
    let body: Record<string, unknown> | undefined;
    let signal: AbortSignal | undefined;
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      language: "ta-IN",
      voiceId: "kavitha",
      clock: fixedClock,
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        signal = init?.signal ?? undefined;
        return new Response(chunkedStream(wav, [10, 44, 45, wav.byteLength]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      },
    });

    const stream = await provider.synthesize({ ...request, language: "hi-IN" });
    const iterator = stream.events[Symbol.asyncIterator]();
    const events: unknown[] = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      events.push(result.value);
    }

    expect(body).toMatchObject({
      text: request.text,
      language_code: "hi-IN",
      speaker: "kavitha",
      model: "bulbul:v3",
      speech_sample_rate: 16_000,
      output_audio_codec: "wav",
    });
    expect(signal?.aborted).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "media.audio.chunk",
      audio: { bytes: pcm, frameCount: 3 },
      metadata: { sarvam: { transport: "http-stream", wireFormat: "wav" } },
    });
    expect(events[1]).toMatchObject({
      type: "media.audio.committed",
      frameCount: 3,
      metadata: { sarvam: { transport: "http-stream", wireFormat: "wav" } },
    });
  });

  it.each([1, 2])(
    "keeps a valid WAV larger than the event limit intact when delivered in %s-byte fragments",
    async (fragmentSize) => {
      const pcm = Uint8Array.from({ length: 32_770 }, (_, index) => index % 256);
      const wav = makeWav(pcm, true);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === wav.byteLength) {
            controller.close();
            return;
          }
          const end = offset === 0 ? 44 : Math.min(offset + fragmentSize, wav.byteLength);
          controller.enqueue(wav.subarray(offset, end));
          offset = end;
        },
      });
      const provider = new SarvamTtsHttpStreamProvider({
        apiKey: "sarvam-secret",
        clock: fixedClock,
        fetchImpl: async () => new Response(body, { status: 200 }),
      });

      const bufferConcat = vi.spyOn(Buffer, "concat");
      let events: TtsEvent[];
      try {
        events = await collectEvents(await provider.synthesize(request));
      } finally {
        bufferConcat.mockRestore();
      }
      const chunks = events.filter((event) => event.type === "media.audio.chunk");

      expect(bufferConcat).not.toHaveBeenCalled();
      expect(chunks.length).toBeLessThan(100);
      expect(chunks.every((event) => event.audio.bytes.byteLength <= 1_024)).toBe(true);
      expect(new Set(chunks.map((event) => event.audio.bytes.buffer)).size).toBe(chunks.length);
      expect(Buffer.concat(chunks.map((event) => Buffer.from(event.audio.bytes)))).toEqual(
        Buffer.from(pcm),
      );
      expect(events.at(-1)?.type).toBe("media.audio.committed");
    },
  );

  it("preserves bounded event batches when a large WAV arrives as one body chunk", async () => {
    const pcm = new Uint8Array(2 * 1024 * 1024);
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      clock: fixedClock,
      fetchImpl: async () => new Response(makeWav(pcm, true), { status: 200 }),
    });

    const events = await collectEvents(await provider.synthesize(request));
    const chunks = events.filter((event) => event.type === "media.audio.chunk");

    expect(chunks.length).toBe(2_048);
    expect(events.at(-1)?.type).toBe("media.audio.committed");
  });

  it("rejects an excessively fragmented streamed WAV within the output-byte bound", async () => {
    const pcm = new Uint8Array(65_536 * 2);
    const wav = makeWav(pcm, true);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === wav.byteLength) {
          controller.close();
          return;
        }
        const end = offset === 0 ? 44 : Math.min(offset + 2, wav.byteLength);
        controller.enqueue(wav.subarray(offset, end));
        offset = end;
      },
    });
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      clock: fixedClock,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });

    await expect(collectEvents(await provider.synthesize(request))).rejects.toThrow(
      /fragment limit/u,
    );
  });

  it("finishes at the declared WAV data boundary and cancels trailing response bytes", async () => {
    const pcm = new Uint8Array([5, 6, 7, 8]);
    let responseCancelled = false;
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(makeWav(pcm));
            },
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              responseCancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "audio/wav" } },
        ),
    });

    const stream = await provider.synthesize(request);
    const events = await Promise.race([
      collectEvents(stream),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("finite WAV response did not complete")), 500),
      ),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "media.audio.chunk", audio: { bytes: pcm } });
    expect(events[1]).toMatchObject({ type: "media.audio.committed" });
    expect(responseCancelled).toBe(true);
  });

  it("accepts the longer 3,500-character HTTP-stream request but rejects the next character", async () => {
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(chunkedStream(makeWav(new Uint8Array([1, 2]))), { status: 200 }),
    });

    await expect(
      provider.synthesize({ ...request, text: "x".repeat(3_500) }),
    ).resolves.toBeDefined();
    await expect(
      provider.synthesize({ ...request, text: "x".repeat(3_501) }),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
  });

  it("maps HTTP-stream errors and cancellation without hanging the consumer", async () => {
    const provider = createSarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: "too_many_requests", message: "slow down" } }),
          {
            status: 429,
          },
        ),
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerRateLimited,
      retriable: true,
    });

    const controller = new AbortController();
    const cancellable = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
          }),
          { status: 200 },
        ),
    });
    const stream = await cancellable.synthesize({ ...request, signal: controller.signal });
    const pending = stream.events[Symbol.asyncIterator]().next();
    await stream.cancel();
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("does not emit queued audio after HTTP-stream cancellation wins the read race", async () => {
    let resolveRead!: (result: { done: false; value: Uint8Array }) => void;
    let resolveCancel!: () => void;
    const reader = {
      read: () =>
        new Promise<{ done: false; value: Uint8Array }>((resolve) => {
          resolveRead = resolve;
        }),
      cancel: () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
      releaseLock: () => undefined,
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const controller = new AbortController();
    const stream = new SarvamTtsHttpStream(body, request, {
      clock: fixedClock,
      model: "bulbul:v3",
      language: "en-IN",
      voice: "shubh",
      transport: "http-stream",
      wireFormat: "wav",
      controller,
      detachAbort: () => undefined,
    });
    stream.start();
    const pending = stream.events[Symbol.asyncIterator]().next();
    const cancellation = stream.cancel();
    resolveRead({ done: false, value: makeWav(new Uint8Array([1, 2, 3, 4])) });
    await Promise.resolve();
    resolveCancel();

    await cancellation;
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("closes events and releases the reader when the request aborts during a read", async () => {
    let resolveRead!: (result: { done: false; value: Uint8Array }) => void;
    let cancelCalled = false;
    let lockReleased = false;
    const reader = {
      read: () =>
        new Promise<{ done: false; value: Uint8Array }>((resolve) => {
          resolveRead = resolve;
        }),
      cancel: async () => {
        cancelCalled = true;
      },
      releaseLock: () => {
        lockReleased = true;
      },
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const controller = new AbortController();
    const stream = new SarvamTtsHttpStream(body, request, {
      clock: fixedClock,
      model: "bulbul:v3",
      language: "en-IN",
      voice: "shubh",
      transport: "http-stream",
      wireFormat: "wav",
      controller,
      detachAbort: () => undefined,
    });
    stream.start();
    const pending = stream.events[Symbol.asyncIterator]().next();

    controller.abort();
    resolveRead({ done: false, value: makeWav(new Uint8Array([1, 2])) });

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("aborted HTTP events stayed open")), 500),
        ),
      ]),
    ).resolves.toMatchObject({ done: true });
    expect(cancelCalled).toBe(true);
    expect(lockReleased).toBe(true);
  });

  it("releases the HTTP body reader after normal completion", async () => {
    let readCount = 0;
    let lockReleased = false;
    const reader = {
      async read() {
        readCount += 1;
        return readCount === 1
          ? { done: false as const, value: makeWav(new Uint8Array([1, 2])) }
          : { done: true as const, value: undefined };
      },
      async cancel() {},
      releaseLock: () => {
        lockReleased = true;
      },
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const stream = new SarvamTtsHttpStream(body, request, {
      clock: fixedClock,
      model: "bulbul:v3",
      language: "en-IN",
      voice: "shubh",
      transport: "http-stream",
      wireFormat: "wav",
      controller: new AbortController(),
      detachAbort: () => undefined,
    });
    stream.start();

    await expect(collectEvents(stream)).resolves.toHaveLength(2);
    expect(lockReleased).toBe(true);
  });

  it("maps caller cancellation while an HTTP error body is pending", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        resolveReadStarted();
        signal?.addEventListener(
          "abort",
          () => streamController.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    });
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(body, { status: 429 });
      },
    });
    const pending = provider.synthesize({ ...request, signal: controller.signal });
    await readStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it.each(["rest", "http-stream"] as const)(
    "does not hang when caller cancellation meets a hostile %s error body",
    async (transport) => {
      const controller = new AbortController();
      let resolveReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        resolveReadStarted = resolve;
      });
      const body = new ReadableStream<Uint8Array>({
        pull() {
          resolveReadStarted();
        },
      });
      const options = {
        apiKey: "sarvam-secret",
        fetchImpl: async () => new Response(body, { status: 500 }),
      };
      const provider =
        transport === "rest"
          ? new SarvamTtsRestProvider(options)
          : new SarvamTtsHttpStreamProvider(options);
      const pending = provider.synthesize({ ...request, signal: controller.signal });
      await readStarted;
      controller.abort();

      await expect(
        Promise.race([
          pending,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("hostile error body did not cancel")), 500),
          ),
        ]),
      ).rejects.toMatchObject({
        code: "provider.connection_cancelled",
        provider: PROVIDER_NAMES.sarvamTts,
      });
    },
  );

  it("fails the event consumer on a truncated WAV or network read error", async () => {
    const truncatedWav = makeWav(new Uint8Array([1, 2, 3, 4])).slice(0, 46);
    const truncatedProvider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(chunkedStream(truncatedWav, [12, truncatedWav.byteLength]), { status: 200 }),
    });
    const truncatedStream = await truncatedProvider.synthesize(request);
    await expect(collectEvents(truncatedStream)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerProtocolInvalid,
      provider: PROVIDER_NAMES.sarvamTts,
    });

    const resetProvider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(makeWav(new Uint8Array([5, 6])));
              controller.error(new Error("stream reset"));
            },
          }),
          { status: 200 },
        ),
    });
    const resetStream = await resetProvider.synthesize(request);
    await expect(collectEvents(resetStream)).rejects.toMatchObject({
      code: "sarvam.tts.error",
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("rejects a successful HTTP response without a readable body", async () => {
    const provider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(null, {
          status: 200,
        }),
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerProtocolInvalid,
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("rejects non-PCM output instead of leaking an unsupported provider codec", async () => {
    const provider = new SarvamTtsHttpStreamProvider({ apiKey: "sarvam-secret" });
    await expect(
      provider.synthesize({
        ...request,
        format: { encoding: "pcm_s16le", sampleRateHz: 8_000, channels: 1 },
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
  });
});

describe("Sarvam Bulbul v3 HTTP catalog matrix", () => {
  it("accepts every supported voice-language pair on REST and HTTP stream", async () => {
    const pcm = new Uint8Array([11, 12, 13, 14]);
    let cases = 0;

    for (const transport of ["rest", "http-stream"] as const) {
      for (const voice of SARVAM_TTS_VOICES) {
        for (const language of SARVAM_TTS_LANGUAGES) {
          const providerOptions = {
            apiKey: "sarvam-secret",
            language,
            voiceId: voice,
            fetchImpl: async (
              _input: Parameters<typeof fetch>[0],
              init?: Parameters<typeof fetch>[1],
            ) => {
              const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
              expect(body.language_code).toBe(toSarvamTtsLanguageCode(language));
              expect(body.speaker).toBe(voice);
              const wav = makeWav(pcm);
              return transport === "rest"
                ? new Response(JSON.stringify({ audios: [Buffer.from(wav).toString("base64")] }), {
                    status: 200,
                  })
                : new Response(chunkedStream(wav, [12, 44]), { status: 200 });
            },
          };
          const provider =
            transport === "rest"
              ? new SarvamTtsRestProvider(providerOptions)
              : new SarvamTtsHttpStreamProvider(providerOptions);
          const events = await collectEvents(await provider.synthesize({ ...request, voice }));
          expect(events).toHaveLength(2);
          cases += 1;
        }
      }
    }

    expect(cases).toBe(SARVAM_TTS_VOICES.length * SARVAM_TTS_LANGUAGES.length * 2);
  });
});

async function collectEvents(stream: {
  readonly events: AsyncIterable<TtsEvent>;
}): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

function chunkedStream(
  bytes: Uint8Array,
  ends: readonly number[] = [bytes.byteLength],
): ReadableStream<Uint8Array> {
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

function makeWav(pcm: Uint8Array, streamingHeader = false): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(streamingHeader ? 0xffff_ffff : 36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(streamingHeader ? 0xffff_ffff : pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

function makeWavWithEmptyJunkChunks(pcm: Uint8Array, junkChunkCount: number): Uint8Array {
  const header = Buffer.alloc(44 + junkChunkCount * 8);
  const wav = Buffer.concat([header, Buffer.from(pcm)]);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
  wav.write("WAVE", 8, "ascii");

  let offset = 12;
  for (let index = 0; index < junkChunkCount; index += 1) {
    wav.write("JUNK", offset, "ascii");
    wav.writeUInt32LE(0, offset + 4);
    offset += 8;
  }

  wav.write("fmt ", offset, "ascii");
  wav.writeUInt32LE(16, offset + 4);
  wav.writeUInt16LE(1, offset + 8);
  wav.writeUInt16LE(1, offset + 10);
  wav.writeUInt32LE(16_000, offset + 12);
  wav.writeUInt32LE(32_000, offset + 16);
  wav.writeUInt16LE(2, offset + 20);
  wav.writeUInt16LE(16, offset + 22);
  offset += 24;
  wav.write("data", offset, "ascii");
  wav.writeUInt32LE(pcm.byteLength, offset + 4);
  Buffer.from(pcm).copy(wav, offset + 8);
  return new Uint8Array(wav);
}
