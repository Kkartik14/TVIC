import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type SessionId } from "@tvic/core";

import { DeepgramSttProvider, DeepgramSttStream } from "../src/deepgram.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    this.sent.push(typeof data === "string" ? data : "[audio]");
    callback?.();
  }

  close(code = 1000): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from("closed"));
  }

  receive(data: Readonly<Record<string, unknown>>): void {
    this.emit("message", Buffer.from(JSON.stringify(data)));
  }
}

const fixedClock = { now: () => "2026-11-14T12:00:00.000Z" };

function makeStream(socket = new FakeSocket()) {
  const stream = new DeepgramSttStream(
    socket as never,
    {
      sessionId: "session_deepgram_utterance_end" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    },
    fixedClock as never,
  );
  return { socket, stream, iterator: stream.events[Symbol.asyncIterator]() };
}

async function finishStream(stream: DeepgramSttStream, socket: FakeSocket): Promise<void> {
  const closing = stream.close();
  socket.close();
  await closing;
}

async function nextBeforeImmediate<T>(next: Promise<T>): Promise<T | "no-event"> {
  return Promise.race([
    next,
    new Promise<"no-event">((resolve) => setImmediate(() => resolve("no-event"))),
  ]);
}

function sentJson(socket: FakeSocket): unknown[] {
  return socket.sent
    .filter((message) => message.startsWith("{"))
    .map((message) => JSON.parse(message));
}

