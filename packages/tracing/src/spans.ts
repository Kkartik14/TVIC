import type { CorrelationId, NormalizedError, SpanId, TraceEventStatus, TurnId } from "@tvic/core";

/**
 * Span kinds the inspection model recognises. `speech` and `endpoint` are reserved:
 * they are only ever produced once the runtime emits VAD speech-boundary / endpoint
 * events (see the plan's data-availability matrix). Any unrecognised event `type`
 * falls through to its raw string, so a new event type never silently disappears.
 */
export type SpanKind =
  | "session"
  | "turn"
  | "speech"
  | "endpoint"
  | "stt"
  | "llm"
  | "tool"
  | "tts"
  | "audio.output"
  | "audio.input"
  | "barge_in"
  | "interrupt"
  | "output.cancelled"
  | "memory"
  | "runtime"
  | "call"
  | "media"
  | "silence";

/**
 * One derived span: a start event + its terminal event joined by `spanId`, collapsed
 * to a time range with a kind, status, and (when available) provider/error/turn
 * linkage. The legacy `TurnView` and the v1 `TurnInspection` share this shape; the
 * extra fields beyond the original waterfall set are optional so both producers stay
 * valid.
 */
export interface SpanView {
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: TraceEventStatus;
  readonly eventCount: number;
  readonly durationMs?: number;
  readonly label?: string;
  readonly provider?: string;
  readonly turnId?: TurnId;
  readonly correlationId?: CorrelationId;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly error?: NormalizedError;
}

// Longest-prefix wins; order matters only where one prefix is a prefix of another.
const SPAN_KINDS: ReadonlyArray<readonly [string, SpanKind]> = [
  ["audio.input", "audio.input"],
  ["audio.output", "audio.output"],
  ["output.cancelled", "output.cancelled"],
  ["stt", "stt"],
  ["llm", "llm"],
  ["tool", "tool"],
  ["tts", "tts"],
  ["barge_in", "barge_in"],
  ["interrupt", "interrupt"],
  ["turn", "turn"],
  ["session", "session"],
  ["memory", "memory"],
  ["runtime", "runtime"],
  ["call", "call"],
  ["media", "media"],
  ["speech", "speech"],
  ["silence", "silence"],
];

/** Maps a trace event `type` to its span kind (prefix match), falling back to the raw type. */
export function spanKind(type: string): string {
  for (const [prefix, kind] of SPAN_KINDS) {
    if (type === prefix || type.startsWith(`${prefix}.`)) {
      return kind;
    }
  }
  return type;
}
