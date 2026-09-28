import WebSocket from "ws";

import {
  AsyncQueue,
  base64ToBytes,
  createAudioNormalizer,
  durationMsForPcm16le,
  frameCountForPcm16le,
  mulawToPcm16le,
} from "@tvic/media";

import {
  PCM16_8K_MONO,
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  createMediaEvent,
  mediaError,
  normalizeUnknownError,
  isDtmfDigit,
  TvicThrowableError,
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
  SessionId,
  StreamEndReason,
} from "@tvic/core";

import {
  SystemProviderClock,
  parseJsonObject,
  providerEventQueueOverflow,
  providerError,
  MAX_PROVIDER_FRAME_BYTES,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  type ProviderClock,
} from "./common.js";
import {
  appendBytes,
  assertTwilioBoundaryFormat,
  numericSequence,
  validateTwilioMessage,
} from "./twilio-protocol.js";
import { TwilioOutboundQueue, type TwilioOutboundMarkLedger } from "./twilio-outbound.js";

export { TWILIO_MAX_AUDIO_EVENT_BYTES } from "./twilio-outbound.js";

export interface TwilioMediaStreamSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: WebSocket.RawData) => void): this;
  on(event: "close", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
}

export interface TwilioMediaStreamCallHandleOptions {
  readonly socket: TwilioMediaStreamSocket;
  readonly callId: CallId;
  readonly sessionId: SessionId;
  readonly inputFormat?: AudioFormat;
  readonly outputFormat?: AudioFormat;
  /** Values authenticated by the host and expected in Twilio's start frame. */
  readonly expectedTwilioCallSid?: string;
  readonly expectedAccountSid?: string;
  readonly clock?: ProviderClock;
  readonly onClosed?: () => void;
}

type TwilioInboundMessage =
  | { readonly event: "connected"; readonly protocol?: string; readonly version?: string }
  | {
      readonly event: "start";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly start?: {
        readonly streamSid?: string;
        readonly accountSid?: string;
        readonly callSid?: string;
        readonly customParameters?: Readonly<Record<string, string>>;
      };
    }
  | {
      readonly event: "media";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly media?: {
        readonly track?: "inbound" | "outbound";
        readonly chunk?: string;
        readonly timestamp?: string;
        readonly payload?: string;
      };
    }
  | {
      readonly event: "dtmf";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly dtmf?: { readonly digit?: string };
    }
  | {
      readonly event: "mark";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly mark?: { readonly name?: string };
    }
  | {
      readonly event: "stop";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly stop?: { readonly callSid?: string };
    };

type MarkStatus = "pending" | "acked" | "cleared" | "undelivered";

interface MarkRecord {
  status: MarkStatus;
  sent: boolean;
  readonly waiters: Set<(acked: boolean) => void>;
  /** Set when the record enters a terminal status; used to bound retention. */
  resolvedAtMs?: number;
}

interface InputMetadata {
  readonly sequence: string | undefined;
  readonly monotonicOffsetMs: number;
  readonly twilioChunk: string | undefined;
  readonly streamSid: string;
}

interface InputMetadataSegment {
  byteLength: number;
  readonly metadata: InputMetadata;
}

/**
 * How long a resolved mark record is kept after its outcome is known, before
 * `#pruneStaleMarks` removes it. Must comfortably exceed any real caller's
 * `confirmPlayout` timeout (30s in `PipelineVoiceLoop`) so a legitimate lookup
 * always finds the record still present; it is not a correctness deadline.
 */
