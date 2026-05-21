import type { ChannelKind } from "./direction.js";
import type { AgentId, CallId, MemoryEntryId, SessionId, TraceId } from "./ids.js";
import type { EndSessionRequest, EndTurnRequest } from "./runtime.js";
import type { SessionState, Session, TerminalSession } from "./session.js";
import type { Timestamp } from "./timestamp.js";
import type { ActiveTurn, TerminalTurn, Turn } from "./turn.js";

export interface TerminalSessionDraft {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly channel: ChannelKind;
  readonly callId?: CallId;
  readonly traceId: TraceId;
  readonly memoryRefs: readonly MemoryEntryId[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: Timestamp;
  readonly state: SessionState;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
}

export function terminalSessionFromRequest(
  draft: TerminalSessionDraft,
  request: EndSessionRequest,
): TerminalSession {
  switch (request.reason) {
    case "completed":
      return { ...draft, status: "completed" };
    case "cancelled":
      return { ...draft, status: "cancelled", cancelReason: request.cancelReason };
    case "failed":
      return { ...draft, status: "failed", error: request.error };
    case "timeout":
      return { ...draft, status: "failed", error: request.error };
  }
}

export function terminalTurnFromRequest(
  turn: ActiveTurn,
  request: EndTurnRequest,
  endedAt: Timestamp,
  durationMs: number,
): TerminalTurn {
  const base = {
    id: turn.id,
    sessionId: turn.sessionId,
    sequence: turn.sequence,
    input: turn.input,
    output: request.output ?? turn.output,
    toolCallIds: request.toolCallIds ?? turn.toolCallIds,
    interruptionRefs: request.interruptionRefs ?? turn.interruptionRefs,
    startedAt: turn.startedAt,
    endedAt,
    latency: {
      ...turn.latency,
      ...request.latency,
      totalMs: request.latency?.totalMs ?? durationMs,
    },
    ...(turn.metadata ? { metadata: turn.metadata } : {}),
  };

  switch (request.reason) {
    case "completed":
      return { ...base, status: "completed" };
    case "cancelled":
      return { ...base, status: "cancelled", reason: request.cancelReason };
    case "failed":
      return { ...base, status: "failed", error: request.error };
  }
}

export function isTerminalSession(session: Session): session is TerminalSession {
  return (
    session.status === "completed" || session.status === "failed" || session.status === "cancelled"
  );
}

export function isTerminalTurn(turn: Turn): turn is TerminalTurn {
  return turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled";
}
