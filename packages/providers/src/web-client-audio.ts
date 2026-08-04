import WebSocket from "ws";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  sameAudioFormat,
} from "@tvic/core";
import type {
  AudioFormat,
  CallHandle,
  CallId,
  CounterIdGenerator,
  InboundMediaEvent,
  InputMediaEvent,
  MediaEventId,
  OutputMediaEvent,
  ProviderCapabilities,
  SessionId,
  StreamEndReason,
  TelephonyProvider,
  TurnId,
} from "@tvic/core";
import { durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import { AsyncQueue } from "./async-queue.js";
import {
  SystemProviderClock,
  parseJsonObject,
  providerError,
  safeSend,
  unknownErrorMessage,
  type ProviderClock,
} from "./common.js";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

export const WEB_CLIENT_AUDIO_CLOSE_CODES = {
  protocol: 4400,
  heartbeatTimeout: 4408,
  superseded: 4409,
  maxDuration: 4410,
  resourceLimit: 4413,
  operatorTerminated: 4500,
} as const;

export const WEB_CLIENT_AUDIO_DEFAULTS = {
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  maxSessionDurationMs: 45 * 60_000,
} as const;

export interface WebClientAudioSocket {
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: "close", handler: (code: number, reason: Buffer) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
}

export type ConnectionObservabilityEvent =
  | {
      readonly type: "session_started";
      readonly callId: CallId;
      readonly sessionId: SessionId;
    }
  | {
      readonly type: "session_ended";
      readonly callId: CallId;
      readonly sessionId: SessionId;
      readonly closeCode: number;
      readonly reason: string;
    }
  | { readonly type: "auth_rejected"; readonly reason: string }
  | {
      readonly type: "reconnect_detected";
      readonly sessionRef: string;
      readonly supersedes: string;
    };

export type WebClientAudioConnectionEvent = ConnectionObservabilityEvent;

export interface WebClientAudioCallHandleOptions {
  readonly socket: WebClientAudioSocket;
  readonly callId: CallId;
  readonly sessionId: SessionId;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxBinaryFrameBytes?: number;
  readonly maxInputBytesPerSecond?: number;
  readonly expectedMode?: "push_to_talk" | "continuous";
  readonly clock?: ProviderClock;
  readonly nowMs?: () => number;
  readonly onConnectionEvent?: (event: ConnectionObservabilityEvent) => void;
  readonly onClosed?: () => void;
}

export class WebClientAudioCallHandle implements CallHandle {
  readonly callId: CallId;
  readonly events: AsyncIterable<InboundMediaEvent>;
  readonly #options: WebClientAudioCallHandleOptions;
  readonly #socket: WebClientAudioSocket;
  readonly #events = new AsyncQueue<InboundMediaEvent>();
  readonly #clock: ProviderClock;
  readonly #ids: CounterIdGenerator<MediaEventId> =
    counterIdGenerator<MediaEventId>("web_audio_event");
  readonly #acked = new Set<string>();
  readonly #waiters = new Map<string, Set<(acked: boolean) => void>>();
  readonly #rateSamples: Array<{ at: number; bytes: number }> = [];
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #nowMs: () => number;
  readonly #maxBinaryFrameBytes: number;
  readonly #maxInputBytesPerSecond: number;
  #mode: "push_to_talk" | "continuous" | null = null;
  #started = false;
  #closed = false;
  #lastActivityAt: number;
  #lastInputSequence = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WebClientAudioCallHandleOptions) {
    this.#options = options;
    this.callId = options.callId;
    this.#socket = options.socket;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#nowMs = options.nowMs ?? Date.now;
    this.#lastActivityAt = this.#nowMs();
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? WEB_CLIENT_AUDIO_DEFAULTS.heartbeatIntervalMs;
    this.#heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? WEB_CLIENT_AUDIO_DEFAULTS.heartbeatTimeoutMs;
    this.#maxBinaryFrameBytes = options.maxBinaryFrameBytes ?? 65_536;
    this.#maxInputBytesPerSecond = options.maxInputBytesPerSecond ?? 128_000;
    this.events = this.#events;
    this.#socket.on("message", (data, isBinary) => this.#handleFrame(data, isBinary));
    this.#socket.on("close", (code, reason) => this.#closeEvents(code, reason.toString("utf8")));
    this.#socket.on("error", (error) => {
      this.#events.push(this.#mediaError(error));
      this.#closeEvents(1006, error.message);
    });
    if (this.#socket.readyState !== WebSocket.OPEN) {
      queueMicrotask(() => this.#closeEvents(1006, "socket not open"));
    }
    this.#startTimer = setTimeout(
      () => this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout, "session.start timeout"),
      this.#heartbeatTimeoutMs,
    );
  }

  async send(event: OutputMediaEvent): Promise<boolean> {
    if (this.#closed) return false;
    if (event.type === "media.audio.chunk") {
      if (!sameAudioFormat(event.audio.format, PCM16_16K_MONO)) {
        throw new Error("Web client audio output must be PCM16 16kHz mono");
      }
      const payload = Buffer.from(event.audio.data.bytes);
      const frame = Buffer.allocUnsafe(12 + payload.byteLength);
      frame.writeUInt8(1, 0);
      frame.writeUInt8(0, 1);
      frame.writeUInt32LE(event.sequence, 2);
      frame.writeUInt32LE(Math.max(0, Math.floor(event.monotonicOffsetMs)), 6);
      frame.writeUInt16LE(0, 10);
      payload.copy(frame, 12);
      return safeSend(this.#socket, frame);
    }
    if (event.type === "media.audio.committed") {
      return this.#sendJson({
        type: "output.commit",
        commitId: String(event.id),
        sequenceRange: event.sequenceRange,
      });
    }
    if (event.type === "media.stream.ended" || event.type === "media.error") {
      await this.close(event.type === "media.error" ? "error" : event.reason);
    }
    return true;
  }

  async deliverText(turnId: TurnId, sequence: number, text: string): Promise<boolean> {
    return this.#sendJson({ type: "assistant.text", turnId, sequence, text });
  }

  async clear(): Promise<void> {
    this.#sendJson({ type: "output.clear" });
  }

  async close(reason: StreamEndReason): Promise<void> {
    this.#sendJson({ type: "session.ended", reason });
    this.terminate(1000, reason);
  }

  terminate(code: number, reason: string): void {
    if (this.#closed) return;
    try {
      this.#socket.close(code, reason);
    } catch {
      // Socket teardown is best-effort.
    }
    this.#closeEvents(code, reason);
  }

  async confirmPlayout(markId: string, timeoutMs: number): Promise<boolean> {
    if (this.#acked.has(markId)) return true;
    if (this.#closed) return false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (acked: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.get(markId)?.delete(finish);
        resolve(acked);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const waiters = this.#waiters.get(markId) ?? new Set();
      waiters.add(finish);
      this.#waiters.set(markId, waiters);
    });
  }

  #handleFrame(raw: WebSocket.RawData, isBinary: boolean): void {
    let data: Buffer;
    try {
      data = rawDataBuffer(raw);
    } catch (error) {
      this.#protocolError(unknownErrorMessage(error));
      return;
    }
    if (isBinary) {
      this.#handleAudio(data);
      return;
    }
    if (data.byteLength > 4096) {
      this.#limit("control frame exceeds 4096 bytes");
      return;
    }
    const message = parseJsonObject(data.toString("utf8"));
    if (!message || typeof message.type !== "string") {
      this.#events.push(this.#mediaError(new Error("Invalid web-client control frame")));
      return;
    }
    this.#handleControl(message);
  }

  #handleControl(message: Readonly<Record<string, unknown>>): void {
    if (!this.#started && message.type !== "session.start") {
      this.#protocolError("session.start must be the first control frame");
      return;
    }
    switch (message.type) {
      case "session.start": {
        if (
          this.#started ||
          message.protocolVersion !== 1 ||
          !isMode(message.mode) ||
          typeof message.clientPlatform !== "string" ||
          (this.#options.expectedMode !== undefined && message.mode !== this.#options.expectedMode)
        ) {
          this.#protocolError("Invalid session.start");
          return;
        }
        const format = parseAudioFormat(message.audioFormat);
        if (!format || !sameAudioFormat(format, PCM16_16K_MONO)) {
          this.#protocolError("Unsupported audio format");
          return;
        }
        this.#started = true;
        if (this.#startTimer) {
          clearTimeout(this.#startTimer);
          this.#startTimer = null;
        }
        this.#mode = message.mode;
        this.#events.push({
          ...this.#base("stream_started", 0),
          type: "media.stream.started",
          format: PCM16_16K_MONO,
        });
        this.#sendJson({
          type: "session.ready",
          sessionId: this.#options.sessionId,
          callId: this.callId,
          mode: this.#mode,
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
          maxSessionDurationMs:
            this.#options.maxSessionDurationMs ?? WEB_CLIENT_AUDIO_DEFAULTS.maxSessionDurationMs,
        });
        this.#startTimers();
        this.#observe({
          type: "session_started",
          callId: this.callId,
          sessionId: this.#options.sessionId,
        });
        return;
      }
      case "turn.end":
        if (this.#mode !== "push_to_talk") {
          this.#protocolError("turn.end requires push_to_talk mode");
          return;
        }
        this.#events.push({ ...this.#base("turn_commit", 0), type: "media.turn.commit_requested" });
        return;
      case "client.interrupt":
        this.#events.push({ ...this.#base("interrupt", 0), type: "media.interrupt.requested" });
        return;
      case "client.mute":
      case "client.unmute":
        return;
      case "client.ping":
        this.#lastActivityAt = this.#nowMs();
        this.#sendJson({ type: "server.pong", nonce: message.nonce });
        return;
      case "output.playout_ack":
        if (typeof message.commitId === "string") this.#resolveAck(message.commitId);
        return;
      case "session.end":
        this.#events.push({
          ...this.#base("stream_ended", 0),
          type: "media.stream.ended",
          reason: "remote_hangup",
          durationMs: 0,
        });
        this.terminate(1000, "session ended");
        return;
      default:
        this.#events.push(this.#mediaError(new Error(`Unknown control type ${message.type}`)));
    }
  }

  #handleAudio(data: Buffer): void {
    if (!this.#started) {
      this.#protocolError("Audio received before session.start");
      return;
    }
    if (data.byteLength > this.#maxBinaryFrameBytes) {
      this.#limit("binary frame too large");
      return;
    }
    if (
      data.byteLength < 12 ||
      data.readUInt8(0) !== 1 ||
      data.readUInt8(1) !== 0 ||
      data.readUInt16LE(10) !== 0 ||
      (data.byteLength - 12) % 2 !== 0
    ) {
      this.#protocolError("Invalid binary audio frame");
      return;
    }
    const payload = data.subarray(12);
    this.#lastActivityAt = this.#nowMs();
    if (!this.#acceptRate(payload.byteLength)) {
      this.#limit("input rate exceeded");
      return;
    }
    const sequence = data.readUInt32LE(2);
    if (sequence !== this.#lastInputSequence + 1) {
      this.#protocolError("Binary audio sequence must be contiguous and start at 1");
      return;
    }
    this.#lastInputSequence = sequence;
    this.#events.push({
      ...this.#base("audio", sequence),
      type: "media.audio.chunk",
      sequence,
      monotonicOffsetMs: data.readUInt32LE(6),
      audio: {
        format: PCM16_16K_MONO,
        durationMs: durationMsForPcm16le(payload, PCM16_16K_MONO.sampleRateHz),
        frameCount: frameCountForPcm16le(payload),
        data: { kind: "inline", bytes: new Uint8Array(payload) },
      },
    });
  }

  #acceptRate(bytes: number): boolean {
    const now = this.#nowMs();
    this.#rateSamples.push({ at: now, bytes });
    while ((this.#rateSamples[0]?.at ?? now) < now - 2000) this.#rateSamples.shift();
    return (
      this.#rateSamples.reduce((sum, item) => sum + item.bytes, 0) <=
      this.#maxInputBytesPerSecond * 2
    );
  }

  #startTimers(): void {
    this.#heartbeatTimer = setInterval(() => {
      if (this.#nowMs() - this.#lastActivityAt >= this.#heartbeatTimeoutMs) {
        this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
      }
    }, this.#heartbeatIntervalMs);
    this.#durationTimer = setTimeout(
      () => this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.maxDuration, "maximum session duration"),
      this.#options.maxSessionDurationMs ?? WEB_CLIENT_AUDIO_DEFAULTS.maxSessionDurationMs,
    );
  }

  #protocolError(message: string): void {
    this.#sendJson({ type: "session.error", code: "protocol_error", message });
    this.#events.push(this.#mediaError(new Error(message)));
    this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol, message);
  }

  #limit(message: string): void {
    this.#events.push(this.#mediaError(new Error(message)));
    this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit, message);
  }

  #sendJson(value: unknown): boolean {
    return safeSend(this.#socket, JSON.stringify(value));
  }

  #base(kind: string, sequence: number): Omit<InputMediaEvent, "type"> {
    return {
      // Counters are handle-local; callId keeps the resulting IDs collision-safe across calls.
      id: `${this.callId}_${this.#ids.next()}_${kind}` as MediaEventId,
      sessionId: this.#options.sessionId,
      callId: this.callId,
      sequence,
      direction: "input",
      timestamp: this.#clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.webClientAudio,
    };
  }

  #mediaError(error: unknown): InputMediaEvent {
    return {
      ...this.#base("error", 0),
      type: "media.error",
      error: providerError(PROVIDER_ERROR_CODES.webClientAudio, unknownErrorMessage(error), {
        category: "media",
        cause: error,
      }),
    };
  }

  #resolveAck(id: string): void {
    this.#acked.add(id);
    const waiters = this.#waiters.get(id);
    this.#waiters.delete(id);
    for (const waiter of waiters ?? []) waiter(true);
  }

  #observe(event: ConnectionObservabilityEvent): void {
    try {
      this.#options.onConnectionEvent?.(event);
    } catch {
      // Observation must not affect the connection.
    }
  }

  #closeEvents(closeCode = 1006, reason = "transport closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#durationTimer) clearTimeout(this.#durationTimer);
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#events.close();
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter(false);
    this.#waiters.clear();
    this.#observe({
      type: "session_ended",
      callId: this.callId,
      sessionId: this.#options.sessionId,
      closeCode,
      reason,
    });
    this.#options.onClosed?.();
  }
}

