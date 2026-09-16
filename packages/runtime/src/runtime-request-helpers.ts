import {
  cancelledError,
  InvalidArgumentError,
  type EndSessionRequest,
  type EndTurnRequest,
  type QueuedToolCall,
  type RunningToolCall,
  type TerminalToolCall,
  type TurnCancellationReason,
} from "@tvic/core";

export function positiveSafeInteger(
  value: number | undefined,
  name: string,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive safe integer: ${resolved}`);
  }
  return resolved;
}

export function turnEndRequestForSession(request: EndSessionRequest): EndTurnRequest {
  switch (request.reason) {
    case "failed":
    case "timeout":
      return { reason: "failed", error: request.error };
    case "completed":
    case "cancelled":
      return { reason: "cancelled", cancelReason: turnCancellationForSession(request) };
  }
}

function turnCancellationForSession(request: EndSessionRequest): TurnCancellationReason {
  if (request.reason !== "cancelled") return "explicit";
  switch (request.cancelReason) {
    case "caller_hangup":
    case "transport_lost":
      return "transport_lost";
    case "recovery_expired":
      return "runtime_restarted";
    case "operator_requested":
    case "shutdown":
      return "explicit";
  }
}

export function cancelOpenToolCall(
  toolCall: QueuedToolCall | RunningToolCall,
  endedAt: TerminalToolCall["endedAt"],
): TerminalToolCall {
  const error = cancelledError("tool.session_ended", "Tool execution was stopped with the session");
  if (toolCall.status === "queued") {
    return { ...toolCall, status: "cancelled", startedAt: endedAt, endedAt, error };
  }
  return { ...toolCall, status: "cancelled", endedAt, error };
}
