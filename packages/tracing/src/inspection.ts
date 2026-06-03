import type { SpanId, TraceEvent, TraceId, TurnId } from "@tvic/core";

// Type-only import: the legacy timeline is now *derived from* this module, so the
// runtime dependency is one-directional (analysis.ts -> inspection.ts).
import type { TimelineInterruption, TurnView } from "./analysis.js";
import { coerceError, numberOr } from "./coerce.js";
import { buildFailure, classifyError, type FailureExplanation } from "./failure.js";
import { deriveTurnInspection, offsetOf, toEvidenceView, turnIdOf } from "./turn-analysis.js";
import type {
  CallInspection,
  CallStatus,
  CallSummary,
  DeriveCallInspectionOptions,
  EvidenceView,
  RecordingSummary,
  TurnInspection,
} from "./inspection-types.js";

// Re-export the view-model surface so the package index has one import home.
export type {
  CallInspection,
  CallStatus,
  CallSummary,
  DeriveCallInspectionOptions,
  EvidenceView,
  InterruptionView,
  LatencyBreakdown,
  LlmPassTiming,
  MemoryWriteView,
  PlayoutState,
  PlayoutView,
  RecordingSummary,
  ReplaySegment,
  ReplaySegmentKind,
  ReplayTrack,
  ToolCallView,
  TurnInspection,
  TurnInspectionStatus,
  TurnTag,
} from "./inspection-types.js";
export type {
  FailureCategory,
  FailureExplanation,
  FailureKind,
  FailureSeverity,
  IncidentKind,
  IncidentView,
} from "./failure.js";
export type { SpanKind, SpanView } from "./spans.js";

/**
 * Derives a stable, UI-ready inspection model from a call's raw trace stream (and,
 * when present, its artifact manifest). All semantic interpretation — failures,
 * incidents, latency, replay segments — lives in this module + turn-analysis.ts so
 * React renders dumb objects. Pure and total: it never throws on malformed input.
 */
export function deriveCallInspection(
  events: readonly TraceEvent[],
  options: DeriveCallInspectionOptions = {},
): CallInspection {
  const evidenceById: Record<string, EvidenceView> = {};
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let traceId: TraceId | undefined;

  // parentSpanId -> turnId, built ONLY from turn-scoped child events (never turn.started/
  // turn.ended, whose parent is the shared session span). Lets turn-less events
  // (memory.write, runtime.retry) attach to their turn via parentSpanId.
  const parentToTurn = new Map<SpanId, TurnId>();
  for (const event of events) {
    evidenceById[String(event.id)] = toEvidenceView(event);
    startMs = Math.min(startMs, offsetOf(event));
    endMs = Math.max(endMs, offsetOf(event));
    traceId ??= event.traceId;
    if (event.type === "turn.started" || event.type === "turn.ended") {
      continue;
    }
    const turnId = turnIdOf(event);
    if (turnId && event.parentSpanId) {
      parentToTurn.set(event.parentSpanId, turnId);
    }
  }
  if (!Number.isFinite(startMs)) {
    startMs = 0;
  }

  const byTurn = new Map<TurnId, TraceEvent[]>();
  const callLevel: TraceEvent[] = [];
  for (const event of events) {
    const turnId =
      turnIdOf(event) ?? (event.parentSpanId ? parentToTurn.get(event.parentSpanId) : undefined);
    if (turnId) {
      const list = byTurn.get(turnId) ?? [];
      list.push(event);
      byTurn.set(turnId, list);
    } else {
      callLevel.push(event);
    }
  }

  const turns = [...byTurn.entries()]
    .map(([turnId, turnEvents]) =>
      deriveTurnInspection(turnId, turnEvents, {
        inputTrackAvailable: options.inputTrackAvailable ?? false,
        outputTrackAvailable: options.outputTrackAvailable ?? false,
      }),
    )
    .sort((a, b) => a.startedMs - b.startedMs);

  // ----- Call-level status + failure -----
  const terminalSession = callLevel.find(
    (event) =>
      event.type === "session.completed" ||
      event.type === "session.failed" ||
      event.type === "session.cancelled",
  );
  const startEvent = callLevel.find(
    (event) => event.type === "session.created" || event.type === "session.started",
  );
  const status = callStatusFromSession(terminalSession, startEvent !== undefined);

  const startedAt = startEvent?.timestamp;
  const endedAt = terminalSession?.timestamp;

  let primaryFailure: FailureExplanation | undefined;
  if (terminalSession?.type === "session.failed") {
    const error = coerceError(terminalSession.error, "session.failed", "session failed");
    primaryFailure = buildFailure({
      kind: classifyError(error),
      occurredAtMs: offsetOf(terminalSession),
      evidenceEventIds: [terminalSession.id],
      error,
    });
  } else {
    primaryFailure = turns.find((turn) => turn.failure)?.failure;
  }

  // ----- Summary -----
  const retryCount = events.filter((event) => event.type === "runtime.retry").length;
  const slowest = slowestTurnId(turns);
  const responseLatencies = turns
    .map((turn) => turn.latency.firstAudioMs)
    .filter((value): value is number => typeof value === "number");
  const summary: CallSummary = {
    turnCount: turns.length,
    completedTurns: turns.filter((turn) => turn.status === "completed").length,
    failedTurns: turns.filter((turn) => turn.status === "failed").length,
    cancelledTurns: turns.filter((turn) => turn.status === "cancelled").length,
    interruptionCount: turns.reduce((total, turn) => total + turn.interruptions.length, 0),
    toolCallCount: turns.reduce((total, turn) => total + turn.tools.length, 0),
    retryCount,
    incidentCount: turns.reduce((total, turn) => total + turn.incidents.length, 0),
    completedTurnsWithIncidents: turns.filter(
      (turn) => turn.status === "completed" && turn.incidents.length > 0,
    ).length,
    ...(responseLatencies.length > 0
      ? {
          averageResponseLatencyMs:
            responseLatencies.reduce((sum, value) => sum + value, 0) / responseLatencies.length,
        }
      : {}),
    ...(slowest ? { slowestTurnId: slowest } : {}),
    ...(primaryFailure ? { primaryFailure } : {}),
  };

  // ----- Artifacts / degraded -----
  // The manifest is read off disk untrusted; every field below is defensive so a
  // malformed manifest (missing `privacy`, non-number `writeFailures`) can't throw.
  const manifest = options.manifest ?? null;
  const privacy = manifest?.privacy;
  const writeFailures = numberOr(manifest?.writeFailures, 0);
  const droppedEventCount = options.droppedEventCount ?? 0;
  const identityIncomplete = manifest?.integrity === "incomplete";
  const degraded =
    options.manifestMissing === true ||
    writeFailures > 0 ||
    droppedEventCount > 0 ||
    identityIncomplete;
  const artifactWarnings = [
    ...(options.manifestMissing ? ["Manifest missing — the call was never finalized."] : []),
    ...(writeFailures > 0
      ? [`${writeFailures} artifact write(s) failed; data may be missing.`]
      : []),
    ...(droppedEventCount > 0
      ? [`${droppedEventCount} corrupt trace line(s) skipped; this record is incomplete.`]
      : []),
    ...(identityIncomplete
      ? ["Manifest identity incomplete — no session/trace id was recorded."]
      : []),
    ...(options.artifactWarnings ?? []),
  ];

  const consentMode =
    privacy?.consentMode === "record" || privacy?.consentMode === "do_not_record"
      ? privacy.consentMode
      : "unknown";
  const recording: RecordingSummary = {
    consentMode,
    persistAudio: privacy?.persistAudio === true,
    redactPii: privacy?.redactPii === true,
    audioAvailable: Boolean(options.inputTrackAvailable || options.outputTrackAvailable),
    inputTrackAvailable: options.inputTrackAvailable ?? false,
    outputTrackAvailable: options.outputTrackAvailable ?? false,
  };

  return {
    ...((options.callId ?? manifest?.callId)
      ? { callId: options.callId ?? String(manifest?.callId) }
      : {}),
    ...(traceId ? { traceId } : {}),
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    degraded,
    artifactWarnings,
    summary,
    turns,
    timeline: {
      turns: turns.map(toTurnView),
      startMs,
      endMs,
      interruptions: summary.interruptionCount,
    },
    recording,
    replay: turns.flatMap((turn) => turn.replaySegments),
    evidenceById,
    rawEventCount: events.length,
  };
}

