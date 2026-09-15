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

import { abortPromise, stallTimer, withTimeout } from "./async-control.js";
import { PROVIDER_CANCEL_TIMEOUT_MS } from "./pipeline-constants.js";

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

export async function raceStartup<T>(
  startup: Promise<T>,
  signal: AbortSignal,
  cancel: (handle: T) => Promise<void>,
  options: {
    readonly timeoutMs?: number;
    readonly timeoutReason?: unknown;
  } = {},
): Promise<T | null> {
  const timeout = options.timeoutMs === undefined ? undefined : stallTimer(options.timeoutMs);
  try {
    const outcome = await Promise.race([
      startup.then((handle) => ({ kind: "ready" as const, handle })),
      abortPromise(signal).then(() => ({ kind: "aborted" as const })),
      ...(timeout ? [timeout.promise.then(() => ({ kind: "timeout" as const }))] : []),
    ]);
    if (outcome.kind === "ready") return outcome.handle;
    void startup
      .then((handle) =>
        cancelProviderBounded(() => cancel(handle), "Provider startup cancellation timed out"),
      )
      .catch(() => undefined);
    if (outcome.kind === "timeout") {
      throw outcomeTimeout(options.timeoutReason);
    }
    return null;
  } finally {
    timeout?.cancel();
  }
}

/** Keep custom provider cancellation from extending a turn or startup forever. */
export async function cancelProviderBounded(
  cancel: () => Promise<void>,
  message: string,
): Promise<void> {
  await withTimeout(
    Promise.resolve().then(cancel),
    PROVIDER_CANCEL_TIMEOUT_MS,
    new Error(message),
  ).catch(() => undefined);
}

/**
 * Return a provider iterator during every exit path without allowing a custom
 * iterator implementation to wedge turn shutdown forever.
 */
export async function closeAsyncIterator<T>(
  iterator: AsyncIterator<T>,
  message: string,
): Promise<void> {
  try {
    await withTimeout(
      Promise.resolve(iterator.return?.()),
      PROVIDER_CANCEL_TIMEOUT_MS,
      new Error(message),
    ).catch(() => undefined);
  } catch {
    // Iterator cleanup is best effort; the owning provider cancellation path
    // remains authoritative for transport teardown.
  }
}

function outcomeTimeout(reason: unknown): unknown {
  return reason ?? new Error("provider startup timed out");
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
