import { describe, expect, it } from "vitest";

import {
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
  ElevenLabsTtsHttpStreamProvider,
  ElevenLabsTtsRestProvider,
  createElevenLabsTtsHttpStreamProvider,
  createElevenLabsTtsRestProvider,
} from "../src/index.js";

const request: TtsSynthesisRequest = {
  sessionId: "elevenlabs-http-session" as SessionId,
  turnId: "elevenlabs-http-turn" as TurnId,
  format: PCM16_16K_MONO,
  text: "Hello from TVIC.",
  model: "eleven_flash_v2_5",
  stream: true,
};

const fixedClock = {
  now(): Timestamp {
    return "2026-09-25T00:00:00.000Z" as Timestamp;
  },
};

describe("ElevenLabs complete HTTP TTS", () => {
  it("sends the documented regular TTS request and normalizes raw PCM", async () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    let url = "";
    let init: RequestInit | undefined;
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      language: "en",
      stability: 0.4,
      similarityBoost: 0.7,
      useSpeakerBoost: true,
      seed: 42,
      enableLogging: false,
      clock: fixedClock,
      fetchImpl: async (input, requestInit) => {
        url = String(input);
        init = requestInit;
        return new Response(pcm, { status: 200, headers: { "content-type": "audio/pcm" } });
      },
    });

    const events = await collectEvents(await provider.synthesize(request));
    const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const parsedUrl = new URL(url);

    expect(parsedUrl.pathname).toBe("/v1/text-to-speech/voice-rest");
    expect(parsedUrl.searchParams.get("output_format")).toBe("pcm_16000");
    expect(parsedUrl.searchParams.get("enable_logging")).toBe("false");
    expect(init?.headers).toMatchObject({
      "xi-api-key": "eleven-secret",
      Accept: "audio/pcm",
      "Content-Type": "application/json",
    });
    expect(parsedBody).toEqual({
      text: request.text,
      model_id: "eleven_flash_v2_5",
      language_code: "en",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.7,
        use_speaker_boost: true,
      },
      seed: 42,
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "media.audio.chunk",
      provider: PROVIDER_NAMES.elevenlabs,
      audio: { bytes: pcm, format: PCM16_16K_MONO, frameCount: 2 },
      metadata: { elevenlabs: { transport: "rest", protocol: "tts" } },
    });
    expect(events[1]).toMatchObject({
      type: "media.audio.committed",
      provider: PROVIDER_NAMES.elevenlabs,
      frameCount: 2,
      chunkIds: [expect.any(String)],
    });
  });

  it("supports timestamped REST output and emits character alignment", async () => {
    const pcm = new Uint8Array([7, 8, 9, 10]);
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(
          "/v1/text-to-speech/voice-rest/with-timestamps",
        );
        expect(new URL(String(input)).searchParams.get("output_format")).toBe("pcm_16000");
        expect(init?.headers).toMatchObject({ Accept: "application/json" });
        return new Response(
          JSON.stringify({
            audio_base64: Buffer.from(pcm).toString("base64"),
            alignment: {
              characters: ["h", "i"],
              character_start_times_seconds: [0, 0.01],
              character_end_times_seconds: [0.01, 0.02],
            },
          }),
          { status: 200 },
        );
      },
    });

    const events = await collectEvents(
      await provider.synthesize({ ...request, text: "hi", timestamps: true }),
    );
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      type: "tts.alignment",
      tokens: ["h", "i"],
      startMs: [0, 10],
      endMs: [10, 20],
    });
  });

  it("supports explicit Text-to-Dialogue requests and preserves every voice input", async () => {
    let body: Record<string, unknown> | undefined;
    let path = "";
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "fallback-voice",
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new Uint8Array([11, 12]), { status: 200 });
      },
    });

    const events = await collectEvents(
      await provider.synthesizeDialogue({
        sessionId: request.sessionId,
        turnId: request.turnId,
        format: request.format,
        model: "eleven_v3",
        stream: false,
        inputs: [
          { text: "Hello.", voiceId: "voice-a" },
          { text: "Hi there.", voiceId: "voice-b" },
        ],
        previousText: "Before.",
        futureText: "After.",
        previousRequestIds: ["request-before"],
        nextRequestIds: ["request-after"],
      }),
    );

    expect(path).toBe("/v1/text-to-dialogue");
    expect(body).toEqual({
      inputs: [
        { text: "Hello.", voice_id: "voice-a" },
        { text: "Hi there.", voice_id: "voice-b" },
      ],
      model_id: "eleven_v3",
      settings: { stability: 0.5 },
      previous_text: "Before.",
      future_text: "After.",
      previous_request_ids: ["request-before"],
      next_request_ids: ["request-after"],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ metadata: { elevenlabs: { protocol: "dialogue" } } });
  });

  it.each([
    [401, TVIC_ERROR_CODES.providerAuthFailed, false],
    [422, TVIC_ERROR_CODES.providerInvalidRequest, false],
    [429, TVIC_ERROR_CODES.providerRateLimited, true],
    [500, TVIC_ERROR_CODES.providerUpstreamFailed, true],
  ] as const)("maps HTTP %s to the canonical provider error", async (status, code, retriable) => {
    const provider = createElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { status: "upstream_code", message: "failure" } }), {
          status,
        }),
    });

    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code,
      provider: PROVIDER_NAMES.elevenlabs,
      retriable,
      metadata: { httpStatus: status, providerCode: "upstream_code" },
    });
  });

  it("rejects unsupported output, malformed PCM, and provider-limit violations before leaking audio", async () => {
    let calls = 0;
    const provider = new ElevenLabsTtsRestProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-rest",
      fetchImpl: async () => {
        calls += 1;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    });

    await expect(
      provider.synthesize({
        ...request,
        format: { encoding: "pcm_s16le", sampleRateHz: 8_000, channels: 1 },
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    await expect(
      provider.synthesize({ ...request, text: "x".repeat(40_001), model: "eleven_flash_v2_5" }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInvalidRequest });
    await expect(provider.synthesize(request)).rejects.toMatchObject({
      code: "elevenlabs.tts.error",
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    });
    expect(calls).toBe(1);
  });
});

