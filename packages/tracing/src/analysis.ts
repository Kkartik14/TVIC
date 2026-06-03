import type { TraceEvent, TurnId } from "@tvic/core";

import { deriveCallInspection } from "./inspection.js";
import type { SpanView } from "./spans.js";

export type { SpanView } from "./spans.js";

export interface TurnMetrics {
  readonly responseLatencyMs?: number;
  /** Absolute monotonic offset (ms from call start) of the committing stt.final. */
  readonly endOfUtteranceMs?: number;
  readonly ttftMs?: number;
  readonly ttfbMs?: number;
  readonly toolMs?: number;
  readonly totalMs?: number;
}

export type TurnViewStatus = "active" | "completed" | "cancelled" | "failed";

/**
 * A single interruption marker on the legacy timeline waterfall (detection time +
 * discarded-frame outcome). The richer per-turn `InterruptionView` lives in the v1
 * inspection model; this minimal marker stays for the existing waterfall.
 */
export interface TimelineInterruption {
  readonly atMs: number;
  readonly framesSent?: number;
}

export interface TurnView {
  readonly turnId: TurnId;
  readonly sequence?: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: TurnViewStatus;
  readonly transcript?: string;
  readonly response?: string;
  readonly interrupted: boolean;
  readonly interruptions: readonly TimelineInterruption[];
  readonly spans: readonly SpanView[];
  readonly metrics: TurnMetrics;
}

export interface CallTimeline {
  readonly turns: readonly TurnView[];
  readonly startMs: number;
  readonly endMs: number;
  readonly interruptions: number;
}

/**
 * The legacy per-turn waterfall timeline. It is now a thin projection of
 * `deriveCallInspection` — the single analyzer — so transcript fallback, numeric
 * guards, and span attribution never drift between the two. The richer `CallInspection`
 * is the source of truth; `TurnView`/`CallTimeline` are the reduced shape kept for the
 * call list and the latency CLI.
 */
export function deriveCallTimeline(events: readonly TraceEvent[]): CallTimeline {
  return deriveCallInspection(events).timeline;
}