/**
 * Projects a v1 `TurnInspection` down to the legacy `TurnView` so the call list, the
 * latency CLI, and existing renderers keep one source of truth (this module) instead
 * of a parallel analyzer.
 */
export function toTurnView(turn: TurnInspection): TurnView {
  const interruptions: TimelineInterruption[] = turn.interruptions.map((interruption) => ({
    atMs: interruption.detectedMs ?? turn.startedMs,
    ...(interruption.framesSentBeforeCancel !== undefined
      ? { framesSent: interruption.framesSentBeforeCancel }
      : interruption.framesSent !== undefined
        ? { framesSent: interruption.framesSent }
        : {}),
  }));
  const l = turn.latency;
  return {
    turnId: turn.turnId,
    ...(turn.sequence !== undefined ? { sequence: turn.sequence } : {}),
    startMs: turn.startedMs,
    endMs: turn.endedMs,
    status: turn.status,
    ...(turn.callerText ? { transcript: turn.callerText } : {}),
    ...(turn.agentText ? { response: turn.agentText } : {}),
    interrupted: turn.interruptions.length > 0,
    interruptions,
    spans: turn.spans,
    metrics: {
      ...(l.endOfUtteranceMs !== undefined ? { endOfUtteranceMs: l.endOfUtteranceMs } : {}),
      ...(l.llmTtftMs !== undefined ? { ttftMs: l.llmTtftMs } : {}),
      ...(l.ttsTtfbMs !== undefined ? { ttfbMs: l.ttsTtfbMs } : {}),
      ...(l.firstAudioMs !== undefined ? { responseLatencyMs: l.firstAudioMs } : {}),
      ...(l.toolMs !== undefined ? { toolMs: l.toolMs } : {}),
      totalMs: l.totalMs,
    },
  };
}

function callStatusFromSession(
  event: TraceEvent | undefined,
  hasSessionStart: boolean,
): CallStatus {
  switch (event?.type) {
    case "session.completed":
      return "completed";
    case "session.failed":
      return "failed";
    case "session.cancelled":
      return "cancelled";
    default:
      // A session that started but has no terminal event is still in progress (a
      // partial / live-tailed trace), not "unknown".
      return hasSessionStart ? "active" : "unknown";
  }
}

function slowestTurnId(turns: readonly TurnInspection[]): TurnId | undefined {
  let best: TurnInspection | undefined;
  let bestMs = -1;
  for (const turn of turns) {
    const metric = turn.latency.firstAudioMs ?? turn.latency.totalMs ?? 0;
    if (metric > bestMs) {
      bestMs = metric;
      best = turn;
    }
  }
  return best?.turnId;
}
