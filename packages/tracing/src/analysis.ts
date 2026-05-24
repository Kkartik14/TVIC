import type { SpanId, TraceEvent, TraceEventStatus, TurnId } from "@tvic/core";

export interface SpanView {
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly kind: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly status: TraceEventStatus;
  readonly eventCount: number;
}

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

export interface InterruptionView {
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
  readonly interruptions: readonly InterruptionView[];
  readonly spans: readonly SpanView[];
  readonly metrics: TurnMetrics;
}

export interface CallTimeline {
  readonly turns: readonly TurnView[];
  readonly startMs: number;
  readonly endMs: number;
  readonly interruptions: number;
}

const SPAN_KINDS: ReadonlyArray<readonly [string, string]> = [
  ["audio.input", "audio.input"],
  ["audio.output", "audio.output"],
  ["stt", "stt"],
  ["llm", "llm"],
  ["tool", "tool"],
  ["tts", "tts"],
  ["barge_in", "barge_in"],
  ["interrupt", "interrupt"],
  ["output.cancelled", "output.cancelled"],
  ["turn", "turn"],
  ["session", "session"],
  ["memory", "memory"],
  ["runtime", "runtime"],
  ["call", "call"],
  ["media", "media"],
  ["speech", "speech"],
  ["silence", "silence"],
];

function spanKind(type: string): string {
  for (const [prefix, kind] of SPAN_KINDS) {
    if (type === prefix || type.startsWith(`${prefix}.`)) {
      return kind;
    }
  }
  return type;
}

interface SpanAccumulator {
  spanId: SpanId;
  parentSpanId?: SpanId;
  kind: string;
  startMs: number;
  endMs: number;
  status: TraceEventStatus;
  eventCount: number;
}

function turnIdOf(event: TraceEvent): TurnId | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

/**
 * Derives a per-turn view (spans + latency metrics + transcript) from a call's
 * raw trace stream. All timing is from `monotonicOffsetMs`, so it is correct
 * regardless of wall-clock skew. Pure: shared by the latency CLI and the viewer.
 */
export function deriveCallTimeline(events: readonly TraceEvent[]): CallTimeline {
  const byTurn = new Map<TurnId, TraceEvent[]>();
  let callStart = Number.POSITIVE_INFINITY;
  let callEnd = 0;

  for (const event of events) {
    callStart = Math.min(callStart, event.monotonicOffsetMs);
    callEnd = Math.max(callEnd, event.monotonicOffsetMs);
    const turnId = turnIdOf(event);
    if (!turnId) {
      continue;
    }
    const list = byTurn.get(turnId) ?? [];
    list.push(event);
    byTurn.set(turnId, list);
  }

  const turns = [...byTurn.entries()]
    .map(([turnId, turnEvents]) => deriveTurn(turnId, turnEvents))
    .sort((a, b) => a.startMs - b.startMs);

  return {
    turns,
    startMs: Number.isFinite(callStart) ? callStart : 0,
    endMs: callEnd,
    interruptions: turns.reduce((total, turn) => total + turn.interruptions.length, 0),
  };
}

