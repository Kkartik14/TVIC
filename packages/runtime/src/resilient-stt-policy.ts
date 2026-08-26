import type { NormalizedError, SttTimestampOrigin, TranscriptEvent } from "@tvic/core";
import { providerError, STT_ERROR_CODES, validationError } from "@tvic/core";

import type { SttReconnectOptions } from "./resilient-stt.js";

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
  readonly maxBufferedCommands: number;
  readonly commitTimeoutMs: number;
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
  maxBufferedBytes: 320_000,
  maxBufferedCommands: 512,
  commitTimeoutMs: 5_000,
};

export function resolveOptions(options: SttReconnectOptions): ResolvedSttReconnectOptions {
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
    maxBufferedCommands: options.maxBufferedCommands ?? DEFAULT_OPTIONS.maxBufferedCommands,
    commitTimeoutMs: options.commitTimeoutMs ?? DEFAULT_OPTIONS.commitTimeoutMs,
  };
  validateInteger(resolved.maxAttempts, "maxAttempts", 0);
  if (typeof resolved.jitter !== "boolean") {
    throw validationError("stt.reconnect.options_invalid", "jitter must be a boolean");
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
  validatePositive(resolved.commitTimeoutMs, "commitTimeoutMs");
  if (resolved.maxBackoffMs < resolved.initialBackoffMs) {
    throw validationError(
      "stt.reconnect.options_invalid",
      "maxBackoffMs must be greater than or equal to initialBackoffMs",
    );
  }
  for (const [name, value] of [
    ["connectTimeoutMs", resolved.connectTimeoutMs],
    ["initialBackoffMs", resolved.initialBackoffMs],
    ["maxBackoffMs", resolved.maxBackoffMs],
    ["stableUptimeMs", resolved.stableUptimeMs],
    ["commitTimeoutMs", resolved.commitTimeoutMs],
  ] as const) {
    if (value > resolved.maxRecoveryDurationMs) {
      throw validationError(
        "stt.reconnect.options_invalid",
        `${name} cannot exceed maxRecoveryDurationMs`,
      );
    }
  }
  return resolved;
}

function validateInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw validationError(
      "stt.reconnect.options_invalid",
      `${name} must be an integer >= ${minimum}`,
    );
  }
}

function validatePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw validationError("stt.reconnect.options_invalid", `${name} must be positive`);
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

export async function withPreservedTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeout: NormalizedError,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeout), timeoutMs);
        timer.unref?.();
        if (signal) {
          onAbort = () => reject(signal.reason ?? timeout);
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function normalizeGenerationError(error: unknown, provider: string): NormalizedError {
  if (isNormalizedError(error)) {
    return error;
  }
  return providerError(STT_ERROR_CODES.protocolError, String(error), {
    provider,
    retriable: false,
    cause: error,
  });
}

function isNormalizedError(error: unknown): error is NormalizedError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    typeof (error as { readonly retriable?: unknown }).retriable === "boolean"
  );
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

export function bufferOverflowError(): NormalizedError {
  return providerError(STT_ERROR_CODES.bufferOverflow, "The bounded STT replay journal is full", {
    retriable: false,
  });
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
