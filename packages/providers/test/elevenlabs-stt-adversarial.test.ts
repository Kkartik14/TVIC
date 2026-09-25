import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, PROVIDER_NAMES } from "@tvic/core";

import { ElevenLabsSttProvider } from "../src/index.js";

const request = {
  sessionId: "elevenlabs-adversarial-session" as never,
  format: PCM16_16K_MONO,
  interimResults: true,
};

describe("ElevenLabs realtime STT adversarial contract", () => {
  it("forwards documented realtime controls and sends previous text once", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      modelId: "scribe_v2_realtime",
      includeTimestamps: true,
      includeLanguageDetection: true,
      secondaryLanguages: ["hi", "en"],
      minSpeechDurationMs: 120,
      minSilenceDurationMs: 480,
      noVerbatim: true,
      filterBackgroundAudio: false,
      enableLogging: false,
      previousText: "Prior context",
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const stream = await provider.open({ ...request, vocabulary: ["TVIC"] });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.getAll("secondary_languages")).toEqual(["hi", "en"]);
    expect(url.searchParams.get("min_speech_duration_ms")).toBe("120");
    expect(url.searchParams.get("min_silence_duration_ms")).toBe("480");
    expect(url.searchParams.get("include_timestamps")).toBe("true");
    expect(url.searchParams.get("include_language_detection")).toBe("true");
    expect(url.searchParams.get("no_verbatim")).toBe("true");
    expect(url.searchParams.get("filter_background_audio")).toBe("false");
    expect(url.searchParams.get("enable_logging")).toBe("false");
    expect(url.searchParams.getAll("keyterms")).toEqual(["TVIC"]);

    await stream.sendAudio(audioChunk());
    await stream.sendAudio(audioChunk());
    const first = JSON.parse(socket.sent[0] ?? "{}");
    const second = JSON.parse(socket.sent[1] ?? "{}");
    expect(first).toEqual(expect.objectContaining({ previous_text: "Prior context" }));
    expect(second).not.toHaveProperty("previous_text");
    await stream.close();
  });

  it("forwards entity detection and does not emit a final before entity metadata arrives", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      entityDetection: ["pii", "phi"],
      includeTimestamps: true,
      webSocketFactory: (url) => {
        expect(new URL(url).searchParams.getAll("entity_detection")).toEqual(["pii", "phi"]);
        return socket as never;
      },
    });
    const stream = await provider.open(request);
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive({ message_type: "committed_transcript", text: "Alice" });
    socket.receive({
      message_type: "committed_transcript_with_timestamps",
      text: "Alice",
      words: [{ text: "Alice", start: 0, end: 0.4, type: "word" }],
    });
    let resolved = false;
    const final = iterator.next().then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    socket.receive({
      message_type: "committed_transcript_entities",
      text: "Alice",
      entities: [{ text: "Alice", type: "name", start: 0, end: 5 }],
    });
    await expect(final).resolves.toMatchObject({
      value: {
        type: "stt.final",
        text: "Alice",
        metadata: { elevenlabs: { entities: [{ type: "name", start: 0, end: 5 }] } },
      },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "stt.endpoint" } });
    await stream.close();
  });

  it("rejects the provider's documented incompatible background-filter combination", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      includeTimestamps: true,
      filterBackgroundAudio: true,
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.open(request)).rejects.toMatchObject({
      code: "provider.invalid_request",
      provider: PROVIDER_NAMES.elevenlabsStt,
    });
    expect(factoryCalls).toBe(0);
  });

  it.each([
    ["negative VAD duration", { minSpeechDurationMs: -1 }],
    ["malformed secondary language", { secondaryLanguages: [null] }],
    ["non-boolean no-verbatim", { noVerbatim: "yes" }],
  ] as const)("rejects %s before opening a socket", async (_name, options) => {
    let factoryCalls = 0;
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      ...options,
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    } as never);

    await expect(provider.open(request)).rejects.toMatchObject({
      code: "provider.invalid_request",
      provider: PROVIDER_NAMES.elevenlabsStt,
    });
    expect(factoryCalls).toBe(0);
  });

  it("rejects a realtime keyterm over the documented character limit", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.open({ ...request, vocabulary: ["x".repeat(21)] })).rejects.toMatchObject(
      {
        code: "stt.vocabulary_invalid",
        provider: PROVIDER_NAMES.elevenlabsStt,
      },
    );
    expect(factoryCalls).toBe(0);
  });

  it("honors interimResults=false instead of leaking partial transcripts", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      webSocketFactory: () => socket as never,
    });
    const stream = await provider.open({ ...request, interimResults: false });
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive({ message_type: "partial_transcript", text: "draft" });
    socket.receive({ message_type: "committed_transcript", text: "stable" });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.final", text: "stable" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.endpoint" },
      done: false,
    });
    await stream.close();
  });

  it("waits for the timestamped commit and preserves nullable live word fields", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      includeTimestamps: true,
      webSocketFactory: () => socket as never,
    });
    const stream = await provider.open(request);
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive({ message_type: "committed_transcript", text: "stable" });
    socket.receive({
      message_type: "committed_transcript_with_timestamps",
      text: "stable",
      language_code: "en",
      words: [
        {
          text: "stable",
          start: 0,
          end: 0.4,
          type: "word",
          speaker_id: null,
          channel_index: null,
        },
      ],
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "stt.final",
        text: "stable",
        language: "en",
        metadata: {
          elevenlabs: {
            words: [{ speaker_id: null, channel_index: null }],
          },
        },
      },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.endpoint" },
      done: false,
    });
    await stream.close();
  });

  it("fails a malformed committed transcript instead of waiting forever for timestamps", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      includeTimestamps: true,
      webSocketFactory: () => socket as never,
    });
    const stream = await provider.open(request);
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive({ message_type: "committed_transcript", text: 42 });

    await expect(pending).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: PROVIDER_NAMES.elevenlabsStt,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("fails a clean provider close when a timestamped commit is still pending", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      includeTimestamps: true,
      webSocketFactory: () => socket as never,
    });
    const stream = await provider.open(request);
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive({ message_type: "committed_transcript", text: "stable" });
    socket.close();

    await expect(pending).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: PROVIDER_NAMES.elevenlabsStt,
    });
  });

  it("rejects malformed request formats and language hints before connecting", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.open({ ...request, format: null as never })).rejects.toMatchObject({
      code: "stt.audio_format_invalid",
    });
    await expect(provider.open({ ...request, language: "en\u0000US" })).rejects.toMatchObject({
      code: "stt.language_invalid",
    });
    expect(factoryCalls).toBe(0);
  });

  it("bounds delayed committed metadata instead of retaining unbounded provider state", async () => {
    const socket = new FakeSocket();
    const provider = new ElevenLabsSttProvider({
      apiKey: "test-key",
      includeTimestamps: true,
      webSocketFactory: () => socket as never,
    });
    const stream = await provider.open(request);
    const pending = stream.events[Symbol.asyncIterator]().next();

    for (let index = 0; index < 65; index += 1) {
      socket.receive({ message_type: "committed_transcript", text: `segment-${index}` });
    }

    await expect(pending).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: PROVIDER_NAMES.elevenlabsStt,
    });
  });
});

function audioChunk() {
  return {
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array([0, 0, 0, 0]),
    },
  } as never;
}

class FakeSocket {
  readonly sent: string[] = [];
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();

  on(event: string, handler: (...values: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (...values: unknown[]) => void): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", 1000, Buffer.alloc(0));
  }

  receive(message: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...values);
  }
}
