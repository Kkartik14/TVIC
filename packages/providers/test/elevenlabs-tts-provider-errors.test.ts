import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, TVIC_ERROR_CODES, type SessionId, type TurnId } from "@tvic/core";
import { ElevenLabsTtsProvider } from "../src/elevenlabs.js";

const request = {
  sessionId: "session_elevenlabs_error" as SessionId,
  turnId: "turn_elevenlabs_error" as TurnId,
  format: PCM16_16K_MONO,
};

class ElevenLabsErrorSocket extends EventEmitter {
  readyState: number;

  constructor(readyState: number = WebSocket.OPEN) {
    super();
    this.readyState = readyState;
  }

  send(_data: string | Buffer, callback?: (error?: Error) => void): void {
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  receive(value: Readonly<Record<string, unknown>>): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

class ElevenLabsHandshakeResponse extends EventEmitter {
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

function documentedError(type: string, code: string): Readonly<Record<string, unknown>> {
  return {
    detail: {
      type,
      code,
      message: "A provider diagnostic that should not be exposed to callers.",
      status: code,
      request_id: "request-elevenlabs-test",
    },
  };
}

describe("ElevenLabs TTS WebSocket provider errors", () => {
  it.each([
    [
      "insufficient credits",
      "payment_required",
      "insufficient_credits",
      TVIC_ERROR_CODES.providerQuotaExceeded,
      "quota_exceeded",
      false,
    ],
    [
      "feature outside the current plan",
      "authorization_error",
      "feature_not_available",
      "provider.plan_not_allowed",
      "plan_not_allowed",
      false,
    ],
    [
      "invalid credentials",
      "authentication_error",
      "invalid_api_key",
      TVIC_ERROR_CODES.providerAuthFailed,
      "auth",
      false,
    ],
    [
      "ordinary rate limit",
      "rate_limit_error",
      "rate_limit_exceeded",
      TVIC_ERROR_CODES.providerRateLimited,
      "rate_limited",
      true,
    ],
    [
      "missing model",
      "not_found",
      "model_not_found",
      TVIC_ERROR_CODES.providerModelUnsupported,
      "model_unsupported",
      false,
    ],
    [
      "provider outage",
      "service_unavailable",
      "service_unavailable",
      TVIC_ERROR_CODES.providerUpstreamFailed,
      "upstream",
      true,
    ],
  ] as const)(
    "classifies an in-band WebSocket %s error",
    async (_cause, type, code, normalizedCode, classification, retriable) => {
      const socket = new ElevenLabsErrorSocket();
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test-key",
        voiceId: "voice",
        webSocketFactory: () => socket as unknown as WebSocket,
      });
      const session = await provider.openSession(request);
      const pending = session.events[Symbol.asyncIterator]().next();
      socket.receive({
        error: "A provider diagnostic that should not be exposed to callers.",
        type,
        code,
        status: code,
      });

      await expect(pending).rejects.toMatchObject({
        code: normalizedCode,
        provider: "elevenlabs",
        retriable,
        metadata: { providerCode: code, providerType: type, classification },
      });
    },
  );

  it.each([
    [
      "documented 402 insufficient-credit response",
      402,
      "payment_required",
      "insufficient_credits",
      TVIC_ERROR_CODES.providerQuotaExceeded,
      "quota_exceeded",
      false,
      {
        httpStatus: 402,
        providerCode: "insufficient_credits",
        providerType: "payment_required",
        classification: "quota_exceeded",
      },
    ],
    [
      "documented 403 plan-feature response",
      403,
      "authorization_error",
      "feature_not_available",
      "provider.plan_not_allowed",
      "plan_not_allowed",
      false,
      {
        httpStatus: 403,
        providerCode: "feature_not_available",
        providerType: "authorization_error",
        classification: "plan_not_allowed",
      },
    ],
    [
      "documented 401 invalid-credential response",
      401,
      "authentication_error",
      "invalid_api_key",
      TVIC_ERROR_CODES.providerAuthFailed,
      "auth",
      false,
      {
        httpStatus: 401,
        providerCode: "invalid_api_key",
        providerType: "authentication_error",
        classification: "auth",
      },
    ],
    [
      "documented 429 rate-limit response",
      429,
      "rate_limit_error",
      "rate_limit_exceeded",
      TVIC_ERROR_CODES.providerRateLimited,
      "rate_limited",
      true,
      {
        httpStatus: 429,
        providerCode: "rate_limit_exceeded",
        providerType: "rate_limit_error",
        classification: "rate_limited",
      },
    ],
    [
      "documented 404 model-not-found response",
      404,
      "not_found",
      "model_not_found",
      TVIC_ERROR_CODES.providerModelUnsupported,
      "model_unsupported",
      false,
      {
        httpStatus: 404,
        providerCode: "model_not_found",
        providerType: "not_found",
        classification: "model_unsupported",
      },
    ],
    [
      "documented 503 service-unavailable response",
      503,
      "service_unavailable",
      "service_unavailable",
      TVIC_ERROR_CODES.providerUpstreamFailed,
      "upstream",
      false,
      { httpStatus: 503, outcomeUnknown: true },
    ],
  ] as const)(
    "classifies a WebSocket handshake rejected with a %s",
    async (
      _description,
      statusCode,
      type,
      code,
      normalizedCode,
      _classification,
      retriable,
      metadata,
    ) => {
      const socket = new ElevenLabsErrorSocket(WebSocket.CONNECTING);
      const body = documentedError(type, code);
      const provider = new ElevenLabsTtsProvider({
        apiKey: "test-key",
        voiceId: "voice",
        webSocketFactory: () => {
          setImmediate(() => {
            socket.emit(
              "unexpected-response",
              {},
              new ElevenLabsHandshakeResponse(statusCode, body),
            );
            setImmediate(() => socket.emit("close", 1006, Buffer.alloc(0)));
          });
          return socket as unknown as WebSocket;
        },
      });

      await expect(provider.openSession(request)).rejects.toMatchObject({
        code: normalizedCode,
        provider: "elevenlabs",
        retriable,
        metadata,
        message: expect.not.stringContaining("provider diagnostic"),
      });
    },
  );
});