export interface WebClientAudioProviderOptions extends Omit<
  WebClientAudioCallHandleOptions,
  "socket" | "callId" | "sessionId" | "onClosed" | "expectedMode"
> {}

export class WebClientAudioProvider implements TelephonyProvider {
  readonly name = PROVIDER_NAMES.webClientAudio;
  readonly kind = "telephony";
  readonly version = "0.1.0";
  readonly capabilities = CAPABILITIES;
  readonly #options: WebClientAudioProviderOptions;
  readonly #pending = new Map<CallId, { socket: WebClientAudioSocket; sessionId: SessionId }>();
  readonly #live = new Map<CallId, WebClientAudioCallHandle>();

  constructor(options: WebClientAudioProviderOptions = {}) {
    this.#options = options;
  }

  async dial(): Promise<CallHandle> {
    throw new Error("Web client audio is accept-only");
  }

  async accept(ctx: Parameters<TelephonyProvider["accept"]>[0]): Promise<CallHandle> {
    const pending = this.#pending.get(ctx.call.id);
    const sessionId = pending?.sessionId ?? ctx.call.sessionId;
    if (!pending || !sessionId) throw new Error(`No attached socket for call ${ctx.call.id}`);
    this.#pending.delete(ctx.call.id);
    return this.acceptWebSocket(pending.socket, ctx.call.id, sessionId);
  }

