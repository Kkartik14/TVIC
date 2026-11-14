import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, TVIC_ERROR_CODES } from "@tvic/core";
import { CartesiaTtsProvider } from "../src/cartesia.js";

class CartesiaErrorSocket {
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();
  readyState: number = WebSocket.OPEN;

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

  send(_data: string | Buffer, callback?: (error?: Error) => void): void {
    callback?.();
  }

  receive(value: Readonly<Record<string, unknown>>): void {
    const payload = Buffer.from(JSON.stringify(value));
    for (const handler of this.#handlers.get("message") ?? []) handler(payload);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.#handlers.get("close") ?? []) handler(1000, Buffer.alloc(0));
  }
}

describe("Cartesia TTS provider errors", () => {
  it("maps the documented WebSocket concurrency error to a retryable rate limit", async () => {
    const socket = new CartesiaErrorSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice-test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_concurrency" as never,
      turnId: "turn_cartesia_concurrency" as never,
      format: PCM16_16K_MONO,
    });
    const pending = session.events[Symbol.asyncIterator]().next();
    socket.receive({
      type: "error",
      done: true,
      status_code: 429,
      error_code: "concurrency_limited",
      title: "Too many concurrent requests",
      message: "The plan concurrency limit was reached.",
      request_id: "request-concurrency-test",
      context_id: "context-concurrency-test",
    });

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerRateLimited,
      retriable: true,
      metadata: {
        httpStatus: 429,
        providerCode: "concurrency_limited",
        classification: "rate_limited",
      },
    });
  });

  it("maps the documented model_not_found code to an unavailable-model error", async () => {
    const socket = new CartesiaErrorSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice-test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_model" as never,
      turnId: "turn_cartesia_model" as never,
      format: PCM16_16K_MONO,
    });
    const pending = session.events[Symbol.asyncIterator]().next();
    socket.receive({
      type: "error",
      done: true,
      status_code: 404,
      error_code: "model_not_found",
      title: "Model not found",
      message: "The requested model does not exist.",
      request_id: "request-model-test",
      context_id: "context-model-test",
    });

    await expect(pending).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerModelUnsupported,
      retriable: false,
      metadata: {
        httpStatus: 404,
        providerCode: "model_not_found",
        classification: "model_unsupported",
      },
    });
  });
});
