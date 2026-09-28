import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  type SessionId,
  type Timestamp,
  type TtsEvent,
  type TurnId,
} from "@tvic/core";

import {
  createElevenLabsDialogueMultiContextProvider,
  createElevenLabsTtsMultiContextProvider,
} from "../src/index.js";

const fixedClock = {
  now(): Timestamp {
    return "2026-09-25T00:00:00.000Z" as Timestamp;
  },
};

describe("ElevenLabs multi-context WebSocket adapters", () => {
  it("multiplexes independent regular TTS contexts over one socket", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    const provider = createElevenLabsTtsMultiContextProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-path",
      modelId: "eleven_flash_v2_5",
      language: "en",
      enableLogging: false,
      clock: fixedClock,
      webSocketFactory: (url) => {
        openedUrl = url;
        return socket as never;
      },
    });

    const connection = await provider.openConnection();
    const first = await connection.openContext({
      contextId: "first",
      sessionId: "multi-session" as SessionId,
      turnId: "first-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-path",
    });
    const second = await connection.openContext({
      contextId: "second",
      sessionId: "multi-session" as SessionId,
      turnId: "second-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-path",
    });

    const url = new URL(openedUrl);
    expect(url.pathname).toBe("/v1/text-to-speech/voice-path/multi-stream-input");
    expect(url.searchParams.get("model_id")).toBe("eleven_flash_v2_5");
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
    expect(url.searchParams.get("language_code")).toBe("en");
    expect(url.searchParams.get("enable_logging")).toBe("false");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      context_id: "first",
      text: " ",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    });
    expect(JSON.parse(socket.sent[1] ?? "{}")).toMatchObject({
      context_id: "second",
      text: " ",
    });

    await first.sendText("first text");
    await second.sendText("second text");
    await first.finish();
    await second.finish();
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({
      context_id: "first",
      text: "first text",
    });
    expect(JSON.parse(socket.sent[3] ?? "{}")).toEqual({
      context_id: "second",
      text: "second text",
    });
    expect(JSON.parse(socket.sent[4] ?? "{}")).toEqual({
      context_id: "first",
      text: " ",
      flush: true,
    });
    expect(JSON.parse(socket.sent[5] ?? "{}")).toEqual({
      context_id: "first",
      close_context: true,
    });
    expect(JSON.parse(socket.sent[6] ?? "{}")).toEqual({
      context_id: "second",
      text: " ",
      flush: true,
    });
    expect(JSON.parse(socket.sent[7] ?? "{}")).toEqual({
      context_id: "second",
      close_context: true,
    });

    const firstIterator = first.events[Symbol.asyncIterator]();
    const secondIterator = second.events[Symbol.asyncIterator]();
    socket.receive({
      context_id: "second",
      audio: Buffer.from([3, 4]).toString("base64"),
      is_final: true,
    });
    socket.receive({
      context_id: "first",
      audio: Buffer.from([1, 2]).toString("base64"),
      is_final: true,
    });

    const firstEvents = await collect(firstIterator);
    const secondEvents = await collect(secondIterator);
    expect(firstEvents).toHaveLength(2);
    expect(firstEvents[0]).toMatchObject({
      type: "media.audio.chunk",
      audio: { bytes: new Uint8Array([1, 2]) },
      provider: PROVIDER_NAMES.elevenlabs,
    });
    expect(firstEvents[1]).toMatchObject({ type: "media.audio.committed" });
    expect(secondEvents[0]).toMatchObject({ audio: { bytes: new Uint8Array([3, 4]) } });
    expect(connection.contexts).toBe(0);
  });

  it("registers voices and emits per-turn commits for dialogue contexts", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsDialogueMultiContextProvider({
      apiKey: "eleven-secret",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a", "voice-b"],
      clock: fixedClock,
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();
    const session = await connection.openContext({
      contextId: "dialogue",
      sessionId: "dialogue-session" as SessionId,
      turnId: "dialogue-turn" as TurnId,
      format: PCM16_16K_MONO,
      voices: ["voice-a", "voice-b"],
      voice: "voice-a",
      timestamps: true,
    });
    expect(new URL(socket.url).pathname).toBe("/v1/text-to-dialogue/multi-stream-input");
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      context_id: "dialogue",
      voices: ["voice-a", "voice-b"],
      voice_settings: { stability: 0.5 },
    });

    await session.sendDialogueTurn("hello", { voiceId: "voice-a" });
    await session.sendDialogueTurn("hi", { voiceId: "voice-b", newTurn: true });
    await session.keepAlive();
    await session.finish();
    expect(JSON.parse(socket.sent[1] ?? "{}")).toEqual({
      context_id: "dialogue",
      inputs: [{ text: "hello", voice_id: "voice-a" }],
    });
    expect(JSON.parse(socket.sent[2] ?? "{}")).toEqual({
      context_id: "dialogue",
      inputs: [{ text: "hi", voice_id: "voice-b", new_turn: true }],
    });
    expect(JSON.parse(socket.sent[3] ?? "{}")).toEqual({
      context_id: "dialogue",
      keep_alive: true,
    });
    expect(JSON.parse(socket.sent[4] ?? "{}")).toEqual({
      context_id: "dialogue",
      close_context: true,
    });

    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive({
      context_id: "dialogue",
      audio: Buffer.from([1, 2]).toString("base64"),
      alignment: {
        chars: ["h"],
        char_start_times_ms: [0],
        char_durations_ms: [20],
      },
      is_final_audio_for_turn: true,
    });
    socket.receive({
      context_id: "dialogue",
      audio: Buffer.from([3, 4]).toString("base64"),
      is_final: true,
    });

    const events = await collect(iterator);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ type: "media.audio.chunk" });
    expect(events[1]).toMatchObject({ type: "tts.alignment", startMs: [0], endMs: [20] });
    expect(events[2]).toMatchObject({ type: "media.audio.committed", frameCount: 1 });
    expect(events[3]).toMatchObject({ type: "media.audio.chunk" });
    expect(events[4]).toMatchObject({ type: "media.audio.committed", frameCount: 1 });
  });

  it("enforces the five-context limit and fails closed on an unknown context", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsDialogueMultiContextProvider({
      apiKey: "eleven-secret",
      modelId: "eleven_v3",
      voiceId: "voice-a",
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();
    const base = {
      sessionId: "limit-session" as SessionId,
      turnId: "limit-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-a",
    } as const;
    for (let index = 0; index < 5; index += 1) {
      await connection.openContext({ ...base, contextId: `context-${index}` });
    }
    await expect(
      connection.openContext({ ...base, contextId: "context-overflow" }),
    ).rejects.toMatchObject({
      code: PROVIDER_NAMES.elevenlabs + ".tts.error",
    });

    socket.receive({ context_id: "not-open", error: "bad context" });
    expect(connection.contexts).toBe(0);
  });

  it("routes an omitted context id only when one regular TTS context is active", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsTtsMultiContextProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-a",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();
    const session = await connection.openContext({
      contextId: "single",
      sessionId: "single-session" as SessionId,
      turnId: "single-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-a",
    });
    const iterator = session.events[Symbol.asyncIterator]();

    socket.receive({
      audio: Buffer.from([1, 2]).toString("base64"),
      isFinal: false,
    });
    socket.receive({
      audio: null,
      isFinal: true,
    });

    const events = await collect(iterator);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "media.audio.chunk" });
    expect(events[1]).toMatchObject({ type: "media.audio.committed" });
  });
});

async function collect(iterator: AsyncIterator<TtsEvent>): Promise<TtsEvent[]> {
  const events: TtsEvent[] = [];
  while (true) {
    const result = await iterator.next();
    if (result.done) return events;
    events.push(result.value);
  }
}

class FakeSocket {
  readonly sent: string[] = [];
  readonly url = "wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input";
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close");
  }

  on(event: "message" | "close" | "error", handler: (value?: never) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (value?: unknown) => void);
    this.#handlers.set(event, handlers);
    return this;
  }

  receive(message: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(value);
  }
}
