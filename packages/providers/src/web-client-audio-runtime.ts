import WebSocket from "ws";
import type {
  AudioFormat,
  CallHandle,
  CallId,
  InboundMediaEvent,
  MediaEventId,
  OutputMediaEvent,
  SessionId,
  StreamEndReason,
  Timestamp,
  TurnId,
} from "@tvic/core";
import type {
  WebClientAudioCallHandleOptions,
  ConnectionObservabilityEvent,
  WebClientAudioControlContext,
  WebClientAudioSocket,
} from "./web-client-audio.js";
import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  createMediaEvent,
  isSampleRateHz,
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
  MAX_PROVIDER_FRAME_BYTES,
  providerEventQueueOverflow,
  parseJsonObject,
  rawDataByteLength,
  rawDataToBuffer,
  providerSendCapacity,
  safeSend,
  unknownErrorMessage,
  type ProviderClock,
} from "./common.js";

type WebClientAudioMode = "push_to_talk" | "continuous";
type AckState = "pending" | "acked" | "timed_out";
interface AckRecord {
  state: AckState;
  expiresAt: number;
}
type AckWaiter = (acked: boolean) => void;
interface RateSample {
  readonly at: number;
  readonly bytes: number;
}
export const WEB_CLIENT_AUDIO_CLOSE_CODES = {
  protocol: 4400,
  heartbeatTimeout: 4408,
  superseded: 4409,
  maxDuration: 4410,
  resourceLimit: 4413,
  operatorTerminated: 4500,
};
export const WEB_CLIENT_AUDIO_DEFAULTS = {
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  maxSessionDurationMs: 45 * 60_000,
  maxPendingEvents: 512,
  maxInputFramesPerSecond: 200,
  maxPendingAcks: 128,
};
export const WEB_CLIENT_AUDIO_ACK_RETENTION_MS = 60_000;
const MAX_WEB_CONTROL_FRAME_BYTES = 4_096;
const MAX_WEB_CONTROL_FRAME_LIMIT_BYTES = 65_536;
const MAX_UINT32 = 0xffff_ffff;

