import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type Timestamp,
  type TtsSynthesisRequest,
  type TurnId,
} from "@tvic/core";

import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  SarvamTtsHttpStreamProvider,
  SarvamTtsRestProvider,
  createSarvamTtsHttpStreamProvider,
  createSarvamTtsRestProvider,
} from "../src/index.js";

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

describe("Sarvam Bulbul v3 REST TTS adapter", () => {
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

    const stream = await provider.synthesize({ ...request, speed: 1.4 });
    const events = await collectEvents(stream);

    expect(url).toBe("https://api.sarvam.ai/text-to-speech");
    expect(headers).toMatchObject({
      "api-subscription-key": "sarvam-secret",
      "Content-Type": "application/json",
    });
    expect(body).toEqual({
      text: request.text,
      language_code: "hi-IN",
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
    });
    expect(events[1]).toMatchObject({
      type: "media.audio.committed",
      provider: PROVIDER_NAMES.sarvamTts,
      frameCount: 2,
      chunkIds: [expect.any(String)],
      metadata: { sarvam: { transport: "rest", requestId: "rest-request-1" } },
    });
  });

  it.each([
    [401, TVIC_ERROR_CODES.providerAuthFailed, false],
    [422, TVIC_ERROR_CODES.providerInvalidRequest, false],
    [429, TVIC_ERROR_CODES.providerRateLimited, true],
    [500, TVIC_ERROR_CODES.providerUpstreamFailed, true],
  ] as const)(
    "maps REST HTTP %s to the canonical provider error",
    async (status, code, retriable) => {
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
        metadata: { httpStatus: status, providerCode: "upstream_code" },
      });
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
      code: TVIC_ERROR_CODES.providerRateLimited,
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: true,
      metadata: { httpStatus: 402 },
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
      code: "sarvam.tts.error",
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    });
    expect(calls).toBe(1);
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

  it("enforces the bounded REST response body before parsing untrusted data", async () => {
    const provider = new SarvamTtsRestProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(new Uint8Array(16 * 1024 * 1024 + 1), {
          status: 200,
        }),
    });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: "sarvam.tts.error",
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });
});

describe("Sarvam Bulbul v3 HTTP stream TTS adapter", () => {
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

    const stream = await provider.synthesize(request);
    const iterator = stream.events[Symbol.asyncIterator]();
    const events: unknown[] = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      events.push(result.value);
    }

    expect(body).toMatchObject({
      text: request.text,
      language_code: "ta-IN",
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
      metadata: { sarvam: { transport: "http-stream" } },
    });
    expect(events[1]).toMatchObject({ type: "media.audio.committed", frameCount: 3 });
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

  it("fails the event consumer on a truncated WAV or network read error", async () => {
    const truncatedWav = makeWav(new Uint8Array([1, 2, 3, 4])).slice(0, 46);
    const truncatedProvider = new SarvamTtsHttpStreamProvider({
      apiKey: "sarvam-secret",
      fetchImpl: async () =>
        new Response(chunkedStream(truncatedWav, [12, truncatedWav.byteLength]), { status: 200 }),
    });
    const truncatedStream = await truncatedProvider.synthesize(request);
    await expect(collectEvents(truncatedStream)).rejects.toMatchObject({
      code: "sarvam.tts.error",
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
      code: "sarvam.tts.error",
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
              expect(body.language_code).toBe(language);
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
  readonly events: AsyncIterable<unknown>;
}): Promise<unknown[]> {
  const events: unknown[] = [];
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
