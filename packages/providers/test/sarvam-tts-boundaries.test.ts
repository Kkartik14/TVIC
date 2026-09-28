import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  type SessionId,
  type Timestamp,
  type TtsSessionOpenRequest,
  type TurnId,
} from "@tvic/core";

import { SARVAM_TTS_LANGUAGES, SarvamTtsProvider, SarvamTtsStream } from "../src/index.js";
import {
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  MAX_PROVIDER_TTS_PENDING_FLUSHES,
} from "../src/common.js";

const request: TtsSessionOpenRequest = {
  sessionId: "sarvam-boundary-session" as SessionId,
  turnId: "sarvam-boundary-turn" as TurnId,
  format: PCM16_16K_MONO,
};

const fixedClock = {
  now(): Timestamp {
    return "2026-09-24T00:00:00.000Z" as Timestamp;
  },
};

describe("Sarvam Bulbul v3 TTS boundaries", () => {
  it.each(SARVAM_TTS_LANGUAGES)("opens every catalog language: %s", async (language) => {
    const socket = new FakeSocket();
    const provider = new SarvamTtsProvider({
      apiKey: "test",
      language,
      webSocketFactory: () => socket as never,
    });

    const session = await provider.openSession(request);
    expect(JSON.parse(socket.sent[0] ?? "{}").data.language_code).toBe(language);
    await session.cancel();
  });

  it("preserves request voice/speed and optional pronunciation dictionary in config", async () => {
    const socket = new FakeSocket();
    const provider = new SarvamTtsProvider({
      apiKey: "test",
      language: "en-IN",
      pronunciationDictionaryId: "dictionary-1",
      webSocketFactory: () => socket as never,
    });

    await provider.openSession({ ...request, voice: "aditya", speed: 2 });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      type: "config",
      data: expect.objectContaining({
        language_code: "en-IN",
        speaker: "aditya",
        pace: 2,
        dict_id: "dictionary-1",
      }),
    });
  });

  it.each([
    ["pace lower bound", { pace: 0.5 }, "pace", 0.5],
    ["pace upper bound", { pace: 2 }, "pace", 2],
    ["temperature lower bound", { temperature: 0.01 }, "temperature", 0.01],
    ["temperature upper bound", { temperature: 1 }, "temperature", 1],
    ["minimum buffer lower bound", { minBufferSize: 30 }, "min_buffer_size", 30],
    ["minimum buffer upper bound", { minBufferSize: 200 }, "min_buffer_size", 200],
    ["maximum chunk lower bound", { maxChunkLength: 50 }, "max_chunk_length", 50],
    ["maximum chunk upper bound", { maxChunkLength: 500 }, "max_chunk_length", 500],
    ["keepalive lower bound", { keepAliveIntervalMs: 1_000 }, undefined, undefined],
    ["keepalive upper bound", { keepAliveIntervalMs: 60_000 }, undefined, undefined],
  ] as const)("accepts %s", async (_name, options, field, value) => {
    const socket = new FakeSocket();
    const provider = new SarvamTtsProvider({
      apiKey: "test",
      language: "en-IN",
      webSocketFactory: () => socket as never,
      ...options,
    });

    const session = await provider.openSession(request);
    if (field !== undefined) expect(JSON.parse(socket.sent[0] ?? "{}").data[field]).toBe(value);
    await session.cancel();
  });

  it.each([
    ["pace below", { pace: 0.499 }],
    ["pace above", { pace: 2.001 }],
    ["pace NaN", { pace: Number.NaN }],
    ["temperature below", { temperature: 0.009 }],
    ["temperature above", { temperature: 1.001 }],
    ["temperature Infinity", { temperature: Number.POSITIVE_INFINITY }],
    ["minimum buffer below", { minBufferSize: 29 }],
    ["minimum buffer fractional", { minBufferSize: 30.5 }],
    ["maximum chunk above", { maxChunkLength: 501 }],
    ["maximum chunk fractional", { maxChunkLength: 50.5 }],
    ["keepalive below", { keepAliveIntervalMs: 999 }],
    ["keepalive above", { keepAliveIntervalMs: 60_001 }],
  ] as const)("rejects %s before connecting", async (_name, options) => {
    let factoryCalls = 0;
    const provider = new SarvamTtsProvider({
      apiKey: "test",
      language: "en-IN",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
      ...options,
    });

    await expect(provider.openSession(request)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    expect(factoryCalls).toBe(0);
  });

  it("accepts exactly 2,500 characters and rejects the next character", async () => {
    const socket = new FakeSocket();
    const session = new SarvamTtsProvider({
      apiKey: "test",
      language: "en-IN",
      webSocketFactory: () => socket as never,
    });
    const stream = await session.openSession(request);

    await expect(stream.sendText("x".repeat(2_500))).resolves.toBeUndefined();
    await expect(stream.sendText("x".repeat(2_501))).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    expect(socket.sent).toHaveLength(2);
    await stream.cancel();
  });

  it("does not send an empty text frame and rejects non-string text", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());

    await stream.sendText("");
    await expect(stream.sendText(42 as never)).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInvalidRequest,
    });
    expect(socket.sent).toHaveLength(1);
    await stream.cancel();
  });

  it("correlates multiple flushes in order and commits each boundary", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const first = stream.flush();
    const second = stream.flush();

    socket.receive(finalMessage());
    socket.receive(finalMessage());

    await expect(first).resolves.toMatchObject({ id: 1, acknowledgedBy: "provider" });
    await expect(second).resolves.toMatchObject({ id: 2, acknowledgedBy: "provider" });
    expect(socket.sent.slice(1).map((value) => JSON.parse(value))).toEqual([
      { type: "flush" },
      { type: "flush" },
    ]);
    await stream.cancel();
  });

  it("rejects a final event that has no pending flush", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(finalMessage());

    await expect(pending).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    });
  });

  it.each([
    ["malformed JSON", Buffer.from("{")],
    ["missing message type", Buffer.from(JSON.stringify({ data: {} }))],
    ["unknown message type", Buffer.from(JSON.stringify({ type: "mystery", data: {} }))],
    [
      "unknown event",
      Buffer.from(JSON.stringify({ type: "event", data: { event_type: "ready" } })),
    ],
    [
      "missing audio content type",
      Buffer.from(JSON.stringify({ type: "audio", data: { audio: "AAA=" } })),
    ],
    [
      "missing audio payload",
      Buffer.from(JSON.stringify({ type: "audio", data: { content_type: "audio/linear16" } })),
    ],
    [
      "malformed provider error",
      Buffer.from(JSON.stringify({ type: "error", data: { code: 500 } })),
    ],
  ] as const)("fails closed on %s", async (_name, body) => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receiveRaw(body);

    await expect(pending).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
      category: "provider",
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it.each([
    ["invalid base64", "%%%=", "audio/linear16"],
    ["empty audio", "", "audio/linear16"],
    ["odd-byte PCM", Buffer.from([1]).toString("base64"), "audio/linear16"],
    ["corrupt WAV", Buffer.from("not-a-wav").toString("base64"), "audio/wav"],
  ] as const)("rejects %s audio", async (_name, audio, contentType) => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive({ type: "audio", data: { content_type: contentType, audio } });

    await expect(pending).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it.each([
    [401, "invalid api key", TVIC_ERROR_CODES.providerAuthFailed, false],
    [403, "permission denied", TVIC_ERROR_CODES.providerAuthFailed, false],
    [429, "rate limit exceeded", TVIC_ERROR_CODES.providerRateLimited, true],
    [400, "invalid request", TVIC_ERROR_CODES.providerInvalidRequest, false],
    [500, "upstream unavailable", TVIC_ERROR_CODES.providerUpstreamFailed, true],
  ] as const)(
    "maps provider error %s to canonical retry policy",
    async (vendorCode, message, code, retriable) => {
      const socket = new FakeSocket();
      const stream = new SarvamTtsStream(socket as never, request, streamOptions());
      const pending = stream.events[Symbol.asyncIterator]().next();

      socket.receive({ type: "error", data: { code: vendorCode, message } });

      await expect(pending).rejects.toMatchObject({
        code,
        retriable,
        metadata: { providerCode: String(vendorCode) },
      });
    },
  );

  it.each([
    [1001, TVIC_ERROR_CODES.providerUpstreamFailed, true],
    [1006, TVIC_ERROR_CODES.providerUpstreamFailed, true],
    [1011, TVIC_ERROR_CODES.providerUpstreamFailed, true],
    [1000, TVIC_ERROR_CODES.providerProtocolInvalid, false],
    [1008, TVIC_ERROR_CODES.providerProtocolInvalid, false],
  ] as const)("maps close code %s", async (closeCode, code, retriable) => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.emitClose(closeCode, Buffer.from("provider closed"));

    await expect(pending).rejects.toMatchObject({
      code,
      retriable,
      metadata: { wsCloseCode: closeCode, wsCloseReason: "provider closed" },
    });
  });

  it("rejects an oversized inbound frame before JSON parsing", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receiveRaw(Buffer.alloc(MAX_PROVIDER_FRAME_BYTES + 1));

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerStreamBufferOverflow,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("fails when the consumer falls behind the bounded event queue", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const audio = audioMessage(new Uint8Array([0, 0]));

    for (let index = 0; index <= 1_024; index += 1) socket.receive(audio);

    const pending = stream.events[Symbol.asyncIterator]().next();
    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerStreamBufferOverflow,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("fails when lifetime output bytes exceed the provider ceiling", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const iterator = stream.events[Symbol.asyncIterator]();
    const pcm = new Uint8Array(2_048);
    const completeChunks = MAX_PROVIDER_TTS_OUTPUT_BYTES / pcm.byteLength;

    for (let index = 0; index < completeChunks; index += 1) {
      const next = iterator.next();
      socket.receive(audioMessage(pcm));
      await next;
    }
    const pending = iterator.next();
    socket.receive(audioMessage(pcm));

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerStreamBufferOverflow,
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("fails when lifetime output chunks exceed the provider ceiling", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const iterator = stream.events[Symbol.asyncIterator]();
    const audio = audioMessage(new Uint8Array([0, 0]));

    for (let index = 0; index < MAX_PROVIDER_TTS_OUTPUT_CHUNKS; index += 1) {
      const next = iterator.next();
      socket.receive(audio);
      await next;
    }
    const pending = iterator.next();
    socket.receive(audio);

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerStreamBufferOverflow,
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("fails all pending flushes when the flush queue reaches its ceiling", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = Array.from({ length: MAX_PROVIDER_TTS_PENDING_FLUSHES }, () =>
      stream.flush().catch((error: unknown) => error),
    );

    await expect(stream.flush()).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerStreamBufferOverflow,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    const settled = await Promise.all(pending);
    expect(settled.every((value) => value instanceof Error || typeof value === "object")).toBe(
      true,
    );
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects pending flush and finish promises on cancellation", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const flush = stream.flush();
    const finish = stream.finish();

    await stream.cancel();

    await expect(flush).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    await expect(finish).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    await expect(stream.sendText("late")).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
    });
    await stream.cancel();
  });

  it("fails and closes when the initial config cannot be sent", async () => {
    const socket = new FakeSocket();
    socket.sendError = new Error("write failed");
    const provider = new SarvamTtsProvider({
      apiKey: "test",
      webSocketFactory: () => socket as never,
    });

    await expect(provider.openSession(request)).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      category: "provider",
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("normalizes socket errors and bounds diagnostic metadata", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.emitError(new Error("transport broke"));

    await expect(pending).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
  });

  it("bounds request and content-type metadata while preserving audio", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(socket as never, request, streamOptions());
    const iterator = stream.events[Symbol.asyncIterator]();
    const longRequestId = "r".repeat(300);
    const longContentType = "c".repeat(128);
    const pcm = new Uint8Array([0, 0]);

    socket.receive({
      type: "audio",
      data: {
        content_type: longContentType,
        request_id: longRequestId,
        audio: Buffer.from(pcm).toString("base64"),
      },
    });
    const event = (await iterator.next()).value;

    expect(event).toMatchObject({
      type: "media.audio.chunk",
      audio: { bytes: pcm },
      metadata: {
        sarvam: {
          contentType: longContentType,
          requestId: `${"r".repeat(253)}...`,
        },
      },
    });
    await stream.cancel();
  });
});

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

function finalMessage(): string {
  return JSON.stringify({ type: "event", data: { event_type: "final" } });
}

function audioMessage(pcm: Uint8Array): string {
  return JSON.stringify({
    type: "audio",
    data: {
      content_type: "audio/linear16",
      audio: Buffer.from(pcm).toString("base64"),
    },
  });
}

class FakeSocket {
  readonly sent: string[] = [];
  readyState: number = WebSocket.OPEN;
  sendError: Error | undefined;
  readonly #handlers = new Map<string, ((...values: unknown[]) => void)[]>();

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(code = 1000, reason = Buffer.alloc(0)): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", code, reason);
  }

  on(event: string, handler: (...values: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  receive(message: unknown): void {
    this.receiveRaw(Buffer.from(typeof message === "string" ? message : JSON.stringify(message)));
  }

  receiveRaw(data: Buffer): void {
    this.#emit("message", data);
  }

  emitClose(code: number, reason: Buffer): void {
    this.#emit("close", code, reason);
  }

  emitError(error: Error): void {
    this.#emit("error", error);
  }

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...values);
  }
}
