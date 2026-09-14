import type { ChannelKind } from "./direction.js";
import type { AgentId, CallId, MemoryEntryId, SessionId } from "./ids.js";
import type { EndSessionRequest, EndTurnRequest, TerminalSource } from "./runtime.js";
import type { SessionState, Session, TerminalSession } from "./session.js";
import type { Timestamp } from "./timestamp.js";
import type { ActiveTurn, TerminalTurn, Turn } from "./turn.js";

export interface TerminalSessionDraft {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly channel: ChannelKind;
  readonly callId?: CallId;
  /** Reserved; the runtime currently leaves this reference index empty. */
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
  const terminalSource = terminalSourceForRequest(request);
  switch (request.reason) {
    case "completed":
      return { ...draft, status: "completed", terminalSource };
    case "cancelled":
      return { ...draft, status: "cancelled", cancelReason: request.cancelReason, terminalSource };
    case "failed":
      return { ...draft, status: "failed", error: request.error, terminalSource };
    case "timeout":
      return { ...draft, status: "failed", error: request.error, terminalSource };
  }
}

export function terminalSourceForRequest(request: EndSessionRequest): TerminalSource {
  if (request.terminalSource !== undefined) return request.terminalSource;
  switch (request.reason) {
    case "completed":
      return "normal_completion";
    case "failed":
      return "legacy_unknown";
    case "timeout":
      return "run_timeout";
    case "cancelled":
      switch (request.cancelReason) {
        case "caller_hangup":
          return "caller_abort";
        case "transport_lost":
          return "remote_transport";
        case "operator_requested":
          return "operator_stop";
        case "recovery_expired":
          return "runtime_recovery";
        case "shutdown":
          return "runtime_shutdown";
      }
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
