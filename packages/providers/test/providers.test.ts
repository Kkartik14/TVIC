import { describe, expect, it } from "vitest";

import type { CallId, SessionId, TelephonyProvider, Timestamp, TurnId } from "@tvic/core";
import { PCM16_16K_MONO, PROVIDER_DEFAULTS, RUNTIME_SAMPLE_RATE_HZ } from "@tvic/core";
import { bytesToBase64 } from "@tvic/media";

import {
  CartesiaTtsStream,
  DeepgramSttStream,
  OpenAiResponsesLlmProvider,
  TwilioMediaStreamCallHandle,
  requireProviderKind,
  supportsAudioFormat,
} from "../src/index.js";
import { AsyncQueue } from "../src/async-queue.js";

const provider: TelephonyProvider = {
  name: "telephony-contract-provider",
  kind: "telephony",
  version: "0.1.0",
  capabilities: {
    streaming: true,
    interruption: true,
    audioFormats: [PCM16_16K_MONO],
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
    expect(supportsAudioFormat(provider, PCM16_16K_MONO)).toBe(true);
  });

  it("normalizes Twilio mulaw media stream input and sends output messages", async () => {
    const socket = new FakeSocket();
    const handle = new TwilioMediaStreamCallHandle({
      socket,
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

  it("rejects an awaiting AsyncQueue consumer on fail", async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    const error = new Error("provider failed");

    queue.fail(error);

    await expect(pending).rejects.toBe(error);
    await expect(iterator.next()).rejects.toBe(error);
  });

  it("maps Deepgram result messages into transcript events", async () => {
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

    socket.receive(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [{ transcript: "hello there", confidence: 0.91, languages: ["en"] }],
        },
      }),
    );

    const result = await iterator.next();
    expect(result.value).toEqual(
      expect.objectContaining({
        type: "stt.final",
        text: "hello there",
        confidence: 0.91,
        language: "en",
        provider: "deepgram",
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

const fixedClock = {
  now(): Timestamp {
    return "2026-05-20T00:00:00.000Z" as Timestamp;
  },
};

class FakeSocket {
  readonly sent: string[] = [];
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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
