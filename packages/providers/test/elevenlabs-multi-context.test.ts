import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  createSpeechControlCatalogSnapshot,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  type SessionId,
  type Timestamp,
  type TtsEvent,
  type TurnId,
} from "@tvic/core";

import {
  createElevenLabsDialogueMultiContextProvider as createElevenLabsDialogueMultiContextProviderImpl,
  createElevenLabsTtsMultiContextProvider as createElevenLabsTtsMultiContextProviderImpl,
} from "../src/index.js";
import type { ElevenLabsMultiContextProviderOptions } from "../src/elevenlabs-multi-context.js";
import { elevenLabsVoiceCatalog } from "./speech-control-catalog-fixtures.js";

function withTestVoiceCatalog(options: ElevenLabsMultiContextProviderOptions) {
  const voices = [...new Set([options.voiceId, ...(options.dialogueVoices ?? [])])].filter(
    (voice): voice is string => voice !== undefined,
  );
  return {
    ...options,
    speechControlCatalog:
      options.speechControlCatalog ??
      elevenLabsVoiceCatalog(
        voices,
        options.allowUnknownModel && options.modelId !== undefined
          ? { extraModels: [options.modelId] }
          : {},
      ),
  };
}

function createElevenLabsTtsMultiContextProvider(options: ElevenLabsMultiContextProviderOptions) {
  return createElevenLabsTtsMultiContextProviderImpl(withTestVoiceCatalog(options));
}

function createElevenLabsDialogueMultiContextProvider(
  options: ElevenLabsMultiContextProviderOptions,
) {
  return createElevenLabsDialogueMultiContextProviderImpl(withTestVoiceCatalog(options));
}

const fixedClock = {
  now(): Timestamp {
    return "2026-09-25T00:00:00.000Z" as Timestamp;
  },
};

