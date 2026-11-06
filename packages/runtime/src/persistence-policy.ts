import {
  BackendUnavailableError,
  DurableError,
  isNormalizedError,
  type Runtime,
  type SessionId,
  type TurnCancellationReason,
  type TurnId,
} from "@tvic/core";
import { criticalWriteLateSettlement } from "./runtime-support.js";

type PromiseOutcome<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timeout"; readonly pending?: Promise<T> };

export async function persistInterruptionCheckpoint(input: {
  readonly runtime: Pick<Runtime, "durablePolicy"> & {
    readonly checkpointTurnInterruption: (
      sessionId: SessionId,
      turnId: TurnId,
      cause: TurnCancellationReason,
    ) => Promise<unknown>;
  };
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly cause: TurnCancellationReason;
  readonly recoveryDeadlineMs: number;
  readonly onDegraded: (error: unknown) => void;
  readonly onRecovered: () => void;
  readonly onFatal: (error: unknown, pendingWrite?: Promise<unknown>) => void | Promise<void>;
}): Promise<boolean> {
  const policy = input.runtime.durablePolicy;
  const maxAttempts = policy?.bargeCheckpointMaxAttempts ?? 3;
  const retryBudgetMs = policy?.bargeCheckpointRetryBudgetMs ?? 500;
  const startedAt = Date.now();
  const initialRetryDeadline = Math.min(startedAt + retryBudgetMs, input.recoveryDeadlineMs);
  let lastError: unknown;
  let pendingCheckpointWrite: Promise<unknown> | undefined;

  const checkpoint = (): Promise<unknown> =>
    input.runtime.checkpointTurnInterruption(input.sessionId, input.turnId, input.cause);
  const attemptCheckpoint = async (): Promise<PromiseOutcome<unknown>> => {
    if (Date.now() >= input.recoveryDeadlineMs) return Promise.resolve({ status: "timeout" });
    const pending = checkpoint();
    const result = await settlePromiseUntil(pending, input.recoveryDeadlineMs);
    if (result.status !== "timeout") return result;
    void pending.catch((error: unknown) => input.onDegraded(error));
    return { status: "timeout", pending };
  };

  let attempts = 0;
  while (attempts < maxAttempts) {
    if (attempts > 0 && Date.now() >= initialRetryDeadline) break;
    if (attempts > 0) {
      const remaining = initialRetryDeadline - Date.now();
      if (remaining <= 0) break;
      await waitMs(Math.min(50 * attempts, remaining));
    }
    attempts += 1;

    const result = await attemptCheckpoint();
    if (result.status === "completed") {
      input.onRecovered();
      return true;
    }
    if (result.status === "timeout") {
      lastError = new BackendUnavailableError(
        "Interruption checkpoint did not settle before the persistence recovery deadline",
      );
      pendingCheckpointWrite = result.pending;
      input.onDegraded(lastError);
      break;
    }

    lastError = result.error;
    input.onDegraded(lastError);
    if (!isRetryablePersistenceFailure(lastError)) break;

    const pendingWrite = criticalWriteLateSettlement(lastError);
    if (pendingWrite) {
      const settlement = await settlePromiseUntil(pendingWrite, input.recoveryDeadlineMs);
      if (settlement.status !== "completed") break;
    }
  }

  if (lastError === undefined) {
    lastError = new BackendUnavailableError(
      "Interruption checkpoint retry budget expired before persistence recovered",
    );
  }
  if (!isRetryablePersistenceFailure(lastError)) {
    await input.onFatal(lastError, pendingCheckpointWrite);
    return false;
  }

  // Keep the transport alive during the recovery grace period, but never start a
  // second checkpoint while a timed-out transaction is still in flight.
  while (Date.now() < input.recoveryDeadlineMs) {
    const remaining = input.recoveryDeadlineMs - Date.now();
    await waitMs(Math.min(50, Math.max(1, remaining)));
    if (Date.now() >= input.recoveryDeadlineMs) break;

    const result = await attemptCheckpoint();
    if (result.status === "completed") {
      input.onRecovered();
      return true;
    }
    if (result.status === "timeout") {
      lastError = new BackendUnavailableError(
        "Interruption checkpoint did not settle before the persistence recovery deadline",
      );
      pendingCheckpointWrite = result.pending;
      break;
    }

    lastError = result.error;
    if (!isRetryablePersistenceFailure(lastError)) break;
    const pendingWrite = criticalWriteLateSettlement(lastError);
    if (pendingWrite) {
      const settlement = await settlePromiseUntil(pendingWrite, input.recoveryDeadlineMs);
      if (settlement.status !== "completed") break;
    }
  }

  await input.onFatal(lastError, pendingCheckpointWrite);
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

function settlePromiseUntil<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<PromiseOutcome<T>> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return Promise.resolve({ status: "timeout" });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = promise.then(
    (value): PromiseOutcome<T> => ({ status: "completed", value }),
    (error: unknown): PromiseOutcome<T> => ({ status: "rejected", error }),
  );
  const timeout = new Promise<PromiseOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), remainingMs);
  });
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function waitMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
