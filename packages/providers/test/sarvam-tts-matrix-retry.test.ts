import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type SessionId, type Timestamp, type TurnId } from "@tvic/core";

import {
  isAmbiguousSarvamTtsMatrixOutcome,
  shouldRetrySarvamTtsMatrixError,
} from "../../../scripts/sarvam-tts-matrix-retry.js";
import { SarvamTtsStream, sarvamTtsProtocolError } from "../src/sarvam-tts.js";

describe("Sarvam TTS live matrix retry policy", () => {
  it("does not retry deterministic quota failures even when marked retriable", () => {
    expect(
      shouldRetrySarvamTtsMatrixError({
        retriable: true,
        code: "provider.rate_limited",
        metadata: { providerCode: "insufficient_quota" },
      }),
    ).toBe(false);
  });

  it("does not automatically retry ambiguous provider outcomes", () => {
    const socketReset = { retriable: true, message: "socket reset" };
    const upstreamFailure = {
      retriable: true,
      code: "provider.upstream_failed",
      metadata: { httpStatus: 500 },
    };

    expect(shouldRetrySarvamTtsMatrixError(socketReset)).toBe(false);
    expect(shouldRetrySarvamTtsMatrixError(upstreamFailure)).toBe(false);
    expect(isAmbiguousSarvamTtsMatrixOutcome(socketReset)).toBe(true);
    expect(isAmbiguousSarvamTtsMatrixOutcome(upstreamFailure)).toBe(true);
  });

  it("retries only an explicit rate-limit rejection and treats it as a known outcome", () => {
    const rateLimited = {
      retriable: true,
      code: "provider.rate_limited",
      metadata: { httpStatus: 429 },
    };

    expect(shouldRetrySarvamTtsMatrixError(rateLimited)).toBe(true);
    expect(isAmbiguousSarvamTtsMatrixOutcome(rateLimited)).toBe(false);
  });

  it("trusts recognized Sarvam error codes over conflicting quota-like message text", () => {
    const rateLimited = Object.assign(new Error("quota exceeded"), {
      retriable: true,
      code: "provider.rate_limited",
      metadata: { providerCode: "rate_limit_exceeded_error", httpStatus: 429 },
    });
    const quotaExhausted = Object.assign(new Error("rate limit exceeded"), {
      retriable: false,
      code: "provider.quota_exceeded",
      metadata: { providerCode: "insufficient_quota_error", httpStatus: 429 },
    });

    expect(shouldRetrySarvamTtsMatrixError(rateLimited)).toBe(true);
    expect(shouldRetrySarvamTtsMatrixError(quotaExhausted)).toBe(false);
  });

  it("does not mistake a generic generation error for an explicit rate-limit rejection", () => {
    const error = sarvamTtsProtocolError(undefined, "failed to generate audio");

    expect(error.code).toBe("provider.upstream_failed");
    expect(shouldRetrySarvamTtsMatrixError(error)).toBe(false);
    expect(isAmbiguousSarvamTtsMatrixOutcome(error)).toBe(true);
  });

  it("keeps an explicit WebSocket 429 eligible for bounded retry", () => {
    const error = sarvamTtsProtocolError("429", "rate limit exceeded");

    expect(error.code).toBe("provider.rate_limited");
    expect(shouldRetrySarvamTtsMatrixError(error)).toBe(true);
    expect(isAmbiguousSarvamTtsMatrixOutcome(error)).toBe(false);
  });

  it("does not retry an in-band 429 after audio has begun and marks the outcome unknown", () => {
    const error = {
      retriable: false,
      code: "provider.rate_limited",
      metadata: { providerCode: "429", audioStarted: true, outcomeUnknown: true },
    };

    expect(shouldRetrySarvamTtsMatrixError(error)).toBe(false);
    expect(isAmbiguousSarvamTtsMatrixOutcome(error)).toBe(true);
  });

  it("does not retry a rate-limit close after the WebSocket has emitted audio", async () => {
    const socket = new FakeSocket();
    const stream = new SarvamTtsStream(
      socket as never,
      {
        sessionId: "session_sarvam_retry" as SessionId,
        turnId: "turn_sarvam_retry" as TurnId,
        format: PCM16_16K_MONO,
      },
      {
        clock: fixedClock,
        model: "bulbul:v4-flash",
        language: "en-IN",
        voice: "simran_en_customer",
        pace: 1,
        temperature: 0.6,
        minBufferSize: 50,
        maxChunkLength: 150,
        keepAliveIntervalMs: 60_000,
      },
    );
    const iterator = stream.events[Symbol.asyncIterator]();
    socket.receive({
      type: "audio",
      data: {
        content_type: "audio/pcm",
        audio: Buffer.from(new Uint8Array(640)).toString("base64"),
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "media.audio.chunk" },
    });

    socket.closeWith(1003, "Rate limit exceeded");
    const failure = await iterator.next().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "provider.rate_limited",
      retriable: false,
      metadata: { wsCloseCode: 1003, audioStarted: true, outcomeUnknown: true },
    });
    expect(shouldRetrySarvamTtsMatrixError(failure)).toBe(false);
    expect(isAmbiguousSarvamTtsMatrixOutcome(failure)).toBe(true);
  });

  it("does not retry non-retriable failures", () => {
    expect(shouldRetrySarvamTtsMatrixError({ retriable: false, message: "invalid input" })).toBe(
      false,
    );
    expect(isAmbiguousSarvamTtsMatrixOutcome({ code: "provider.invalid_request" })).toBe(false);
  });
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  send(): void {}

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  receive(message: Readonly<Record<string, unknown>>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  closeWith(code: number, reason: string): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
}

const fixedClock = {
  now(): Timestamp {
    return "2026-10-11T00:00:00.000Z" as Timestamp;
  },
};
