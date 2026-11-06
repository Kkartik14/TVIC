import type { AudioFormat, NormalizedError, SttTimestampOrigin, TranscriptEvent } from "@tvic/core";
import {
  normalizeUnknownError,
  providerError,
  STT_ERROR_CODES,
  timeoutError,
  validationError,
  TvicThrowableError,
} from "@tvic/core";

import type { SttReconnectOptions } from "./resilient-stt.js";
import {
  DEFAULT_STT_MAX_BUFFERED_BYTES,
  DEFAULT_STT_MAX_BUFFERED_COMMANDS,
  STT_SEND_TIMEOUT_MS,
} from "./pipeline-constants.js";
import { DEFAULT_STT_AGENT_CONTEXT_TIMEOUT_MS } from "./stt-agent-context.js";

export interface ResolvedSttReconnectOptions {
  readonly maxAttempts: number;
  readonly connectTimeoutMs: number;
  readonly maxRecoveryDurationMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly jitter: boolean;
  readonly stableUptimeMs: number;
  readonly maxQuickFailures: number;
  readonly uncertainWindowMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedBytesExplicit: boolean;
  readonly maxBufferedCommands: number;
  readonly maxBufferedCommandsExplicit: boolean;
  readonly sendTimeoutMs: number;
  readonly contextUpdateTimeoutMs: number;
  readonly audioWriteTimeoutMs: number;
  readonly audioWriteErrorCode: string;
  readonly commitTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

const DEFAULT_OPTIONS: ResolvedSttReconnectOptions = {
  maxAttempts: 3,
  connectTimeoutMs: 10_000,
  maxRecoveryDurationMs: 30_000,
  initialBackoffMs: 250,
  maxBackoffMs: 4_000,
  jitter: true,
  stableUptimeMs: 5_000,
  maxQuickFailures: 3,
  uncertainWindowMs: 10_000,
  maxBufferedBytes: DEFAULT_STT_MAX_BUFFERED_BYTES,
  maxBufferedBytesExplicit: false,
  maxBufferedCommands: DEFAULT_STT_MAX_BUFFERED_COMMANDS,
  maxBufferedCommandsExplicit: false,
  sendTimeoutMs: STT_SEND_TIMEOUT_MS,
  contextUpdateTimeoutMs: DEFAULT_STT_AGENT_CONTEXT_TIMEOUT_MS,
  audioWriteTimeoutMs: STT_SEND_TIMEOUT_MS,
  audioWriteErrorCode: STT_ERROR_CODES.transportTimeout,
  commitTimeoutMs: 5_000,
  closeTimeoutMs: 5_000,
};

export function resolveOptions(options: SttReconnectOptions): ResolvedSttReconnectOptions {
  const sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_OPTIONS.sendTimeoutMs;
  const resolved: ResolvedSttReconnectOptions = {
    maxAttempts: options.maxAttempts ?? DEFAULT_OPTIONS.maxAttempts,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_OPTIONS.connectTimeoutMs,
    maxRecoveryDurationMs: options.maxRecoveryDurationMs ?? DEFAULT_OPTIONS.maxRecoveryDurationMs,
    initialBackoffMs: options.initialBackoffMs ?? DEFAULT_OPTIONS.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_OPTIONS.maxBackoffMs,
    jitter: options.jitter ?? DEFAULT_OPTIONS.jitter,
    stableUptimeMs: options.stableUptimeMs ?? DEFAULT_OPTIONS.stableUptimeMs,
    maxQuickFailures: options.maxQuickFailures ?? DEFAULT_OPTIONS.maxQuickFailures,
    uncertainWindowMs: options.uncertainWindowMs ?? DEFAULT_OPTIONS.uncertainWindowMs,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_OPTIONS.maxBufferedBytes,
    maxBufferedBytesExplicit: options.maxBufferedBytes !== undefined,
    maxBufferedCommands: options.maxBufferedCommands ?? DEFAULT_OPTIONS.maxBufferedCommands,
    maxBufferedCommandsExplicit: options.maxBufferedCommands !== undefined,
    sendTimeoutMs,
    contextUpdateTimeoutMs:
      options.contextUpdateTimeoutMs ?? DEFAULT_OPTIONS.contextUpdateTimeoutMs,
    // `audioWriteTimeoutMs` is the newer explicit name. Keep the main-branch
    // `sendTimeoutMs` alias behavior and error code when only that option is
    // supplied, while allowing the feature branch's canonical timeout to be
    // independently configured.
    audioWriteTimeoutMs:
      options.audioWriteTimeoutMs ?? options.sendTimeoutMs ?? DEFAULT_OPTIONS.audioWriteTimeoutMs,
    audioWriteErrorCode:
      options.audioWriteTimeoutMs !== undefined
        ? STT_ERROR_CODES.audioWriteTimeout
        : STT_ERROR_CODES.transportTimeout,
    commitTimeoutMs: options.commitTimeoutMs ?? DEFAULT_OPTIONS.commitTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_OPTIONS.closeTimeoutMs,
  };
  validateInteger(resolved.maxAttempts, "maxAttempts", 0);
  if (typeof resolved.jitter !== "boolean") {
    throw TvicThrowableError.from(
      validationError("stt.reconnect.options_invalid", "jitter must be a boolean"),
    );
  }
  validatePositive(resolved.connectTimeoutMs, "connectTimeoutMs");
  validatePositive(resolved.maxRecoveryDurationMs, "maxRecoveryDurationMs");
  validateInteger(resolved.initialBackoffMs, "initialBackoffMs", 0);
  validateInteger(resolved.maxBackoffMs, "maxBackoffMs", 0);
  validatePositive(resolved.stableUptimeMs, "stableUptimeMs");
  validateInteger(resolved.maxQuickFailures, "maxQuickFailures", 1);
  validateInteger(resolved.uncertainWindowMs, "uncertainWindowMs", 0);
  validateInteger(resolved.maxBufferedBytes, "maxBufferedBytes", 1);
  validateInteger(resolved.maxBufferedCommands, "maxBufferedCommands", 1);
  validatePositive(resolved.sendTimeoutMs, "sendTimeoutMs");
  validatePositive(resolved.contextUpdateTimeoutMs, "contextUpdateTimeoutMs");
  validatePositive(resolved.audioWriteTimeoutMs, "audioWriteTimeoutMs");
  validatePositive(resolved.commitTimeoutMs, "commitTimeoutMs");
  validatePositive(resolved.closeTimeoutMs, "closeTimeoutMs");
  if (resolved.maxBackoffMs < resolved.initialBackoffMs) {
    throw TvicThrowableError.from(
      validationError(
        "stt.reconnect.options_invalid",
        "maxBackoffMs must be greater than or equal to initialBackoffMs",
      ),
    );
  }
  return resolved;
}

const DEFAULT_STT_FRAME_DURATION_MS = 20;
const DEFAULT_STT_COMMAND_FRAME_DURATION_MS = 10;
const DEFAULT_STT_CONTROL_COMMAND_HEADROOM = 16;
const MAX_DERIVED_STT_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_DERIVED_STT_BUFFERED_COMMANDS = 8_192;

export function resolveStreamOptions(
  options: ResolvedSttReconnectOptions,
  format: AudioFormat,
): ResolvedSttReconnectOptions {
  const frameDurationMs = format.frameDurationMs ?? DEFAULT_STT_FRAME_DURATION_MS;
  const commandFrameDurationMs = format.frameDurationMs ?? DEFAULT_STT_COMMAND_FRAME_DURATION_MS;
  validateInteger(format.sampleRateHz, "format.sampleRateHz", 1);
  validateInteger(format.channels, "format.channels", 1);
  validatePositive(frameDurationMs, "format.frameDurationMs");
  validatePositive(commandFrameDurationMs, "format.frameDurationMs");

  const bufferedDurationMs =
    2 * options.uncertainWindowMs + options.maxRecoveryDurationMs + frameDurationMs;
  const bytesPerSample = format.encoding === "pcm_f32le" ? 4 : 2;
  const derivedBytes = clampDerivedLimit(
    Math.ceil(
      (format.sampleRateHz * format.channels * bytesPerSample * bufferedDurationMs) / 1_000,
    ),
    MAX_DERIVED_STT_BUFFERED_BYTES,
  );
  const derivedCommands = clampDerivedLimit(
    Math.ceil(bufferedDurationMs / commandFrameDurationMs) + DEFAULT_STT_CONTROL_COMMAND_HEADROOM,
    MAX_DERIVED_STT_BUFFERED_COMMANDS,
  );

  return {
    ...options,
    maxBufferedBytes: options.maxBufferedBytesExplicit ? options.maxBufferedBytes : derivedBytes,
    maxBufferedCommands: options.maxBufferedCommandsExplicit
      ? options.maxBufferedCommands
      : derivedCommands,
  };
}

function clampDerivedLimit(value: number, ceiling: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), ceiling) : ceiling;
}

function validateInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw TvicThrowableError.from(
      validationError("stt.reconnect.options_invalid", `${name} must be an integer >= ${minimum}`),
    );
  }
}

function validatePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw TvicThrowableError.from(
      validationError("stt.reconnect.options_invalid", `${name} must be positive`),
    );
  }
}

export function sameOptions(
  a: ResolvedSttReconnectOptions,
  b: ResolvedSttReconnectOptions,
): boolean {
  return Object.keys(DEFAULT_OPTIONS).every(
    (key) =>
      a[key as keyof ResolvedSttReconnectOptions] === b[key as keyof ResolvedSttReconnectOptions],
  );
}

export function withJitter(base: number, jitter: boolean): number {
  return jitter ? Math.floor(Math.random() * (base + 1)) : base;
}

export function audioWriteTimeoutError(
  code: string,
  message: string,
  provider?: string,
): NormalizedError {
  const canonicalCode =
    code === STT_ERROR_CODES.audioWriteTimeout ||
    code === "stt.audio_write_timeout" ||
    code === "stt.send_timeout"
      ? STT_ERROR_CODES.transportTimeout
      : code;
  return timeoutError(
    canonicalCode,
    message,
    provider ? { provider, retriable: false } : { retriable: false },
  );
}

export function normalizeGenerationError(error: unknown, provider: string): NormalizedError {
  return normalizeUnknownError(error, {
    code: STT_ERROR_CODES.protocolError,
    category: "provider",
    provider,
    retriable: false,
  });
}

