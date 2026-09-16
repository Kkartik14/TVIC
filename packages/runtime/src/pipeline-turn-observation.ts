import type { SessionId, SessionMetricsRecorder, TerminalTurn } from "@tvic/core";

export function recordTerminalTurn(
  turn: TerminalTurn,
  sessionId: SessionId,
  recorder: SessionMetricsRecorder | undefined,
): void {
  const attributes: Record<string, string | number | boolean> = {
    session_id: sessionId,
    turn_id: turn.id,
    status: turn.status,
    sequence: turn.sequence,
  };
  if (turn.latency.totalMs !== undefined) attributes.total_ms = turn.latency.totalMs;
  try {
    recorder?.record("turn.end", attributes);
  } catch {
    // Metrics are observation only.
  }
  try {
    recorder?.onTurn(turn, sessionId);
  } catch {
    // Metrics are observation only.
  }
}
