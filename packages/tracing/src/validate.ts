import type { TraceEvent } from "@tvic/core";

// Every TraceEvent variant carries these core fields as non-empty strings (see
// TraceEventCore). A line missing any of them cannot be safely treated as a trace
// event — spans would collapse under `undefined` and evidence ids would be
// unresolvable — so the analyzer/loader must reject it rather than cast it.
const REQUIRED_STRING_FIELDS = [
  "id",
  "traceId",
  "sessionId",
  "timestamp",
  "spanId",
  "correlationId",
  "type",
  "status",
] as const;

/**
 * Structural validator for a single parsed trace record. Returns true only when the
 * value has every required trace-core string field plus a finite `monotonicOffsetMs`.
 * This is the trust boundary for artifacts read off disk, which may be corrupt or
 * partially written. It validates the core envelope, not every per-type field.
 */
export function isTraceEvent(value: unknown): value is TraceEvent {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const event = value as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    const fieldValue = event[field];
    if (typeof fieldValue !== "string" || fieldValue.length === 0) {
      return false;
    }
  }
  return typeof event.monotonicOffsetMs === "number" && Number.isFinite(event.monotonicOffsetMs);
}
