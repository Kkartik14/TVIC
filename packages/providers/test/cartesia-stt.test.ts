import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import type { SessionId, Timestamp } from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  TVIC_ERROR_CODES,
  createMediaEvent,
} from "@tvic/core";
import { CartesiaSttProvider, PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "../src/index.js";

describe("Cartesia Ink STT", () => {
  it("transcribes a complete raw audio payload through the batch endpoint", async () => {
    let openedUrl = "";
    let requestHeaders: Headers | undefined;
    let requestForm: FormData | undefined;
    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      fetchImpl: async (input, init) => {
        openedUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        requestForm = init?.body as FormData;
        return new Response(
          JSON.stringify({
            type: "transcript",
            text: "hello from batch",
            request_id: "batch-1",
            language: "en",
            duration: 2.5,
            words: [
              { word: "hello", start: 0, end: 0.8 },
              { word: "from", start: 0.9, end: 1.3 },
              { word: "batch", start: 1.4, end: 2.5 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const result = await provider.transcribe({
      audio: new Uint8Array([1, 2, 3, 4]),
      fileName: "fixture.pcm",
      mimeType: "audio/pcm",
      format: PCM16_16K_MONO,
      language: "en",
      model: "ink-whisper",
      timestampGranularities: ["word"],
    });

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/stt");
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(requestHeaders?.get("authorization")).toBe("Bearer cartesia-key");
    expect(requestHeaders?.get("cartesia-version")).toBe(PROVIDER_API_VERSIONS.cartesiaStt);
    expect(requestForm?.get("model")).toBe("ink-whisper");
    expect(requestForm?.get("language")).toBe("en");
    expect(requestForm?.getAll("timestamp_granularities[]")).toEqual(["word"]);
    const file = requestForm?.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("fixture.pcm");
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(result).toMatchObject({
      text: "hello from batch",
      requestId: "batch-1",
      language: "en",
      durationMs: 2_500,
      words: [
        { word: "hello", startMs: 0, endMs: 800 },
        { word: "from", startMs: 900, endMs: 1_300 },
        { word: "batch", startMs: 1_400, endMs: 2_500 },
      ],
    });
    expect(provider.capabilities.batch).toEqual({ input: true, output: true });
    expect(provider.capabilities.batchModels).toEqual(["ink-whisper"]);
  });

  it("rejects unsupported batch models and normalizes HTTP provider failures", async () => {
    let fetchCalls = 0;
    const unsupported = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    });
    await expect(
      unsupported.transcribe({ audio: new Uint8Array([1]), model: "ink-2" }),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerModelUnsupported,
      provider: PROVIDER_NAMES.cartesiaStt,
    });
    expect(fetchCalls).toBe(0);

    const rejected = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "nope" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(rejected.transcribe({ audio: new Uint8Array([1]) })).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerAuthFailed,
      provider: PROVIDER_NAMES.cartesiaStt,
    });
  });

  it("cancels an in-flight batch request through the caller signal", async () => {
    const controller = new AbortController();
    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const pending = provider.transcribe({ audio: new Uint8Array([1]), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "provider.connection_cancelled",
      provider: PROVIDER_NAMES.cartesiaStt,
    });
  });

  it("rejects malformed batch transcript responses as protocol failures", async () => {
    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: "transcript",
            text: "partial",
            words: [{ word: "partial", start: 1.5, end: 1.2 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(provider.transcribe({ audio: new Uint8Array([1]) })).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.cartesiaStt,
    });
  });

  it("opens the current manual endpoint and maps finalize transcripts", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> | undefined;
    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      language: "en",
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "cartesia-stt-manual" as SessionId,
      format: PCM16_16K_MONO,
      model: "ink-preview",
      interimResults: true,
      vocabulary: ["Cartesia", "Ink 2"],
    });
    expect(stream.commitMode).toBe("provider");
    expect(stream.timestampOrigin).toBe("generation");

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/stt/websocket");
    expect(url.searchParams.get("model")).toBe("ink-preview");
    expect(url.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("cartesia_version")).toBe(PROVIDER_API_VERSIONS.cartesiaStt);
    expect(url.searchParams.getAll("keyterm")).toEqual(["Cartesia", "Ink 2"]);
    expect(openedHeaders).toEqual({
      "X-API-Key": "cartesia-key",
      "Cartesia-Version": PROVIDER_API_VERSIONS.cartesiaStt,
    });

    await stream.sendAudio(audioChunk("cartesia-stt-manual"));
    expect(Buffer.isBuffer(socket.sent[0])).toBe(true);
    const commit = stream.commit();
    expect(socket.sent[1]).toBe("finalize");

    const iterator = stream.events[Symbol.asyncIterator]();
    socket.receive({ type: "transcript", is_final: false, text: "hello" });
    socket.receive({ type: "transcript", is_final: true, text: " world", language: "en" });
    socket.receive({ type: "flush_done", request_id: "flush-1" });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.partial", text: "hello", provider: PROVIDER_NAMES.cartesiaStt },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.final", text: " world", language: "en" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.endpoint", reason: "manual" },
      done: false,
    });
    await expect(commit).resolves.toBeUndefined();

    const closing = stream.close();
    socket.receive({ type: "done", request_id: "close-1" });
    await expect(closing).resolves.toBeUndefined();
  });

  it("supports Ink's native turn endpoint and cumulative transcript events", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      mode: "auto",
      turnStartThreshold: 0.7,
      turnEagerEndThreshold: 0.5,
      turnEndThreshold: 0.2,
      turnEndTimeoutMs: 4_500,
      webSocketFactory(url) {
        openedUrl = url;
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "cartesia-stt-auto" as SessionId,
      format: PCM16_16K_MONO,
      model: "ink-2",
      interimResults: true,
    });
    expect(stream.commitMode).toBe("none");
    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/stt/turns/websocket");
    expect(url.searchParams.get("turn_start_threshold")).toBe("0.7");
    expect(url.searchParams.get("turn_eager_end_threshold")).toBe("0.5");
    expect(url.searchParams.get("turn_end_threshold")).toBe("0.2");
    expect(url.searchParams.get("turn_end_timeout_ms")).toBe("4500");

    const iterator = stream.events[Symbol.asyncIterator]();
    socket.receive({ type: "turn.start" });
    socket.receive({ type: "turn.update", transcript: "hello" });
    socket.receive({ type: "turn.eager_end", transcript: "hello there" });
    socket.receive({ type: "turn.resume" });
    socket.receive({ type: "turn.update", transcript: "hello there friend" });
    socket.receive({ type: "turn.end", transcript: "hello there friend" });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.speech.started" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.partial", text: "hello" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.partial", text: "hello there" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.partial", text: "hello there friend" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.final", text: "hello there friend" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.endpoint", reason: "provider" },
      done: false,
    });

    const closing = stream.close();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "close" }));
    socket.receive({ type: "done" });
    await expect(closing).resolves.toBeUndefined();
  });

  it("rejects unsupported models, invalid turn thresholds, and malformed envelopes", async () => {
    const socket = new FakeSocket();
    let factoryCalls = 0;
    expect(
      () =>
        new CartesiaSttProvider({
          apiKey: "cartesia-key",
          mode: "auto",
          turnStartThreshold: 0.2,
        }),
    ).toThrow(/turn thresholds/);

    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      mode: "auto",
      webSocketFactory: () => {
        factoryCalls += 1;
        return socket as never;
      },
    });

    expect(factoryCalls).toBe(0);
    await expect(
      provider.open({
        sessionId: "cartesia-stt-invalid" as SessionId,
        format: PCM16_16K_MONO,
        model: "ink-whisper-2025-06-04",
        interimResults: true,
      }),
    ).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerModelUnsupported,
      provider: PROVIDER_NAMES.cartesiaStt,
    });
    expect(factoryCalls).toBe(0);

    const manual = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      webSocketFactory: () => socket as never,
    });
    const stream = await manual.open({
      sessionId: "cartesia-stt-malformed" as SessionId,
      format: PCM16_16K_MONO,
      model: PROVIDER_CATALOG.cartesiaStt.defaultModel,
      interimResults: true,
    });
    const pending = stream.events[Symbol.asyncIterator]().next();
    socket.receive({ type: "future_event" });
    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.cartesiaStt,
    });
  });

  it("allows an explicit close while the native turn is still active", async () => {
    const socket = new FakeSocket();
    const provider = new CartesiaSttProvider({
      apiKey: "cartesia-key",
      mode: "auto",
      webSocketFactory: () => socket as never,
    });
    const stream = await provider.open({
      sessionId: "cartesia-stt-active-close" as SessionId,
      format: PCM16_16K_MONO,
      model: "ink-2",
      interimResults: true,
    });

    socket.receive({ type: "turn.start" });
    const closing = stream.close();
    socket.receive({ type: "done" });

    await expect(closing).resolves.toBeUndefined();
  });
});

function audioChunk(sessionId: string) {
  return createMediaEvent({
    id: "cartesia-stt-audio" as never,
    type: "media.audio.chunk",
    sessionId: sessionId as SessionId,
    sequence: 1,
    direction: "input",
    timestamp: "2026-09-26T00:00:00.000Z" as Timestamp,
    monotonicOffsetMs: 0,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array(640),
    },
  });
}

class FakeSocket {
  readonly sent: Array<string | Buffer> = [];
  readyState: number = WebSocket.OPEN;
  #handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", 1000, Buffer.alloc(0));
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  receive(message: Readonly<Record<string, unknown>>): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...args);
  }
}
