import { isNormalizedError } from "@tvic/core";
import type {
  CorrelationId,
  NormalizedError,
  SpanId,
  ToolCallId,
  TraceEvent,
  TraceEventId,
  TraceEventStatus,
  TurnId,
} from "@tvic/core";

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
import {
  coerceError,
  durationOr,
  durationOrUndefined,
  isPlainRecord,
  nonNegativeIntOr,
  numberOr,
  positiveIntOr,
  positiveIntOrUndefined,
  safeStringOr,
  safeStringOrUndefined,
} from "./coerce.js";
import type {
  EvidenceView,
  InterruptionView,
  LatencyBreakdown,
  LlmPassTiming,
  MemoryWriteView,
  PlayoutState,
  PlayoutView,
  ReplaySegment,
  ToolCallView,
  TurnArtifactAvailability,
  TurnInspection,
  TurnInspectionStatus,
  TurnTag,
} from "./inspection-types.js";

const ENDPOINT_UNAVAILABLE = "endpoint timing unavailable (no VAD/endpoint events yet)";

export function offsetOf(event: TraceEvent): number {
  return event.monotonicOffsetMs;
}

export function turnIdOf(event: TraceEvent): TurnId | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export function toEvidenceView(event: TraceEvent): EvidenceView {
  const error = "error" in event && isNormalizedError(event.error) ? event.error : undefined;
  const provider = safeStringOrUndefined(event.provider);
  return {
    eventId: event.id,
    type: event.type,
    offsetMs: event.monotonicOffsetMs,
    status: event.status,
    ...(provider ? { provider } : {}),
    ...(error ? { code: error.code, message: error.message } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
  };
}

export function deriveTurnInspection(
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
        sequence = positiveIntOrUndefined(event.sequence);
        break;
      case "turn.ended":
        turnEndedDurationMs = durationOrUndefined(event.durationMs);
        if (event.status === "succeeded") {
          status = "completed";
        } else if (event.status === "cancelled") {
          status = "cancelled";
          cancelReason = safeStringOr(event.reason, "unknown");
        } else {
          status = "failed";
          turnError = event;
        }
        break;
      case "stt.final":
        callerText = safeStringOrUndefined(event.text);
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
        pass.tokenText += safeStringOr(event.text, "");
        break;
      }
      case "llm.completed": {
        const pass = ensureLlmPass(llmPassBySpan, event.spanId);
        pass.completedMs = offset;
        pass.durationMs = durationOrUndefined(event.durationMs);
        // Some providers deliver the reply only on completion (no streamed tokens);
        // keep it as the pass's fallback transcript.
        const completedText = safeStringOrUndefined(event.text);
        if (completedText && completedText.length > 0) {
          pass.completedText = completedText;
        }
        break;
      }
      case "llm.failed": {
        const pass = ensureLlmPass(llmPassBySpan, event.spanId);
        pass.completedMs = offset;
        pass.durationMs = durationOrUndefined(event.durationMs);
        pass.status = "failed";
        break;
      }
      case "tool.queued":
      case "tool.started": {
        const tool = ensureToolForEvent(toolByCallId, event);
        tool.startedMs ??= offset;
        tool.attempts = Math.max(tool.attempts, positiveIntOr(event.attempt, 1));
        break;
      }
      case "tool.completed": {
        const tool = ensureToolForEvent(toolByCallId, event);
        tool.status = "succeeded";
        tool.attempts = Math.max(tool.attempts, positiveIntOr(event.attempt, 1));
        tool.durationMs = durationOrUndefined(event.durationMs);
        toolMs += durationOr(event.durationMs, 0);
        break;
      }
      case "tool.failed":
      case "tool.timed_out": {
        const identity = toolIdentityOf(event);
        const tool = ensureTool(toolByCallId, identity.toolCallId, identity.toolName);
        tool.status = event.type === "tool.timed_out" ? "timed_out" : "failed";
        tool.attempts = Math.max(tool.attempts, positiveIntOr(event.attempt, 1));
        tool.durationMs = durationOrUndefined(event.durationMs);
        toolMs += durationOr(event.durationMs, 0);
        // Recorded raw; whether this is "recovered" or "unrecovered" depends on the
        // turn's terminal status, decided after the loop.
        toolFailures.push({
          id: event.id,
          offset,
          error: coerceError(event.error, "tool.failed", "tool failed"),
          toolName: identity.toolName,
          attempt: positiveIntOr(event.attempt, 1),
        });
        break;
      }
      case "tool.cancelled": {
        const tool = ensureToolForEvent(toolByCallId, event);
        tool.status = "cancelled";
        tool.attempts = Math.max(tool.attempts, positiveIntOr(event.attempt, 1));
        tool.durationMs = durationOrUndefined(event.durationMs);
        break;
      }
      case "runtime.retry": {
        const cause = coerceError(event.cause, "runtime.retry", "retry");
        const attempt = positiveIntOr(event.attempt, 1);
        incidents.push(
          buildIncident({
            kind: "tool_retry",
            occurredAtMs: offset,
            evidenceEventIds: [event.id],
            message: `Retry ${attempt} of ${safeStringOr(event.operation, "operation")}: ${cause.message}`,
            error: cause,
            attempt,
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
            message: `Barge-in candidate rejected (${safeStringOr(
              event.reason,
              "unknown",
            )}), confidence ${numberOr(event.confidence, 0).toFixed(2)}.`,
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
        ttsTotalMs = durationOrUndefined(event.durationMs);
        break;
      case "audio.output.chunk":
        firstAudioMs ??= offset;
        break;
      case "audio.output.ended":
        audioOutputEndedStatus = outputEndedStatusOf(event.status);
        playoutMs = durationOrUndefined(event.durationMs);
        break;
      case "interrupt.detected":
        interruptDetectedMs ??= offset;
        interruptCause = safeStringOrUndefined(event.cause);
        interruptEvidence.push(event.id);
        break;
      case "interrupt.handled":
        interruptHandledMs ??= offset;
        interruptLatencyMs = durationOrUndefined(event.durationMs);
        interruptEvidence.push(event.id);
        break;
      case "output.cancelled":
        outputCancelledMs ??= offset;
        framesSentAtCancel = nonNegativeIntOr(event.framesSent, 0);
        interruptEvidence.push(event.id);
        break;
      case "memory.write":
        memoryWrites.push({
          key: safeStringOr(event.key, "(unknown)"),
          scope: safeStringOr(event.scope, "session"),
          mode: event.mode === "put" ? "put" : "append",
          atMs: offset,
        });
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
  // Guard the trust boundary: a core-valid event can carry a non-NormalizedError `error`
  // or non-object `metadata` from disk; never attach those raw to the span view.
  const error: NormalizedError | undefined =
    "error" in event && isNormalizedError(event.error) ? event.error : undefined;
  const metadata = isPlainRecord(event.metadata) ? event.metadata : undefined;
  const provider = safeStringOrUndefined(event.provider);
  if (existing) {
    existing.startMs = Math.min(existing.startMs, offset);
    existing.endMs = Math.max(existing.endMs, offset);
    existing.status = event.status;
    existing.eventCount += 1;
    if (provider) {
      existing.provider = provider;
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
    ...(provider ? { provider } : {}),
    ...(turnId ? { turnId } : {}),
    ...(error ? { error } : {}),
    ...(metadata ? { metadata } : {}),
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

type ToolTraceEvent = Extract<
  TraceEvent,
  | { readonly type: "tool.queued" }
  | { readonly type: "tool.started" }
  | { readonly type: "tool.completed" }
  | { readonly type: "tool.failed" }
  | { readonly type: "tool.timed_out" }
  | { readonly type: "tool.cancelled" }
>;

function toolIdentityOf(event: ToolTraceEvent): {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
} {
  return {
    toolCallId: safeStringOr(event.toolCallId, `${event.id}:tool`) as ToolCallId,
    toolName: safeStringOr(event.toolName, "(unknown tool)"),
  };
}

function ensureToolForEvent(map: Map<ToolCallId, MutableTool>, event: ToolTraceEvent): MutableTool {
  const identity = toolIdentityOf(event);
  return ensureTool(map, identity.toolCallId, identity.toolName);
}

function outputEndedStatusOf(value: unknown): "succeeded" | "cancelled" | undefined {
  return value === "succeeded" || value === "cancelled" ? value : undefined;
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
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