function deriveTurn(turnId: TurnId, events: readonly TraceEvent[]): TurnView {
  const spans = new Map<SpanId, SpanAccumulator>();
  const interruptions: InterruptionView[] = [];
  let sequence: number | undefined;
  let status: TurnViewStatus = "active";
  let transcript: string | undefined;
  const responseParts: string[] = [];

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let endOfUtteranceMs: number | undefined;
  let firstTokenMs: number | undefined;
  let firstAudioMs: number | undefined;
  let ttsStartedMs: number | undefined;
  let firstTtsChunkMs: number | undefined;
  let toolMs = 0;
  let interrupted = false;

  for (const event of events) {
    startMs = Math.min(startMs, event.monotonicOffsetMs);
    endMs = Math.max(endMs, event.monotonicOffsetMs);

    const existing = spans.get(event.spanId);
    if (existing) {
      existing.startMs = Math.min(existing.startMs, event.monotonicOffsetMs);
      existing.endMs = Math.max(existing.endMs, event.monotonicOffsetMs);
      existing.status = event.status;
      existing.eventCount += 1;
    } else {
      spans.set(event.spanId, {
        spanId: event.spanId,
        ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
        kind: spanKind(event.type),
        startMs: event.monotonicOffsetMs,
        endMs: event.monotonicOffsetMs,
        status: event.status,
        eventCount: 1,
      });
    }

    switch (event.type) {
      case "turn.started":
        sequence = event.sequence;
        break;
      case "turn.ended":
        status =
          event.status === "succeeded"
            ? "completed"
            : event.status === "cancelled"
              ? "cancelled"
              : "failed";
        // turn.ended is already stamped at turn end; do NOT add durationMs (that
        // would double-count). The top-of-loop max(endMs, offset) covers it.
        break;
      case "stt.final":
        transcript = event.text;
        endOfUtteranceMs = event.monotonicOffsetMs;
        break;
      case "llm.token":
        firstTokenMs = firstTokenMs ?? event.monotonicOffsetMs;
        responseParts.push(event.text);
        break;
      case "tts.started":
        ttsStartedMs = ttsStartedMs ?? event.monotonicOffsetMs;
        break;
      case "tts.chunk":
        firstTtsChunkMs = firstTtsChunkMs ?? event.monotonicOffsetMs;
        break;
      case "audio.output.chunk":
        firstAudioMs = firstAudioMs ?? event.monotonicOffsetMs;
        break;
      case "tool.completed":
      case "tool.failed":
      case "tool.timed_out":
        toolMs += event.durationMs;
        break;
      case "interrupt.detected":
        // The canonical interruption marker: when the runtime decided to interrupt.
        interrupted = true;
        interruptions.push({ atMs: event.monotonicOffsetMs });
        break;
      case "barge_in.detected":
        // Raw detection signal; the runtime emits interrupt.detected when it acts.
        interrupted = true;
        break;
      case "output.cancelled":
        // Cancellation outcome — attach discarded-frames to the detection it follows.
        interrupted = true;
        if (interruptions.length > 0) {
          const last = interruptions[interruptions.length - 1];
          if (last) {
            interruptions[interruptions.length - 1] = { ...last, framesSent: event.framesSent };
          }
        } else {
          interruptions.push({ atMs: event.monotonicOffsetMs, framesSent: event.framesSent });
        }
        break;
      default:
        break;
    }
  }

  const metrics: TurnMetrics = {
    ...(endOfUtteranceMs !== undefined ? { endOfUtteranceMs } : {}),
    ...(endOfUtteranceMs !== undefined && firstTokenMs !== undefined
      ? { ttftMs: Math.max(0, firstTokenMs - endOfUtteranceMs) }
      : {}),
    ...(ttsStartedMs !== undefined && firstTtsChunkMs !== undefined
      ? { ttfbMs: Math.max(0, firstTtsChunkMs - ttsStartedMs) }
      : {}),
    ...(endOfUtteranceMs !== undefined && firstAudioMs !== undefined
      ? { responseLatencyMs: Math.max(0, firstAudioMs - endOfUtteranceMs) }
      : {}),
    ...(toolMs > 0 ? { toolMs } : {}),
    totalMs: Math.max(0, endMs - (Number.isFinite(startMs) ? startMs : 0)),
  };

  return {
    turnId,
    ...(sequence !== undefined ? { sequence } : {}),
    startMs: Number.isFinite(startMs) ? startMs : 0,
    endMs,
    status,
    ...(transcript ? { transcript } : {}),
    ...(responseParts.length > 0 ? { response: responseParts.join("") } : {}),
    interrupted,
    interruptions,
    spans: [...spans.values()].sort((a, b) => a.startMs - b.startMs),
    metrics,
  };
}
