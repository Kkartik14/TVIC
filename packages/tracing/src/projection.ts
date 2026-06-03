import { mediaError } from "@tvic/core";
import type {
  AgentId,
  EndSessionRequest,
  EndTurnRequest,
  IdGenerator,
  InputMediaEvent,
  LlmStreamEvent,
  MediaEventId,
  MemoryRef,
  NormalizedError,
  SessionId,
  SpanId,
  CorrelationId,
  TerminalSession,
  TerminalTurn,
  Timestamp,
  ToolCallId,
  ToolDefinition,
  ToolId,
  ToolName,
  TraceEvent,
  TraceEventId,
  TraceId,
  TranscriptEvent,
  TurnId,
} from "@tvic/core";

export interface TraceCoreInput {
  readonly id: TraceEventId;
  readonly traceId: TraceId;
  readonly sessionId: SessionId;
  readonly timestamp: Timestamp;
  readonly monotonicOffsetMs: number;
  readonly spanId: SpanId;
  readonly correlationId: CorrelationId;
  readonly parentSpanId?: SpanId;
}

export function traceCore(input: TraceCoreInput): TraceCoreInput {
  return {
    id: input.id,
    traceId: input.traceId,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    monotonicOffsetMs: input.monotonicOffsetMs,
    spanId: input.spanId,
    correlationId: input.correlationId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
  };
}

export function sessionCreatedTrace(core: TraceCoreInput, agentId: AgentId): TraceEvent {
  return {
    ...traceCore(core),
    type: "session.created",
    status: "succeeded",
    agentId,
  };
}

export function sessionStartedTrace(core: TraceCoreInput): TraceEvent {
  return {
    ...traceCore(core),
    type: "session.started",
    status: "succeeded",
  };
}

export function turnStartedTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  sequence: number,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "turn.started",
    status: "started",
    turnId,
    sequence,
  };
}

export function turnEndTrace(
  core: TraceCoreInput,
  turn: TerminalTurn,
  request: EndTurnRequest,
  durationMs: number,
): TraceEvent {
  const base = {
    ...traceCore(core),
    type: "turn.ended" as const,
    turnId: turn.id,
    durationMs,
  };

  switch (turn.status) {
    case "completed":
      return { ...base, status: "succeeded" };
    case "cancelled":
      return {
        ...base,
        status: "cancelled",
        reason: request.reason === "cancelled" ? request.cancelReason : turn.reason,
      };
    case "failed":
      return { ...base, status: "failed", error: turn.error };
  }
}

export function sessionEndTrace(
  id: TraceEventId,
  session: TerminalSession,
  request: EndSessionRequest,
  durationMs: number,
  spanId: SpanId,
  correlationId: CorrelationId,
): TraceEvent {
  const core = {
    id,
    traceId: session.traceId,
    sessionId: session.id,
    timestamp: session.endedAt,
    monotonicOffsetMs: durationMs,
    spanId,
    correlationId,
  };

  if (session.status === "completed") {
    return {
      ...core,
      type: "session.completed",
      status: "succeeded",
      durationMs,
    };
  }

  if (session.status === "cancelled") {
    return {
      ...core,
      type: "session.cancelled",
      status: "cancelled",
      durationMs,
      cancelReason: request.reason === "cancelled" ? request.cancelReason : "cancelled",
    };
  }

  return {
    ...core,
    type: "session.failed",
    status: "failed",
    durationMs,
    error: session.error,
  };
}