describe("ElevenLabs multi-context WebSocket adapters", () => {
  it("rejects SSML parsing options and custom URL overrides before connecting", () => {
    let factoryCalls = 0;
    const webSocketFactory = () => {
      factoryCalls += 1;
      return new FakeSocket() as never;
    };

    expect(() =>
      createElevenLabsTtsMultiContextProvider({
        apiKey: "test",
        voiceId: "voice",
        enableSsmlParsing: true,
        webSocketFactory,
      }),
    ).toThrow(/SSML parsing is disabled/u);
    expect(() =>
      createElevenLabsTtsMultiContextProvider({
        apiKey: "test",
        voiceId: "voice",
        url: "wss://example.test/tts?enable_ssml_parsing=true",
        webSocketFactory,
      }),
    ).toThrow(/SSML parsing is disabled/u);
    expect(factoryCalls).toBe(0);
  });

  it("rejects Eleven v4 on the standard multi-context TTS WebSocket before opening", async () => {
    let factoryCalls = 0;
    const provider = createElevenLabsTtsMultiContextProvider({
      apiKey: "test",
      voiceId: "voice",
      modelId: "eleven_v4_turbo",
      allowUnknownModel: true,
      webSocketFactory: () => {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(provider.openConnection()).rejects.toThrow(/Text-to-Dialogue endpoint/);
    expect(factoryCalls).toBe(0);
  });

  it("rejects a context model that differs from its connection model", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsTtsMultiContextProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-path",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();

    await expect(
      connection.openContext({
        contextId: "different-model",
        sessionId: "multi-session" as SessionId,
        turnId: "different-model-turn" as TurnId,
        format: PCM16_16K_MONO,
        voice: "voice-path",
        model: "eleven_turbo_v2_5",
      }),
    ).rejects.toThrow(/model is fixed by the connection/);
    expect(socket.sent).toHaveLength(0);
    await connection.close();
  });

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
    expect(new URL(openedUrl).searchParams.get("enable_ssml_parsing")).toBe("false");
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
      speechControlCatalog: createSpeechControlCatalogSnapshot(
        ["voice-a", "voice-b"].map((voice) => ({
          provider: PROVIDER_NAMES.elevenlabs,
          control: "tts.voice",
          scope: { type: "account" as const, model: "eleven_v3", voice },
          status: "supported" as const,
          mutability: "provider" as const,
          source: "https://elevenlabs.io/docs/api-reference/voices/search",
          verifiedAt: "2026-10-25",
        })),
        { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
      ),
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

  it("rejects unlisted request-level dialogue voices before registering a context", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsDialogueMultiContextProvider({
      apiKey: "eleven-secret",
      modelId: "eleven_v3",
      voiceId: "voice-a",
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();

    await expect(
      connection.openContext({
        contextId: "unlisted-dialogue-voice",
        sessionId: "unlisted-dialogue-session" as SessionId,
        turnId: "unlisted-dialogue-turn" as TurnId,
        format: PCM16_16K_MONO,
        voice: "voice-a",
        voices: ["voice-a", "unlisted-voice"],
        speechControlCatalog: elevenLabsVoiceCatalog(["voice-a"]),
      }),
    ).rejects.toThrow(/account voice catalog unknown for voice unlisted-voice/u);

    expect(connection.contexts).toBe(0);
    expect(socket.sent).toHaveLength(0);
    await connection.close();
  });

  it("does not let callers mutate the validated dialogue voice list after registration", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsDialogueMultiContextProvider({
      apiKey: "eleven-secret",
      modelId: "eleven_v3",
      voiceId: "voice-a",
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();
    const voices = ["voice-a"];
    const session = await connection.openContext({
      contextId: "mutable-dialogue-voices",
      sessionId: "mutable-dialogue-session" as SessionId,
      turnId: "mutable-dialogue-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-a",
      voices,
      speechControlCatalog: elevenLabsVoiceCatalog(["voice-a"]),
    });
    const sentBeforeMutation = socket.sent.length;

    voices.push("unlisted-voice");
    await expect(session.sendDialogueTurn("hello", { voiceId: "unlisted-voice" })).rejects.toThrow(
      /dialogue voice is not registered/u,
    );
    expect(socket.sent).toHaveLength(sentBeforeMutation);
    await connection.close();
  });

  it("sends square-bracket caller text unchanged on regular multi-context sessions", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsTtsMultiContextProvider({
      apiKey: "eleven-secret",
      voiceId: "voice-a",
      modelId: "eleven_flash_v2_5",
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();
    const session = await connection.openContext({
      contextId: "literal-text",
      sessionId: "literal-session" as SessionId,
      turnId: "literal-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-a",
    });
    const sentBefore = socket.sent.length;

    await session.sendText("The caller wrote [laughs].");
    expect(JSON.parse(socket.sent[sentBefore] ?? "{}")).toMatchObject({
      context_id: "literal-text",
      text: "The caller wrote [laughs].",
    });
    await connection.close();
  });

  it("sends square-bracket caller text unchanged on dialogue multi-context sessions", async () => {
    const socket = new FakeSocket();
    const provider = createElevenLabsDialogueMultiContextProvider({
      apiKey: "eleven-secret",
      modelId: "eleven_v3",
      dialogueVoices: ["voice-a"],
      webSocketFactory: () => socket as never,
    });
    const connection = await provider.openConnection();
    const session = await connection.openContext({
      contextId: "literal-dialogue",
      sessionId: "literal-dialogue-session" as SessionId,
      turnId: "literal-dialogue-turn" as TurnId,
      format: PCM16_16K_MONO,
      voice: "voice-a",
      voices: ["voice-a"],
    });
    const sentBefore = socket.sent.length;

    await session.sendDialogueTurn("The caller wrote [laughs].");
    expect(socket.sent.slice(sentBefore).map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({
        inputs: [{ text: "The caller wrote [laughs].", voice_id: "voice-a" }],
      }),
    ]);
    await connection.close();
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
