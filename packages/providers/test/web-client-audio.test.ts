import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  createMediaEvent,
  isNormalizedError,
  isTvicError,
  PCM16_16K_MONO,
  TVIC_ERROR_CODES,
} from "@tvic/core";
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
import {
  PROVIDER_OUTBOUND_HARD_LIMIT_BYTES,
  PROVIDER_OUTBOUND_HIGH_WATER_BYTES,
} from "../src/common.js";

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

  it("normalizes fragmented RawData before parsing", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    const iterator = handle.events[Symbol.asyncIterator]();
    const start = Buffer.from(startMessage());
    socket.raw([start.subarray(0, 7), start.subarray(7)], false);
    const frame = audioFrame(1, new Uint8Array(640));
    socket.raw([frame.subarray(0, 9), frame.subarray(9)], true);

    expect((await iterator.next()).value?.type).toBe("media.stream.started");
    expect((await iterator.next()).value?.type).toBe("media.audio.chunk");
    expect(socket.closedWith).toBeUndefined();
  });

  it("surfaces malformed JSON as media.error without throwing", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    const next = handle.events[Symbol.asyncIterator]().next();
    socket.text("{");
    const event = (await next).value;
    expect(event).toMatchObject({ type: "media.error", kind: "lifecycle" });
    if (event?.type !== "media.error") throw new Error("expected media.error");
    expect(isNormalizedError(event.error)).toBe(true);
    expect(isTvicError(event.error)).toBe(false);
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
  });

  it("closes on an unknown control message instead of continuing the session", () => {
    const socket = new FakeWebSocket();
    createHandle(socket);
    socket.text(startMessage());
    socket.text(JSON.stringify({ type: "provider.secret_control" }));
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
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

  it("bounds small control-frame floods independently of the audio budget", () => {
    const socket = new FakeWebSocket();
    createHandle(socket, {
      clock: {
        now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
        monotonicNowMs: () => 0,
      },
    });
    socket.text(startMessage());
    for (let index = 0; index < 100; index += 1) {
      socket.text(JSON.stringify({ type: "client.ping", nonce: index }));
    }
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("does not let rapid client pings reset the inactivity timeout", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      let monotonicNowMs = 0;
      let wallNowMs = 0;
      createHandle(socket, {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 2_000,
        maxSessionDurationMs: 5_000,
        nowMs: () => wallNowMs,
        clock: {
          now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
          monotonicNowMs: () => monotonicNowMs,
        },
      });
      socket.text(startMessage());
      socket.text(JSON.stringify({ type: "client.ping", nonce: "first" }));
      monotonicNowMs = 500;
      wallNowMs = 500;
      socket.text(JSON.stringify({ type: "client.ping", nonce: "too_soon" }));

      monotonicNowMs = 2_000;
      wallNowMs = 2_000;
      vi.advanceTimersByTime(2_000);

      expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid configured binary frame limits", () => {
    for (const maxBinaryFrameBytes of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      1,
      12,
      13,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => createHandle(new FakeWebSocket(), { maxBinaryFrameBytes })).toThrow(RangeError);
    }
  });

  it("rejects an invalid configured pending acknowledgement limit", () => {
    expect(() => createHandle(new FakeWebSocket(), { maxPendingAcks: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it("rejects an unbounded configured inbound event queue", () => {
    expect(() =>
      createHandle(new FakeWebSocket(), { maxPendingEvents: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
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

  it("rejects empty audio and bounds tiny-frame floods", () => {
    const empty = new FakeWebSocket();
    createHandle(empty);
    empty.text(startMessage());
    empty.binary(audioFrame(1, new Uint8Array(0)));
    expect(empty.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);

    const flooded = new FakeWebSocket();
    createHandle(flooded, { maxInputFramesPerSecond: 1 });
    flooded.text(startMessage());
    flooded.binary(audioFrame(1, new Uint8Array(2)));
    flooded.binary(audioFrame(2, new Uint8Array(2)));
    flooded.binary(audioFrame(3, new Uint8Array(2)));
    expect(flooded.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("rejects unsafe input rate ceilings before accepting a call", () => {
    for (const rateLimit of [
      { maxInputBytesPerSecond: Number.NaN },
      { maxInputBytesPerSecond: Number.POSITIVE_INFINITY },
      { maxInputBytesPerSecond: Number.MAX_VALUE },
      { maxInputFramesPerSecond: Number.NaN },
      { maxInputFramesPerSecond: Number.POSITIVE_INFINITY },
      { maxInputFramesPerSecond: Number.MAX_VALUE },
    ]) {
      expect(() => createHandle(new FakeWebSocket(), rateLimit)).toThrow(RangeError);
    }
  });

  it("accepts the configured 200-frame rate at the exact window boundary", () => {
    const socket = new FakeWebSocket();
    let monotonicNowMs = 0;
    const payload = new Uint8Array(640);
    createHandle(socket, {
      clock: {
        now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
        monotonicNowMs: () => monotonicNowMs,
      },
    });
    socket.text(startMessage());

    for (let sequence = 1; sequence <= 401; sequence += 1) {
      monotonicNowMs = (sequence - 1) * 5;
      socket.binary(audioFrame(sequence, payload));
    }
    expect(socket.closedWith).toBeUndefined();

    socket.binary(audioFrame(402, payload));
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("keeps input rate limits stable when the wall clock jumps forward", () => {
    const socket = new FakeWebSocket();
    let monotonicNowMs = 0;
    let wallNowMs = 0;
    createHandle(socket, {
      maxInputFramesPerSecond: 1,
      clock: {
        now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
        monotonicNowMs: () => monotonicNowMs,
      },
      nowMs: () => wallNowMs,
    });
    socket.text(startMessage());
    socket.binary(audioFrame(1, new Uint8Array(2)));
    monotonicNowMs = 5;
    wallNowMs = 5;
    socket.binary(audioFrame(2, new Uint8Array(2)));
    monotonicNowMs = 10;
    wallNowMs = 10_000;
    socket.binary(audioFrame(3, new Uint8Array(2)));

    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("closes when the inbound event queue reaches its bound", () => {
    const socket = new FakeWebSocket();
    createHandle(socket, { maxPendingEvents: 2 });
    socket.text(startMessage());
    socket.text(JSON.stringify({ type: "turn.end" }));
    socket.text(JSON.stringify({ type: "client.interrupt" }));
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
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
    await expect(handle.send(outputAudio(PCM16_16K_MONO))).resolves.toBe(true);
    await expect(handle.send(outputCommit("commit_1"))).resolves.toBe(true);
    const ack = handle.confirmPlayout("commit_1", 1_000);
    socket.text(JSON.stringify({ type: "output.playout_ack", commitId: "commit_1" }));
    await expect(ack).resolves.toBe(true);

    await expect(handle.send(outputAudio(PCM16_16K_MONO))).resolves.toBe(true);
    await expect(handle.send(outputCommit("commit_2"))).resolves.toBe(true);
    const pending = handle.confirmPlayout("commit_2", 1_000);
    socket.drop();
    await expect(pending).resolves.toBe(false);
  });

  it("continues to accept playout acknowledgements after inbound media ends", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());
    await handle.endInput?.("completed");
    expect(socket.json()).toContainEqual({ type: "input.closed", reason: "completed" });

    await expect(handle.send(outputAudio(PCM16_16K_MONO))).resolves.toBe(true);
    await expect(handle.send(outputCommit("final_turn"))).resolves.toBe(true);
    const ack = handle.confirmPlayout("final_turn", 1_000);
    socket.text(JSON.stringify({ type: "output.playout_ack", commitId: "final_turn" }));
    await expect(ack).resolves.toBe(true);
    await handle.close("completed");
  });

  it("does not expose stream.started when session.ready is not accepted", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    const iterator = handle.events[Symbol.asyncIterator]();
    socket.send = () => {
      throw new Error("ready write failed");
    };

    socket.text(startMessage());

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "media.error",
        error: { code: TVIC_ERROR_CODES.providerTransportWriteFailed },
      },
      done: false,
    });
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("reports canonical clear write failures and closes the session", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());
    socket.send = () => {
      throw new Error("clear write failed");
    };

    await expect(handle.clear()).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerTransportWriteFailed,
      provider: "web-client-audio",
      retriable: false,
    });
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
  });

  it("only admits issued contiguous output ranges and caps pending acknowledgements", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());

    await expect(handle.send(outputAudio(PCM16_16K_MONO, 1, "audio_1"))).resolves.toBe(true);
    await expect(handle.send(outputAudio(PCM16_16K_MONO, 1, "duplicate"))).resolves.toBe(false);
    await expect(handle.send(outputAudio(PCM16_16K_MONO, 3, "skipped"))).resolves.toBe(false);
    await expect(handle.send(outputCommit("commit_invalid", [1, 2]))).resolves.toBe(false);
    await expect(handle.send(outputAudio(PCM16_16K_MONO, 2, "audio_2"))).resolves.toBe(true);
    await expect(handle.send(outputCommit("commit_1", [1, 2]))).resolves.toBe(true);

    await expect(handle.send(outputAudio(PCM16_16K_MONO, 1, "audio_after_commit"))).resolves.toBe(
      true,
    );
    await expect(handle.send(outputCommit("commit_after_commit", [1, 1]))).resolves.toBe(true);

    const boundedSocket = new FakeWebSocket();
    const bounded = createHandle(boundedSocket, { maxPendingAcks: 1_000 });
    boundedSocket.text(startMessage());
    for (let index = 0; index < 128; index += 1) {
      await expect(
        bounded.send(outputAudio(PCM16_16K_MONO, 1, `bounded_audio_${index}`)),
      ).resolves.toBe(true);
      await expect(bounded.send(outputCommit(`bounded_commit_${index}`, [1, 1]))).resolves.toBe(
        true,
      );
    }
    await expect(
      bounded.send(outputAudio(PCM16_16K_MONO, 1, "bounded_overflow_audio")),
    ).resolves.toBe(true);
    await expect(bounded.send(outputCommit("bounded_overflow", [1, 1]))).resolves.toBe(false);
    expect(boundedSocket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("normalizes invalid output media and unsupported provider operations", async () => {
    const handle = createHandle(new FakeWebSocket());
    await expect(
      handle.send(outputAudio({ ...PCM16_16K_MONO, sampleRateHz: 8_000 })),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "web_client_audio.output_format_invalid",
      category: "validation",
    });

    const provider = createWebClientAudioProvider();
    await expect(provider.dial()).rejects.toMatchObject({
      name: "ProviderError",
      code: "web_client_audio.dial_unsupported",
      category: "provider",
    });
    await expect(
      provider.accept({ call: { id: "call_missing" as CallId } } as never),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "web_client_audio.socket_missing",
      category: "provider",
    });
  });

  it("rejects a pending socket when the runtime session identity differs", async () => {
    const provider = createWebClientAudioProvider();
    const socket = new FakeWebSocket();
    const callId = "call_session_mismatch" as CallId;
    provider.attachWebSocket(socket, callId, "pending_session" as SessionId);

    await expect(
      provider.accept({ call: { id: callId, sessionId: "runtime_session" as SessionId } } as never),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider.identity_mismatch",
      category: "provider",
    });
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol);
  });

  it("sends output.commit before resolving its matching acknowledgement", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());
    await expect(handle.send(outputAudio(PCM16_16K_MONO))).resolves.toBe(true);
    await expect(handle.send(outputCommit("commit_1"))).resolves.toBe(true);
    expect(socket.json()).toContainEqual(
      expect.objectContaining({ type: "output.commit", commitId: "commit_1" }),
    );
    const confirmed = handle.confirmPlayout("commit_1", 1_000);
    socket.text(JSON.stringify({ type: "output.playout_ack", commitId: "commit_1" }));
    await expect(confirmed).resolves.toBe(true);
  });

  it("keeps the transmitted frame independent from caller-owned audio bytes", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    const original = new Uint8Array([1, 2, 3, 4]);
    const event = outputAudio(PCM16_16K_MONO, 1, "owned_audio", original);
    if (event.type !== "media.audio.chunk") throw new Error("expected audio event");

    await expect(handle.send(event)).resolves.toBe(true);
    const sentFrame = socket.sent.find((item): item is Buffer => Buffer.isBuffer(item));
    event.audio.bytes.fill(0);

    expect(sentFrame?.subarray(12)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("reports terminal delivery failure when the socket is already closed", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.readyState = WebSocket.CLOSED;
    await expect(handle.send(outputStreamEnded())).resolves.toBe(false);
  });

  it("closes when outbound pressure reaches the high-water mark", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());

    socket.bufferedAmount = PROVIDER_OUTBOUND_HIGH_WATER_BYTES;
    await expect(handle.send(outputAudio(PCM16_16K_MONO))).resolves.toBe(false);
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);

    expect(socket.sent.filter((item) => Buffer.isBuffer(item))).toHaveLength(0);
    socket.bufferedAmount = PROVIDER_OUTBOUND_HARD_LIMIT_BYTES;
    await expect(handle.send(outputAudio(PCM16_16K_MONO))).resolves.toBe(false);
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);
  });

  it("ignores acknowledgements for commits the server did not issue", async () => {
    const socket = new FakeWebSocket();
    const handle = createHandle(socket);
    socket.text(startMessage());
    socket.text(JSON.stringify({ type: "output.playout_ack", commitId: "forged" }));
    await expect(handle.confirmPlayout("forged", 1_000)).resolves.toBe(false);
  });

  it("closes after 10 seconds without ping or audio and treats audio as activity", () => {
    vi.useFakeTimers();
    try {
      const idle = new FakeWebSocket();
      createHandle(idle, {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 10_000,
        clock: {
          now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
          monotonicNowMs: () => Date.now(),
        },
      });
      idle.text(startMessage());
      vi.advanceTimersByTime(10_000);
      expect(idle.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout);

      const active = new FakeWebSocket();
      createHandle(active, {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 10_000,
        clock: {
          now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
          monotonicNowMs: () => Date.now(),
        },
      });
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

  it("uses monotonic time for inactivity despite wall-clock jumps", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      let monotonicNowMs = 0;
      let wallNowMs = 0;
      createHandle(socket, {
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 2_000,
        nowMs: () => wallNowMs,
        clock: {
          now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
          monotonicNowMs: () => monotonicNowMs,
        },
      });
      socket.text(startMessage());

      monotonicNowMs = 500;
      wallNowMs = 10_000;
      vi.advanceTimersByTime(1_000);
      expect(socket.closedWith).toBeUndefined();

      monotonicNowMs = 2_000;
      wallNowMs = -10_000;
      vi.advanceTimersByTime(1_000);
      expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the full inactivity grace period when session.start is accepted", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      createHandle(socket, {
        clock: {
          now: () => "2026-07-31T00:00:00.000Z" as Timestamp,
          monotonicNowMs: () => Date.now(),
        },
      });
      vi.advanceTimersByTime(9_000);
      socket.text(startMessage());

      vi.advanceTimersByTime(WEB_CLIENT_AUDIO_DEFAULTS.heartbeatIntervalMs);
      expect(socket.closedWith).toBeUndefined();
      vi.advanceTimersByTime(WEB_CLIENT_AUDIO_DEFAULTS.heartbeatTimeoutMs);
      expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsafe or contradictory heartbeat timing options", () => {
    for (const options of [
      { heartbeatIntervalMs: Number.NaN },
      { heartbeatIntervalMs: 99 },
      { heartbeatIntervalMs: 60_001 },
      { heartbeatTimeoutMs: Number.POSITIVE_INFINITY },
      { heartbeatTimeoutMs: 199 },
      { heartbeatTimeoutMs: 120_001 },
      { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 1_000 },
      { heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 10_000 },
    ]) {
      expect(() => createHandle(new FakeWebSocket(), options)).toThrow(RangeError);
    }
  });

  it("rejects input budgets and event queues above their hard bounds", () => {
    for (const options of [
      { maxInputBytesPerSecond: 1_000_001 },
      { maxInputFramesPerSecond: 1_001 },
      { maxPendingEvents: 2_049 },
    ]) {
      expect(() => createHandle(new FakeWebSocket(), options)).toThrow(RangeError);
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
    const provider = createWebClientAudioProvider({
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
    });
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

  it("supersedes a live connection without letting the old connection remove its replacement", async () => {
    const provider = createWebClientAudioProvider({
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 120_000,
    });
    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    const callId = "call_live_replaced" as CallId;
    await provider.acceptWebSocket(first, callId, "session_first" as SessionId);
    await provider.acceptWebSocket(second, callId, "session_second" as SessionId);

    expect(first.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded);
    await provider.hangup(callId);
    expect(second.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated);
  });

  it("validates provider options before accepting sessions", () => {
    expect(() => createWebClientAudioProvider({ heartbeatIntervalMs: 99 })).toThrow(RangeError);
  });

  it("rejects session durations outside Node's timer-safe range", () => {
    for (const maxSessionDurationMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      1.5,
      2_147_483_648,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => createWebClientAudioProvider({ maxSessionDurationMs })).toThrow(RangeError);
    }

    expect(() =>
      createWebClientAudioProvider({ maxSessionDurationMs: 2_147_483_647 }),
    ).not.toThrow();
  });

  it("drops an unattached pending socket when its transport closes", async () => {
    const provider = createWebClientAudioProvider();
    const socket = new FakeWebSocket();
    const callId = "call_pending" as CallId;
    provider.attachWebSocket(socket, callId, "session_pending" as SessionId);
    socket.drop();

    await expect(
      provider.accept({ call: { id: callId, sessionId: "session_pending" as SessionId } } as never),
    ).rejects.toThrow("No attached socket");
  });

  it("does not retain already-closed or replaced pending sockets", async () => {
    const provider = createWebClientAudioProvider();
    const alreadyClosed = new FakeWebSocket();
    alreadyClosed.drop();
    provider.attachWebSocket(alreadyClosed, "call_closed" as CallId, "session_closed" as SessionId);
    await expect(
      provider.accept({ call: { id: "call_closed" as CallId } } as never),
    ).rejects.toThrow("No attached socket");

    const first = new FakeWebSocket();
    const second = new FakeWebSocket();
    const callId = "call_replaced" as CallId;
    provider.attachWebSocket(first, callId, "session_first" as SessionId);
    provider.attachWebSocket(second, callId, "session_second" as SessionId);
    expect(first.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded);
    await provider.supersede(callId);
    expect(second.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded);
  });

  it("closes pending sockets during hangup", async () => {
    const provider = createWebClientAudioProvider();
    const socket = new FakeWebSocket();
    const callId = "call_pending_hangup" as CallId;
    provider.attachWebSocket(socket, callId, "session_pending_hangup" as SessionId);
    await provider.hangup(callId);
    expect(socket.closedWith?.code).toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated);
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

  it("uses the resolved session duration after the caller mutates its options", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeWebSocket();
      const options = {
        socket,
        callId: "call_web" as CallId,
        sessionId: "session_web" as SessionId,
        maxSessionDurationMs: 50,
      };
      new WebClientAudioCallHandle(options);
      options.maxSessionDurationMs = 1_000;

      socket.text(startMessage());
      expect(socket.json()[0]).toEqual(expect.objectContaining({ maxSessionDurationMs: 50 }));
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
    | "maxInputBytesPerSecond"
    | "maxSessionDurationMs"
    | "maxInputFramesPerSecond"
    | "maxPendingEvents"
    | "maxPendingAcks"
    | "clock"
    | "nowMs"
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

function outputCommit(
  id: string,
  sequenceRange: readonly [number, number] = [1, 1],
): OutputMediaEvent {
  return createMediaEvent({
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
    sequenceRange,
  });
}

function outputAudio(
  format: AudioFormat = PCM16_16K_MONO,
  sequence = 1,
  id = "audio_1",
  bytes: Uint8Array = new Uint8Array(2),
): OutputMediaEvent {
  return createMediaEvent({
    id: id as MediaEventId,
    type: "media.audio.chunk",
    sessionId: "session_web" as SessionId,
    callId: "call_web" as CallId,
    sequence,
    direction: "output",
    timestamp: "2026-07-31T00:00:00.000Z" as Timestamp,
    monotonicOffsetMs: 0,
    audio: { format, bytes, durationMs: 0, frameCount: 0 },
  });
}

function outputStreamEnded(): OutputMediaEvent {
  return createMediaEvent({
    id: "stream_end" as MediaEventId,
    type: "media.stream.ended",
    sessionId: "session_web" as SessionId,
    callId: "call_web" as CallId,
    sequence: 1,
    direction: "output",
    timestamp: "2026-07-31T00:00:00.000Z" as Timestamp,
    monotonicOffsetMs: 0,
    reason: "completed",
    durationMs: 0,
  });
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
  bufferedAmount = 0;
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
