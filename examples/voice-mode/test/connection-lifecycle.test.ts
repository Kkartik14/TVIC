import { describe, expect, it, vi } from "vitest";

import {
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
  createWebClientAudioProvider,
  type CallId,
  type SessionId,
  type Timestamp,
  type WebClientAudioProvider,
  type WebClientAudioSocket,
} from "voice-runtime";

import {
  StartupBufferedWebClientSocket,
  VoiceConnectionRegistry,
} from "../src/connection-lifecycle.js";

describe("voice connection lifecycle", () => {
  it("aborts and waits for in-flight startup before superseding its call", async () => {
    const supersede = vi.fn(async (_callId: CallId) => undefined);
    const hangup = vi.fn(async (_callId: CallId) => undefined);
    const telephony: Pick<WebClientAudioProvider, "supersede" | "hangup"> = {
      supersede,
      hangup,
    };
    const registry = new VoiceConnectionRegistry(telephony);
    const rawSocket = new FakeWebClientAudioSocket();
    const callId = "call_1" as CallId;
    const attempt = registry.begin("session_1", callId, rawSocket);

    const cancellation = registry.supersede("session_1");
    await Promise.resolve();
    expect(attempt.signal.aborted).toBe(true);
    expect(rawSocket.closed).toEqual({
      code: WEB_CLIENT_AUDIO_CLOSE_CODES.superseded,
      reason: "superseded by reconnect",
    });
    expect(supersede).not.toHaveBeenCalled();

    attempt.settleStartup();
    await cancellation;

    expect(supersede).toHaveBeenCalledOnce();
    expect(supersede).toHaveBeenCalledWith(callId);
  });

  it("closes peers that exceed the bounded pre-attachment message buffer", () => {
    const rawSocket = new FakeWebClientAudioSocket();
    const onTerminal = vi.fn();
    const buffered = new StartupBufferedWebClientSocket(rawSocket, onTerminal);
    const received: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      rawSocket.receive(Buffer.from([index]), true);
    }
    buffered.on("message", (data) => received.push(data.toString()));

    expect(rawSocket.closed).toEqual({
      code: WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit,
      reason: "startup input limit exceeded",
    });
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
  });

  it("closes a peer that exceeds the pre-attachment byte budget", () => {
    const rawSocket = new FakeWebClientAudioSocket();
    const buffered = new StartupBufferedWebClientSocket(rawSocket, vi.fn());
    const received: unknown[] = [];
    rawSocket.receive(Buffer.alloc(WEB_CLIENT_AUDIO_DEFAULTS.maxBinaryFrameBytes + 1), true);
    buffered.on("message", (data) => received.push(data));

    expect(rawSocket.closed).toEqual({
      code: WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit,
      reason: "startup input limit exceeded",
    });
    expect(received).toEqual([]);
  });

  it("keeps a synchronously replayed session.start alive after the startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const rawSocket = new FakeWebClientAudioSocket();
      const buffered = new StartupBufferedWebClientSocket(rawSocket, vi.fn());
      const callId = "call_buffered_start" as CallId;
      const sessionId = "session_buffered_start" as SessionId;

      rawSocket.receive(
        Buffer.from(
          JSON.stringify({
            type: "session.start",
            protocolVersion: 1,
            mode: "push_to_talk",
            clientPlatform: "test",
            audioFormat: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
          }),
        ),
        false,
      );

      const telephony = createWebClientAudioProvider({
        clock: {
          now: () => "2026-10-08T00:00:00.000Z" as Timestamp,
          monotonicNowMs: () => Date.now(),
        },
      });
      const handle = await telephony.acceptWebSocket(buffered, callId, sessionId, {
        expectedMode: "push_to_talk",
      });
      const events = handle.events[Symbol.asyncIterator]();
      expect((await events.next()).value?.type).toBe("media.stream.started");

      await vi.advanceTimersByTimeAsync(WEB_CLIENT_AUDIO_DEFAULTS.heartbeatIntervalMs);
      rawSocket.receive(Buffer.from(JSON.stringify({ type: "client.ping", nonce: "keepalive" })), false);
      await vi.advanceTimersByTimeAsync(WEB_CLIENT_AUDIO_DEFAULTS.heartbeatTimeoutMs - WEB_CLIENT_AUDIO_DEFAULTS.heartbeatIntervalMs);

      expect(rawSocket.closed).toBeUndefined();

      await telephony.hangup(callId);
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeWebClientAudioSocket implements WebClientAudioSocket {
  readonly #messageHandlers: Array<(data: Buffer, isBinary: boolean) => void> = [];
  readonly #closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  readonly #errorHandlers: Array<(error: Error) => void> = [];
  readyState = 1;
  bufferedAmount = 0;
  closed: { readonly code: number | undefined; readonly reason: string | undefined } | undefined;

  send(_data: string | Buffer): void {}

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    const closeReason = Buffer.from(reason ?? "");
    for (const handler of this.#closeHandlers) handler(code ?? 1000, closeReason);
  }

  on(event: "message", handler: (data: Buffer, isBinary: boolean) => void): this;
  on(event: "close", handler: (code: number, reason: Buffer) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(
    event: "message" | "close" | "error",
    handler:
      | ((data: Buffer, isBinary: boolean) => void)
      | ((code: number, reason: Buffer) => void)
      | ((error: Error) => void),
  ): this {
    if (event === "message") {
      this.#messageHandlers.push(handler as (data: Buffer, isBinary: boolean) => void);
    } else if (event === "close") {
      this.#closeHandlers.push(handler as (code: number, reason: Buffer) => void);
    } else {
      this.#errorHandlers.push(handler as (error: Error) => void);
    }
    return this;
  }

  receive(data: Buffer, isBinary: boolean): void {
    for (const handler of this.#messageHandlers) handler(data, isBinary);
  }
}
