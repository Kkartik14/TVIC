import { internalError, isNormalizedError } from "@tvic/core";
import type { NormalizedError } from "@tvic/core";

// `isTraceEvent` validates only the trace-core envelope, so a core-valid event can
// still carry malformed per-event payload fields (a string `attempt`, an absent
// `error`, a non-object `metadata`). These coercions keep one bad event from pushing
// NaN / wrong types into the derived model, since the analyzer ingests artifacts that
// may be corrupt or hand-edited.

/** A finite number, or the fallback — never NaN / a string that would `+=`-concatenate. */
export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A positive integer (>= 1), or the fallback — for attempt/retry counts. */
export function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export function positiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

/** A non-negative integer (>= 0), or the fallback — for frame counts. */
export function nonNegativeIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/** A non-negative finite duration (ms), or undefined — never negative / NaN / string. */
export function durationOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A non-negative finite duration (ms), or the fallback — for accumulation. */
export function durationOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function safeStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function safeStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces an untrusted `error`/`cause` payload to a real NormalizedError so
 * classification and rendering never throw on a corrupt artifact.
 */
export function coerceError(value: unknown, code: string, message: string): NormalizedError {
  return isNormalizedError(value) ? value : internalError(code, message);
}
