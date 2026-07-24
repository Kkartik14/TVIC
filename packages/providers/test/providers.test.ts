import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import type { CallId, SessionId, TelephonyProvider, Timestamp, TurnId } from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  RUNTIME_SAMPLE_RATE_HZ,
  isIncrementalTextToSpeechProvider,
} from "@tvic/core";
import { bytesToBase64 } from "@tvic/media";

import {
  CartesiaTtsProvider,
  CartesiaTtsStream,
  DeepgramSttStream,
  OpenAiResponsesLlmProvider,
  TwilioMediaStreamCallHandle,
  requireProviderKind,
  supportsAudioFormat,
  type TwilioMediaStreamSocket,
} from "../src/index.js";
import { AsyncQueue } from "../src/async-queue.js";
import { safeClose, safeSend } from "../src/common.js";

const provider: TelephonyProvider = {
  name: "telephony-contract-provider",
  kind: "telephony",
  version: "0.1.0",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: true, truncation: false },
    transports: ["websocket"],
    audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  },
  async dial() {
    throw new Error("not used");
  },
  async accept() {
    throw new Error("not used");
  },
  async hangup() {
    return;
  },
};

describe("provider utilities", () => {
  it("narrows providers by kind", () => {
    expect(requireProviderKind(provider, "telephony")).toBe(provider);
  });

  it("checks normalized audio format support", () => {
    expect(supportsAudioFormat(provider, PCM16_16K_MONO, "input")).toBe(true);
    expect(supportsAudioFormat(provider, PCM16_16K_MONO, "output")).toBe(true);
  });

  it("rejects formats outside the Twilio adapter's declared boundary", () => {
    expect(
      () =>
        new TwilioMediaStreamCallHandle({
          socket: new FakeSocket() as unknown as TwilioMediaStreamSocket,
          callId: "call_twilio" as CallId,
          sessionId: "session_twilio" as SessionId,
          inputFormat: { ...PCM16_16K_MONO, sampleRateHz: 24000 },
        }),
    ).toThrow("requires 16kHz PCM mono");
  });

  it("identifies providers with native incremental TTS sessions", () => {
    const cartesia = new CartesiaTtsProvider({ apiKey: "test", voiceId: "voice" });
    expect(isIncrementalTextToSpeechProvider(cartesia)).toBe(true);
    expect(
      isIncrementalTextToSpeechProvider({ ...cartesia, openSession: undefined } as never),
    ).toBe(false);
  });

  it("normalizes Twilio mulaw media stream input and sends output messages", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio" as CallId,
      sessionId: "session_twilio" as SessionId,
    });
    const iterator = handle.events[Symbol.asyncIterator]();

    socket.receive(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid: "MZ123",
        start: { streamSid: "MZ123", callSid: "CA123" },
      }),
    );
    socket.receive(
      JSON.stringify({
        event: "media",
        sequenceNumber: "2",
        streamSid: "MZ123",
        media: {
          track: "inbound",
          chunk: "1",
          timestamp: "20",
          payload: bytesToBase64(new Uint8Array(160)),
        },
      }),
    );

    const started = await iterator.next();
    const audio = await iterator.next();

    expect(started.value?.type).toBe("media.stream.started");
    expect(audio.value?.type).toBe("media.audio.chunk");
    expect(audio.value?.direction).toBe("input");
    if (audio.value?.type === "media.audio.chunk") {
      expect(audio.value.audio.format.sampleRateHz).toBe(RUNTIME_SAMPLE_RATE_HZ);
      expect(audio.value.audio.frameCount).toBe(320);
    }

    await handle.send({
      id: "media_output" as never,
      type: "media.audio.chunk",
      sessionId: "session_twilio" as SessionId,
      callId: "call_twilio" as CallId,
      sequence: 1,
      direction: "output",
      timestamp: "2026-05-20T00:00:00.000Z" as never,
      monotonicOffsetMs: 0,
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        data: { kind: "inline", bytes: new Uint8Array(640) },
      },
    });
    await handle.clear();

    expect(socket.sent.map((message) => JSON.parse(message) as { event: string })).toEqual([
      expect.objectContaining({ event: "media" }),
      expect.objectContaining({ event: "clear" }),
    ]);
  });

  it("generates unique deterministic Twilio IDs without provider sequence numbers", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio_ids" as CallId,
      sessionId: "session_twilio_ids" as SessionId,
      clock: fixedClock,
    });
    const iterator = handle.events[Symbol.asyncIterator]();

    socket.receive("invalid");
    socket.receive("still invalid");
    const first = await iterator.next();
    const second = await iterator.next();

    expect(first.value?.id).not.toBe(second.value?.id);
    expect(String(first.value?.id)).toContain(String(fixedClock.now()));
  });

  it("rejects an awaiting AsyncQueue consumer on fail", async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    const error = new Error("provider failed");

    queue.fail(error);

    await expect(pending).rejects.toBe(error);
    await expect(iterator.next()).rejects.toBe(error);
  });

  it("separates Deepgram final segments from conversational endpoints", async () => {
    const socket = new FakeSocket();
    const stream = new DeepgramSttStream(
      socket as never,
      {
        sessionId: "session_deepgram" as SessionId,
        format: PCM16_16K_MONO,
        interimResults: true,
      },
      fixedClock,
    );
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive(JSON.stringify({ type: "SpeechStarted", timestamp: 0 }));
    const speechStarted = await iterator.next();
    expect(speechStarted.value).toEqual(
      expect.objectContaining({ type: "stt.speech.started", audioOffsetMs: 0, sequence: 1 }),
    );

    socket.receive(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        start: 0,
        duration: 0.4,
        channel: {
          alternatives: [{ transcript: "hello", confidence: 0.91, languages: ["en"] }],
        },
      }),
    );

    const firstSegment = await iterator.next();
    expect(firstSegment.value).toEqual(
      expect.objectContaining({
        type: "stt.final",
        text: "hello",
        confidence: 0.91,
        language: "en",
        provider: "deepgram",
        sequence: 2,
        audioStartMs: 0,
        audioEndMs: 400,
      }),
    );

    socket.receive(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        start: 0.4,
        duration: 0.3,
        channel: { alternatives: [{ transcript: "there", confidence: 0.9 }] },
      }),
    );

    const finalSegment = await iterator.next();
    const endpoint = await iterator.next();
    expect(finalSegment.value).toEqual(
      expect.objectContaining({ type: "stt.final", text: "there", sequence: 3 }),
    );
    expect(endpoint.value).toEqual(
      expect.objectContaining({
        type: "stt.endpoint",
        reason: "provider",
        sequence: 4,
        audioOffsetMs: 700,
      }),
    );
  });

  it("maps Cartesia chunk/done messages into output media events", async () => {
    const socket = new FakeSocket();
    const stream = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia" as SessionId,
        turnId: "turn_cartesia" as TurnId,
        text: "confirmed",
        format: PCM16_16K_MONO,
        stream: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_DEFAULTS.cartesia.model,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_one_shot",
      },
    );
    const iterator = stream.events[Symbol.asyncIterator]();
    const bytes = new Uint8Array(640);

    socket.receive(
      JSON.stringify({
        type: "chunk",
        context_id: "ctx_1",
        data: Buffer.from(bytes).toString("base64"),
      }),
    );
    socket.receive(JSON.stringify({ type: "done" }));

    const chunk = await iterator.next();
    const committed = await iterator.next();

    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual(
      expect.objectContaining({
        model_id: PROVIDER_DEFAULTS.cartesia.model,
        transcript: "confirmed",
      }),
    );
    expect(chunk.value).toEqual(
      expect.objectContaining({ type: "media.audio.chunk", provider: "cartesia" }),
    );
    if (chunk.value?.type === "media.audio.chunk") {
      expect(chunk.value.audio.frameCount).toBe(320);
    }
    expect(committed.value).toEqual(
      expect.objectContaining({ type: "media.audio.committed", frameCount: 320 }),
    );
  });

  it("streams incremental Cartesia text with flush and alignment events", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_incremental" as SessionId,
        turnId: "turn_cartesia_incremental" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_DEFAULTS.cartesia.model,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_cartesia_incremental",
      },
    );

    await session.sendText("Hello, ");
    const flushPromise = session.flush();
    await session.sendText("world.");
    await session.finish();

    expect(socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ transcript: "Hello, ", continue: true, add_timestamps: true }),
      expect.objectContaining({ transcript: "", continue: true, flush: true }),
      expect.objectContaining({ transcript: "world.", continue: true }),
      expect.objectContaining({ transcript: "", continue: false }),
    ]);

    const iterator = session.events[Symbol.asyncIterator]();
    socket.receive(
      JSON.stringify({
        type: "chunk",
        data: Buffer.from(new Uint8Array(640)).toString("base64"),
        flush_id: 1,
      }),
    );
    socket.receive(
      JSON.stringify({
        type: "timestamps",
        flush_id: 1,
        word_timestamps: { words: ["Hello"], start: [0], end: [0.4] },
      }),
    );
    socket.receive(JSON.stringify({ type: "flush_done", flush_id: 1 }));
    await expect(flushPromise).resolves.toBe(1);
    socket.receive(JSON.stringify({ type: "done" }));

    const chunk = await iterator.next();
    const alignment = await iterator.next();
    const flush = await iterator.next();
    const committed = await iterator.next();
    expect(chunk.value).toEqual(expect.objectContaining({ sequence: 1 }));
    expect(alignment.value).toEqual(
      expect.objectContaining({
        type: "tts.alignment",
        unit: "word",
        tokens: ["Hello"],
        startMs: [0],
        endMs: [400],
        flushId: 1,
        sequence: 1,
      }),
    );
    expect(flush.value).toEqual(
      expect.objectContaining({ type: "tts.flush.completed", flushId: 1, sequence: 2 }),
    );
    expect(committed.value).toEqual(
      expect.objectContaining({
        type: "media.audio.committed",
        sequence: 2,
        sequenceRange: [1, 1],
      }),
    );
  });

  it("declares and performs only Cartesia request cancellation", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_cancel" as SessionId,
        turnId: "turn_cartesia_cancel" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_DEFAULTS.cartesia.model,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_cancel",
      },
    );
    const provider = new CartesiaTtsProvider({ apiKey: "test", voiceId: "voice" });

    expect(provider.capabilities.cancellation).toMatchObject({ request: true, output: false });
    await session.cancel();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
      context_id: "context_cartesia_cancel",
      cancel: true,
    });
    await expect(session.sendText("too late")).rejects.toMatchObject({
      category: "provider",
      provider: "cartesia",
    });
  });

  it("makes finish idempotent and normalizes writes after finish", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_finish" as SessionId,
        turnId: "turn_cartesia_finish" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_DEFAULTS.cartesia.model,
        language: "en",
        clock: fixedClock,
        timestamps: false,
        contextId: "context_cartesia_finish",
      },
    );

    await session.finish();
    await session.finish();
    expect(socket.sent).toHaveLength(1);
    await expect(session.sendText("too late")).rejects.toMatchObject({
      category: "provider",
      provider: "cartesia",
    });
  });

  it("fails malformed alignment and rejects an outstanding flush", async () => {
    const socket = new FakeSocket();
    const session = new CartesiaTtsStream(
      socket as never,
      {
        sessionId: "session_cartesia_malformed" as SessionId,
        turnId: "turn_cartesia_malformed" as TurnId,
        format: PCM16_16K_MONO,
        timestamps: true,
      },
      {
        voiceId: "voice_1",
        modelId: PROVIDER_DEFAULTS.cartesia.model,
        language: "en",
        clock: fixedClock,
        timestamps: true,
        contextId: "context_cartesia_malformed",
      },
    );
    const iterator = session.events[Symbol.asyncIterator]();
    const flush = session.flush();
    const flushAssertion = expect(flush).rejects.toMatchObject({ category: "provider" });

    socket.receive(
      JSON.stringify({
        type: "timestamps",
        word_timestamps: { words: ["broken"], start: [0], end: [] },
      }),
    );

    await expect(iterator.next()).rejects.toMatchObject({ category: "provider" });
    await flushAssertion;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("closes the connected socket when one-shot stream construction fails", async () => {
    const socket = new FakeSocket();
    socket.send = () => {
      throw new Error("write failed");
    };
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      clock: fixedClock,
      webSocketFactory: () => socket as never,
    });

    await expect(
      provider.synthesize({
        sessionId: "session_cartesia_leak" as SessionId,
        turnId: "turn_cartesia_leak" as TurnId,
        text: "hello",
        format: PCM16_16K_MONO,
        stream: true,
      }),
    ).rejects.toMatchObject({ category: "provider", provider: "cartesia" });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("uses collision-safe context IDs even when the provider clock is fixed", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const sockets = [firstSocket, secondSocket];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice",
      clock: fixedClock,
      webSocketFactory: () => sockets.shift() as never,
    });
    const request = {
      sessionId: "session_cartesia_ids" as SessionId,
      turnId: "turn_cartesia_ids" as TurnId,
      format: PCM16_16K_MONO,
    };

    const first = await provider.openSession(request);
    const second = await provider.openSession(request);
    await first.sendText("one");
    await second.sendText("two");
    const firstContext = JSON.parse(firstSocket.sent[0] ?? "{}").context_id;
    const secondContext = JSON.parse(secondSocket.sent[0] ?? "{}").context_id;

    expect(firstContext).not.toBe(secondContext);
    expect(firstContext).toContain(String(fixedClock.now()));
    await first.cancel();
    await second.cancel();
  });

  it("streams OpenAI response text and accumulated tool-call arguments", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        sseStream([
          { type: "response.output_text.delta", delta: "Checking." },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "function_call", call_id: "call_1", name: "check_availability" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '{"partySize":2',
          },
          { type: "response.function_call_arguments.delta", output_index: 1, delta: "}" },
          { type: "response.function_call_arguments.done", output_index: 1 },
          { type: "response.completed" },
        ]),
        { status: 200 },
      );

    try {
      const provider = new OpenAiResponsesLlmProvider({ apiKey: "test" });
      const completion = await provider.complete({
        sessionId: "session_openai" as SessionId,
        turnId: "turn_openai" as TurnId,
        model: "gpt-test",
        messages: [{ role: "user", content: "book a table" }],
        stream: true,
      });
      const events = [];
      for await (const event of completion.events) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual([
        "llm.started",
        "llm.token",
        "llm.tool_call",
        "llm.completed",
      ]);
      expect(events.find((event) => event.type === "llm.tool_call")).toEqual(
        expect.objectContaining({
          call: expect.objectContaining({
            callRef: "call_1",
            toolName: "check_availability",
            input: { partySize: 2 },
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("twilio playout confirmation", () => {
  function makeHandle() {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket: socket as unknown as TwilioMediaStreamSocket,
      callId: "call_twilio" as CallId,
      sessionId: "session_twilio" as SessionId,
    });
    return { socket, handle };
  }

  it("confirms playout only on a mark ack, never on timeout", async () => {
    const { socket, handle } = makeHandle();
    // No ack within the window → unconfirmed (we never claim "heard" without proof).
    expect(await handle.confirmPlayout("m1", 10)).toBe(false);

    const pending = handle.confirmPlayout("m2", 1000);
    socket.receive(JSON.stringify({ event: "mark", streamSid: "s", mark: { name: "m2" } }));
    expect(await pending).toBe(true);
  });

  it("reports unheard when the call drops before the ack", async () => {
    const { socket, handle } = makeHandle();
    const pending = handle.confirmPlayout("m3", 1000);
    socket.close(); // caller hung up before playout reached the mark
    expect(await pending).toBe(false);
  });
});

describe("socket safety", () => {
  it("safeSend writes only while OPEN and never throws", () => {
    const socket = new FakeSocket();
    expect(safeSend(socket, "hello")).toBe(true);
    expect(socket.sent).toEqual(["hello"]);

    socket.readyState = WebSocket.CLOSING;
    expect(safeSend(socket, "dropped")).toBe(false);
    expect(socket.sent).toEqual(["hello"]);

    const throwing = new FakeSocket();
    throwing.send = () => {
      throw new Error("boom");
    };
    expect(safeSend(throwing, "x")).toBe(false);
  });

  it("safeClose never throws even if close() throws", () => {
    const socket = new FakeSocket();
    socket.close = () => {
      throw new Error("already closed");
    };
    expect(() => safeClose(socket)).not.toThrow();
  });
});

const fixedClock = {
  now(): Timestamp {
    return "2026-05-20T00:00:00.000Z" as Timestamp;
  },
};

class FakeSocket {
  readonly sent: string[] = [];
  // safeSend only writes while the socket is OPEN.
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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

function sseStream(
  events: readonly Readonly<Record<string, unknown>>[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
