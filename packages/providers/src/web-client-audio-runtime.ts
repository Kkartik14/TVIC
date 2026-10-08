import WebSocket from "ws";
import type {
  CallHandle,
  CallId,
  InboundMediaEvent,
  MediaEventId,
  OutputMediaEvent,
  ProviderCapabilities,
  SessionId,
  StreamEndReason,
  TelephonyProvider,
  Timestamp,
} from "@tvic/core";
import type {
  WebClientAudioCallHandleOptions,
  ConnectionObservabilityEvent,
  WebClientAudioProviderOptions,
  WebClientAudioSocket,
} from "./web-client-audio.js";
import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  createMediaEvent,
  mediaError,
  providerError,
  sameAudioFormat,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import { durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";
import { AsyncQueue } from "./async-queue.js";
import {
  SystemProviderClock,
  providerEventQueueOverflow,
  parseJsonObject,
  providerMonotonicNowMs,
  rawDataByteLength,
  rawDataToBuffer,
  providerSendCapacity,
  safeSend,
  unknownErrorMessage,
  type ProviderClock,
} from "./common.js";
import {
  closeSocket,
  isMode,
  MAX_WEB_AUDIO_SEQUENCE,
  MAX_WEB_CONTROL_FRAME_BYTES,
  normalizeSequenceRange,
  parseAudioFormat,
  PENDING_ACCEPT_TIMEOUT_MS,
  type WebClientAudioMode,
} from "./web-client-audio-protocol.js";
import {
  MAX_CONTROL_BYTES_PER_SECOND,
  MAX_CONTROL_FRAMES_PER_SECOND,
  resolveWebClientAudioLimits,
  WEB_CLIENT_AUDIO_DEFAULTS,
} from "./web-client-audio-limits.js";
import { WebClientAudioRateWindow } from "./web-client-audio-rate-window.js";

export { WEB_CLIENT_AUDIO_DEFAULTS };

type AckState = "pending" | "acked" | "timed_out";
interface AckRecord {
  state: AckState;
  expiresAt: number;
}
type AckWaiter = (acked: boolean) => void;
interface PendingSocket {
  readonly socket: WebClientAudioSocket;
  readonly sessionId: SessionId;
  readonly timer: ReturnType<typeof setTimeout>;
}

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} as const satisfies ProviderCapabilities;
export const WEB_CLIENT_AUDIO_CLOSE_CODES = {
  protocol: 4400,
  heartbeatTimeout: 4408,
  superseded: 4409,
  maxDuration: 4410,
  resourceLimit: 4413,
  operatorTerminated: 4500,
};
export const WEB_CLIENT_AUDIO_ACK_RETENTION_MS = 60_000;

/** @typedef {import("@tvic/core").InboundMediaEvent} InboundMediaEvent */
/** @typedef {import("./web-client-audio.js").WebClientAudioCallHandleOptions} WebClientAudioCallHandleOptions */
/** @typedef {import("./web-client-audio.js").WebClientAudioProviderOptions} WebClientAudioProviderOptions */

