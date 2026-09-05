import {
  isNormalizedError,
  isTerminalTurn,
  normalizeLegacyError,
  STT_STREAM_ENDED_REASON,
} from "@tvic/core";
import type {
  NormalizedError,
  Runtime,
  SessionId,
  TerminalToolCall,
  TerminalTurn,
  ToolCall,
  TurnCancellationReason,
  TurnId,
} from "@tvic/core";

export function isTerminalToolCall(toolCall: ToolCall): toolCall is TerminalToolCall {
  return ["succeeded", "failed", "timed_out", "cancelled"].includes(toolCall.status);
}

export function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => undefined;
  const abort = (): void => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export function cancellationReason(reason: string): TurnCancellationReason {
  switch (reason) {
    case "barge_in":
      return "barge_in";
    case "dtmf":
      return "dtmf";
    case "explicit":
      return "explicit";
    case "timeout":
      return "timeout";
    case "not_heard":
      return "not_heard";
    case "lease_lost":
      return "lease_lost";
    case "runtime_restarted":
      return "runtime_restarted";
    case "remote_hangup":
    case "transport_closed":
    case "tts_failed":
    case "stt_error":
    case "stt_ended":
    case "media_error":
      return "transport_lost";
    default:
      return "transport_lost";
  }
}

export function isSttStreamEndedError(error: unknown): error is NormalizedError {
  const normalized = isNormalizedError(error) ? error : normalizeLegacyError(error);
  return normalized?.metadata?.reason === STT_STREAM_ENDED_REASON;
}

export async function readTerminalTurn(
  runtime: Runtime,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<TerminalTurn | null> {
  try {
    const snapshot = await runtime.inspectSession(sessionId);
    const existing = snapshot.turns.find((candidate) => candidate.id === turnId);
    return existing && isTerminalTurn(existing) ? existing : null;
  } catch {
    return null;
  }
}

export async function awaitTerminalTurn(
  runtime: Runtime,
  sessionId: SessionId,
  turnId: TurnId,
): Promise<TerminalTurn | null> {
  const graceMs = runtime.durablePolicy?.persistenceRecoveryGraceMs ?? 2_000;
  const deadline = Date.now() + graceMs;
  do {
    const terminal = await readTerminalTurn(runtime, sessionId, turnId);
    if (terminal) return terminal;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  } while (Date.now() < deadline);
  return null;
}