export function mediaEventTrace(
  ids: IdGenerator,
  id: TraceEventId,
  traceId: TraceId,
  event: InputMediaEvent,
): TraceEvent | null {
  const spanId = event.spanId ?? ids.span();
  const correlationId = event.correlationId ?? ids.correlation();
  const metadata = event.metadata ? { metadata: event.metadata } : {};
  switch (event.type) {
    case "media.stream.started":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        timestamp: event.timestamp,
        monotonicOffsetMs: event.monotonicOffsetMs,
        spanId,
        correlationId,
        ...metadata,
        type: "media.stream.started",
        status: "succeeded",
        direction: "input",
      };
    case "media.stream.ended":
      return event.reason === "error"
        ? {
            id,
            traceId,
            sessionId: event.sessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            timestamp: event.timestamp,
            monotonicOffsetMs: event.monotonicOffsetMs,
            spanId,
            correlationId,
            ...metadata,
            type: "media.stream.ended",
            status: "failed",
            direction: "input",
            durationMs: event.durationMs,
            error: mediaError("media.stream.error"),
          }
        : {
            id,
            traceId,
            sessionId: event.sessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            timestamp: event.timestamp,
            monotonicOffsetMs: event.monotonicOffsetMs,
            spanId,
            correlationId,
            ...metadata,
            type: "media.stream.ended",
            status: "succeeded",
            direction: "input",
            durationMs: event.durationMs,
          };
    case "media.audio.chunk":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.timestamp,
        monotonicOffsetMs: event.monotonicOffsetMs,
        spanId,
        correlationId,
        ...metadata,
        type: "audio.input.chunk",
        status: "in_progress",
        mediaEventId: event.id,
        frameCount: event.audio.frameCount,
        durationMs: event.audio.durationMs,
      };
    case "speech.started":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.timestamp,
        monotonicOffsetMs: event.monotonicOffsetMs,
        spanId,
        correlationId,
        ...metadata,
        type: "speech.started",
        status: "started",
      };
    case "speech.ended":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.timestamp,
        monotonicOffsetMs: event.monotonicOffsetMs,
        spanId,
        correlationId,
        ...metadata,
        type: "speech.ended",
        status: "succeeded",
        durationMs: event.durationMs,
      };
    case "barge_in.detected": {
      const turnId = event.turnId ?? event.againstTurnId;
      return turnId
        ? {
            id,
            traceId,
            sessionId: event.sessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            turnId,
            timestamp: event.timestamp,
            monotonicOffsetMs: event.monotonicOffsetMs,
            spanId,
            correlationId,
            ...metadata,
            type: "barge_in.detected",
            status: "succeeded",
            confidence: event.confidence,
          }
        : null;
    }
    case "media.error":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        timestamp: event.timestamp,
        monotonicOffsetMs: event.monotonicOffsetMs,
        spanId,
        correlationId,
        ...metadata,
        type: "media.stream.ended",
        status: "failed",
        direction: "input",
        durationMs: 0,
        error: event.error,
      };
    case "dtmf.received":
    case "silence.started":
    case "silence.ended":
      return null;
  }
}

export function sttFinalTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  transcript: string,
  event: TranscriptEvent,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "stt.final",
    status: "succeeded",
    turnId,
    text: transcript,
    ...(typeof event.confidence === "number" ? { confidence: event.confidence } : {}),
    durationMs: 0,
    provider: event.provider,
  };
}

export function llmStreamTrace(
  core: TraceCoreInput,
  event: LlmStreamEvent,
  model: string,
  durationMs: number,
): TraceEvent | null {
  switch (event.type) {
    case "llm.started":
      return {
        ...traceCore(core),
        type: "llm.started",
        status: "started",
        turnId: event.turnId,
        model: event.model,
      };
    case "llm.token":
      return {
        ...traceCore(core),
        type: "llm.token",
        status: "in_progress",
        turnId: event.turnId,
        text: event.text,
      };
    case "llm.completed":
      return {
        ...traceCore(core),
        type: "llm.completed",
        status: "succeeded",
        turnId: event.turnId,
        model,
        durationMs,
        ...(event.text ? { text: event.text } : {}),
        ...(event.usage
          ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }
          : {}),
      };
    case "llm.failed":
      return {
        ...traceCore(core),
        type: "llm.failed",
        status: "failed",
        turnId: event.turnId,
        model,
        durationMs,
        error: event.error,
      };
    case "llm.tool_call":
      return null;
  }
}

export function toolQueuedTrace(
  core: TraceCoreInput,
  tool: ToolDefinition,
  toolCallId: ToolCallId,
  turnId: TurnId,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tool.queued",
    status: "started",
    toolId: tool.id,
    toolName: tool.name,
    toolCallId,
    turnId,
    attempt: 1,
  };
}

export function toolStartedTrace(
  core: TraceCoreInput,
  tool: ToolDefinition,
  toolCallId: ToolCallId,
  turnId: TurnId,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tool.started",
    status: "in_progress",
    toolId: tool.id,
    toolName: tool.name,
    toolCallId,
    turnId,
    attempt: 1,
  };
}

export function toolCompletedTrace(
  core: TraceCoreInput,
  tool: ToolDefinition,
  toolCallId: ToolCallId,
  turnId: TurnId,
  attempt: number,
  durationMs: number,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tool.completed",
    status: "succeeded",
    toolId: tool.id,
    toolName: tool.name,
    toolCallId,
    turnId,
    attempt,
    durationMs,
  };
}

export function toolNotFoundTrace(
  core: TraceCoreInput,
  toolName: ToolName,
  toolCallId: ToolCallId,
  turnId: TurnId,
  error: NormalizedError,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tool.failed",
    status: "failed",
    toolId: "unknown" as ToolId,
    toolName,
    toolCallId,
    turnId,
    attempt: 1,
    durationMs: 0,
    error,
  };
}