export class WebClientAudioCallHandle implements CallHandle {
  callId: CallId;
  events: AsyncIterable<InboundMediaEvent>;
  #options: WebClientAudioCallHandleOptions;
  #socket: WebClientAudioSocket;
  #events: AsyncQueue<InboundMediaEvent>;
  #clock: ProviderClock;
  #ids = counterIdGenerator<MediaEventId>("web_audio_event");
  #ackRecords = new Map<string, AckRecord>();
  #waiters = new Map<string, Set<AckWaiter>>();
  #inputRateWindow: WebClientAudioRateWindow;
  #controlRateWindow: WebClientAudioRateWindow;
  #heartbeatIntervalMs: number;
  #heartbeatTimeoutMs: number;
  #maxSessionDurationMs: number;
  #nowMs: () => number;
  #maxBinaryFrameBytes: number;
  #maxPendingAcks: number;
  #mode: WebClientAudioMode | null = null;
  #starting = false;
  #started = false;
  #inputFinished = false;
  #hostClosing = false;
  #localTermination = false;
  #closed = false;
  #remoteHangupSignaled = false;
  #resolveRemoteHangup!: () => void;
  readonly remoteHangup = new Promise<void>((resolve) => {
    this.#resolveRemoteHangup = resolve;
  });
  #lastActivityAtMonotonicMs: number;
  #lastAcceptedPingAtMonotonicMs = Number.NEGATIVE_INFINITY;
  #lastInputSequence = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #startTimer: ReturnType<typeof setTimeout> | null = null;
  #nextOutputSequence = 1;
  constructor(options: WebClientAudioCallHandleOptions) {
    this.#options = options;
    this.callId = options.callId;
    this.#socket = options.socket;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#nowMs = options.nowMs ?? Date.now;
    this.#lastActivityAtMonotonicMs = providerMonotonicNowMs(this.#clock);
    const limits = resolveWebClientAudioLimits(options);
    this.#heartbeatIntervalMs = limits.heartbeatIntervalMs;
    this.#heartbeatTimeoutMs = limits.heartbeatTimeoutMs;
    this.#maxSessionDurationMs = limits.maxSessionDurationMs;
    this.#maxBinaryFrameBytes = limits.maxBinaryFrameBytes;
    this.#inputRateWindow = new WebClientAudioRateWindow(
      limits.maxInputBytesPerSecond,
      limits.maxInputFramesPerSecond,
    );
    this.#controlRateWindow = new WebClientAudioRateWindow(
      MAX_CONTROL_BYTES_PER_SECOND,
      MAX_CONTROL_FRAMES_PER_SECOND,
    );
    this.#maxPendingAcks = limits.maxPendingAcks;
    this.#events = new AsyncQueue<InboundMediaEvent>({
      maxBuffered: limits.maxPendingEvents,
      onOverflow: () =>
        TvicThrowableError.from(
          mediaError(PROVIDER_ERROR_CODES.webClientAudio, "Input event queue exceeded its bound", {
            provider: PROVIDER_NAMES.webClientAudio,
          }),
        ),
    });
    this.events = this.#events;
    this.#startTimer = setTimeout(
      () => this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout, "session.start timeout"),
      this.#heartbeatTimeoutMs,
    );
    this.#socket.on("message", (data, isBinary) => this.#handleFrame(data, isBinary));
    this.#socket.on("close", (code, reason) =>
      this.#closeEvents(
        code,
        reason.toString("utf8"),
        !this.#hostClosing && !this.#localTermination,
      ),
    );
    this.#socket.on("error", (error) => {
      this.#signalRemoteHangup();
      this.#pushEvent(this.#mediaError(error));
      this.#closeEvents(1006, error.message);
    });
    if (this.#socket.readyState !== WebSocket.OPEN) {
      queueMicrotask(() => this.#closeEvents(1006, "socket not open"));
    }
  }
  async send(event: OutputMediaEvent): Promise<boolean> {
    if (this.#closed) return false;
    if (event.type === "media.audio.chunk") {
      if (!sameAudioFormat(event.audio.format, PCM16_16K_MONO)) {
        throw TvicThrowableError.from(
          validationError(
            "web_client_audio.output_format_invalid",
            "Web client audio output must be PCM16 16kHz mono",
            { provider: PROVIDER_NAMES.webClientAudio, metadata: { format: event.audio.format } },
          ),
        );
      }
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        event.sequence > MAX_WEB_AUDIO_SEQUENCE ||
        event.sequence !== this.#nextOutputSequence
      ) {
        return false;
      }
      const payloadByteLength = event.audio.bytes.byteLength;
      const frameByteLength = 12 + payloadByteLength;
      if (frameByteLength > this.#maxBinaryFrameBytes) {
        this.#limit("outbound audio frame exceeds its bound");
        return false;
      }
      const frame = Buffer.allocUnsafe(frameByteLength);
      frame.writeUInt8(1, 0);
      frame.writeUInt8(0, 1);
      frame.writeUInt32LE(event.sequence, 2);
      frame.writeUInt32LE(Math.max(0, Math.floor(event.monotonicOffsetMs)), 6);
      frame.writeUInt16LE(0, 10);
      frame.set(event.audio.bytes, 12);
      const sent = this.#sendRaw(frame);
      if (sent) {
        this.#nextOutputSequence += 1;
      }
      return sent;
    }
    if (event.type === "media.audio.committed") {
      const commitId = String(event.id);
      this.#pruneAckRecords();
      const sequenceRange = normalizeSequenceRange(event.sequenceRange);
      if (
        !sequenceRange ||
        !this.#hasOutputSequenceRange(sequenceRange[0], sequenceRange[1]) ||
        this.#ackRecords.has(commitId)
      ) {
        return false;
      }
      if (this.#ackRecords.size >= this.#maxPendingAcks) {
        this.#limit("playout acknowledgement limit exceeded");
        return false;
      }
      this.#ackRecords.set(commitId, {
        state: "pending",
        expiresAt: this.#nowMs() + WEB_CLIENT_AUDIO_ACK_RETENTION_MS,
      });
      const sent = this.#sendJson({
        type: "output.commit",
        commitId,
        sequenceRange,
      });
      if (!sent) this.#ackRecords.delete(commitId);
      else this.#resetOutputLedger();
      return sent;
    }
    if (event.type === "media.stream.ended" || event.type === "media.error") {
      return this.#sendSessionEnded(event.type === "media.error" ? "error" : event.reason);
    }
    return true;
  }
  async deliverText(turnId: string, sequence: number, text: string): Promise<boolean> {
    return this.#sendJson({ type: "assistant.text", turnId, sequence, text });
  }
  async clear(): Promise<void> {
    if (this.#closed) return;
    this.#invalidateAcknowledgements();
    if (this.#sendJson({ type: "output.clear" })) {
      this.#resetOutputLedger();
      return;
    }
    throw this.#failTransportWrite("clear");
  }
  async close(reason: StreamEndReason): Promise<void> {
    if (this.#closed) return;
    await this.endInput(reason);
    if (!this.#sendSessionEnded(reason)) throw this.#failTransportWrite("close");
  }
  async endInput(reason: StreamEndReason): Promise<void> {
    if (!this.#endInput(reason)) throw this.#failTransportWrite("input_end");
  }
  terminate(code: number, reason: string): void {
    if (this.#closed) return;
    this.#localTermination = true;
    try {
      this.#socket.close(code, reason);
    } catch {
      // Socket teardown is best-effort.
    }
    this.#closeEvents(code, reason);
  }
  async confirmPlayout(markId: string, timeoutMs: number): Promise<boolean> {
    this.#pruneAckRecords();
    const record = this.#ackRecords.get(markId);
    if (!record || record.state === "timed_out" || this.#closed) return false;
    if (record.state === "acked") {
      this.#ackRecords.delete(markId);
      return true;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish: AckWaiter = (acked) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.#waiters.get(markId);
        waiters?.delete(finish);
        if (waiters?.size === 0) this.#waiters.delete(markId);
        const current = this.#ackRecords.get(markId);
        if (acked) {
          this.#ackRecords.delete(markId);
        } else if (current?.state === "pending") {
          current.state = "timed_out";
          current.expiresAt = this.#nowMs() + WEB_CLIENT_AUDIO_ACK_RETENTION_MS;
        }
        resolve(acked);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const waiters = this.#waiters.get(markId) ?? new Set();
      waiters.add(finish);
      this.#waiters.set(markId, waiters);
    });
  }
  #handleFrame(raw: WebSocket.RawData, isBinary: boolean): void {
    if (this.#closed) return;
    const maxBytes = isBinary ? this.#maxBinaryFrameBytes : 4096;
    const byteLength = rawDataByteLength(raw);
    if (!Number.isSafeInteger(byteLength)) {
      this.#protocolError("Unsupported WebSocket frame representation");
      return;
    }
    if (byteLength > maxBytes) {
      this.#limit(isBinary ? "binary frame too large" : "control frame exceeds 4096 bytes");
      return;
    }
    if (
      !isBinary &&
      !this.#controlRateWindow.accept(byteLength, providerMonotonicNowMs(this.#clock))
    ) {
      this.#limit("control rate exceeded");
      return;
    }
    let data: Buffer;
    try {
      data = rawDataToBuffer(raw, maxBytes);
    } catch (error) {
      this.#protocolError(unknownErrorMessage(error));
      return;
    }
    if (isBinary) {
      if (this.#inputFinished) return;
      this.#handleAudio(data);
      return;
    }
    if (data.byteLength > 4096) {
      this.#limit("control frame exceeds 4096 bytes");
      return;
    }
    const message = parseJsonObject(data.toString("utf8"));
    if (!message || typeof message.type !== "string") {
      this.#protocolError("Invalid web-client control frame");
      return;
    }
    this.#handleControl(message as Readonly<Record<string, unknown>> & { readonly type: string });
  }
  #handleControl(message: Readonly<Record<string, unknown>> & { readonly type: string }): void {
    if (!this.#started && !this.#starting && message.type !== "session.start") {
      this.#protocolError("session.start must be the first control frame");
      return;
    }
    switch (message.type) {
      case "session.start": {
        if (
          this.#started ||
          this.#starting ||
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
        this.#starting = true;
        if (
          !this.#sendJson({
            type: "session.ready",
            sessionId: this.#options.sessionId,
            callId: this.callId,
            mode: message.mode,
            heartbeatIntervalMs: this.#heartbeatIntervalMs,
            maxSessionDurationMs: this.#maxSessionDurationMs,
          })
        ) {
          this.#starting = false;
          this.#failTransportWrite("session.ready");
          return;
        }
        if (
          !this.#pushEvent(
            createMediaEvent({
              ...this.#base("stream_started", 0),
              type: "media.stream.started",
              format: PCM16_16K_MONO,
            }),
          )
        ) {
          this.#starting = false;
          return;
        }
        this.#mode = message.mode;
        this.#started = true;
        this.#starting = false;
        this.#lastActivityAtMonotonicMs = providerMonotonicNowMs(this.#clock);
        if (this.#startTimer) {
          clearTimeout(this.#startTimer);
          this.#startTimer = null;
        }
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
        this.#pushEvent(
          createMediaEvent({
            ...this.#base("turn_commit", 0),
            type: "media.turn.commit_requested",
          }),
        );
        return;
      case "client.interrupt":
        this.#pushEvent(
          createMediaEvent({
            ...this.#base("interrupt", 0),
            type: "media.interrupt.requested",
          }),
        );
        return;
      case "client.mute":
      case "client.unmute":
        return;
      case "client.ping": {
        const nowMonotonicMs = providerMonotonicNowMs(this.#clock);
        if (nowMonotonicMs - this.#lastAcceptedPingAtMonotonicMs >= this.#heartbeatIntervalMs) {
          this.#lastAcceptedPingAtMonotonicMs = nowMonotonicMs;
          this.#lastActivityAtMonotonicMs = nowMonotonicMs;
        }
        this.#sendJson({ type: "server.pong", nonce: message.nonce });
        return;
      }
      case "output.playout_ack":
        if (typeof message.commitId === "string") this.#resolveAck(message.commitId);
        return;
      case "session.end":
        this.#signalRemoteHangup();
        if (!this.#endInput("remote_hangup")) this.#failTransportWrite("input_end");
        this.terminate(1000, "session ended");
        return;
      default:
        this.#protocolError(`Unknown control type ${message.type}`);
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
      data.byteLength === 12 ||
      (data.byteLength - 12) % 2 !== 0
    ) {
      this.#protocolError("Invalid binary audio frame");
      return;
    }
    const payload = data.subarray(12);
    const nowMonotonicMs = providerMonotonicNowMs(this.#clock);
    this.#lastActivityAtMonotonicMs = nowMonotonicMs;
    if (!this.#inputRateWindow.accept(payload.byteLength, nowMonotonicMs)) {
      this.#limit("input rate exceeded");
      return;
    }
    const sequence = data.readUInt32LE(2);
    if (sequence !== this.#lastInputSequence + 1) {
      this.#protocolError("Binary audio sequence must be contiguous and start at 1");
      return;
    }
    this.#lastInputSequence = sequence;
    this.#pushEvent(
      createMediaEvent({
        ...this.#base("audio", sequence),
        type: "media.audio.chunk",
        sequence,
        monotonicOffsetMs: data.readUInt32LE(6),
        audio: {
          format: PCM16_16K_MONO,
          durationMs: durationMsForPcm16le(payload, PCM16_16K_MONO.sampleRateHz),
          frameCount: frameCountForPcm16le(payload),
          bytes: new Uint8Array(payload),
        },
      }),
    );
  }
  #startTimers(): void {
    this.#heartbeatTimer = setInterval(() => {
      if (
        providerMonotonicNowMs(this.#clock) - this.#lastActivityAtMonotonicMs >=
        this.#heartbeatTimeoutMs
      ) {
        this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
      }
    }, this.#heartbeatIntervalMs);
    this.#durationTimer = setTimeout(
      () => this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.maxDuration, "maximum session duration"),
      this.#maxSessionDurationMs,
    );
  }
  #protocolError(message: string): void {
    this.#sendJson({ type: "session.error", code: "protocol_error", message });
    this.#pushDiagnostic(this.#mediaError(new Error(message)));
    this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.protocol, message);
  }
  #limit(message: string): void {
    this.#pushDiagnostic(this.#mediaError(new Error(message)));
    this.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit, message);
  }
  #pushDiagnostic(event: InboundMediaEvent): void {
    if (this.#events.push(event)) return;
    this.#events.fail(
      TvicThrowableError.from(providerEventQueueOverflow(PROVIDER_NAMES.webClientAudio)),
    );
  }
  #pushEvent(event: InboundMediaEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#limit("input event queue exceeded");
    return false;
  }
  #endInput(reason: StreamEndReason): boolean {
    if (this.#inputFinished || this.#closed) return true;
    this.#inputFinished = true;
    if (!this.#sendJson({ type: "input.closed", reason })) return false;
    this.#pushEvent(
      createMediaEvent({
        ...this.#base("stream_ended", 0),
        type: "media.stream.ended",
        reason,
        durationMs: 0,
      }),
    );
    return true;
  }
  #sendJson(value: unknown): boolean {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data, "utf8") > MAX_WEB_CONTROL_FRAME_BYTES) {
      this.#limit("outbound control frame exceeds 4096 bytes");
      return false;
    }
    return this.#sendRaw(data);
  }
  #sendRaw(data: string | Buffer): boolean {
    const capacity = providerSendCapacity(this.#socket, data);
    if (capacity === "hard_limit") {
      this.#limit("outbound socket buffer limit exceeded");
      return false;
    }
    if (capacity === "high_water") {
      this.#limit("outbound socket buffer limit exceeded");
      return false;
    }
    return safeSend(this.#socket, data);
  }
  #sendSessionEnded(reason: string): boolean {
    this.#hostClosing = true;
    const sent = this.#sendJson({ type: "session.ended", reason });
    this.terminate(1000, reason);
    return sent;
  }
  #failTransportWrite(operation: string): TvicThrowableError {
    const error = TvicThrowableError.from(
      providerError(
        TVIC_ERROR_CODES.providerTransportWriteFailed,
        `${PROVIDER_NAMES.webClientAudio} ${operation} write was not accepted by the socket`,
        {
          provider: PROVIDER_NAMES.webClientAudio,
          retriable: false,
          metadata: { operation },
        },
      ),
    );
    if (!this.#closed) {
      this.#pushDiagnostic(
        createMediaEvent({
          ...this.#base("error", 0),
          type: "media.error",
          error,
        }),
      );
      this.#closeEvents(1006, `${operation} write failed`);
      closeSocket(this.#socket, WEB_CLIENT_AUDIO_CLOSE_CODES.protocol, `${operation} write failed`);
    }
    return error;
  }
  #base(
    kind: string,
    sequence: number,
  ): {
    readonly id: MediaEventId;
    readonly sessionId: SessionId;
    readonly callId: CallId;
    readonly sequence: number;
    readonly direction: "input";
    readonly timestamp: Timestamp;
    readonly monotonicOffsetMs: number;
    readonly provider: "web-client-audio";
  } {
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
  #mediaError(error: unknown): InboundMediaEvent {
    return createMediaEvent({
      ...this.#base("error", 0),
      type: "media.error",
      error: mediaError(PROVIDER_ERROR_CODES.webClientAudio, unknownErrorMessage(error), {
        cause: error,
      }),
    });
  }
  #resolveAck(id: string): void {
    this.#pruneAckRecords();
    const record = this.#ackRecords.get(id);
    if (!record || record.state !== "pending") return;
    record.state = "acked";
    record.expiresAt = this.#nowMs() + WEB_CLIENT_AUDIO_ACK_RETENTION_MS;
    const waiters = this.#waiters.get(id);
    if (waiters) {
      for (const waiter of waiters) waiter(true);
    }
  }
  #pruneAckRecords(): void {
    const now = this.#nowMs();
    for (const [id, record] of this.#ackRecords) {
      if (record.expiresAt > now || this.#waiters.has(id)) continue;
      this.#ackRecords.delete(id);
    }
  }
  #invalidateAcknowledgements(): void {
    for (const waiters of this.#waiters.values()) {
      for (const waiter of waiters) waiter(false);
    }
    this.#waiters.clear();
    this.#ackRecords.clear();
  }
  #hasOutputSequenceRange(start: number, end: number): boolean {
    // Successful output sequences are dense from 1 through nextOutputSequence - 1.
    return start >= 1 && end >= start && end < this.#nextOutputSequence;
  }
  #resetOutputLedger(): void {
    this.#nextOutputSequence = 1;
  }
  #observe(event: ConnectionObservabilityEvent): void {
    try {
      this.#options.onConnectionEvent?.(event);
    } catch {
      // Observation must not affect the connection.
    }
  }
  #closeEvents(closeCode = 1006, reason = "transport closed", remoteHangup = false): void {
    if (this.#closed) return;
    if (remoteHangup) this.#signalRemoteHangup();
    this.#closed = true;
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (this.#durationTimer !== null) {
      clearTimeout(this.#durationTimer);
      this.#durationTimer = null;
    }
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
    this.#events.close();
    this.#invalidateAcknowledgements();
    this.#resetOutputLedger();
    this.#observe({
      type: "session_ended",
      callId: this.callId,
      sessionId: this.#options.sessionId,
      closeCode,
      reason,
    });
    try {
      this.#options.onClosed?.();
    } catch {
      // Connection cleanup must not turn an observer failure into an
      // uncaught exception from a WebSocket event handler.
    }
  }
  #signalRemoteHangup(): void {
    if (this.#remoteHangupSignaled || this.#hostClosing || this.#localTermination || this.#closed) {
      return;
    }
    this.#remoteHangupSignaled = true;
    this.#resolveRemoteHangup();
  }
}
export class WebClientAudioProvider implements TelephonyProvider {
  name: "web-client-audio" = PROVIDER_NAMES.webClientAudio;
  kind: "telephony" = "telephony";
  version: "0.1.0" = "0.1.0";
  capabilities: ProviderCapabilities = CAPABILITIES;
  readonly #options: WebClientAudioProviderOptions;
  #pending = new Map<CallId, PendingSocket>();
  #live = new Map<CallId, WebClientAudioCallHandle>();
  constructor(options: WebClientAudioProviderOptions = {}) {
    const limits = resolveWebClientAudioLimits(options);
    this.#options = Object.freeze({
      ...options,
      heartbeatIntervalMs: limits.heartbeatIntervalMs,
      heartbeatTimeoutMs: limits.heartbeatTimeoutMs,
      maxSessionDurationMs: limits.maxSessionDurationMs,
      maxBinaryFrameBytes: limits.maxBinaryFrameBytes,
      maxInputBytesPerSecond: limits.maxInputBytesPerSecond,
      maxInputFramesPerSecond: limits.maxInputFramesPerSecond,
      maxPendingEvents: limits.maxPendingEvents,
      maxPendingAcks: limits.maxPendingAcks,
    });
  }
  async dial(): Promise<CallHandle> {
    throw TvicThrowableError.from(
      providerError("web_client_audio.dial_unsupported", "Web client audio is accept-only", {
        provider: PROVIDER_NAMES.webClientAudio,
        retriable: false,
      }),
    );
  }
  async accept(ctx: Parameters<TelephonyProvider["accept"]>[0]): Promise<CallHandle> {
    const pending = this.#pending.get(ctx.call.id);
    if (!pending) {
      throw TvicThrowableError.from(
        providerError(
          "web_client_audio.socket_missing",
          `No attached socket for call ${ctx.call.id}`,
          { provider: PROVIDER_NAMES.webClientAudio, retriable: false },
        ),
      );
    }
    if (ctx.call.sessionId !== undefined && pending.sessionId !== ctx.call.sessionId) {
      this.#pending.delete(ctx.call.id);
      clearTimeout(pending.timer);
      closeSocket(pending.socket, WEB_CLIENT_AUDIO_CLOSE_CODES.protocol, "session mismatch");
      throw TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerIdentityMismatch,
          `Attached Web Client socket session does not match runtime session for call ${ctx.call.id}`,
          {
            provider: PROVIDER_NAMES.webClientAudio,
            retriable: false,
            metadata: {
              callId: ctx.call.id,
              pendingSessionId: pending.sessionId,
              runtimeSessionId: ctx.call.sessionId,
            },
          },
        ),
      );
    }
    const sessionId = ctx.call.sessionId ?? pending.sessionId;
    this.#pending.delete(ctx.call.id);
    clearTimeout(pending.timer);
    return this.acceptWebSocket(pending.socket, ctx.call.id, sessionId);
  }
  attachWebSocket(socket: WebClientAudioSocket, callId: CallId, sessionId: SessionId): void {
    const previous = this.#pending.get(callId);
    if (previous?.socket === socket) {
      return;
    }
    if (previous?.socket !== socket) {
      this.#pending.delete(callId);
      if (previous) {
        clearTimeout(previous.timer);
        closeSocket(previous.socket, WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded");
      }
    }
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
    const timer = setTimeout(() => {
      if (this.#pending.get(callId)?.socket !== socket) return;
      this.#pending.delete(callId);
      closeSocket(socket, WEB_CLIENT_AUDIO_CLOSE_CODES.heartbeatTimeout, "accept timeout");
    }, PENDING_ACCEPT_TIMEOUT_MS);
    timer.unref?.();
    this.#pending.set(callId, { socket, sessionId, timer });
    socket.on("close", () => {
      const pending = this.#pending.get(callId);
      if (pending?.socket === socket) {
        clearTimeout(pending.timer);
        this.#pending.delete(callId);
      }
    });
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      const pending = this.#pending.get(callId);
      if (pending?.socket === socket) {
        clearTimeout(pending.timer);
        this.#pending.delete(callId);
      }
    }
  }
  async acceptWebSocket(
    socket: WebClientAudioSocket,
    callId: CallId,
    sessionId: SessionId,
    connectionOptions: { readonly expectedMode?: "push_to_talk" | "continuous" } = {},
  ): Promise<WebClientAudioCallHandle> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded by reconnect");
    let handle: WebClientAudioCallHandle;
    handle = new WebClientAudioCallHandle({
      ...this.#options,
      socket,
      callId,
      sessionId,
      ...connectionOptions,
      onClosed: () => {
        if (this.#live.get(callId) === handle) this.#live.delete(callId);
      },
    });
    this.#live.set(callId, handle);
    return handle;
  }
  async hangup(callId: CallId): Promise<void> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated, "terminated");
    const pending = this.#pending.get(callId);
    this.#pending.delete(callId);
    if (pending) {
      clearTimeout(pending.timer);
      closeSocket(pending.socket, WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated, "terminated");
    }
  }
  async supersede(callId: CallId): Promise<void> {
    this.#live
      .get(callId)
      ?.terminate(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded, "superseded by reconnect");
    const pending = this.#pending.get(callId);
    this.#pending.delete(callId);
    if (pending) {
      clearTimeout(pending.timer);
      closeSocket(
        pending.socket,
        WEB_CLIENT_AUDIO_CLOSE_CODES.superseded,
        "superseded by reconnect",
      );
    }
  }
}
export function createWebClientAudioProvider(
  options: WebClientAudioProviderOptions = {},
): WebClientAudioProvider {
  return new WebClientAudioProvider(options);
}