/** @typedef {import("@tvic/core").InboundMediaEvent} InboundMediaEvent */
/** @typedef {import("./web-client-audio.js").WebClientAudioCallHandleOptions} WebClientAudioCallHandleOptions */
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
  #rateSamples: RateSample[] = [];
  #heartbeatIntervalMs: number;
  #heartbeatTimeoutMs: number;
  #nowMs: () => number;
  #maxBinaryFrameBytes: number;
  #maxControlFrameBytes: number;
  #maxInputBytesPerSecond: number;
  #maxInputFramesPerSecond: number;
  #maxPendingAcks: number;
  #mode: WebClientAudioMode | null = null;
  #starting = false;
  #started = false;
  #closed = false;
  #terminalCloseDeferred = false;
  #lastActivityAt: number;
  #lastInputSequence = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #startTimer: ReturnType<typeof setTimeout> | null = null;
  #nextOutputSequence = 1;
  #outputSequences = new Set<number>();
  #pendingOutputSourceSequenceStart: number | undefined;
  #pendingOutputSourceSequenceEnd: number | undefined;
  #lastOutputSourceTurnId: TurnId | undefined;
  #hasOutputSourceSequence = false;
  #lastOutputSourceSequence = 0;
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
    this.#maxBinaryFrameBytes = Math.min(
      options.maxBinaryFrameBytes ?? 65_536,
      MAX_PROVIDER_FRAME_BYTES,
    );
    const maxControlFrameBytes = options.maxControlFrameBytes ?? MAX_WEB_CONTROL_FRAME_BYTES;
    if (
      !Number.isSafeInteger(maxControlFrameBytes) ||
      maxControlFrameBytes < 1 ||
      maxControlFrameBytes > MAX_WEB_CONTROL_FRAME_LIMIT_BYTES
    ) {
      throw new Error(
        `maxControlFrameBytes must be an integer from 1 to ${MAX_WEB_CONTROL_FRAME_LIMIT_BYTES}`,
      );
    }
    this.#maxControlFrameBytes = maxControlFrameBytes;
    this.#maxInputBytesPerSecond = options.maxInputBytesPerSecond ?? 128_000;
    this.#maxInputFramesPerSecond =
      options.maxInputFramesPerSecond ?? WEB_CLIENT_AUDIO_DEFAULTS.maxInputFramesPerSecond;
    this.#maxPendingAcks = Math.min(
      options.maxPendingAcks ?? WEB_CLIENT_AUDIO_DEFAULTS.maxPendingAcks,
      WEB_CLIENT_AUDIO_DEFAULTS.maxPendingAcks,
    );
    this.#events = new AsyncQueue<InboundMediaEvent>({
      maxBuffered: options.maxPendingEvents ?? WEB_CLIENT_AUDIO_DEFAULTS.maxPendingEvents,
      onOverflow: () =>
        TvicThrowableError.from(
          mediaError(PROVIDER_ERROR_CODES.webClientAudio, "Input event queue exceeded its bound", {
            provider: PROVIDER_NAMES.webClientAudio,
          }),
        ),
    });
    this.events = this.#events;
    this.#socket.on("message", (data, isBinary) => this.#handleFrame(data, isBinary));
    this.#socket.on("close", (code, reason) => this.#closeEvents(code, reason.toString("utf8")));
    this.#socket.on("error", (error) => {
      this.#pushEvent(this.#mediaError(error));
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
    if (this.#isClosed()) return false;
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
      const wireSequence = this.#nextOutputSequence;
      const sourceTurnChanged =
        this.#hasOutputSourceSequence &&
        event.turnId !== undefined &&
        event.turnId !== this.#lastOutputSourceTurnId;
      const previousSourceSequence = sourceTurnChanged ? 0 : this.#lastOutputSourceSequence;
      if (
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        event.sequence > MAX_UINT32 ||
        event.sequence <= previousSourceSequence ||
        wireSequence > MAX_UINT32
      ) {
        return false;
      }
      const payload = Buffer.from(event.audio.bytes);
      const frame = Buffer.allocUnsafe(12 + payload.byteLength);
      if (frame.byteLength > this.#maxBinaryFrameBytes) {
        this.#limit("outbound audio frame exceeds its bound");
        return false;
      }
      frame.writeUInt8(1, 0);
      frame.writeUInt8(0, 1);
      frame.writeUInt32LE(wireSequence, 2);
      frame.writeUInt32LE(Math.max(0, Math.floor(event.monotonicOffsetMs)), 6);
      frame.writeUInt16LE(0, 10);
      payload.copy(frame, 12);
      const sent = this.#sendRaw(frame);
      if (sent) {
        this.#outputSequences.add(wireSequence);
        this.#nextOutputSequence += 1;
        this.#pendingOutputSourceSequenceStart ??= event.sequence;
        this.#pendingOutputSourceSequenceEnd = event.sequence;
        if (sourceTurnChanged || !this.#hasOutputSourceSequence) {
          this.#lastOutputSourceTurnId = event.turnId;
        }
        this.#hasOutputSourceSequence = true;
        this.#lastOutputSourceSequence = event.sequence;
      }
      return sent;
    }
    if (event.type === "media.audio.committed") {
      const commitId = String(event.id);
      this.#pruneAckRecords();
      const sourceSequenceRange = normalizeSequenceRange(event.sequenceRange);
      const wireSequenceRange = normalizeSequenceRange([1, this.#nextOutputSequence - 1]);
      if (
        !sourceSequenceRange ||
        this.#pendingOutputSourceSequenceStart === undefined ||
        this.#pendingOutputSourceSequenceEnd === undefined ||
        sourceSequenceRange[0] !== this.#pendingOutputSourceSequenceStart ||
        sourceSequenceRange[1] !== this.#pendingOutputSourceSequenceEnd ||
        !wireSequenceRange ||
        !this.#hasOutputSequenceRange(wireSequenceRange[0], wireSequenceRange[1]) ||
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
        sequenceRange: wireSequenceRange,
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
    if (this.#isClosed()) return false;
    return this.#sendJson({ type: "assistant.text", turnId, sequence, text });
  }
  async clear(): Promise<void> {
    if (this.#isClosed()) return;
    this.#invalidateAcknowledgements();
    if (this.#sendJson({ type: "output.clear" })) {
      this.#resetOutputLedger();
      return;
    }
    throw this.#failTransportWrite("clear");
  }
  async close(reason: StreamEndReason): Promise<void> {
    if (this.#isClosed()) return;
    if (this.#options.deferTerminalClose) {
      this.#deferTerminalClose();
      return;
    }
    if (!this.#sendSessionEnded(reason)) {
      throw this.#failTransportWrite("close");
    }
  }
  terminate(code: number, reason: string): void {
    if (this.#closed || this.#terminalCloseDeferred) return;
    if (this.#options.deferTerminalClose) {
      this.#deferTerminalClose();
      return;
    }
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
    if (!record || record.state === "timed_out" || this.#isClosed()) return false;
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
    if (this.#isClosed()) return;
    const maxBytes = isBinary ? this.#maxBinaryFrameBytes : this.#maxControlFrameBytes;
    const byteLength = rawDataByteLength(raw);
    if (!Number.isSafeInteger(byteLength)) {
      this.#protocolError("Unsupported WebSocket frame representation");
      return;
    }
    if (byteLength > maxBytes) {
      this.#limit(
        isBinary
          ? "binary frame too large"
          : `control frame exceeds ${this.#maxControlFrameBytes} bytes`,
      );
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
      this.#handleAudio(data);
      return;
    }
    if (data.byteLength > this.#maxControlFrameBytes) {
      this.#limit(`control frame exceeds ${this.#maxControlFrameBytes} bytes`);
      return;
    }
    const message = parseJsonObject(data.toString("utf8"));
    if (!message || typeof message.type !== "string") {
      this.#protocolError("Invalid web-client control frame");
      return;
    }
    if (containsInvalidJsonNumber(message)) {
      this.#protocolError(
        "Control frame contains a non-finite number or an integer outside the JavaScript safe integer range",
      );
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
            maxSessionDurationMs:
              this.#options.maxSessionDurationMs ?? WEB_CLIENT_AUDIO_DEFAULTS.maxSessionDurationMs,
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
      case "client.ping":
        this.#lastActivityAt = this.#nowMs();
        this.#sendJson({ type: "server.pong", nonce: message.nonce });
        return;
      case "output.playout_ack":
        if (typeof message.commitId === "string") this.#resolveAck(message.commitId);
        return;
      case "session.end":
        this.#pushEvent(
          createMediaEvent({
            ...this.#base("stream_ended", 0),
            type: "media.stream.ended",
            reason: "remote_hangup",
            durationMs: 0,
          }),
        );
        this.terminate(1000, "session ended");
        return;
      default: {
        let handled = false;
        try {
          handled =
            this.#options.onControlMessage?.(message, {
              callId: this.callId,
              sessionId: this.#options.sessionId,
            } satisfies WebClientAudioControlContext) ?? false;
        } catch {
          this.#protocolError("Application control handler failed");
          return;
        }
        if (!handled) this.#protocolError(`Unknown control type ${message.type}`);
      }
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
  #acceptRate(bytes: number): boolean {
    const now = this.#nowMs();
    this.#rateSamples.push({ at: now, bytes });
    while ((this.#rateSamples[0]?.at ?? now) < now - 2000) this.#rateSamples.shift();
    return (
      this.#rateSamples.reduce((sum, item) => sum + item.bytes, 0) <=
        this.#maxInputBytesPerSecond * 2 &&
      this.#rateSamples.length <= this.#maxInputFramesPerSecond * 2
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
  #sendJson(value: unknown): boolean {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data, "utf8") > this.#maxControlFrameBytes) {
      this.#limit(`outbound control frame exceeds ${this.#maxControlFrameBytes} bytes`);
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
    if (this.#options.deferTerminalClose) {
      this.#deferTerminalClose();
      return true;
    }
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
    if (!this.#isClosed()) {
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
    if (start < 1 || end < start) return false;
    if (end - start + 1 > this.#outputSequences.size) return false;
    for (let sequence = start; sequence <= end; sequence += 1) {
      if (!this.#outputSequences.has(sequence)) return false;
    }
    return true;
  }
  #resetOutputLedger(): void {
    this.#outputSequences.clear();
    this.#nextOutputSequence = 1;
    this.#pendingOutputSourceSequenceStart = undefined;
    this.#pendingOutputSourceSequenceEnd = undefined;
  }
  #observe(event: ConnectionObservabilityEvent): void {
    try {
      this.#options.onConnectionEvent?.(event);
    } catch {
      // Observation must not affect the connection.
    }
  }
  #isClosed(): boolean {
    return this.#closed || this.#terminalCloseDeferred;
  }
  #deferTerminalClose(): void {
    if (this.#terminalCloseDeferred || this.#closed) return;
    this.#terminalCloseDeferred = true;
    this.#releaseSessionResources();
  }
  #releaseSessionResources(): void {
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
  }
  #closeEvents(closeCode = 1006, reason = "transport closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#releaseSessionResources();
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
}
function isMode(value: unknown): value is WebClientAudioMode {
  return value === "push_to_talk" || value === "continuous";
}
function containsInvalidJsonNumber(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "number") {
      if (
        !Number.isFinite(current) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current))
      ) {
        return true;
      }
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current !== null && typeof current === "object") {
      for (const item of Object.values(current as Record<string, unknown>)) pending.push(item);
    }
  }
  return false;
}
function normalizeSequenceRange(value: readonly unknown[]): readonly [number, number] | null {
  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > MAX_UINT32
  ) {
    return null;
  }
  return [start, end];
}
function parseAudioFormat(value: unknown): AudioFormat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !isNormalizedAudioEncoding(record.encoding) ||
    !isSampleRateHz(record.sampleRateHz) ||
    !isChannelLayout(record.channels)
  )
    return null;
  return {
    encoding: record.encoding,
    sampleRateHz: record.sampleRateHz,
    channels: record.channels,
  };
}
function isNormalizedAudioEncoding(value: unknown): value is AudioFormat["encoding"] {
  return value === "pcm_s16le" || value === "pcm_s16be" || value === "pcm_f32le";
}
function isChannelLayout(value: unknown): value is AudioFormat["channels"] {
  return value === 1 || value === 2;
}
export function closeSocket(socket: WebClientAudioSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Pending transport teardown is best-effort.
  }
}
