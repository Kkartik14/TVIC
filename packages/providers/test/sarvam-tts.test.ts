import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  type SessionId,
  type Timestamp,
  type TtsSessionOpenRequest,
  type TurnId,
} from "@tvic/core";

import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  SarvamTtsProvider,
  SarvamTtsStream,
} from "../src/index.js";
import { PROVIDER_CATALOG } from "../src/catalog.js";

describe("Sarvam Bulbul v3 TTS adapter", () => {
  it("opens the documented WebSocket and sends a strict v3 linear16 config", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> = {};
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "hi-IN",
      voiceId: "ishita",
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    const session = await provider.openSession({
      ...request,
      voice: "ishita",
      speed: 1.2,
    });

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/text-to-speech/ws");
    expect(url.searchParams.get("model")).toBe(PROVIDER_CATALOG.sarvamTts.defaultModel);
    expect(url.searchParams.get("send_completion_event")).toBe("true");
    expect(openedHeaders).toEqual({ "api-subscription-key": "sarvam-secret" });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "config",
      data: {
        model: "bulbul:v3",
        language_code: "hi-IN",
        speaker: "ishita",
        pace: 1.2,
        temperature: 0.6,
        speech_sample_rate: "16000",
        output_audio_codec: "linear16",
        min_buffer_size: 50,
        max_chunk_length: 150,
      },
    });

    await session.cancel();
  });

  it("declares every Bulbul v3 voice and language", () => {
    const provider = new SarvamTtsProvider({ apiKey: "sarvam-secret" });
    expect(provider.capabilities.models).toEqual(["bulbul:v3"]);
    expect(provider.capabilities.languages).toEqual(SARVAM_TTS_LANGUAGES);
    expect(provider.capabilities.voices).toEqual(SARVAM_TTS_VOICES);
    expect(SARVAM_TTS_VOICES).toHaveLength(37);
    expect(SARVAM_TTS_LANGUAGES).toHaveLength(11);
  });

  it("accepts every documented voice without falling back to another voice", async () => {
    for (const voice of SARVAM_TTS_VOICES) {
      const socket = new FakeSocket();
      const provider = new SarvamTtsProvider({
        apiKey: "sarvam-secret",
        language: "en-IN",
        voiceId: voice,
        webSocketFactory: () => socket as never,
      });
      const session = await provider.openSession({ ...request, voice });
      const config = JSON.parse(socket.sent[0] ?? "{}");
      expect(config.data.speaker).toBe(voice);
      await session.cancel();
    }
  });

  it("streams decoded linear16 audio, correlates final events to flushes, and commits each turn", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, {
      clock: fixedClock,
      model: "bulbul:v3",
      language: "en-IN",
      voice: "shubh",
      pace: 1,
      temperature: 0.6,
      minBufferSize: 50,
      maxChunkLength: 150,
      keepAliveIntervalMs: 60_000,
    });
    const iterator = session.events[Symbol.asyncIterator]();

    await session.sendText("Hello from TVIC.");
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      type: "text",
      data: { text: "Hello from TVIC." },
    });
    const flush = session.flush();
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({ type: "flush" });

    const pcm = new Uint8Array(640).fill(7);
    socket.receive(
      JSON.stringify({
        type: "audio",
        data: {
          content_type: "audio/linear16",
          audio: Buffer.from(pcm).toString("base64"),
          request_id: "sarvam-request-1",
        },
      }),
    );
    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));

    await expect(flush).resolves.toMatchObject({ id: 1, acknowledgedBy: "provider" });
    const events = [await iterator.next(), await iterator.next(), await iterator.next()].map(
      (result) => result.value,
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "media.audio.chunk",
        provider: PROVIDER_NAMES.sarvamTts,
        audio: expect.objectContaining({ bytes: pcm, frameCount: 320 }),
      }),
      expect.objectContaining({
        type: "media.audio.committed",
        provider: PROVIDER_NAMES.sarvamTts,
        frameCount: 320,
        chunkIds: [expect.any(String)],
      }),
      expect.objectContaining({
        type: "tts.flush.completed",
        provider: PROVIDER_NAMES.sarvamTts,
        flushId: 1,
        acknowledgedBy: "provider",
      }),
    ]);

    await session.cancel();
  });

  it("strips a valid WAV wrapper when the provider labels linear16 as audio/wav", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const iterator = session.events[Symbol.asyncIterator]();
    const pcm = new Uint8Array(320).fill(3);
    const wav = makeWav(pcm);
    const flush = session.flush();

    socket.receive(
      JSON.stringify({
        type: "audio",
        data: { content_type: "audio/wav", audio: Buffer.from(wav).toString("base64") },
      }),
    );
    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));

    await flush;
    const audio = (await iterator.next()).value;
    expect(audio).toEqual(
      expect.objectContaining({
        type: "media.audio.chunk",
        audio: expect.objectContaining({ bytes: pcm, frameCount: 160 }),
      }),
    );
    await session.cancel();
  });

  it("sends explicit keepalive pings and finishes only after the provider final event", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    await session.keepAlive();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ type: "ping" });

    const finished = session.finish();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({ type: "flush" });
    let settled = false;
    void finished.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    socket.receive(JSON.stringify({ type: "event", data: { event_type: "final" } }));
    await finished;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects unsupported model, voice, language, format, and v3-only invalid options before connecting", async () => {
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "sarvam-secret",
      language: "en-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openSession({ ...request, model: "bulbul:v2" })).rejects.toMatchObject({
      code: "provider.model_unsupported",
    });
    await expect(provider.openSession({ ...request, voice: "not-a-voice" })).rejects.toMatchObject({
      code: "provider.voice_unsupported",
    });
    await expect(
      new SarvamTtsProvider({ apiKey: "sarvam-secret", language: "as-IN" as never }).openSession(
        request,
      ),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(
      provider.openSession({ ...request, format: { ...PCM16_16K_MONO, sampleRateHz: 8_000 } }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(
      new SarvamTtsProvider({ apiKey: "sarvam-secret", pace: 2.1 }).openSession(request),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    await expect(provider.openSession({ ...request, timestamps: true })).rejects.toMatchObject({
      code: "provider.invalid_request",
    });
    expect(factoryCalls).toBe(0);
  });

  it("fails malformed provider frames and never emits corrupt audio", async () => {
    const cases = [
      JSON.stringify({ type: "audio", data: { content_type: "audio/linear16", audio: "%%%" } }),
      JSON.stringify({ type: "audio", data: { content_type: "audio/linear16", audio: "AA==" } }),
      JSON.stringify({ type: "event", data: { event_type: "unknown" } }),
      JSON.stringify({ type: "unexpected", data: {} }),
    ];

    for (const body of cases) {
      const socket = new FakeSocket();
      const session = new SarvamTtsStream(socket as never, request, streamOptions());
      const pending = session.events[Symbol.asyncIterator]().next();
      socket.receive(body);
      await expect(pending).rejects.toMatchObject({
        code: PROVIDER_ERROR_CODES.sarvamTts,
        provider: PROVIDER_NAMES.sarvamTts,
      });
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    }
  });

  it("maps provider errors to canonical retry policy and preserves the vendor code", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = session.events[Symbol.asyncIterator]().next();
    socket.receive(
      JSON.stringify({
        type: "error",
        data: { code: 429, message: "rate limit exceeded" },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "provider.rate_limited",
      retriable: true,
      metadata: { providerCode: "429" },
    });
  });
});

const request: TtsSessionOpenRequest = {
  sessionId: "session_sarvam_tts" as SessionId,
  turnId: "turn_sarvam_tts" as TurnId,
  format: PCM16_16K_MONO,
};

function streamOptions() {
  return {
    clock: fixedClock,
    model: "bulbul:v3",
    language: "en-IN",
    voice: "shubh",
    pace: 1,
    temperature: 0.6,
    minBufferSize: 50,
    maxChunkLength: 150,
    keepAliveIntervalMs: 60_000,
  } as const;
}

const fixedClock = {
  now(): Timestamp {
    return "2026-09-24T00:00:00.000Z" as Timestamp;
  },
};

function makeWav(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
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
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

class FakeSocket {
  readonly sent: string[] = [];
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", 1000, Buffer.alloc(0));
  }

  on(event: "message" | "close" | "error", handler: (value?: never) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (value?: unknown) => void);
    this.#handlers.set(event, handlers);
    return this;
  }

  receive(data: string): void {
    this.#emit("message", Buffer.from(data));
  }

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...values);
    }
  }
}
