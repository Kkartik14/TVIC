import {
  PCM16_8K_MONO,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  providerError,
  TvicThrowableError,
} from "@tvic/core";
import type { OutputMediaEvent, StreamEndReason } from "@tvic/core";
import { bytesToBase64, createAudioNormalizer, pcm16leToMulaw } from "@tvic/media";

import {
  MAX_PROVIDER_FRAME_BYTES,
  providerMonotonicNowMs,
  providerSendCapacity,
  safeSend,
  type ProviderClock,
} from "./common.js";
import { assertTwilioBoundaryFormat } from "./twilio-protocol.js";

export const TWILIO_MAX_AUDIO_EVENT_BYTES = 65_536;

const MAX_PENDING_OUTBOUND_OPERATIONS = 256;
const MAX_PENDING_OUTBOUND_DATA_OPERATIONS = 255;
const MAX_PENDING_OUTBOUND_BYTES = 1_048_576;
const MAX_PENDING_OUTBOUND_AUDIO_MS = 10_000;
const MAX_OUTBOUND_OPERATION_AGE_MS = 5_000;

export interface TwilioOutboundSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface TwilioOutboundMarkLedger {
  reserve(name: string): boolean;
  markSent(name: string): void;
  markUndelivered(name: string): void;
  markCleared(name: string): void;
  invalidateCleared(): void;
}

export interface TwilioOutboundQueueOptions {
  readonly socket: TwilioOutboundSocket;
  readonly clock: ProviderClock;
  readonly getStreamSid: () => string;
  readonly marks: TwilioOutboundMarkLedger;
  readonly isHandleClosed: () => boolean;
  readonly onCloseRequested: () => void;
  readonly onMediaError: (error: unknown) => void;
  readonly onFinishClose: (reason: StreamEndReason) => void;
}

interface TwilioOutboundCandidate {
  readonly kind: "data" | "control";
  readonly action: "data" | "clear" | "close";
  readonly frames: readonly string[];
  readonly sourceBytes: number;
  readonly generatedPcmBytes: number;
  readonly serializedBytes: number;
  readonly audioMs: number;
  readonly residualBytes: number;
  readonly markName?: string;
  readonly nextNormalizer?: ReturnType<typeof createAudioNormalizer>;
  readonly nextPending?: Uint8Array<ArrayBufferLike>;
  readonly previousNormalizer?: ReturnType<typeof createAudioNormalizer>;
  readonly previousPending?: Uint8Array<ArrayBufferLike>;
  readonly closeReason?: StreamEndReason;
}

interface TwilioOutboundOperation {
  readonly candidate: TwilioOutboundCandidate;
  readonly epoch: number;
  readonly admittedAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: boolean) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

/**
 * Owns Twilio's bounded, FIFO output state machine. Keeping admission,
 * cancellation, rollback, and write failure in one module prevents the call
 * handle from becoming a second transport implementation.
 */
