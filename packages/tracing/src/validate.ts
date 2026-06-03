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

const TRACE_EVENT_TYPES = new Set<string>([
  "session.created",
  "session.started",
  "session.completed",
  "session.failed",
  "session.cancelled",
  "turn.started",
  "turn.ended",
  "call.created",
  "call.connected",
  "call.ended",
  "media.stream.started",
  "media.stream.ended",
  "audio.input.started",
  "audio.input.chunk",
  "audio.input.ended",
  "audio.output.started",
  "audio.output.chunk",
  "audio.output.ended",
  "speech.started",
  "speech.ended",
  "stt.started",
  "stt.partial",
  "stt.final",
  "stt.failed",
  "llm.started",
  "llm.token",
  "llm.completed",
  "llm.failed",
  "tool.queued",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.timed_out",
  "tool.cancelled",
  "tts.started",
  "tts.chunk",
  "tts.completed",
  "tts.failed",
  "barge_in.detected",
  "barge_in.rejected",
  "interrupt.detected",
  "interrupt.handled",
  "output.cancelled",
  "memory.read",
  "memory.write",
  "memory.delete",
  "runtime.retry",
  "runtime.timeout",
  "runtime.fallback",
]);

const TRACE_EVENT_STATUSES = new Set<string>([
  "started",
  "in_progress",
  "succeeded",
  "failed",
  "cancelled",
]);

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
  return (
    TRACE_EVENT_TYPES.has(event.type as string) &&
    TRACE_EVENT_STATUSES.has(event.status as string) &&
    typeof event.monotonicOffsetMs === "number" &&
    Number.isFinite(event.monotonicOffsetMs)
  );
}

/**
 * Parses a `call.jsonl` body into validated trace events, dropping (and counting) any
 * line that is not valid JSON or does not pass `isTraceEvent`. The single shared parser
 * for every artifact reader (viewer, latency CLI), so a corrupt line never throws and
 * never enters the analyzer half-formed. A positive `dropped` count means the record is
 * incomplete.
 */
export function parseTraceJsonl(jsonl: string): {
  readonly events: TraceEvent[];
  readonly dropped: number;
} {
  const events: TraceEvent[] = [];
  let dropped = 0;
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    if (isTraceEvent(parsed)) {
      events.push(parsed);
    } else {
      dropped += 1;
    }
  }
  return { events, dropped };
}
