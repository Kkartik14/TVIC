import { internalError, isNormalizedError } from "@tvic/core";
import type {
  CallArtifactManifest,
  CorrelationId,
  MediaEventId,
  NormalizedError,
  SpanId,
  Timestamp,
  ToolCallId,
  TraceEvent,
  TraceEventId,
  TraceEventStatus,
  TraceId,
  TurnId,
} from "@tvic/core";

// Type-only import: the legacy timeline is now *derived from* this module, so the
// runtime dependency is one-directional (analysis.ts -> inspection.ts).
import type { CallTimeline, TimelineInterruption, TurnView } from "./analysis.js";
import { spanKind, type SpanView } from "./spans.js";
import {
  buildFailure,
  buildIncident,
  classifyCancelReason,
  classifyError,
  toolErrorIncidentKind,
  type FailureExplanation,
  type IncidentView,
} from "./failure.js";

export type {
  FailureCategory,
  FailureExplanation,
  FailureKind,
  FailureSeverity,
  IncidentKind,
  IncidentView,
} from "./failure.js";
export type { SpanKind, SpanView } from "./spans.js";

// ---------- View-model types ----------

export type CallStatus = "completed" | "failed" | "cancelled" | "active" | "unknown";
export type TurnInspectionStatus = "completed" | "failed" | "cancelled" | "active";
export type TurnTag = "tool" | "interrupted" | "failed" | "cancelled" | "completed";

export interface LlmPassTiming {
  readonly passIndex: number;
  readonly kind: "initial" | "post_tool";
  readonly spanId: SpanId;
  readonly startedMs?: number;
  readonly firstTokenMs?: number;
  readonly completedMs?: number;
  readonly durationMs?: number;
  readonly toolCallIds: readonly ToolCallId[];
  /**
   * True when this post-tool pass follows a failed tool result the model recovered
   * from. Derived (not a distinct runtime-emitted LLM pass).
   */
  readonly recoveredFromToolFailure: boolean;
  readonly status: TraceEventStatus;
}

export interface LatencyBreakdown {
  /** Overlapping tags — a tool turn can also be interrupted or failed. */
  readonly turnTags: readonly TurnTag[];
  /** Endpoint delay (last speech frame -> commit). Null until VAD/endpoint events exist. */
  readonly endpointMs: number | null;
  readonly endpointAvailable: boolean;
  /** Absolute call-clock offset of the committing stt.final (the EOU marker). */
  readonly endOfUtteranceMs?: number;
  /** Endpoint -> stt.final. Unavailable (undefined) until endpoint events exist. */
  readonly sttFinalMs?: number;
  /** First LLM pass TTFT (EOU -> first token of the turn). */
  readonly llmTtftMs?: number;
  readonly llmTotalMs?: number;
  readonly llmPasses: readonly LlmPassTiming[];
  readonly toolMs?: number;
  readonly ttsTtfbMs?: number;
  readonly ttsTotalMs?: number;
  /** EOU -> first audio out (the headline response latency). */
  readonly firstAudioMs?: number;
  /** Playout duration from audio.output completion — not first-audio-to-confirmation. */
  readonly playoutMs?: number;
  /** Always derived (turn.ended duration, or observed span). */
  readonly totalMs: number;
  readonly bottleneck?: { readonly stage: string; readonly ms: number };
  readonly warnings: readonly string[];
}

export interface ToolCallView {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly attempts: number;
  readonly startedMs?: number;
  readonly durationMs?: number;
}

export type PlayoutState = "heard" | "unconfirmed" | "cancelled" | "none";

export interface PlayoutView {
  readonly state: PlayoutState;
  readonly framesSent: number;
  readonly playedMs?: number;
}

export interface InterruptionView {
  readonly turnId: TurnId;
  readonly detectedMs?: number;
  readonly handledMs?: number;
  readonly cancelledOutputMs?: number;
  readonly latencyMs?: number;
  readonly framesSent?: number;
  /** Derived from output-active / sent frames; does not claim byte-level heard audio. */
  readonly wasSpeaking: boolean;
  readonly framesSentBeforeCancel?: number;
  readonly reason?: string;
  readonly status: "handled" | "rejected" | "detected";
  readonly evidenceEventIds: readonly TraceEventId[];
}

export type ReplaySegmentKind =
  | "caller_speech"
  | "agent_sent"
  | "agent_heard"
  | "interruption"
  | "failure"
  | "tool_wait"
  | "silence";

export type ReplayTrack = "caller" | "agent" | "none";

