import { EventEmitter } from "node:events";
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

class CartesiaHandshakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;

  send(_data: string | Buffer, callback?: (error?: Error) => void): void {
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

class CartesiaHandshakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly body: Readonly<Record<string, unknown>>,
  ) {
    super();
  }

  resume(): void {
    setImmediate(() => {
      this.emit("data", Buffer.from(JSON.stringify(this.body)));
      this.emit("end");
    });
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

  it.each([
    [
      "quota",
      {
        type: "error",
        done: true,
        error_code: "quota_exceeded",
        title: "Quota exceeded",
        message: "The account quota has been exceeded.",
        request_id: "request-quota-test",
        context_id: "context-quota-test",
      },
      TVIC_ERROR_CODES.providerQuotaExceeded,
      "quota_exceeded",
      "quota_exceeded",
      false,
    ],
    [
      "plan restriction",
      {
        type: "error",
        done: true,
        status_code: 403,
        error_code: "plan_upgrade_required",
        title: "Plan upgrade required",
        message: "This feature requires a higher plan tier.",
        request_id: "request-plan-test",
        context_id: "context-plan-test",
      },
      "provider.plan_not_allowed",
      "plan_upgrade_required",
      "plan_not_allowed",
      false,
    ],
    [
      "rejected credentials",
      {
        type: "error",
        done: true,
        status_code: 401,
        error_code: null,
        title: "Unauthorized",
        message: "The API key was rejected.",
        request_id: "request-auth-test",
        context_id: "context-auth-test",
      },
      TVIC_ERROR_CODES.providerAuthFailed,
      null,
      "auth",
      false,
    ],
    [
      "upstream failure",
      {
        type: "error",
        done: true,
        status_code: 503,
        error_code: null,
        title: "Service unavailable",
        message: "The provider is temporarily unavailable.",
        request_id: "request-upstream-test",
        context_id: "context-upstream-test",
      },
      TVIC_ERROR_CODES.providerUpstreamFailed,
      null,
      "upstream",
      true,
    ],
    [
      "rate limit",
      {
        type: "error",
        done: true,
        status_code: 429,
        error_code: "concurrency_limited",
        title: "Too many concurrent requests",
        message: "The account concurrency limit was reached.",
        request_id: "request-rate-test",
        context_id: "context-rate-test",
      },
      TVIC_ERROR_CODES.providerRateLimited,
      "concurrency_limited",
      "rate_limited",
      true,
    ],
    [
      "unavailable model",
      {
        type: "error",
        done: true,
        status_code: 404,
        error_code: "model_not_found",
        title: "Model not found",
        message: "The requested model does not exist.",
        request_id: "request-model-table-test",
        context_id: "context-model-table-test",
      },
      TVIC_ERROR_CODES.providerModelUnsupported,
      "model_not_found",
      "model_unsupported",
      false,
    ],
  ] as const)(
    "classifies the Cartesia WebSocket %s event",
    async (_cause, event, code, providerCode, classification, retriable) => {
      const socket = new CartesiaErrorSocket();
      const provider = new CartesiaTtsProvider({
        apiKey: "test-key",
        voiceId: "voice-test",
        webSocketFactory: () => socket as unknown as WebSocket,
      });
      const session = await provider.openSession({
        sessionId: "session_cartesia_structured" as never,
        turnId: "turn_cartesia_structured" as never,
        format: PCM16_16K_MONO,
      });
      const pending = session.events[Symbol.asyncIterator]().next();
      socket.receive(event);

      await expect(pending).rejects.toMatchObject({
        code,
        provider: "cartesia",
        retriable,
        metadata: {
          ...(providerCode ? { providerCode } : {}),
          classification,
        },
      });
    },
  );

  it.each([
    [
      "quota",
      400,
      {
        error_code: "quota_exceeded",
        title: "Quota exceeded",
        message: "The account quota has been exceeded.",
        request_id: "request-quota-handshake-test",
      },
      TVIC_ERROR_CODES.providerQuotaExceeded,
      "quota_exceeded",
      "quota_exceeded",
      false,
    ],
    [
      "plan restriction",
      403,
      {
        error_code: "plan_upgrade_required",
        title: "Plan upgrade required",
        message: "This feature requires a higher plan tier.",
        request_id: "request-plan-handshake-test",
      },
      "provider.plan_not_allowed",
      "plan_upgrade_required",
      "plan_not_allowed",
      false,
    ],
    [
      "rejected credentials",
      401,
      {
        error_code: null,
        title: "Unauthorized",
        message: "The API key was rejected.",
        request_id: "request-auth-handshake-test",
      },
      TVIC_ERROR_CODES.providerAuthFailed,
      null,
      "auth",
      false,
    ],
    [
      "rate limit",
      429,
      {
        error_code: "concurrency_limited",
        title: "Too many concurrent requests",
        message: "The account concurrency limit was reached.",
        request_id: "request-rate-handshake-test",
      },
      TVIC_ERROR_CODES.providerRateLimited,
      "concurrency_limited",
      "rate_limited",
      true,
    ],
    [
      "unavailable model",
      404,
      {
        error_code: "model_not_found",
        title: "Model not found",
        message: "The requested model does not exist.",
        request_id: "request-model-handshake-test",
      },
      TVIC_ERROR_CODES.providerModelUnsupported,
      "model_not_found",
      "model_unsupported",
      false,
    ],
    [
      "upstream failure",
      503,
      {
        error_code: null,
        title: "Service unavailable",
        message: "The provider is temporarily unavailable.",
        request_id: "request-upstream-handshake-test",
      },
      TVIC_ERROR_CODES.providerUpstreamFailed,
      null,
      "upstream",
      true,
    ],
  ] as const)(
    "preserves a Cartesia WebSocket connect failure's %s cause",
    async (_cause, statusCode, body, code, providerCode, classification, retriable) => {
      const socket = new CartesiaHandshakeSocket();
      const provider = new CartesiaTtsProvider({
        apiKey: "test-key",
        voiceId: "voice-test",
        webSocketFactory: () => {
          setImmediate(() => {
            socket.emit("unexpected-response", {}, new CartesiaHandshakeResponse(statusCode, body));
            setImmediate(() => socket.emit("close", 1006, Buffer.alloc(0)));
          });
          return socket as unknown as WebSocket;
        },
      });

      await expect(
        provider.openSession({
          sessionId: "session_cartesia_handshake" as never,
          turnId: "turn_cartesia_handshake" as never,
          format: PCM16_16K_MONO,
        }),
      ).rejects.toMatchObject({
        code,
        provider: "cartesia",
        retriable,
        metadata: {
          httpStatus: statusCode,
          ...(providerCode ? { providerCode } : {}),
          classification,
        },
      });
    },
  );
});
