import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  type SessionId,
  type Timestamp,
  type TtsSession,
  type TurnId,
} from "@tvic/core";

import { CartesiaTtsStream, ElevenLabsTtsProvider, ElevenLabsTtsStream } from "../src/index.js";

interface SessionHarness {
  readonly session: TtsSession;
  readonly socket: FakeSocket;
  acknowledgeFlush(id: number): void;
}

function ttsSessionContract(
  adapter: string,
  create: () => SessionHarness,
  acknowledgedBy: "provider" | "transport",
): void {
  describe(`${adapter} TTS session contract`, () => {
    it("accepts incremental text and returns distinct flush boundaries", async () => {
      const harness = create();
      await harness.session.sendText("First sentence. ");
      const first = harness.session.flush();
      harness.acknowledgeFlush(1);
      await harness.session.sendText("Second sentence.");
      const second = harness.session.flush();
      harness.acknowledgeFlush(2);

      const firstResult = await first;
      const secondResult = await second;
      expect(firstResult.acknowledgedBy).toBe(acknowledgedBy);
      expect(secondResult.acknowledgedBy).toBe(acknowledgedBy);
      expect(firstResult.id).not.toBe(secondResult.id);
    });

    it("makes finish and cancel idempotent and rejects text after finish", async () => {
      const harness = create();
      await harness.session.finish();
      const sentAfterFirstFinish = harness.socket.sent.length;
      await harness.session.finish();
      expect(harness.socket.sent).toHaveLength(sentAfterFirstFinish);
      await expect(harness.session.sendText("late text")).rejects.toMatchObject({
        category: "provider",
      });
      await harness.session.cancel();
      await harness.session.cancel();
      expect(harness.socket.readyState).toBe(WebSocket.CLOSED);
    });
  });
}

ttsSessionContract(
  "Cartesia",
  () => {
    const socket = new FakeSocket();
    return {
      socket,
      session: new CartesiaTtsStream(socket as never, request, {
        voiceId: "voice_cartesia",
        modelId: PROVIDER_DEFAULTS.cartesia.model,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_contract",
      }),
      acknowledgeFlush(id) {
        socket.receive(JSON.stringify({ type: "flush_done", flush_id: id }));
      },
    };
  },
  "provider",
);

ttsSessionContract(
  "ElevenLabs",
  () => {
    const socket = new FakeSocket();
    return {
      socket,
      session: new ElevenLabsTtsStream(socket as never, request, {
        clock: fixedClock,
        stability: 0.5,
        similarityBoost: 0.8,
      }),
      acknowledgeFlush() {},
    };
  },
  "transport",
);

describe("ElevenLabs TTS adapter", () => {
  it("opens the documented PCM WebSocket and initializes voice settings", async () => {
    const socket = new FakeSocket();
    let openedUrl = "";
    let openedHeaders: Readonly<Record<string, string>> = {};
    const provider = new ElevenLabsTtsProvider({
      apiKey: "secret",
      voiceId: "voice/with spaces",
      clock: fixedClock,
      webSocketFactory(url, headers) {
        openedUrl = url;
        openedHeaders = headers;
        return socket as never;
      },
    });

    await provider.openSession(request);

    const url = new URL(openedUrl);
    expect(url.pathname).toContain("voice%2Fwith%20spaces/stream-input");
    expect(url.searchParams.get("model_id")).toBe(PROVIDER_DEFAULTS.elevenlabs.model);
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
    expect(url.searchParams.get("sync_alignment")).toBe("true");
    expect(openedHeaders).toEqual({ "xi-api-key": "secret" });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        text: " ",
        voice_settings: expect.objectContaining({ stability: 0.5, similarity_boost: 0.8 }),
      }),
    );
  });

  it("maps PCM audio, character alignment, and final output into shared events", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const iterator = session.events[Symbol.asyncIterator]();
    const flush = await session.flush();
    expect(flush.acknowledgedBy).toBe("transport");

    socket.receive(
      JSON.stringify({
        audio: Buffer.from(new Uint8Array(640)).toString("base64"),
        normalizedAlignment: {
          chars: ["H", "i"],
          charStartTimesMs: [0, 50],
          charDurationsMs: [50, 60],
        },
        isFinal: true,
      }),
    );

    const events = [
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
    ].map((step) => step.value);
    expect(events).toEqual([
      expect.objectContaining({ type: "tts.flush.completed", acknowledgedBy: "transport" }),
      expect.objectContaining({ type: "media.audio.chunk" }),
      expect.objectContaining({
        type: "tts.alignment",
        unit: "character",
        tokens: ["H", "i"],
        startMs: [0, 50],
        endMs: [50, 110],
      }),
      expect.objectContaining({ type: "media.audio.committed", frameCount: 320 }),
    ]);
  });

  it("fails malformed alignment instead of silently discarding it", async () => {
    const socket = new FakeSocket();
    const session = new ElevenLabsTtsStream(socket as never, request, {
      clock: fixedClock,
      stability: 0.5,
      similarityBoost: 0.8,
    });
    const pending = session.events[Symbol.asyncIterator]().next();

    socket.receive(
      JSON.stringify({
        alignment: { chars: ["x"], charStartTimesMs: [0], charDurationsMs: [] },
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "elevenlabs.tts.error",
      category: "provider",
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects formats outside its declared PCM16 boundary before connecting", async () => {
    let factoryCalls = 0;
    const provider = new ElevenLabsTtsProvider({
      apiKey: "secret",
      voiceId: "voice",
      webSocketFactory() {
        factoryCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({
        ...request,
        format: { ...PCM16_16K_MONO, sampleRateHz: 24_000 },
      }),
    ).rejects.toMatchObject({ code: "elevenlabs.tts.error" });
    expect(factoryCalls).toBe(0);
  });

  it("closes the connected socket when session initialization cannot be sent", async () => {
    const socket = new FakeSocket();
    socket.send = () => {
      throw new Error("write failed");
    };
    const provider = new ElevenLabsTtsProvider({
      apiKey: "secret",
      voiceId: "voice",
      webSocketFactory: () => socket as never,
    });

    await expect(provider.openSession(request)).rejects.toMatchObject({
      code: "elevenlabs.tts.error",
      category: "provider",
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});

const request = {
  sessionId: "session_tts_contract" as SessionId,
  turnId: "turn_tts_contract" as TurnId,
  format: PCM16_16K_MONO,
  timestamps: true,
};

const fixedClock = {
  now(): Timestamp {
    return "2026-07-25T00:00:00.000Z" as Timestamp;
  },
};

class FakeSocket {
  readonly sent: string[] = [];
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.#emit("close");
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

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(value);
    }
  }
}