export interface ReplaySegment {
  readonly id: string;
  readonly kind: ReplaySegmentKind;
  readonly label: string;
  readonly track: ReplayTrack;
  /** Call-clock monotonicOffsetMs — the seek contract; matches the aligned audio route. */
  readonly startMs: number;
  readonly endMs: number;
  readonly turnId?: TurnId;
  readonly spanId?: SpanId;
  readonly mediaEventIds: readonly MediaEventId[];
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface MemoryWriteView {
  readonly key: string;
  readonly scope: string;
  readonly mode: "put" | "append";
  readonly atMs: number;
}

export interface TurnInspection {
  readonly turnId: TurnId;
  readonly sequence?: number;
  readonly status: TurnInspectionStatus;
  readonly startedMs: number;
  readonly endedMs: number;
  readonly durationMs: number;
  readonly callerText?: string;
  readonly agentText?: string;
  readonly latency: LatencyBreakdown;
  readonly spans: readonly SpanView[];
  readonly tools: readonly ToolCallView[];
  readonly interruptions: readonly InterruptionView[];
  readonly playout: PlayoutView;
  readonly memoryWrites: readonly MemoryWriteView[];
  readonly failure?: FailureExplanation;
  readonly incidents: readonly IncidentView[];
  readonly replaySegments: readonly ReplaySegment[];
  readonly evidenceEventIds: readonly TraceEventId[];
}

export interface RecordingSummary {
  readonly consentMode: "record" | "do_not_record" | "unknown";
  readonly persistAudio: boolean;
  readonly redactPii: boolean;
  readonly audioAvailable: boolean;
  readonly inputTrackAvailable: boolean;
  readonly outputTrackAvailable: boolean;
}

export interface CallSummary {
  readonly turnCount: number;
  readonly completedTurns: number;
  readonly failedTurns: number;
  readonly cancelledTurns: number;
  readonly interruptionCount: number;
  readonly toolCallCount: number;
  readonly retryCount: number;
  readonly incidentCount: number;
  readonly completedTurnsWithIncidents: number;
  readonly averageResponseLatencyMs?: number;
  readonly slowestTurnId?: TurnId;
  readonly primaryFailure?: FailureExplanation;
}

export interface CallInspection {
  readonly callId?: string;
  readonly traceId?: TraceId;
  readonly status: CallStatus;
  readonly startedAt?: Timestamp;
  readonly endedAt?: Timestamp;
  /** Call-clock origin (min monotonicOffsetMs); the audio route aligns to this. */
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
  readonly degraded: boolean;
  readonly artifactWarnings: readonly string[];
  readonly summary: CallSummary;
  readonly turns: readonly TurnInspection[];
  /** The legacy waterfall timeline, reused so existing renderers keep working. */
  readonly timeline: CallTimeline;
  readonly recording: RecordingSummary;
  readonly replay: readonly ReplaySegment[];
  /** Evidence lookup so UI panels resolve evidenceEventIds without parsing raw JSON. */
  readonly eventsById: Readonly<Record<string, TraceEvent>>;
  readonly rawEventCount: number;
}

export interface DeriveCallInspectionOptions {
  readonly callId?: string;
  readonly manifest?: CallArtifactManifest | null;
  /** True when a manifest was expected but absent (close() never finished). */
  readonly manifestMissing?: boolean;
  readonly inputTrackAvailable?: boolean;
  readonly outputTrackAvailable?: boolean;
  readonly artifactWarnings?: readonly string[];
  /** Trace lines dropped by the loader as corrupt/invalid — makes the call degraded. */
  readonly droppedEventCount?: number;
}

const ENDPOINT_UNAVAILABLE = "endpoint timing unavailable (no VAD/endpoint events yet)";

// ---------- Derivation ----------

function offsetOf(event: TraceEvent): number {
  return event.monotonicOffsetMs;
}

function turnIdOf(event: TraceEvent): TurnId | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

/**
 * Derives a stable, UI-ready inspection model from a call's raw trace stream (and,
 * when present, its artifact manifest). All semantic interpretation — failures,
 * incidents, latency, replay segments — lives here so React renders dumb objects.
 * Pure and total: it never throws on malformed input.
 */
export function deriveCallInspection(
  events: readonly TraceEvent[],
  options: DeriveCallInspectionOptions = {},
): CallInspection {
  const eventsById: Record<string, TraceEvent> = {};
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let traceId: TraceId | undefined;

  // parentSpanId -> turnId, built ONLY from turn-scoped child events (never turn.started/
  // turn.ended, whose parent is the shared session span). Lets turn-less events
  // (memory.write, runtime.retry) attach to their turn via parentSpanId.
  const parentToTurn = new Map<SpanId, TurnId>();
  for (const event of events) {
    eventsById[String(event.id)] = event;
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
  const degraded = options.manifestMissing === true || writeFailures > 0 || droppedEventCount > 0;
  const artifactWarnings = [
    ...(options.manifestMissing ? ["Manifest missing — the call was never finalized."] : []),
    ...(writeFailures > 0
      ? [`${writeFailures} artifact write(s) failed; data may be missing.`]
      : []),
    ...(droppedEventCount > 0
      ? [`${droppedEventCount} corrupt trace line(s) skipped; this record is incomplete.`]
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
    eventsById,
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

interface TurnArtifactAvailability {
  readonly inputTrackAvailable: boolean;
  readonly outputTrackAvailable: boolean;
}

function deriveTurnInspection(
  turnId: TurnId,
  rawEvents: readonly TraceEvent[],
  availability: TurnArtifactAvailability,
): TurnInspection {
  const events = [...rawEvents].sort((a, b) => offsetOf(a) - offsetOf(b));
  const evidenceEventIds = events.map((event) => event.id);

  let sequence: number | undefined;
  let status: TurnInspectionStatus = "active";
  let turnEndedDurationMs: number | undefined;
  let cancelReason: string | undefined;
  let turnError: TraceEvent | undefined;

  let endOfUtteranceMs: number | undefined;
  let callerText: string | undefined;

  let ttsStartedMs: number | undefined;
  let firstTtsChunkMs: number | undefined;
  let ttsTotalMs: number | undefined;
  let firstAudioMs: number | undefined;
  let playoutMs: number | undefined;
  let toolMs = 0;
  let audioOutputEndedStatus: "succeeded" | "cancelled" | undefined;
  // runtime.timeout evidence for this turn (Phase 0 stall traces), so a timeout-cancel
  // explanation can point at the actual stall, not just output.cancelled.
  const stallEvidence: TraceEventId[] = [];
  let firstStallMs: number | undefined;

  const spans = new Map<SpanId, MutableSpan>();
  const llmPassBySpan = new Map<SpanId, MutableLlmPass>();
  const toolByCallId = new Map<ToolCallId, MutableTool>();
  // Tool failures are recorded raw and turned into incidents only AFTER the turn's
  // terminal status is known — a failure is "recovered" only if the turn completed.
  const toolFailures: {
    readonly id: TraceEventId;
    readonly offset: number;
    readonly error: NormalizedError;
    readonly toolName: string;
    readonly attempt: number;
  }[] = [];
  const memoryWrites: MemoryWriteView[] = [];
  const interruptions: InterruptionView[] = [];
  const incidents: IncidentView[] = [];

  // Interruption assembly state (one barge-in handled per turn in the current loop).
  let interruptDetectedMs: number | undefined;
  let interruptCause: string | undefined;
  let interruptHandledMs: number | undefined;
  let interruptLatencyMs: number | undefined;
  let outputCancelledMs: number | undefined;
  let framesSentAtCancel: number | undefined;
  const interruptEvidence: TraceEventId[] = [];

  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;

  for (const event of events) {
    const offset = offsetOf(event);
    startMs = Math.min(startMs, offset);
    endMs = Math.max(endMs, offset);
    accumulateSpan(spans, event);

    switch (event.type) {
      case "turn.started":
        sequence = event.sequence;
        break;
      case "turn.ended":
        turnEndedDurationMs = numberOrUndefined(event.durationMs);
        if (event.status === "succeeded") {
          status = "completed";
        } else if (event.status === "cancelled") {
          status = "cancelled";
          cancelReason = event.reason;
        } else {
          status = "failed";
          turnError = event;
        }
        break;
      case "stt.final":
        callerText = event.text;
        endOfUtteranceMs = offset;
        break;
      case "llm.started": {
        const pass = ensureLlmPass(llmPassBySpan, event.spanId);
        pass.startedMs = offset;
        break;
      }
      case "llm.token": {
        const pass = ensureLlmPass(llmPassBySpan, event.spanId);
        pass.firstTokenMs ??= offset;
        pass.tokenText += event.text;
        break;
      }
      case "llm.completed": {
        const pass = ensureLlmPass(llmPassBySpan, event.spanId);
        pass.completedMs = offset;
        pass.durationMs = numberOrUndefined(event.durationMs);
        // Some providers deliver the reply only on completion (no streamed tokens);
        // keep it as the pass's fallback transcript.
        if (typeof event.text === "string" && event.text.length > 0) {
          pass.completedText = event.text;
        }
        break;
      }
      case "llm.failed": {
        const pass = ensureLlmPass(llmPassBySpan, event.spanId);
        pass.completedMs = offset;
        pass.durationMs = numberOrUndefined(event.durationMs);
        pass.status = "failed";
        break;
      }
      case "tool.queued":
      case "tool.started": {
        const tool = ensureTool(toolByCallId, event.toolCallId, String(event.toolName));
        tool.startedMs ??= offset;
        tool.attempts = Math.max(tool.attempts, event.attempt);
        break;
      }
      case "tool.completed": {
        const tool = ensureTool(toolByCallId, event.toolCallId, String(event.toolName));
        tool.status = "succeeded";
        tool.attempts = Math.max(tool.attempts, event.attempt);
        tool.durationMs = numberOrUndefined(event.durationMs);
        toolMs += numberOr(event.durationMs, 0);
        break;
      }
      case "tool.failed":
      case "tool.timed_out": {
        const tool = ensureTool(toolByCallId, event.toolCallId, String(event.toolName));
        tool.status = event.type === "tool.timed_out" ? "timed_out" : "failed";
        tool.attempts = Math.max(tool.attempts, event.attempt);
        tool.durationMs = numberOrUndefined(event.durationMs);
        toolMs += numberOr(event.durationMs, 0);
        // Recorded raw; whether this is "recovered" or "unrecovered" depends on the
        // turn's terminal status, decided after the loop.
        toolFailures.push({
          id: event.id,
          offset,
          error: coerceError(event.error, "tool.failed", "tool failed"),
          toolName: String(event.toolName),
          attempt: event.attempt,
        });
        break;
      }
      case "tool.cancelled": {
        const tool = ensureTool(toolByCallId, event.toolCallId, String(event.toolName));
        tool.status = "cancelled";
        tool.attempts = Math.max(tool.attempts, event.attempt);
        tool.durationMs = numberOrUndefined(event.durationMs);
        break;
      }
      case "runtime.retry": {
        const cause = coerceError(event.cause, "runtime.retry", "retry");
        incidents.push(
          buildIncident({
            kind: "tool_retry",
            occurredAtMs: offset,
            evidenceEventIds: [event.id],
            message: `Retry ${event.attempt} of ${event.operation}: ${cause.message}`,
            error: cause,
            attempt: event.attempt,
          }),
        );
        break;
      }
      case "barge_in.rejected":
        incidents.push(
          buildIncident({
            kind: "rejected_barge_in",
            occurredAtMs: offset,
            evidenceEventIds: [event.id],
            message: `Barge-in candidate rejected (${event.reason}), confidence ${numberOr(
              event.confidence,
              0,
            ).toFixed(2)}.`,
          }),
        );
        break;
      case "runtime.timeout":
        stallEvidence.push(event.id);
        firstStallMs ??= offset;
        break;
      case "tts.started":
        ttsStartedMs ??= offset;
        break;
      case "tts.chunk":
        firstTtsChunkMs ??= offset;
        break;
      case "tts.completed":
        ttsTotalMs = numberOrUndefined(event.durationMs);
        break;
      case "audio.output.chunk":
        firstAudioMs ??= offset;
        break;
      case "audio.output.ended":
        audioOutputEndedStatus = event.status;
        playoutMs = numberOrUndefined(event.durationMs);
        break;
      case "interrupt.detected":
        interruptDetectedMs ??= offset;
        interruptCause = event.cause;
        interruptEvidence.push(event.id);
        break;
      case "interrupt.handled":
        interruptHandledMs ??= offset;
        interruptLatencyMs = event.durationMs;
        interruptEvidence.push(event.id);
        break;
      case "output.cancelled":
        outputCancelledMs ??= offset;
        framesSentAtCancel = event.framesSent;
        interruptEvidence.push(event.id);
        break;
      case "memory.write":
        memoryWrites.push({ key: event.key, scope: event.scope, mode: event.mode, atMs: offset });
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(startMs)) {
    startMs = 0;
  }
  const totalMs = turnEndedDurationMs ?? Math.max(0, endMs - startMs);

  // ----- Tool incidents (now that the terminal status is known) -----
  // A tool failure is "recovered" only if the turn actually completed; a turn that
  // failed/cancelled after a tool failure must not claim recovery.
  for (const failure of toolFailures) {
    const baseKind = toolErrorIncidentKind(failure.error.code);
    const kind =
      baseKind === "tool_failed_recovered" && status !== "completed"
        ? "tool_failed_unrecovered"
        : baseKind;
    incidents.push(
      buildIncident({
        kind,
        occurredAtMs: failure.offset,
        evidenceEventIds: [failure.id],
        message: failure.error.message,
        error: failure.error,
        toolName: failure.toolName,
        attempt: failure.attempt,
      }),
    );
  }
  incidents.sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  // ----- LLM passes (ordered; tool calls attributed to the initial pass) -----
  const toolCallIds = [...toolByCallId.keys()];
  const toolFailureOffsets = toolFailures.map((failure) => failure.offset);
  const sortedPasses = [...llmPassBySpan.values()].sort(
    (a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0),
  );
  const llmPasses: LlmPassTiming[] = sortedPasses.map((pass, index) => {
    // A post-tool pass recovered from a tool failure only if a tool actually failed in
    // the window between the previous pass and this one — not whenever ANY tool in the
    // whole turn failed (that would mis-mark a later pass following a successful tool).
    const prevStart = index > 0 ? (sortedPasses[index - 1]!.startedMs ?? -Infinity) : -Infinity;
    const thisStart = pass.startedMs ?? Infinity;
    const recoveredFromToolFailure =
      index > 0 && toolFailureOffsets.some((o) => o > prevStart && o <= thisStart);
    return {
      passIndex: index,
      kind: index === 0 ? "initial" : "post_tool",
      spanId: pass.spanId,
      ...(pass.startedMs !== undefined ? { startedMs: pass.startedMs } : {}),
      ...(pass.firstTokenMs !== undefined ? { firstTokenMs: pass.firstTokenMs } : {}),
      ...(pass.completedMs !== undefined ? { completedMs: pass.completedMs } : {}),
      ...(pass.durationMs !== undefined ? { durationMs: pass.durationMs } : {}),
      toolCallIds: index === 0 ? toolCallIds : [],
      recoveredFromToolFailure,
      status: pass.status,
    };
  });

  // Agent transcript: per pass, streamed tokens if any, else the completed-event text.
  const agentText = sortedPasses
    .map((pass) => (pass.tokenText.length > 0 ? pass.tokenText : (pass.completedText ?? "")))
    .join("");

  const firstTokenMs = llmPasses.find((pass) => pass.firstTokenMs !== undefined)?.firstTokenMs;
  const llmTtftMs =
    endOfUtteranceMs !== undefined && firstTokenMs !== undefined
      ? Math.max(0, firstTokenMs - endOfUtteranceMs)
      : undefined;
  const llmTotalMs = sumDefined(llmPasses.map((pass) => pass.durationMs));
  const ttsTtfbMs =
    ttsStartedMs !== undefined && firstTtsChunkMs !== undefined
      ? Math.max(0, firstTtsChunkMs - ttsStartedMs)
      : undefined;
  const responseLatencyMs =
    endOfUtteranceMs !== undefined && firstAudioMs !== undefined
      ? Math.max(0, firstAudioMs - endOfUtteranceMs)
      : undefined;

  const turnTags = deriveTurnTags(
    status,
    toolCallIds.length > 0,
    interruptDetectedMs !== undefined,
  );
  const warnings: string[] = [ENDPOINT_UNAVAILABLE];
  if (firstAudioMs === undefined && status === "completed") {
    warnings.push("no agent audio was produced for this turn");
  }

  const latency: LatencyBreakdown = {
    turnTags,
    endpointMs: null,
    endpointAvailable: false,
    ...(endOfUtteranceMs !== undefined ? { endOfUtteranceMs } : {}),
    ...(llmTtftMs !== undefined ? { llmTtftMs } : {}),
    ...(llmTotalMs !== undefined ? { llmTotalMs } : {}),
    llmPasses,
    ...(toolMs > 0 ? { toolMs } : {}),
    ...(ttsTtfbMs !== undefined ? { ttsTtfbMs } : {}),
    ...(ttsTotalMs !== undefined ? { ttsTotalMs } : {}),
    ...(responseLatencyMs !== undefined ? { firstAudioMs: responseLatencyMs } : {}),
    ...(playoutMs !== undefined ? { playoutMs } : {}),
    totalMs,
    warnings,
  };
  const bottleneck = deriveBottleneck(latency);
  const latencyWithBottleneck: LatencyBreakdown = bottleneck ? { ...latency, bottleneck } : latency;

  // ----- Playout -----
  const framesSent = framesSentAtCancel ?? 0;
  const playout: PlayoutView = {
    state: derivePlayoutState(firstAudioMs !== undefined, audioOutputEndedStatus, cancelReason),
    framesSent,
    ...(playoutMs !== undefined ? { playedMs: playoutMs } : {}),
  };

  // ----- Interruptions (the handled barge-in, if any) -----
  if (interruptDetectedMs !== undefined) {
    interruptions.push({
      turnId,
      detectedMs: interruptDetectedMs,
      ...(interruptHandledMs !== undefined ? { handledMs: interruptHandledMs } : {}),
      ...(outputCancelledMs !== undefined ? { cancelledOutputMs: outputCancelledMs } : {}),
      ...(interruptLatencyMs !== undefined ? { latencyMs: interruptLatencyMs } : {}),
      ...(framesSentAtCancel !== undefined ? { framesSent: framesSentAtCancel } : {}),
      wasSpeaking: (framesSentAtCancel ?? 0) > 0 || firstAudioMs !== undefined,
      ...(framesSentAtCancel !== undefined ? { framesSentBeforeCancel: framesSentAtCancel } : {}),
      ...(cancelReason
        ? { reason: cancelReason }
        : interruptCause
          ? { reason: interruptCause }
          : {}),
      status: "handled",
      evidenceEventIds: interruptEvidence,
    });
  }

  // ----- Terminal failure (only when the turn itself ended failed/cancelled) -----
  let failure: FailureExplanation | undefined;
  if (status === "failed" && turnError && turnError.type === "turn.ended" && "error" in turnError) {
    const error = coerceError(turnError.error, "turn.failed", "turn failed");
    failure = buildFailure({
      kind: classifyError(error),
      occurredAtMs: offsetOf(turnError),
      evidenceEventIds: failureEvidence(events, turnError.id),
      error,
    });
  } else if (status === "cancelled" && cancelReason) {
    // A timeout-cancel (interrupt timeout policy) must point at the runtime.timeout
    // stall evidence, not just output.cancelled — otherwise "provider stalled" has no
    // proof. Other cancels (barge-in) point at the interruption evidence.
    const cancelEvidence =
      cancelReason === "timeout" && stallEvidence.length > 0
        ? [...stallEvidence, ...interruptEvidence]
        : interruptEvidence.length > 0
          ? interruptEvidence
          : evidenceEventIds;
    failure = buildFailure({
      kind: classifyCancelReason(cancelReason),
      occurredAtMs:
        cancelReason === "timeout" && firstStallMs !== undefined
          ? firstStallMs
          : (outputCancelledMs ?? endMs),
      evidenceEventIds: cancelEvidence,
      messageOverride: cancelMessage(cancelReason),
    });
  }

  const tools: ToolCallView[] = [...toolByCallId.values()].map((tool) => ({
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    status: tool.status,
    attempts: tool.attempts,
    ...(tool.startedMs !== undefined ? { startedMs: tool.startedMs } : {}),
    ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
  }));

  const replaySegments = deriveReplaySegments({
    turnId,
    startMs,
    endOfUtteranceMs,
    firstAudioMs,
    audioEndMs: endMs,
    playoutState: playout.state,
    interruptDetectedMs,
    outputCancelledMs,
    failureAtMs: failure?.occurredAtMs,
    availability,
  });

  return {
    turnId,
    ...(sequence !== undefined ? { sequence } : {}),
    status,
    startedMs: startMs,
    endedMs: endMs,
    durationMs: totalMs,
    ...(callerText ? { callerText } : {}),
    ...(agentText ? { agentText } : {}),
    latency: latencyWithBottleneck,
    spans: [...spans.values()].map(finalizeSpan).sort((a, b) => a.startMs - b.startMs),
    tools,
    interruptions,
    playout,
    memoryWrites,
    ...(failure ? { failure } : {}),
    incidents,
    replaySegments,
    evidenceEventIds,
  };
}

// ---------- Span accumulation ----------

interface MutableSpan {
  spanId: SpanId;
  parentSpanId?: SpanId;
  kind: string;
  startMs: number;
  endMs: number;
  status: TraceEventStatus;
  eventCount: number;
  provider?: string;
  turnId?: TurnId;
  correlationId: CorrelationId;
  error?: NormalizedError;
  metadata?: Readonly<Record<string, unknown>>;
}

function accumulateSpan(spans: Map<SpanId, MutableSpan>, event: TraceEvent): void {
  const offset = offsetOf(event);
  const existing = spans.get(event.spanId);
  const error: NormalizedError | undefined = "error" in event ? event.error : undefined;
  if (existing) {
    existing.startMs = Math.min(existing.startMs, offset);
    existing.endMs = Math.max(existing.endMs, offset);
    existing.status = event.status;
    existing.eventCount += 1;
    if (event.provider) {
      existing.provider = event.provider;
    }
    if (error) {
      existing.error = error;
    }
    return;
  }
  const turnId = turnIdOf(event);
  spans.set(event.spanId, {
    spanId: event.spanId,
    ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
    kind: spanKind(event.type),
    startMs: offset,
    endMs: offset,
    status: event.status,
    eventCount: 1,
    correlationId: event.correlationId,
    ...(event.provider ? { provider: event.provider } : {}),
    ...(turnId ? { turnId } : {}),
    ...(error ? { error } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  });
}

function finalizeSpan(span: MutableSpan): SpanView {
  return {
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    kind: span.kind,
    startMs: span.startMs,
    endMs: span.endMs,
    durationMs: Math.max(0, span.endMs - span.startMs),
    status: span.status,
    eventCount: span.eventCount,
    label: span.kind,
    correlationId: span.correlationId,
    ...(span.provider ? { provider: span.provider } : {}),
    ...(span.turnId ? { turnId: span.turnId } : {}),
    ...(span.metadata ? { metadata: span.metadata } : {}),
    ...(span.error ? { error: span.error } : {}),
  };
}

// ---------- Small helpers ----------

interface MutableLlmPass {
  spanId: SpanId;
  startedMs?: number;
  firstTokenMs?: number;
  completedMs?: number;
  durationMs?: number | undefined;
  tokenText: string;
  completedText?: string;
  status: TraceEventStatus;
}

function ensureLlmPass(map: Map<SpanId, MutableLlmPass>, spanId: SpanId): MutableLlmPass {
  let pass = map.get(spanId);
  if (!pass) {
    pass = { spanId, status: "in_progress", tokenText: "" };
    map.set(spanId, pass);
  }
  return pass;
}

interface MutableTool {
  toolCallId: ToolCallId;
  toolName: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  attempts: number;
  startedMs?: number;
  durationMs?: number | undefined;
}

function ensureTool(
  map: Map<ToolCallId, MutableTool>,
  toolCallId: ToolCallId,
  toolName: string,
): MutableTool {
  let tool = map.get(toolCallId);
  if (!tool) {
    tool = { toolCallId, toolName, status: "failed", attempts: 1 };
    map.set(toolCallId, tool);
  }
  return tool;
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

// Defensive numeric reads: a trace field is typed `number`, but the analyzer ingests
// artifacts that may be corrupt/hand-edited, so a non-number must never string-concat
// into a metric or violate the view-model's numeric contract.
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// The loader validates only the trace-core envelope, so a core-valid event can still
// carry a malformed/absent `error`/`cause` payload. Coerce to a real NormalizedError
// so classification and rendering never throw on a corrupt artifact.
function coerceError(value: unknown, code: string, message: string): NormalizedError {
  return isNormalizedError(value) ? value : internalError(code, message);
}

function deriveTurnTags(
  status: TurnInspectionStatus,
  hadTool: boolean,
  interrupted: boolean,
): TurnTag[] {
  const tags: TurnTag[] = [];
  if (hadTool) {
    tags.push("tool");
  }
  if (interrupted) {
    tags.push("interrupted");
  }
  if (status === "failed") {
    tags.push("failed");
  } else if (status === "cancelled") {
    tags.push("cancelled");
  } else if (status === "completed") {
    tags.push("completed");
  }
  return tags;
}

function deriveBottleneck(
  latency: LatencyBreakdown,
): { readonly stage: string; readonly ms: number } | undefined {
  // Endpoint is intentionally excluded — it is unavailable until VAD events exist.
  const candidates: ReadonlyArray<readonly [string, number | undefined]> = [
    ["llm", latency.llmTotalMs ?? latency.llmTtftMs],
    ["tool", latency.toolMs],
    ["tts", latency.ttsTtfbMs],
    ["playout", latency.playoutMs],
  ];
  let best: { stage: string; ms: number } | undefined;
  for (const [stage, ms] of candidates) {
    if (typeof ms === "number" && (!best || ms > best.ms)) {
      best = { stage, ms };
    }
  }
  return best;
}

function derivePlayoutState(
  hadAudio: boolean,
  endedStatus: "succeeded" | "cancelled" | undefined,
  cancelReason: string | undefined,
): PlayoutState {
  if (!hadAudio) {
    // No audio frames were ever sent. A well-formed trace ends here with no audio.output
    // events at all ("none"); a malformed trace claiming a succeeded playout with zero
    // chunks must not be reported as "heard".
    return "none";
  }
  if (endedStatus === "succeeded") {
    return "heard";
  }
  if (cancelReason === "not_heard") {
    return "unconfirmed";
  }
  return "cancelled";
}

function cancelMessage(reason: string): string {
  switch (reason) {
    case "barge_in":
      return "Caller interrupted during agent playout; output was cancelled before it finished.";
    case "not_heard":
      return "Output was sent to the transport but playout was not confirmed before the call ended.";
    case "timeout":
      return "A provider stalled; the turn was cancelled under the interrupt timeout policy.";
    case "remote_hangup":
      return "The caller hung up before the reply finished.";
    default:
      return `Turn cancelled (${reason}).`;
  }
}

/** The failing provider/tool events plus the terminal turn.ended, as evidence. */
function failureEvidence(events: readonly TraceEvent[], turnEndedId: TraceEventId): TraceEventId[] {
  const failing = events
    .filter(
      (event) =>
        event.type === "llm.failed" ||
        event.type === "tool.failed" ||
        event.type === "tool.timed_out" ||
        event.type === "runtime.timeout",
    )
    .map((event) => event.id);
  return [...failing, turnEndedId];
}

interface ReplaySegmentInput {
  readonly turnId: TurnId;
  readonly startMs: number;
  readonly endOfUtteranceMs: number | undefined;
  readonly firstAudioMs: number | undefined;
  readonly audioEndMs: number;
  readonly playoutState: PlayoutState;
  readonly interruptDetectedMs: number | undefined;
  readonly outputCancelledMs: number | undefined;
  readonly failureAtMs: number | undefined;
  readonly availability: TurnArtifactAvailability;
}

function deriveReplaySegments(input: ReplaySegmentInput): ReplaySegment[] {
  const segments: ReplaySegment[] = [];

  // Caller speech: turn start -> end of utterance, on the caller track.
  if (input.endOfUtteranceMs !== undefined && input.endOfUtteranceMs > input.startMs) {
    segments.push({
      id: `${input.turnId}:caller`,
      kind: "caller_speech",
      label: "caller speech",
      track: "caller",
      startMs: input.startMs,
      endMs: input.endOfUtteranceMs,
      turnId: input.turnId,
      mediaEventIds: [],
      available: input.availability.inputTrackAvailable,
      ...(input.availability.inputTrackAvailable
        ? {}
        : { unavailableReason: "no caller audio track" }),
    });
  }

  // Agent output: first audio -> audio end. `agent_sent` is precise; `agent_heard`
  // exists only when playout was confirmed (turn-level fidelity, not byte-perfect).
  if (input.firstAudioMs !== undefined) {
    const agentEnd = Math.max(input.firstAudioMs, input.outputCancelledMs ?? input.audioEndMs);
    segments.push({
      id: `${input.turnId}:agent_sent`,
      kind: "agent_sent",
      label: "agent (sent)",
      track: "agent",
      startMs: input.firstAudioMs,
      endMs: agentEnd,
      turnId: input.turnId,
      mediaEventIds: [],
      available: input.availability.outputTrackAvailable,
      ...(input.availability.outputTrackAvailable
        ? {}
        : { unavailableReason: "no agent audio track" }),
    });
    const heard = input.playoutState === "heard";
    segments.push({
      id: `${input.turnId}:agent_heard`,
      kind: "agent_heard",
      label: "agent (heard)",
      track: "agent",
      startMs: input.firstAudioMs,
      endMs: agentEnd,
      turnId: input.turnId,
      mediaEventIds: [],
      available: heard && input.availability.outputTrackAvailable,
      ...(heard && input.availability.outputTrackAvailable
        ? {}
        : { unavailableReason: "playout not confirmed (turn-level heard fidelity)" }),
    });
  }

  if (input.interruptDetectedMs !== undefined) {
    segments.push({
      id: `${input.turnId}:interruption`,
      kind: "interruption",
      label: "interruption",
      track: "none",
      startMs: input.interruptDetectedMs,
      endMs: input.outputCancelledMs ?? input.interruptDetectedMs,
      turnId: input.turnId,
      mediaEventIds: [],
      available: false,
      unavailableReason: "marker only",
    });
  }

  if (input.failureAtMs !== undefined) {
    segments.push({
      id: `${input.turnId}:failure`,
      kind: "failure",
      label: "failure",
      track: "none",
      startMs: input.failureAtMs,
      endMs: input.failureAtMs,
      turnId: input.turnId,
      mediaEventIds: [],
      available: false,
      unavailableReason: "marker only",
    });
  }

  return segments;
}
