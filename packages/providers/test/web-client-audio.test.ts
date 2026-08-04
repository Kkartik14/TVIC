import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";
import type {
  AudioFormat,
  CallId,
  MediaEventId,
  OutputMediaEvent,
  SessionId,
  Timestamp,
} from "@tvic/core";

import {
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
  WebClientAudioCallHandle,
  createWebClientAudioProvider,
  type ConnectionObservabilityEvent,
  type WebClientAudioSocket,
} from "../src/index.js";

describe("WebClientAudioCallHandle", () => {
  it("accepts session.start, binary PCM, and explicit turn boundaries", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    const iterator = handle.events[Symbol.asyncIterator]();

    socket.text(startMessage());
    socket.binary(audioFrame(1, new Uint8Array(640)));
    socket.text(JSON.stringify({ type: "turn.end" }));

    expect((await iterator.next()).value?.type).toBe("media.stream.started");
    const audio = (await iterator.next()).value;
    expect(audio?.type).toBe("media.audio.chunk");
    expect((await iterator.next()).value?.type).toBe("media.turn.commit_requested");
    expect(socket.json()[0]).toEqual(expect.objectContaining({ type: "session.ready" }));
  });

  it("surfaces malformed JSON as media.error without throwing", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    const next = handle.events[Symbol.asyncIterator]().next();
    socket.text("{");
    expect((await next).value?.type).toBe("media.error");
  });

  it("rejects oversized control frames and unsupported raw frame representations", async () => {
    const oversized = new FakeWebSocket();
    createHandle(oversized);
    oversized.text("x".repeat(4097));
    expect(oversized.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);

    const unsupported = new FakeWebSocket();
    const handle = createHandle(unsupported);
    const next = handle.events[Symbol.asyncIterator]().next();
    unsupported.raw(new Blob(["bad"]) as unknown as WebSocket.RawData, false);
    expect((await next).value?.type).toBe("media.error");
    expect(unsupported.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
  });

  it("rejects unsupported formats and oversized frames", async () => {
    const wrong = new FakeWebSocket();
    createHandle(wrong);
    wrong.text(
      startMessage({
        ...PCM16_16K_MONO,
        sampleRateHz: 8_000 as AudioFormat["sampleRateHz"],
      }),
    );
    expect(wrong.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);

    const oversized = new FakeWebSocket();
    createHandle(oversized, { maxBinaryFrameBytes: 20 });
    oversized.text(startMessage());
    oversized.binary(audioFrame(1, new Uint8Array(10)));
    expect(oversized.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("rejects invalid binary headers and sustained input-rate excess", () => {
    const invalid = new FakeWebSocket();
    createHandle(invalid);
    invalid.text(startMessage());
    const wrongVersion = audioFrame(1, new Uint8Array(2));
    wrongVersion.writeUInt8(2, 0);
    invalid.binary(wrongVersion);
    expect(invalid.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);

    const flooded = new FakeWebSocket();
    new WebClientAudioCallHandle({
      socket: flooded,
      callId: "call_web" as CallId,
      sessionId: "session_web" as SessionId,
      maxInputBytesPerSecond: 1,
    });
    flooded.text(startMessage());
    flooded.binary(audioFrame(1, new Uint8Array(4)));
    expect(flooded.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("rejects a session.start mode that conflicts with the authenticated mode", () => {
    const socket = new FakeWebSocket();
    new WebClientAudioCallHandle({
      socket,
      callId: "call_web" as CallId,
      sessionId: "session_web" as SessionId,
      expectedMode: "push_to_talk",
    });
    socket.text(
      JSON.stringify({
        type: "session.start",
        protocolVersion: 1,
        mode: "continuous",
        audioFormat: PCM16_16K_MONO,
      }),
    );
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
  });

  it("round-trips playout acknowledgement and resolves pending marks false on drop", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());
    const ack = handle.confirmPlayout("commit_1", 1_000);
    socket.text(JSON.stringify({ type: "output.playout_ack", commitId: "commit_1" }));
    await expect(ack).resolves.toBe(true);

    const pending = handle.confirmPlayout("commit_2", 1_000);
    socket.drop();
    await expect(pending).resolves.toBe(false);
  });

  it("sends output.commit before resolving its matching acknowledgement", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());
    await expect(handle.send(outputCommit("commit_1"))).resolves.toBe(true);
    expect(socket.json()).toContainEqual(
      expect.objectContaining({ type: "output.commit", commitId: "commit_1" }),
    );
    const confirmed = handle.confirmPlayout("commit_1", 1_000);
    socket.text(JSON.stringify({ type: "output.playout_ack", commitId: "commit_1" }));
    await expect(confirmed).resolves.toBe(true);
  });

  it("closes after 10 seconds without ping or audio and treats audio as activity", () => {
    vi.useFakeTimers();
    try {
      const idle = new FakeWebSocket();
      createHandle(idle, { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 10_000 });
      idle.text(startMessage());
      vi.advanceTimersByTime(10_000);
      expect(idle.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout);

      const active = new FakeWebSocket();
      createHandle(active, { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 10_000 });
      active.text(startMessage());
      vi.advanceTimersByTime(9_000);
      active.binary(audioFrame(1, new Uint8Array(640)));
      vi.advanceTimersByTime(9_000);
      expect(active.closedWith).toBeUndefined();
      vi.advanceTimersByTime(1_000);
      expect(active.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advertises the specified heartbeat and 45-minute default duration", () => {
    const socket = new FakeWebSocket();
    createHandle(socket);
    socket.text(startMessage());
    expect(socket.json()[0]).toEqual(
      expect.objectContaining({
        heartbeatIntervalMs: WEB_CLIENT_AUDIO_DEFAULTS.heartbeatIntervalMs,
        maxSessionDurationMs: 45 * 60_000,
      }),
    );
  });

  it("reports required lifecycle events and swallows observer errors", () => {
    const events: ConnectionObservabilityEvent[] = [];
    const socket = new FakeWebSocket();
    const handle = createHandle(socket, {
      onConnectionEvent(event) {
        events.push(event);
        throw new Error("observer failed");
      },
    });
    expect(() => socket.text(startMessage())).not.toThrow();
    expect(() => handle.terminate(4500, "operator terminated")).not.toThrow();
    expect(events).toEqual([
      expect.objectContaining({ type: "session_started" }),
      expect.objectContaining({
        type: "session_ended",
        closeCode: 4500,
        reason: "operator terminated",
      }),
    ]);
  });

  it("hangup and supersede close live handles with their assigned codes", async () => {
    const provider = createWebClientAudioProvider({ heartbeatIntervalMs: 60_000 });
    const terminated = new FakeWebSocket();
    await provider.acceptWebSocket(
      terminated,
      "call_terminated" as CallId,
      "session_terminated" as SessionId,
    );
    await provider.hangup("call_terminated" as CallId);
    expect(terminated.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated);

    const superseded = new FakeWebSocket();
    await provider.acceptWebSocket(
      superseded,
      "call_superseded" as CallId,
      "session_superseded" as SessionId,
    );
    await provider.supersede("call_superseded" as CallId);
    expect(superseded.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded);
  });

  it("enforces maximum session duration", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      createHandle(socket, { maxSessionDurationMs: 50 });
      socket.text(startMessage());
      vi.advanceTimersByTime(50);
      expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.maxDuration);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHandle(
  socket: FakeWebSocket,
  options: Pick<
    ConstructorParameters<typeof WebClientAudioCallHandle>[0],
    | "heartbeatIntervalMs"
    | "heartbeatTimeoutMs"
    | "maxBinaryFrameBytes"
    | "maxSessionDurationMs"
    | "onConnectionEvent"
  > = {},
): WebClientAudioCallHandle {
  return new WebClientAudioCallHandle({
    socket,
    callId: "call_web" as CallId,
    sessionId: "session_web" as SessionId,
    ...options,
  });
}

function outputCommit(id: string): OutputMediaEvent {
  return {
    id: id as MediaEventId,
    type: "media.audio.committed",
    sessionId: "session_web" as SessionId,
    callId: "call_web" as CallId,
    sequence: 1,
    direction: "output",
    timestamp: "2026-07-31T00:00:00.000Z" as Timestamp,
    monotonicOffsetMs: 0,
    durationMs: 20,
    frameCount: 320,
    chunkIds: ["chunk_1" as MediaEventId],
    sequenceRange: [1, 1],
  };
}

function startMessage(format: AudioFormat = PCM16_16K_MONO): string {
  return JSON.stringify({
    type: "session.start",
    protocolVersion: 1,
    mode: "push_to_talk",
    clientPlatform: "test",
    audioFormat: format,
  });
}

function audioFrame(sequence: number, payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(12 + payload.byteLength);
  frame.writeUInt8(1, 0);
  frame.writeUInt32LE(sequence, 2);
  Buffer.from(payload).copy(frame, 12);
  return frame;
}

class FakeWebSocket implements WebClientAudioSocket {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<string | Buffer> = [];
  closedWith: { code?: number; reason?: string } | undefined;
  readonly #messageHandlers: Array<(data: WebSocket.RawData, isBinary: boolean) => void> = [];
  readonly #closeHandlers: Array<(code: number, reason: Buffer) => void> = [];
  readonly #errorHandlers: Array<(error: Error) => void> = [];

  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSED;
    this.closedWith = { ...(code !== undefined ? { code } : {}), ...(reason ? { reason } : {}) };
    for (const handler of this.#closeHandlers) handler(code ?? 1000, Buffer.from(reason ?? ""));
  }
  on(event: "message", handler: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: "close", handler: (code: number, reason: Buffer) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(
    event: string,
    handler:
      | ((data: WebSocket.RawData, isBinary: boolean) => void)
      | ((code: number, reason: Buffer) => void)
      | ((error: Error) => void),
  ): this {
    if (event === "message")
      this.#messageHandlers.push(handler as (data: WebSocket.RawData, isBinary: boolean) => void);
    else if (event === "close")
      this.#closeHandlers.push(handler as (code: number, reason: Buffer) => void);
    else this.#errorHandlers.push(handler as (error: Error) => void);
    return this;
  }
  text(value: string): void {
    for (const handler of this.#messageHandlers) handler(Buffer.from(value), false);
  }
  binary(value: Buffer): void {
    for (const handler of this.#messageHandlers) handler(value, true);
  }
  raw(value: WebSocket.RawData, isBinary: boolean): void {
    for (const handler of this.#messageHandlers) handler(value, isBinary);
  }
  drop(): void {
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.#closeHandlers) handler(1006, Buffer.from("dropped"));
  }
  json(): unknown[] {
    return this.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as unknown);
  }
}