export function isRecoveryExhausted(error: NormalizedError): boolean {
  return error.code === STT_ERROR_CODES.recoveryExhausted;
}

export function normalizeAudioOffsets(
  event: TranscriptEvent,
  origin: SttTimestampOrigin,
  offsetMs: number,
): TranscriptEvent {
  if (origin === "session" || offsetMs === 0) {
    return event;
  }
  if (event.type === "stt.endpoint" || event.type === "stt.speech.started") {
    return {
      ...event,
      ...(event.audioOffsetMs !== undefined
        ? { audioOffsetMs: event.audioOffsetMs + offsetMs }
        : {}),
    };
  }
  return {
    ...event,
    ...(event.audioStartMs !== undefined ? { audioStartMs: event.audioStartMs + offsetMs } : {}),
    ...(event.audioEndMs !== undefined ? { audioEndMs: event.audioEndMs + offsetMs } : {}),
  };
}

export type SttBufferOverflowLimit = "bytes" | "entries";

export function bufferOverflowError(
  limit: SttBufferOverflowLimit,
  configured: number,
  observed: number,
): NormalizedError {
  return providerError(STT_ERROR_CODES.bufferOverflow, "The bounded STT replay journal is full", {
    retriable: false,
    metadata: { limit, configured, observed },
  });
}

export function sessionBufferOverflowError(): NormalizedError {
  return providerError(
    STT_ERROR_CODES.sessionBufferOverflow,
    "The bounded STT event queue is full",
    {
      retriable: false,
    },
  );
}

export function recoveryExhaustedError(cause: unknown): NormalizedError {
  return providerError(STT_ERROR_CODES.recoveryExhausted, "STT reconnect recovery was exhausted", {
    retriable: false,
    cause,
  });
}

export function closedError(): NormalizedError {
  return providerError(STT_ERROR_CODES.closed, "The resilient STT stream is closed", {
    retriable: false,
  });
}
