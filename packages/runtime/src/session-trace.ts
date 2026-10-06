import type { NormalizedError, RuntimeSessionTrace, SessionEndEvent } from "@tvic/core";

const MAX_TRACE_TURNS = 500;
const MAX_TRACE_TOOL_CALLS = 1_000;

/** Projects a content-bearing session end event into TVIC's metadata-only trace contract. */
export function toRuntimeSessionTrace(event: SessionEndEvent): RuntimeSessionTrace {
  const turns = event.snapshot.turns;
  const toolCalls = event.snapshot.toolCalls;
  const selectedTurns = turns.slice(-MAX_TRACE_TURNS);
  const selectedToolCalls = toolCalls.slice(-MAX_TRACE_TOOL_CALLS);

  return {
    schemaVersion: 1,
    privacy: {
      classification: "metadata_only",
      excludes: [
        "transcripts",
        "audio",
        "tool_names",
        "tool_arguments",
        "tool_results",
        "provider_error_messages",
        "session_metadata",
        "variables",
        "memory",
      ],
    },
    session: {
      id: event.session.id,
      ...(event.session.callId ? { callId: event.session.callId } : {}),
      agentId: event.session.agentId,
      channel: event.session.channel,
      status: event.session.status,
      ...(event.session.terminalSource ? { terminalSource: event.session.terminalSource } : {}),
      createdAt: event.session.createdAt,
      startedAt: event.session.startedAt,
      endedAt: event.session.endedAt,
      ...(event.session.status === "failed" ? { error: traceError(event.session.error) } : {}),
    },
    snapshot: {
      status: event.snapshotStatus ?? "available",
      turnCount: turns.length,
      omittedTurnCount: turns.length - selectedTurns.length,
      toolCallCount: toolCalls.length,
      omittedToolCallCount: toolCalls.length - selectedToolCalls.length,
    },
    turns: selectedTurns.map((turn) => ({
      id: turn.id,
      sequence: turn.sequence,
      status: turn.status,
      startedAt: turn.startedAt,
      ...("endedAt" in turn ? { endedAt: turn.endedAt } : {}),
      latency: traceLatency(turn.latency),
      ...(turn.output.delivery ? { delivery: traceDelivery(turn.output.delivery) } : {}),
      ...(turn.status === "failed" ? { error: traceError(turn.error) } : {}),
    })),
    toolCalls: selectedToolCalls.map((call) => ({
      id: call.toolCallId,
      turnId: call.turnId,
      status: call.status,
      attempts: call.attempts,
      queuedAt: call.queuedAt,
      ...("startedAt" in call ? { startedAt: call.startedAt } : {}),
      ...("endedAt" in call ? { endedAt: call.endedAt } : {}),
      ...(isFailedToolCall(call) ? { error: traceError(call.error) } : {}),
    })),
  };
}

function traceLatency(
  latency: SessionEndEvent["snapshot"]["turns"][number]["latency"],
): RuntimeSessionTrace["turns"][number]["latency"] {
  return {
    ...(latency.listenedMs !== undefined ? { listenedMs: latency.listenedMs } : {}),
    ...(latency.endpointMs !== undefined ? { endpointMs: latency.endpointMs } : {}),
    ...(latency.firstTokenMs !== undefined ? { firstTokenMs: latency.firstTokenMs } : {}),
    ...(latency.firstAudioMs !== undefined ? { firstAudioMs: latency.firstAudioMs } : {}),
    ...(latency.toolMs !== undefined ? { toolMs: latency.toolMs } : {}),
    ...(latency.interruptionTailMs !== undefined
      ? { interruptionTailMs: latency.interruptionTailMs }
      : {}),
    ...(latency.totalMs !== undefined ? { totalMs: latency.totalMs } : {}),
    ...(latency.recoveryGapMs !== undefined ? { recoveryGapMs: latency.recoveryGapMs } : {}),
  };
}

function traceDelivery(
  delivery: NonNullable<SessionEndEvent["snapshot"]["turns"][number]["output"]["delivery"]>,
): NonNullable<RuntimeSessionTrace["turns"][number]["delivery"]> {
  return { audio: delivery.audio, text: delivery.text };
}

function isFailedToolCall(
  call: SessionEndEvent["snapshot"]["toolCalls"][number],
): call is Extract<SessionEndEvent["snapshot"]["toolCalls"][number], { readonly error: unknown }> {
  return "error" in call;
}

function traceError(error: NormalizedError): NonNullable<RuntimeSessionTrace["session"]["error"]> {
  return { code: error.code, category: error.category, retriable: error.retriable };
}