  attachWebSocket(socket: WebClientAudioSocket, callId: CallId, sessionId: SessionId): void {
    this.#pending.set(callId, { socket, sessionId });
  }

  async acceptWebSocket(
    socket: WebClientAudioSocket,
    callId: CallId,
    sessionId: SessionId,
    connectionOptions: { readonly expectedMode?: "push_to_talk" | "continuous" } = {},
  ): Promise<WebClientAudioCallHandle> {
    const handle = new WebClientAudioCallHandle({
      ...this.#options,
      socket,
      callId,
      sessionId,
      ...connectionOptions,
      onClosed: () => this.#live.delete(callId),
    });
    this.#live.set(callId, handle);
    return handle;
  }

  async hangup(callId: CallId): Promise<void> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated, "terminated");
    this.#pending.delete(callId);
  }

  async supersede(callId: CallId): Promise<void> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded by reconnect");
    this.#pending.delete(callId);
  }
}

export function createWebClientAudioProvider(
  options: WebClientAudioProviderOptions = {},
): WebClientAudioProvider {
  return new WebClientAudioProvider(options);
}

function isMode(value: unknown): value is "push_to_talk" | "continuous" {
  return value === "push_to_talk" || value === "continuous";
}

function parseAudioFormat(value: unknown): AudioFormat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record.encoding !== "string" ||
    typeof record.sampleRateHz !== "number" ||
    typeof record.channels !== "number"
  )
    return null;
  return {
    encoding: record.encoding as AudioFormat["encoding"],
    sampleRateHz: record.sampleRateHz as AudioFormat["sampleRateHz"],
    channels: record.channels as 1 | 2,
  };
}

function rawDataBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  throw new Error("Unsupported WebSocket frame representation");
}