export class TwilioOutboundQueue {
  readonly #options: TwilioOutboundQueueOptions;
  #outputNormalizer = createAudioNormalizer({
    inputFormat: PCM16_16K_MONO,
    outputFormat: PCM16_8K_MONO,
  });
  #outputPending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #queue: TwilioOutboundOperation[] = [];
  #running: TwilioOutboundOperation | null = null;
  #pumpScheduled = false;
  #epoch = 0;
  #pendingOperations = 0;
  #pendingDataOperations = 0;
  #pendingBytes = 0;
  #pendingAudioMs = 0;
  #controlPending = false;
  #clearPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #closeAfterControl: {
    readonly reason: StreamEndReason;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  } | null = null;
  #dataFence = false;
  #healthy = true;
  #closed = false;

  constructor(options: TwilioOutboundQueueOptions) {
    this.#options = options;
  }

  send(event: OutputMediaEvent): Promise<boolean> {
    if (this.#closed || this.#options.isHandleClosed()) return Promise.resolve(false);
    if (event.type === "media.stream.ended" || event.type === "media.error") {
      this.#options.onCloseRequested();
      const reason = event.type === "media.error" ? "error" : event.reason;
      return this.close(reason).then(() => true);
    }
    let candidate: TwilioOutboundCandidate;
    try {
      candidate = this.#buildCandidate(event);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#admit(candidate);
  }

  clear(): Promise<void> {
    if (this.#closed || this.#options.isHandleClosed()) return Promise.resolve();
    if (this.#clearPromise) {
      this.#cancelQueuedData("clear");
      this.#options.marks.invalidateCleared();
      this.#resetOutputState();
      return this.#clearPromise;
    }
    if (this.#closePromise) return this.#closePromise;
    this.#cancelQueuedData("clear");
    this.#options.marks.invalidateCleared();
    let candidate: TwilioOutboundCandidate;
    try {
      candidate = withSerializedBytes({
        kind: "control",
        action: "clear",
        frames: [this.#serialize({ event: "clear", streamSid: this.#options.getStreamSid() })],
        sourceBytes: 0,
        generatedPcmBytes: 0,
        serializedBytes: 0,
        audioMs: 0,
        residualBytes: 0,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    // Discard local residual audio before later candidates can be admitted
    // behind the clear barrier.
    this.#resetOutputState();
    const clearPromise = this.#admit(candidate).then((sent) => {
      if (sent) return;
      throw this.#transportWriteError("clear");
    });
    this.#clearPromise = clearPromise;
    const clearSettled = (): void => {
      if (this.#clearPromise === clearPromise) this.#clearPromise = null;
    };
    void clearPromise.then(clearSettled, clearSettled);
    return clearPromise;
  }

  close(reason: StreamEndReason): Promise<void> {
    if (this.#closed || this.#options.isHandleClosed()) return Promise.resolve();
    if (this.#closePromise) return this.#closePromise;
    this.#cancelQueuedData("close");
    this.#resetOutputState();
    if (this.#controlPending) {
      this.#closePromise = this.#waitForControlThenClose(reason);
      return this.#closePromise;
    }
    const candidate: TwilioOutboundCandidate = {
      kind: "control",
      action: "close",
      frames: [],
      sourceBytes: 0,
      generatedPcmBytes: 0,
      serializedBytes: 0,
      audioMs: 0,
      residualBytes: 0,
      closeReason: reason,
    };
    this.#closePromise = this.#admit(candidate).then((sent) => {
      if (sent) return;
      throw this.#transportWriteError("close");
    });
    return this.#closePromise;
  }

  onTransportClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    const transportError = this.#transportWriteError("close");
    for (const operation of this.#queue.splice(0)) {
      if (operation.candidate.markName !== undefined) {
        this.#options.marks.markUndelivered(operation.candidate.markName);
      }
      this.#settle(operation, false);
    }
    if (this.#closeAfterControl) {
      const pendingClose = this.#closeAfterControl;
      this.#closeAfterControl = null;
      pendingClose.reject(transportError);
    }
    this.#recomputeAccounting();
  }

  #buildCandidate(event: OutputMediaEvent): TwilioOutboundCandidate {
    if (event.type !== "media.audio.chunk" && event.type !== "media.audio.committed") {
      return {
        kind: "data",
        action: "data",
        frames: [],
        sourceBytes: 0,
        generatedPcmBytes: 0,
        serializedBytes: 0,
        audioMs: 0,
        residualBytes: this.#outputPending.byteLength,
      };
    }
    if (
      event.type === "media.audio.chunk" &&
      event.audio.bytes.byteLength > TWILIO_MAX_AUDIO_EVENT_BYTES
    ) {
      throw TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerInputRejected,
          `Twilio outbound audio event exceeds ${TWILIO_MAX_AUDIO_EVENT_BYTES} source bytes`,
          { provider: PROVIDER_NAMES.twilio, retriable: false },
        ),
      );
    }
    if (event.type === "media.audio.chunk") {
      assertTwilioBoundaryFormat(event.audio.format);
    }

    const previousNormalizer = this.#outputNormalizer;
    const previousPending = this.#outputPending;
    const normalizer = previousNormalizer.fork();
    const produced =
      event.type === "media.audio.chunk"
        ? normalizer.push(event.audio.bytes)
        : normalizer.finishSegment();
    const pending = appendBytes(this.#outputPending, produced);
    const flushed = frameTwilioOutput(pending, event.type === "media.audio.committed", (frame) =>
      this.#serialize({
        event: "media",
        streamSid: this.#options.getStreamSid(),
        media: { payload: bytesToBase64(pcm16leToMulaw(frame)) },
      }),
    );
    const frames = [...flushed.frames];
    const nextPending = flushed.pending;
    const markName = event.type === "media.audio.committed" ? String(event.id) : undefined;
    if (markName !== undefined) {
      frames.push(
        this.#serialize({
          event: "mark",
          streamSid: this.#options.getStreamSid(),
          mark: { name: markName },
        }),
      );
    }
    return withSerializedBytes({
      kind: "data",
      action: "data",
      frames,
      sourceBytes: event.type === "media.audio.chunk" ? event.audio.bytes.byteLength : 0,
      generatedPcmBytes: produced.byteLength,
      serializedBytes: 0,
      audioMs: (produced.byteLength / (2 * PCM16_8K_MONO.sampleRateHz)) * 1000,
      residualBytes: nextPending.byteLength,
      nextNormalizer: normalizer,
      nextPending,
      previousNormalizer,
      previousPending,
      ...(markName === undefined ? {} : { markName }),
    });
  }

  #admit(candidate: TwilioOutboundCandidate): Promise<boolean> {
    if (this.#closed || this.#options.isHandleClosed()) return Promise.resolve(false);
    if (candidate.kind === "data" && (this.#dataFence || !this.#healthy))
      return Promise.resolve(false);
    if (candidate.kind === "control" && this.#controlPending) return Promise.resolve(false);
    const previousResidualBytes = this.#outputPending.byteLength;
    const projectedBytes =
      this.#pendingBytes +
      candidate.serializedBytes +
      candidate.residualBytes -
      (candidate.kind === "data" ? previousResidualBytes : 0);
    const projectedOperations = this.#pendingOperations + 1;
    const projectedDataOperations =
      this.#pendingDataOperations + (candidate.kind === "data" ? 1 : 0);
    const projectedAudioMs = this.#pendingAudioMs + candidate.audioMs;
    if (
      projectedOperations > MAX_PENDING_OUTBOUND_OPERATIONS ||
      projectedDataOperations > MAX_PENDING_OUTBOUND_DATA_OPERATIONS ||
      projectedBytes > MAX_PENDING_OUTBOUND_BYTES ||
      projectedAudioMs > MAX_PENDING_OUTBOUND_AUDIO_MS
    ) {
      this.#reportAdmissionFailure("Twilio outbound admission limit exceeded");
      return Promise.resolve(false);
    }
    if (candidate.markName !== undefined && !this.#options.marks.reserve(candidate.markName)) {
      return Promise.resolve(false);
    }
    if (candidate.nextNormalizer) {
      this.#outputNormalizer = candidate.nextNormalizer;
      this.#outputPending = candidate.nextPending ?? new Uint8Array();
    }
    return new Promise<boolean>((resolve, reject) => {
      const operation = {
        candidate,
        epoch: this.#epoch,
        admittedAtMs: providerMonotonicNowMs(this.#options.clock),
        timer: setTimeout(() => undefined, MAX_OUTBOUND_OPERATION_AGE_MS),
        resolve,
        reject,
        settled: false,
      } satisfies TwilioOutboundOperation;
      clearTimeout(operation.timer);
      operation.timer = setTimeout(() => this.#expire(operation), MAX_OUTBOUND_OPERATION_AGE_MS);
      operation.timer.unref?.();
      this.#queue.push(operation);
      if (candidate.kind === "control") this.#controlPending = true;
      this.#recomputeAccounting();
      this.#schedulePump();
    });
  }

  #schedulePump(): void {
    if (this.#pumpScheduled) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#running || this.#queue.length === 0) return;
    const operation = this.#queue.shift();
    if (!operation || operation.settled) {
      this.#schedulePump();
      return;
    }
    this.#running = operation;
    let result = false;
    try {
      if (operation.epoch !== this.#epoch || this.#closed) {
        result = false;
      } else if (operation.candidate.action === "close") {
        this.#options.onFinishClose(operation.candidate.closeReason ?? "completed");
        result = true;
      } else if (operation.candidate.action === "clear") {
        result = this.#executeFrames(operation.candidate.frames, "clear");
        if (!result) {
          const error = this.#transportWriteError("clear");
          this.#settle(operation, undefined, error);
          return;
        }
      } else if (this.#dataFence || !this.#healthy) {
        result = false;
      } else {
        result = this.#executeFrames(operation.candidate.frames, "data");
        if (operation.candidate.markName !== undefined) {
          if (result) this.#options.marks.markSent(operation.candidate.markName);
          else this.#options.marks.markUndelivered(operation.candidate.markName);
        }
        if (!result) {
          this.#healthy = false;
          this.#dataFence = true;
        }
      }
      this.#settle(operation, result);
    } catch (error) {
      if (operation.candidate.markName !== undefined) {
        this.#options.marks.markUndelivered(operation.candidate.markName);
      }
      this.#settle(operation, undefined, error);
    } finally {
      this.#running = null;
      if (operation.candidate.kind === "control") this.#controlPending = false;
      this.#recomputeAccounting();
      if (this.#closeAfterControl && operation.candidate.action === "clear") {
        const after = this.#closeAfterControl;
        this.#closeAfterControl = null;
        this.#options.onFinishClose(after.reason);
        after.resolve();
      }
      this.#schedulePump();
    }
  }

  #executeFrames(frames: readonly string[], operation: "data" | "clear"): boolean {
    for (const frame of frames) {
      if (!this.#sendJson(frame)) {
        this.#handleWriteFailure(operation);
        return false;
      }
    }
    return true;
  }

  #handleWriteFailure(operation: "data" | "clear"): void {
    const error = this.#transportWriteError(operation);
    this.#healthy = false;
    this.#dataFence = true;
    this.#epoch += 1;
    this.#cancelQueuedData(error);
    this.#resetOutputState();
    this.#options.onMediaError(error);
    if (this.#closeAfterControl) {
      const pendingClose = this.#closeAfterControl;
      this.#closeAfterControl = null;
      pendingClose.reject(error);
    }
    this.#options.onFinishClose("error");
  }

  #settle(operation: TwilioOutboundOperation, value: boolean | undefined, error?: unknown): void {
    if (operation.settled) return;
    operation.settled = true;
    clearTimeout(operation.timer);
    if (error !== undefined) operation.reject(error);
    else operation.resolve(value ?? false);
  }

  #expire(operation: TwilioOutboundOperation): void {
    if (operation.settled) return;
    const elapsed = providerMonotonicNowMs(this.#options.clock) - operation.admittedAtMs;
    if (elapsed < MAX_OUTBOUND_OPERATION_AGE_MS) {
      operation.timer = setTimeout(
        () => this.#expire(operation),
        MAX_OUTBOUND_OPERATION_AGE_MS - Math.max(0, elapsed),
      );
      operation.timer.unref?.();
      return;
    }
    const error = TvicThrowableError.from(
      providerError(
        TVIC_ERROR_CODES.providerTransportTimeout,
        `Twilio outbound operation exceeded ${MAX_OUTBOUND_OPERATION_AGE_MS}ms`,
        {
          provider: PROVIDER_NAMES.twilio,
          retriable: false,
          metadata: { timeoutMs: MAX_OUTBOUND_OPERATION_AGE_MS },
        },
      ),
    );
    this.#dataFence = true;
    this.#healthy = false;
    this.#epoch += 1;
    this.#cancelQueuedData(error);
    this.#resetOutputState();
    this.#settle(operation, undefined, error);
    this.#options.onMediaError(error);
    if (this.#closeAfterControl) {
      const pendingClose = this.#closeAfterControl;
      this.#closeAfterControl = null;
      pendingClose.reject(error);
    }
    this.#options.onFinishClose("error");
    this.#recomputeAccounting();
  }

  #cancelQueuedData(reason: "clear" | "close" | unknown): void {
    const retained: TwilioOutboundOperation[] = [];
    let rollback:
      | {
          readonly normalizer: ReturnType<typeof createAudioNormalizer>;
          readonly pending: Uint8Array<ArrayBufferLike>;
        }
      | undefined;
    for (const operation of this.#queue) {
      if (operation.candidate.kind !== "data") {
        retained.push(operation);
        continue;
      }
      rollback ??=
        operation.candidate.previousNormalizer && operation.candidate.previousPending
          ? {
              normalizer: operation.candidate.previousNormalizer,
              pending: operation.candidate.previousPending,
            }
          : undefined;
      if (operation.candidate.markName !== undefined) {
        if (reason === "clear") this.#options.marks.markCleared(operation.candidate.markName);
        else this.#options.marks.markUndelivered(operation.candidate.markName);
      }
      if (reason instanceof Error || (typeof reason === "object" && reason !== null)) {
        this.#settle(operation, undefined, reason);
      } else {
        this.#settle(operation, false);
      }
    }
    this.#queue = retained;
    if (rollback) {
      this.#outputNormalizer = rollback.normalizer;
      this.#outputPending = rollback.pending;
    }
    this.#recomputeAccounting();
  }

  #recomputeAccounting(): void {
    const operations = [
      ...(this.#running && !this.#running.settled ? [this.#running] : []),
      ...this.#queue.filter((operation) => !operation.settled),
    ];
    this.#pendingOperations = operations.length;
    this.#pendingDataOperations = operations.filter(
      (operation) => operation.candidate.kind === "data",
    ).length;
    this.#pendingBytes =
      this.#outputPending.byteLength +
      operations.reduce((sum, operation) => sum + operation.candidate.serializedBytes, 0);
    this.#pendingAudioMs = operations.reduce(
      (sum, operation) => sum + operation.candidate.audioMs,
      0,
    );
  }

  #resetOutputState(): void {
    this.#outputNormalizer = createAudioNormalizer({
      inputFormat: PCM16_16K_MONO,
      outputFormat: PCM16_8K_MONO,
    });
    this.#outputPending = new Uint8Array();
  }

  #reportAdmissionFailure(message: string): void {
    const error = providerError(TVIC_ERROR_CODES.providerStreamBufferOverflow, message, {
      provider: PROVIDER_NAMES.twilio,
      retriable: false,
    });
    this.#options.onMediaError(error);
    this.#options.onFinishClose("error");
  }

  #serialize(message: unknown): string {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    if (Buffer.byteLength(data, "utf8") > MAX_PROVIDER_FRAME_BYTES) {
      throw TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerStreamBufferOverflow,
          "Twilio outbound frame exceeded its bound",
          { provider: PROVIDER_NAMES.twilio, retriable: false },
        ),
      );
    }
    return data;
  }

  #sendJson(message: unknown): boolean {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    const capacity = providerSendCapacity(this.#options.socket, data);
    if (capacity === "hard_limit" || capacity === "high_water") return false;
    return safeSend(this.#options.socket, data);
  }

  #transportWriteError(operation: string): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(
        TVIC_ERROR_CODES.providerTransportWriteFailed,
        `${PROVIDER_NAMES.twilio} ${operation} write was not accepted by the socket`,
        {
          provider: PROVIDER_NAMES.twilio,
          retriable: false,
          metadata: { operation },
        },
      ),
    );
  }

  #waitForControlThenClose(reason: StreamEndReason): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#closeAfterControl = { reason, resolve, reject };
    });
  }
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function withSerializedBytes(candidate: TwilioOutboundCandidate): TwilioOutboundCandidate {
  return {
    ...candidate,
    serializedBytes: candidate.frames.reduce(
      (total, frame) => total + Buffer.byteLength(frame, "utf8"),
      0,
    ),
  };
}

function frameTwilioOutput(
  pending: Uint8Array,
  final: boolean,
  encode: (frame: Uint8Array) => string,
): { readonly frames: readonly string[]; readonly pending: Uint8Array } {
  const frameBytes = 160 * 2;
  const frames: string[] = [];
  let offset = 0;
  while (pending.byteLength - offset >= frameBytes) {
    frames.push(encode(pending.slice(offset, offset + frameBytes)));
    offset += frameBytes;
  }
  if (final && offset < pending.byteLength) {
    frames.push(encode(pending.slice(offset)));
    offset = pending.byteLength;
  }
  return { frames, pending: offset === 0 ? pending : pending.slice(offset) };
}