describe("Deepgram UtteranceEnd", () => {
  it("ends accepted final segments once and ignores duplicate or late markers", async () => {
    const { socket, stream, iterator } = makeStream();
    await stream.sendAudio({
      audio: { format: PCM16_16K_MONO, bytes: new Uint8Array([0, 0]) },
    } as never);

    socket.receive({
      type: "Results",
      is_final: true,
      speech_final: false,
      start: 0,
      duration: 0.4,
      channel: { alternatives: [{ transcript: "hello" }] },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.final", text: "hello", sequence: 1 },
      done: false,
    });

    socket.receive({ type: "UtteranceEnd", last_word_end: 0.4, channel: [0, 1] });
    expect(await nextBeforeImmediate(iterator.next())).toMatchObject({
      value: { type: "stt.endpoint", reason: "provider", audioOffsetMs: 400, sequence: 2 },
      done: false,
    });

    const afterDuplicate = iterator.next();
    socket.receive({ type: "UtteranceEnd", last_word_end: 0.4, channel: [0, 1] });
    socket.receive({ type: "UtteranceEnd", last_word_end: 0.2, channel: [0, 1] });
    expect(
      sentJson(socket).filter((message) => (message as { type?: string }).type === "Finalize"),
    ).toEqual([]);
    await finishStream(stream, socket);
    await expect(afterDuplicate).resolves.toEqual({ value: undefined, done: true });
  });

  it("finalizes partial-only input but emits the endpoint only after a final transcript", async () => {
    const { socket, stream, iterator } = makeStream();
    await stream.sendAudio({
      audio: { format: PCM16_16K_MONO, bytes: new Uint8Array([0, 0]) },
    } as never);

    socket.receive({
      type: "Results",
      is_final: false,
      start: 0,
      duration: 0.4,
      channel: { alternatives: [{ transcript: "hello wor" }] },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.partial", text: "hello wor" },
      done: false,
    });

    const afterUtteranceEnd = iterator.next();
    socket.receive({ type: "UtteranceEnd", last_word_end: 0.4, channel: [0, 1] });
    expect(await nextBeforeImmediate(afterUtteranceEnd)).toBe("no-event");
    expect(sentJson(socket)).toContainEqual({ type: "Finalize" });

    socket.receive({
      type: "Results",
      is_final: true,
      speech_final: false,
      start: 0,
      duration: 0.4,
      channel: { alternatives: [{ transcript: "hello world" }] },
    });
    await expect(afterUtteranceEnd).resolves.toMatchObject({
      value: { type: "stt.final", text: "hello world", sequence: 2 },
      done: false,
    });
    expect(await nextBeforeImmediate(iterator.next())).toMatchObject({
      value: { type: "stt.endpoint", reason: "provider", audioOffsetMs: 400, sequence: 3 },
      done: false,
    });

    await finishStream(stream, socket);
  });

  it("does not produce an endpoint for noise-only audio", async () => {
    const { socket, stream, iterator } = makeStream();
    await stream.sendAudio({
      audio: { format: PCM16_16K_MONO, bytes: new Uint8Array([0, 0]) },
    } as never);

    const noTranscript = iterator.next();
    socket.receive({ type: "UtteranceEnd", last_word_end: 0.8, channel: [0, 1] });
    expect(await nextBeforeImmediate(noTranscript)).toBe("no-event");
    expect(sentJson(socket)).toContainEqual({ type: "Finalize" });

    socket.receive({
      type: "Results",
      is_final: true,
      speech_final: false,
      start: 0,
      duration: 0.8,
      channel: { alternatives: [] },
    });
    socket.receive({ type: "UtteranceEnd", last_word_end: 0.8, channel: [0, 1] });
    await finishStream(stream, socket);
    await expect(noTranscript).resolves.toEqual({ value: undefined, done: true });
  });

  it("does not reuse a noise-only marker after an empty Finalize result", async () => {
    const { socket, stream, iterator } = makeStream();
    await stream.sendAudio({
      audio: { format: PCM16_16K_MONO, bytes: new Uint8Array([0, 0]) },
    } as never);

    const nextEvent = iterator.next();
    socket.receive({ type: "UtteranceEnd", last_word_end: 0.8, channel: [0, 1] });
    expect(await nextBeforeImmediate(nextEvent)).toBe("no-event");
    expect(sentJson(socket)).toContainEqual({ type: "Finalize" });

    socket.receive({
      type: "Results",
      is_final: true,
      speech_final: false,
      start: 0,
      duration: 0.8,
      channel: { alternatives: [] },
    });
    expect(await nextBeforeImmediate(nextEvent)).toBe("no-event");

    socket.receive({
      type: "Results",
      is_final: false,
      start: 1,
      duration: 0.2,
      channel: { alternatives: [{ transcript: "the" }] },
    });
    await expect(nextEvent).resolves.toMatchObject({
      value: { type: "stt.partial", text: "the" },
      done: false,
    });

    const nextSegment = iterator.next();
    socket.receive({
      type: "Results",
      is_final: true,
      speech_final: false,
      start: 1,
      duration: 0.2,
      channel: { alternatives: [{ transcript: "the next sentence" }] },
    });
    await expect(nextSegment).resolves.toMatchObject({
      value: { type: "stt.final", text: "the next sentence" },
      done: false,
    });
    expect(await nextBeforeImmediate(iterator.next())).toBe("no-event");

    await finishStream(stream, socket);
  });

  it("requests UtteranceEnd only when interim results are enabled", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new DeepgramSttProvider({
      apiKey: "test-key",
      endpointingMs: 300,
      webSocketFactory(url) {
        openedUrl = url;
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "session_deepgram_utterance_end_url" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("endpointing")).toBe("300");
    expect(url.searchParams.get("utterance_end_ms")).toBe("1000");
    await finishStream(stream as DeepgramSttStream, socket);
  });

  it("does not request UtteranceEnd when interim results are disabled", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = new DeepgramSttProvider({
      apiKey: "test-key",
      endpointingMs: 300,
      webSocketFactory(url) {
        openedUrl = url;
        return socket as never;
      },
    });

    const stream = await provider.open({
      sessionId: "session_deepgram_no_interim_utterance_end_url" as SessionId,
      format: PCM16_16K_MONO,
      interimResults: false,
    });
    const url = new URL(openedUrl);
    expect(url.searchParams.get("interim_results")).toBe("false");
    expect(url.searchParams.has("utterance_end_ms")).toBe(false);
    await finishStream(stream as DeepgramSttStream, socket);
  });
});