describe("ElevenLabs chunked HTTP TTS", () => {
  it("streams raw PCM across arbitrary byte boundaries and commits once", async () => {
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      clock: fixedClock,
      fetchImpl: async (input) => {
        expect(new URL(String(input)).pathname).toBe("/v1/text-to-speech/voice-stream/stream");
        return new Response(chunkedStream(new Uint8Array([1, 2, 3, 4]), [1, 3]), {
          status: 200,
        });
      },
    });

    const events = await collectEvents(await provider.synthesize(request));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ audio: { bytes: new Uint8Array([1, 2]) } });
    expect(events[1]).toMatchObject({ audio: { bytes: new Uint8Array([3, 4]) } });
    expect(events[2]).toMatchObject({
      type: "media.audio.committed",
      frameCount: 2,
      metadata: { elevenlabs: { transport: "http-stream" } },
    });
  });

  it("parses timestamped JSON objects split across network chunks", async () => {
    const first = JSON.stringify({
      audio_base64: Buffer.from([1, 2]).toString("base64"),
      alignment: {
        characters: ["a"],
        character_start_times_seconds: [0],
        character_end_times_seconds: [0.01],
      },
    });
    const second = JSON.stringify({ audio_base64: Buffer.from([3, 4]).toString("base64") });
    const encoded = new TextEncoder().encode(first + second);
    const provider = new ElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      clock: fixedClock,
      fetchImpl: async (input) => {
        expect(new URL(String(input)).pathname).toBe(
          "/v1/text-to-speech/voice-stream/stream/with-timestamps",
        );
        return new Response(chunkedStream(encoded, [2, 7, first.length + 1]), { status: 200 });
      },
    });

    const events = await collectEvents(await provider.synthesize({ ...request, timestamps: true }));
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ audio: { bytes: new Uint8Array([1, 2]) } });
    expect(events[1]).toMatchObject({ type: "tts.alignment", tokens: ["a"] });
    expect(events[2]).toMatchObject({ audio: { bytes: new Uint8Array([3, 4]) } });
    expect(events[3]).toMatchObject({ type: "media.audio.committed", frameCount: 2 });
  });

  it("supports timestamped Dialogue HTTP streaming", async () => {
    let path = "";
    const response = JSON.stringify({ audio_base64: Buffer.from([5, 6]).toString("base64") });
    const provider = new ElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-a",
      clock: fixedClock,
      fetchImpl: async (input) => {
        path = new URL(String(input)).pathname;
        return new Response(new TextEncoder().encode(response), { status: 200 });
      },
    });

    const events = await collectEvents(
      await provider.synthesizeDialogue({
        sessionId: request.sessionId,
        turnId: request.turnId,
        format: request.format,
        model: "eleven_v3",
        stream: true,
        timestamps: true,
        inputs: [{ text: "Hello", voiceId: "voice-a" }],
      }),
    );
    expect(path).toBe("/v1/text-to-dialogue/stream/with-timestamps");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "media.audio.chunk" });
    expect(events[1]).toMatchObject({ type: "media.audio.committed" });
  });

  it("cancels a pending output consumer without hanging it", async () => {
    const provider = new ElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {},
          }),
          { status: 200 },
        ),
    });
    const stream = await provider.synthesize(request);
    const pending = stream.events[Symbol.asyncIterator]().next();
    await stream.cancel();
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it("fails a timed stream on truncated JSON instead of returning partial audio", async () => {
    const provider = createElevenLabsTtsHttpStreamProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-stream",
      fetchImpl: async () =>
        new Response(new TextEncoder().encode('{"audio_base64":"AQI='), { status: 200 }),
    });
    await expect(
      collectEvents(await provider.synthesize({ ...request, timestamps: true })),
    ).rejects.toMatchObject({
      code: "elevenlabs.tts.error",
      provider: PROVIDER_NAMES.elevenlabs,
    });
  });
});

async function collectEvents(stream: {
  readonly events: AsyncIterable<TtsEvent>;
}): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

function chunkedStream(bytes: Uint8Array, ends: readonly number[]): ReadableStream<Uint8Array> {
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