const MARK_RETENTION_MS = 60_000;
const MAX_PENDING_MARKS = 128;
export class TwilioMediaStreamCallHandle implements CallHandle {
  readonly events: AsyncIterable<InboundMediaEvent>;
  readonly #socket: TwilioMediaStreamSocket;
  readonly #events = new AsyncQueue<InboundMediaEvent>({
    maxBuffered: 512,
    onOverflow: () =>
      providerEventQueueOverflow(PROVIDER_NAMES.twilio, "twilio.media_stream.buffer_overflow"),
  });
  readonly #inputFormat: AudioFormat;
  readonly #clock: ProviderClock;
  readonly #eventIds: CounterIdGenerator<MediaEventId> =
    counterIdGenerator<MediaEventId>("twilio_event");
  // Twilio echoes a mark both when it plays and when clear() discards it. The
  // state machine keeps those indistinguishable wire messages from becoming a
  // false claim that the caller heard audio.
  readonly #marks = new Map<string, MarkRecord>();
  readonly #inputNormalizer = createAudioNormalizer({
    inputFormat: PCM16_8K_MONO,
    outputFormat: PCM16_16K_MONO,
  });
  #inputPending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  readonly #inputMetadataSegments: InputMetadataSegment[] = [];
  #lastInputMetadata: InputMetadata | undefined;
  readonly #outbound: TwilioOutboundQueue;
  #inputFinished = false;
  #accepting = true;
  #streamSid: string | null = null;
  #lastSequenceNumber: number | null = null;
  #closed = false;
  #closeNotified = false;

  constructor(readonly options: TwilioMediaStreamCallHandleOptions) {
    this.callId = options.callId;
    this.#socket = options.socket;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#inputFormat = options.inputFormat ?? PCM16_16K_MONO;
    assertTwilioBoundaryFormat(this.#inputFormat);
    if (options.outputFormat) {
      assertTwilioBoundaryFormat(options.outputFormat);
    }
    this.events = this.#events;
    this.#outbound = new TwilioOutboundQueue({
      socket: this.#socket,
      clock: this.#clock,
      getStreamSid: () => this.#requiredStreamSid(),
      marks: {
        reserve: (name) => this.#reserveMark(name),
        markSent: (name) => this.#markSent(name),
        markUndelivered: (name) => this.#markUndelivered(name),
        markCleared: (name) => this.#markCleared(name),
        invalidateCleared: () => this.#invalidateClearedMarks(),
      } satisfies TwilioOutboundMarkLedger,
      isHandleClosed: () => this.#closed,
      onCloseRequested: () => {
        this.#accepting = false;
      },
      onMediaError: (error) => {
        this.#pushEvent(this.#mediaError(error));
      },
      onFinishClose: (reason) => this.#finishClose(reason),
    });

    this.#socket.on("message", (data) => this.#handleRawMessage(data));
    this.#socket.on("close", () => {
      this.#finishInbound();
      this.#closeEvents();
    });
    this.#socket.on("error", (error) => {
      this.#inputFinished = true;
      this.#inputPending = new Uint8Array();
      this.#pushEvent(this.#mediaError(error));
      this.#closeEvents();
    });
  }

  readonly callId: CallId;

  send(event: OutputMediaEvent): Promise<boolean> {
    if (!this.#accepting || this.#closed) return Promise.resolve(false);
    return this.#outbound.send(event);
  }

  clear(): Promise<void> {
    if (!this.#accepting || this.#closed) return Promise.resolve();
    return this.#outbound.clear();
  }

  close(reason: StreamEndReason): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#accepting = false;
    return this.#outbound.close(reason);
  }

  #finishClose(reason: StreamEndReason): void {
    if (this.#closed) return;
    this.#accepting = false;
    if (reason === "error") {
      this.#inputFinished = true;
      this.#inputPending = new Uint8Array();
    }
    this.#closed = true;
    safeClose(this.#socket);
    this.#closeEvents();
  }

  #handleRawMessage(data: WebSocket.RawData): void {
    if (this.#closed) return;
    if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
      this.#failProtocol("message exceeded the size limit");
      return;
    }
    const body = rawDataToBuffer(data).toString("utf8");
    const parsed = parseJsonObject(body);
    if (!parsed || typeof parsed.event !== "string") {
      this.#failProtocol("message shape is invalid");
      return;
    }

    const protocolError = validateTwilioMessage(parsed, this.#streamSid, this.#lastSequenceNumber);
    if (protocolError) {
      this.#failProtocol(protocolError);
      return;
    }
    if (parsed.event !== "connected") {
      this.#lastSequenceNumber = Number(parsed.sequenceNumber);
    }

    this.#handleMessage(parsed as TwilioInboundMessage);
  }

  #handleMessage(message: TwilioInboundMessage): void {
    switch (message.event) {
      case "connected":
        return;
      case "start":
        if (
          this.options.expectedTwilioCallSid !== undefined &&
          message.start?.callSid !== this.options.expectedTwilioCallSid
        ) {
          this.#failProtocol("start.callSid does not match the authenticated call");
          return;
        }
        if (
          this.options.expectedAccountSid !== undefined &&
          message.start?.accountSid !== this.options.expectedAccountSid
        ) {
          this.#failProtocol("start.accountSid does not match the authenticated account");
          return;
        }
        this.#streamSid = message.streamSid || message.start?.streamSid || null;
        this.#pushEvent(
          createMediaEvent({
            id: this.#mediaEventId("stream_started", message.sequenceNumber),
            type: "media.stream.started",
            sessionId: this.options.sessionId,
            callId: this.callId,
            sequence: numericSequence(message.sequenceNumber),
            direction: "input",
            timestamp: this.#clock.now(),
            monotonicOffsetMs: 0,
            provider: PROVIDER_NAMES.twilio,
            format: this.#inputFormat,
            metadata: {
              accountSid: message.start?.accountSid,
              twilioCallSid: message.start?.callSid,
              customParameters: message.start?.customParameters,
            },
          }),
        );
        return;
      case "media":
        this.#handleMediaMessage(message);
        return;
      case "dtmf":
        if (isDtmfDigit(message.dtmf?.digit)) {
          this.#pushEvent(
            createMediaEvent({
              id: this.#mediaEventId("dtmf", message.sequenceNumber),
              type: "dtmf.received",
              sessionId: this.options.sessionId,
              callId: this.callId,
              sequence: numericSequence(message.sequenceNumber),
              direction: "input",
              timestamp: this.#clock.now(),
              monotonicOffsetMs: 0,
              provider: PROVIDER_NAMES.twilio,
              digit: message.dtmf.digit,
            }),
          );
        }
        return;
      case "mark":
        if (message.mark?.name) {
          this.#resolveMark(message.mark.name);
        }
        return;
      case "stop":
        this.#finishInbound();
        this.#pushEvent(
          createMediaEvent({
            id: this.#mediaEventId("stream_ended", message.sequenceNumber),
            type: "media.stream.ended",
            sessionId: this.options.sessionId,
            callId: this.callId,
            sequence: numericSequence(message.sequenceNumber),
            direction: "input",
            timestamp: this.#clock.now(),
            monotonicOffsetMs: 0,
            provider: PROVIDER_NAMES.twilio,
            reason: "remote_hangup",
            durationMs: 0,
          }),
        );
        safeClose(this.#socket);
        this.#closeEvents();
        return;
    }
  }

  #handleMediaMessage(message: Extract<TwilioInboundMessage, { readonly event: "media" }>): void {
    if (message.media?.track !== "inbound" || !message.media.payload) {
      return;
    }

    const mulaw = base64ToBytes(message.media.payload);
    const pcm8k = mulawToPcm16le(mulaw);
    const converted = this.#inputNormalizer.push(pcm8k);
    if (converted.byteLength > 0) {
      const metadata: InputMetadata = {
        sequence: message.sequenceNumber,
        monotonicOffsetMs: numericSequence(message.media.timestamp),
        twilioChunk: message.media.chunk,
        streamSid: message.streamSid,
      };
      this.#lastInputMetadata = metadata;
      this.#inputMetadataSegments.push({ byteLength: converted.byteLength, metadata });
    }
    this.#inputPending = appendBytes(this.#inputPending, converted);
    this.#flushInbound(false);
  }

  #finishInbound(): void {
    if (this.#inputFinished) {
      return;
    }
    this.#inputFinished = true;
    const converted = this.#inputNormalizer.finish();
    if (converted.byteLength > 0 && this.#lastInputMetadata) {
      this.#inputMetadataSegments.push({
        byteLength: converted.byteLength,
        metadata: this.#lastInputMetadata,
      });
    }
    this.#inputPending = appendBytes(this.#inputPending, converted);
    this.#flushInbound(true);
  }

  #flushInbound(final: boolean): void {
    const frameBytes = 320 * 2;
    while (this.#inputPending.byteLength >= frameBytes) {
      this.#pushInboundEvent(
        this.#inputPending.slice(0, frameBytes),
        this.#consumeInputMetadata(frameBytes),
      );
      this.#inputPending = this.#inputPending.slice(frameBytes);
    }
    if (final && this.#inputPending.byteLength > 0) {
      this.#pushInboundEvent(
        this.#inputPending,
        this.#consumeInputMetadata(this.#inputPending.byteLength),
      );
      this.#inputPending = new Uint8Array();
    }
    if (this.#inputPending.byteLength === 0) {
      this.#inputMetadataSegments.length = 0;
    }
  }

  #consumeInputMetadata(byteLength: number): InputMetadata | undefined {
    const first = this.#inputMetadataSegments[0]?.metadata;
    let remaining = byteLength;
    while (remaining > 0 && this.#inputMetadataSegments.length > 0) {
      const segment = this.#inputMetadataSegments[0];
      if (!segment) {
        break;
      }
      const consumed = Math.min(remaining, segment.byteLength);
      segment.byteLength -= consumed;
      remaining -= consumed;
      if (segment.byteLength === 0) {
        this.#inputMetadataSegments.shift();
      }
    }
    return first;
  }

  #pushInboundEvent(bytes: Uint8Array, metadata: InputMetadata | undefined): void {
    const event = createMediaEvent({
      id: this.#mediaEventId("audio", metadata?.sequence),
      type: "media.audio.chunk",
      sessionId: this.options.sessionId,
      callId: this.callId,
      sequence: numericSequence(metadata?.sequence),
      direction: "input",
      timestamp: this.#clock.now(),
      monotonicOffsetMs: metadata?.monotonicOffsetMs ?? 0,
      provider: PROVIDER_NAMES.twilio,
      audio: {
        format: this.#inputFormat,
        durationMs: durationMsForPcm16le(bytes, this.#inputFormat.sampleRateHz),
        frameCount: frameCountForPcm16le(bytes),
        bytes,
      },
      metadata: {
        twilioChunk: metadata?.twilioChunk,
        twilioStreamSid: metadata?.streamSid ?? "",
      },
    });
    this.#pushEvent(event);
  }

  #pushEvent(event: InboundMediaEvent): boolean {
    if (this.#events.push(event)) {
      return true;
    }
    const error = providerError(
      "twilio.media_stream.buffer_overflow",
      "Twilio inbound media exceeded the bounded runtime queue",
      { provider: PROVIDER_NAMES.twilio, retriable: false },
    );
    this.#inputFinished = true;
    this.#accepting = false;
    safeClose(this.#socket);
    this.#events.fail(TvicThrowableError.from(error));
    // Do not wait for a close event to settle playout waiters. A test double or
    // a broken transport may never emit that event after close(), but every
    // pending mark is already known to be undelivered once the input queue has
    // overflowed.
    this.#closeEvents();
    return false;
  }

  #failProtocol(reason: string): void {
    if (this.#closed) return;
    const error = providerError(
      PROVIDER_ERROR_CODES.twilioMedia,
      "Twilio media stream protocol validation failed",
      {
        provider: PROVIDER_NAMES.twilio,
        retriable: false,
        metadata: { reason },
      },
    );
    this.#inputFinished = true;
    this.#inputPending = new Uint8Array();
    this.#accepting = false;
    this.#pushEvent(this.#mediaError(error));
    safeClose(this.#socket);
    this.#closeEvents();
  }

  #requiredStreamSid(): string {
    if (!this.#streamSid) {
      throw TvicThrowableError.from(
        providerError("twilio.stream_sid_missing", "Twilio streamSid is not available yet", {
          provider: PROVIDER_NAMES.twilio,
          retriable: false,
        }),
      );
    }
    return this.#streamSid;
  }

  #mediaError(error: unknown): InputMediaEvent {
    const normalized = normalizeUnknownError(error, {
      code: PROVIDER_ERROR_CODES.twilioMedia,
      category: "media",
      provider: PROVIDER_NAMES.twilio,
      retriable: false,
    });
    const options = {
      provider: normalized.provider ?? PROVIDER_NAMES.twilio,
      retriable: normalized.retriable,
      ...(normalized.cause !== undefined ? { cause: normalized.cause } : {}),
      ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
    };
    const eventError =
      normalized.code === TVIC_ERROR_CODES.providerTransportWriteFailed
        ? mediaError(TVIC_ERROR_CODES.providerTransportWriteFailed, normalized.message, options)
        : normalized.code === TVIC_ERROR_CODES.providerTransportTimeout
          ? mediaError(TVIC_ERROR_CODES.providerTransportTimeout, normalized.message, options)
          : normalized.code === TVIC_ERROR_CODES.providerStreamBufferOverflow
            ? mediaError(TVIC_ERROR_CODES.providerStreamBufferOverflow, normalized.message, options)
            : mediaError(PROVIDER_ERROR_CODES.twilioMedia, normalized.message, options);
    return createMediaEvent({
      id: this.#mediaEventId("error"),
      type: "media.error",
      sessionId: this.options.sessionId,
      callId: this.callId,
      sequence: 0,
      direction: "input",
      timestamp: this.#clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.twilio,
      error: eventError,
    });
  }

  #mediaEventId(kind: string, sequence?: string): MediaEventId {
    // Counters are handle-local; callId keeps IDs collision-safe across simultaneous
    // handles even when their injected clocks and Twilio sequence numbers are equal.
    return `${this.callId}_${this.#eventIds.next()}_${kind}_${sequence ?? this.#clock.now()}` as MediaEventId;
  }

  async confirmPlayout(markId: string, timeoutMs: number): Promise<boolean> {
    this.#pruneStaleMarks();
    const existing = this.#marks.get(markId);
    if (existing?.status === "acked") {
      return true;
    }
    if (existing?.status === "cleared" || existing?.status === "undelivered" || this.#closed) {
      return false; // the call dropped before this mark could play out
    }
    if (!existing && this.#pendingMarkCount() >= MAX_PENDING_MARKS) {
      this.#failProtocol("pending playout mark limit exceeded");
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (acked: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const record = this.#marks.get(markId);
        record?.waiters.delete(finish);
        // A timeout is an unconfirmed result, not proof that the audio was
        // undelivered. Keep the record pending so a genuinely late Twilio ack
        // can still upgrade it to `acked`, but make it eligible for retention
        // pruning once its last active waiter has gone away.
        if (!acked && record?.status === "pending" && record.waiters.size === 0) {
          record.resolvedAtMs = Date.now();
        }
        resolve(acked);
      };
      // No ack within the window: we have no proof the caller heard it, so report
      // false (unconfirmed). We never claim "heard" without a mark ack.
      const timer = setTimeout(() => finish(false), timeoutMs);
      const record = existing ?? {
        status: "pending" as const,
        sent: false,
        waiters: new Set<(acked: boolean) => void>(),
      };
      record.waiters.add(finish);
      this.#marks.set(markId, record);
    });
  }

  #reserveMark(name: string): boolean {
    this.#pruneStaleMarks();
    const existing = this.#marks.get(name);
    if (existing && (existing.status !== "pending" || existing.sent)) return false;
    if (!existing && this.#pendingMarkCount() >= MAX_PENDING_MARKS) {
      const error = providerError(
        TVIC_ERROR_CODES.providerStreamBufferOverflow,
        "pending playout mark limit exceeded",
        {
          provider: PROVIDER_NAMES.twilio,
          retriable: false,
        },
      );
      this.#pushEvent(this.#mediaError(error));
      this.#finishClose("error");
      return false;
    }
    this.#marks.set(
      name,
      existing ?? {
        status: "pending",
        sent: false,
        waiters: new Set(),
      },
    );
    return true;
  }

  #markSent(name: string): void {
    const record = this.#marks.get(name);
    if (record) record.sent = true;
  }

  #resolveMark(name: string): void {
    const record = this.#marks.get(name);
    // A mark is proof only for an outbound mark this handle created. Unknown
    // names are ignored so a forged/stale peer frame cannot make an arbitrary
    // `confirmPlayout` lookup succeed.
    if (!record) return;
    if (record.status === "pending") {
      record.status = "acked";
      record.resolvedAtMs = Date.now();
      this.#resolveMarkWaiters(record, true);
    } else if (record.status === "cleared" || record.status === "undelivered") {
      this.#resolveMarkWaiters(record, false);
    }
  }

  #markUndelivered(name: string): void {
    const record = this.#marks.get(name);
    if (!record) {
      this.#marks.set(name, {
        status: "undelivered",
        sent: false,
        waiters: new Set(),
        resolvedAtMs: Date.now(),
      });
      return;
    }
    if (record.status === "pending") {
      record.status = "undelivered";
      record.resolvedAtMs = Date.now();
      this.#resolveMarkWaiters(record, false);
    }
  }

  #markCleared(name: string): void {
    const record = this.#marks.get(name);
    if (!record) {
      this.#marks.set(name, {
        status: "cleared",
        sent: false,
        waiters: new Set(),
        resolvedAtMs: Date.now(),
      });
      return;
    }
    if (record.status === "pending") {
      record.status = "cleared";
      record.resolvedAtMs = Date.now();
      this.#resolveMarkWaiters(record, false);
    }
  }

  #invalidateClearedMarks(): void {
    for (const record of this.#marks.values()) {
      if (record.status === "pending" && record.sent) {
        record.status = "cleared";
        record.resolvedAtMs = Date.now();
        this.#resolveMarkWaiters(record, false);
      }
    }
  }

  #pruneStaleMarks(): void {
    const cutoff = Date.now() - MARK_RETENTION_MS;
    for (const [name, record] of this.#marks) {
      if (
        record.waiters.size === 0 &&
        record.resolvedAtMs !== undefined &&
        record.resolvedAtMs <= cutoff
      ) {
        this.#marks.delete(name);
      }
    }
  }

  #pendingMarkCount(): number {
    let count = 0;
    for (const record of this.#marks.values()) {
      if (record.status === "pending") count += 1;
    }
    return count;
  }

  #resolveMarkWaiters(record: MarkRecord, acked: boolean): void {
    const waiters = [...record.waiters];
    record.waiters.clear();
    for (const waiter of waiters) {
      waiter(acked);
    }
  }

  #closeEvents(): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#closed = true;
    this.#outbound.onTransportClosed();
    this.#events.close();
    // The call dropped: any output awaiting playout confirmation was not heard.
    for (const record of this.#marks.values()) {
      if (record.status === "pending") {
        record.status = "undelivered";
        record.resolvedAtMs = Date.now();
        this.#resolveMarkWaiters(record, false);
      }
    }
    // Safe to drop every record unconditionally: `confirmPlayout`'s `this.#closed`
    // check now answers `false` for any markId regardless of whether its record
    // still exists, so nothing depends on this map past this point.
    this.#marks.clear();
    this.options.onClosed?.();
  }
}