export function toolFailedTrace(
  core: TraceCoreInput,
  tool: ToolDefinition,
  toolCallId: ToolCallId,
  turnId: TurnId,
  type: "tool.failed" | "tool.timed_out",
  attempt: number,
  durationMs: number,
  error: NormalizedError,
): TraceEvent {
  return {
    ...traceCore(core),
    type,
    status: "failed",
    toolId: tool.id,
    toolName: tool.name,
    toolCallId,
    turnId,
    attempt,
    durationMs,
    error,
  };
}

export function toolCancelledTrace(
  core: TraceCoreInput,
  tool: ToolDefinition,
  toolCallId: ToolCallId,
  turnId: TurnId,
  attempt: number,
  durationMs: number,
  reason: string,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tool.cancelled",
    status: "cancelled",
    toolId: tool.id,
    toolName: tool.name,
    toolCallId,
    turnId,
    attempt,
    durationMs,
    reason,
  };
}

export function ttsStartedTrace(core: TraceCoreInput, turnId: TurnId, voice?: string): TraceEvent {
  return {
    ...traceCore(core),
    type: "tts.started",
    status: "started",
    turnId,
    ...(voice ? { voice } : {}),
  };
}

export function ttsChunkTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  mediaEventId: MediaEventId,
  frameCount: number,
  durationMs: number,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tts.chunk",
    status: "in_progress",
    turnId,
    mediaEventId,
    frameCount,
    durationMs,
  };
}

export function ttsCompletedTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  durationMs: number,
  totalFrames: number,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "tts.completed",
    status: "succeeded",
    turnId,
    durationMs,
    totalFrames,
  };
}

export function audioOutputStartedTrace(core: TraceCoreInput, turnId: TurnId): TraceEvent {
  return {
    ...traceCore(core),
    type: "audio.output.started",
    status: "started",
    turnId,
  };
}

export function audioOutputChunkTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  mediaEventId: MediaEventId,
  frameCount: number,
  durationMs: number,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "audio.output.chunk",
    status: "in_progress",
    turnId,
    mediaEventId,
    frameCount,
    durationMs,
  };
}

export function audioOutputEndedTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  durationMs: number,
  status: "succeeded" | "cancelled" = "succeeded",
): TraceEvent {
  return {
    ...traceCore(core),
    type: "audio.output.ended",
    status,
    turnId,
    durationMs,
  };
}

export function interruptDetectedTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  cause: "barge_in" | "dtmf" | "explicit" | "timeout",
): TraceEvent {
  return {
    ...traceCore(core),
    type: "interrupt.detected",
    status: "succeeded",
    turnId,
    cause,
  };
}

export function interruptHandledTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  durationMs: number,
  outputCancelled: boolean,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "interrupt.handled",
    status: "succeeded",
    turnId,
    durationMs,
    outputCancelled,
  };
}

export function outputCancelledTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  framesSent: number,
  durationMs: number,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "output.cancelled",
    status: "cancelled",
    turnId,
    framesSent,
    durationMs,
  };
}

export function bargeInRejectedTrace(
  core: TraceCoreInput,
  turnId: TurnId,
  confidence: number,
  reason: "min_speech_not_met" | "below_echo_floor" | "stt_not_confirmed" | "policy_ignored",
): TraceEvent {
  return {
    ...traceCore(core),
    type: "barge_in.rejected",
    status: "cancelled",
    turnId,
    confidence,
    reason,
  };
}

export function runtimeTimeoutTrace(
  core: TraceCoreInput,
  operation: string,
  timeoutMs: number,
  options: {
    readonly stage?: "llm" | "tts" | "stt";
    readonly policyAction?: "fail" | "interrupt";
    readonly turnId?: TurnId;
    readonly provider?: string;
  } = {},
): TraceEvent {
  return {
    ...traceCore(core),
    type: "runtime.timeout",
    status: "failed",
    operation,
    timeoutMs,
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.policyAction ? { policyAction: options.policyAction } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
  };
}

export function runtimeRetryTrace(
  core: TraceCoreInput,
  operation: string,
  attempt: number,
  delayMs: number,
  cause: NormalizedError,
): TraceEvent {
  return {
    ...traceCore(core),
    type: "runtime.retry",
    status: "in_progress",
    operation,
    attempt,
    delayMs,
    cause,
  };
}

export function memoryWriteTrace(
  core: TraceCoreInput,
  ref: MemoryRef,
  key: string,
  mode: "put" | "append",
): TraceEvent {
  return {
    ...traceCore(core),
    type: "memory.write",
    status: "succeeded",
    memoryRef: ref,
    key,
    scope: ref.scope,
    mode,
  };
}
