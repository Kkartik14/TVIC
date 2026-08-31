import {
  DurableError,
  isNormalizedError,
  type Runtime,
  type SessionId,
  type TurnCancellationReason,
  type TurnId,
} from "@tvic/core";

export async function persistInterruptionCheckpoint(input: {
  readonly runtime: Runtime;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly cause: TurnCancellationReason;
  readonly onDegraded: () => void;
}): Promise<boolean> {
  const policy = input.runtime.durablePolicy;
  const maxAttempts = policy?.bargeCheckpointMaxAttempts ?? 3;
  const retryBudgetMs = policy?.bargeCheckpointRetryBudgetMs ?? 500;
  const recoveryGraceMs = policy?.persistenceRecoveryGraceMs ?? 2_000;
  const startedAt = Date.now();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await input.runtime.checkpointTurnInterruption(input.sessionId, input.turnId, input.cause);
      input.runtime.setPersistenceHealth(input.sessionId, false);
      return true;
    } catch (error) {
      lastError = error;
      if (!isRetryablePersistenceFailure(error) || attempt === maxAttempts) break;
      const remaining = retryBudgetMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await waitMs(Math.min(50 * attempt, remaining));
    }
    if (Date.now() - startedAt >= retryBudgetMs) break;
  }

  const retryable = isRetryablePersistenceFailure(lastError);
  if (!retryable) {
    await abortSession(input.runtime, input.sessionId);
    return false;
  }

  input.onDegraded();
  input.runtime.setPersistenceHealth(input.sessionId, true);

  // Keep the transport alive during the recovery grace period, but continue
  // probing the checkpoint. A database outage that heals during this window
  // should restore the call rather than being converted into a session abort
  // solely because the first retry budget elapsed.
  const recoveryDeadline = Date.now() + recoveryGraceMs;
  while (Date.now() < recoveryDeadline) {
    const remaining = recoveryDeadline - Date.now();
    await waitMs(Math.min(50, Math.max(1, remaining)));
    try {
      await input.runtime.checkpointTurnInterruption(input.sessionId, input.turnId, input.cause);
      input.runtime.setPersistenceHealth(input.sessionId, false);
      return true;
    } catch (error) {
      lastError = error;
      if (!isRetryablePersistenceFailure(error)) break;
    }
  }
  await abortSession(input.runtime, input.sessionId);
  return false;
}

function isRetryablePersistenceFailure(error: unknown): boolean {
  if (error instanceof DurableError) return error.retriable;
  if (isNormalizedError(error)) return error.retriable;
  // Unknown failures are treated as transient backend failures. Correctness-
  // critical errors must use DurableError or NormalizedError instead of relying
  // on message text.
  return true;
}

async function abortSession(runtime: Runtime, sessionId: SessionId): Promise<void> {
  await runtime
    .endSession(sessionId, {
      reason: "cancelled",
      cancelReason: "shutdown",
    })
    .catch(() => undefined);
}

function waitMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
