import {
  BackendUnavailableError,
  DurableError,
  internalError,
  isNormalizedError,
  isTerminalTurn,
  normalizedError,
  normalizeUnknownError,
  timeoutError,
} from "@tvic/core";
import type {
  EndTurnRequest,
  NormalizedError,
  Runtime,
  SessionId,
  TerminalTurn,
  Turn,
  TurnCancellationReason,
  TurnId,
} from "@tvic/core";
import { settleBy, type Settlement } from "./async-control.js";
import { criticalWriteLateSettlement, isCriticalWriteTimeoutError } from "./runtime-support.js";

type PromiseOutcome<T> = Settlement<T> & { readonly pending?: Promise<T> };

export interface DurableWriteRecoveryOptions {
  readonly runtime: Runtime;
  readonly sessionId: SessionId;
  readonly emitError: (error: NormalizedError, recoverable: boolean) => void;
  readonly onSessionFailure: (failure: NormalizedError) => void;
  readonly closeCall: () => Promise<void>;
  readonly abortRun: (reason?: unknown) => void;
  readonly abortActiveTurn: () => void;
}

export class DurableWriteRecovery {
  readonly #options: DurableWriteRecoveryOptions;
  #persistenceDegraded = false;
  #nonCheckpointPersistenceDegraded = false;
  #checkpointPersistenceDegraded = false;
  #nonCheckpointPersistenceGeneration = 0;
  #lastPersistenceFailure: NormalizedError | undefined;
  #persistenceSessionEnding = false;
  readonly #pendingPersistenceWriteSettlements = new Set<Promise<unknown>>();
  #persistenceRecoveryStartedAtMs: number | undefined;
  #persistenceRecoveryDeadlineMs: number | undefined;
  #persistenceGate: Promise<boolean> = Promise.resolve(true);

  constructor(options: DurableWriteRecoveryOptions) {
    this.#options = options;
  }

  get isDegraded(): boolean {
    return this.#persistenceDegraded;
  }

  get nonCheckpointDegraded(): boolean {
    return this.#nonCheckpointPersistenceDegraded;
  }

  get nonCheckpointGeneration(): number {
    return this.#nonCheckpointPersistenceGeneration;
  }

  get lastFailure(): NormalizedError | undefined {
    return this.#lastPersistenceFailure;
  }

  get sessionEnding(): boolean {
    return this.#persistenceSessionEnding;
  }

  get recoveryDeadlineMs(): number | undefined {
    return this.#persistenceRecoveryDeadlineMs;
  }

  admit(): Promise<boolean> {
    return this.#persistenceGate;
  }

  onWriteFailure(
    source: string,
    error: unknown,
    recoverable = isRetryablePersistenceFailure(error),
  ): number {
    const wasDegraded = this.#persistenceDegraded;
    if (!this.#nonCheckpointPersistenceDegraded) {
      this.#nonCheckpointPersistenceGeneration += 1;
      this.beginRecoveryWindow();
    }
    this.#nonCheckpointPersistenceDegraded = true;
    this.#trackPendingPersistenceWrite(error);
    this.#lastPersistenceFailure = this.failure(error, source);
    this.#syncPersistenceHealth();
    if (!wasDegraded) {
      this.#emitPersistenceFailure(this.#lastPersistenceFailure, recoverable);
    }
    return this.#nonCheckpointPersistenceGeneration;
  }

  recoverNonCheckpoint(generation: number): void {
    if (
      generation !== this.#nonCheckpointPersistenceGeneration ||
      !this.#nonCheckpointPersistenceDegraded
    ) {
      return;
    }
    this.#nonCheckpointPersistenceDegraded = false;
    this.#lastPersistenceFailure = undefined;
    this.#syncPersistenceHealth();
  }

  failure(error: unknown, source: string): NormalizedError {
    const normalized = normalizeUnknownError(error, {
      code: "durable.write.failure",
      category: "internal",
      retriable: true,
    });
    const metadata = { ...(normalized.metadata ?? {}), degraded: true, source };
    const timeoutFailure = isNormalizedError(error) && error.category === "timeout";
    if (!isBackendUnavailableError(error) && !timeoutFailure) {
      if (isNormalizedError(error)) return error;
      return normalizedError(normalized.code, normalized.message, {
        category: normalized.category,
        retriable: normalized.retriable,
        ...(normalized.provider ? { provider: normalized.provider } : {}),
        cause: normalized.cause ?? error,
        metadata,
      });
    }
    return internalError("durable.write.failure", normalized.message, {
      cause: error,
      metadata,
    });
  }

  async recoverTurnStatus(
    turnId: TurnId,
    status: "thinking" | "calling_tool" | "speaking",
    recoveryDeadline: number,
  ): Promise<boolean> {
    while (Date.now() < recoveryDeadline) {
      const pendingWrites = [...this.#pendingPersistenceWriteSettlements];
      if (pendingWrites.length > 0) {
        const settlement = await settleBy(
          () => Promise.all(pendingWrites).then(() => undefined),
          recoveryDeadline,
        );
        if (settlement.status === "timeout") return false;
        for (const pendingWrite of pendingWrites) {
          this.#pendingPersistenceWriteSettlements.delete(pendingWrite);
        }
      }

      const inspection = await settleBy(
        () => this.#options.runtime.inspectSession(this.#options.sessionId),
        recoveryDeadline,
      );
      if (inspection.status !== "completed") return false;
      const persisted = inspection.value.turns.find((candidate) => candidate.id === turnId);
      if (!persisted || isTerminalTurn(persisted)) return false;
      if (persisted.status === status) return true;
      if (persisted.status !== "started") return false;

      const statusWriteOperation = this.#options.runtime.updateTurnStatus(
        this.#options.sessionId,
        turnId,
        status,
      );
      const statusWrite = await settleBy(() => statusWriteOperation, recoveryDeadline);
      if (statusWrite.status === "completed") return statusWrite.value.status === status;
      if (statusWrite.status === "timeout") {
        const pendingSettlement = statusWriteOperation.then(
          () => undefined,
          async (error: unknown) => {
            this.onWriteFailure("turn_status_recovery", error);
            const lateSettlement = criticalWriteLateSettlement(error);
            if (lateSettlement) await lateSettlement;
          },
        );
        this.#trackPendingPersistenceSettlement(pendingSettlement);
        return false;
      }
      this.onWriteFailure("turn_status_recovery", statusWrite.error);
      if (!isRetryablePersistenceFailure(statusWrite.error)) return false;

      const remainingMs = recoveryDeadline - Date.now();
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
    }
    return false;
  }

  onInterrupt(turnId: TurnId, cause: TurnCancellationReason): Promise<boolean> {
    const checkpoint = persistInterruptionCheckpoint({
      runtime: this.#options.runtime,
      sessionId: this.#options.sessionId,
      turnId,
      cause,
      onDegraded: (error) => this.#markCheckpointPersistenceDegraded(error),
      onRecovered: () => this.#recoverCheckpointPersistence(),
      onFatal: (error, pendingWrite) =>
        this.endSessionAfterPersistenceFailure(
          this.failure(error, "interruption_checkpoint"),
          pendingWrite,
        ),
    });
    this.#persistenceGate = this.#persistenceGate
      .then((previous) => (previous ? checkpoint : false))
      .catch(() => false);
    return checkpoint;
  }

  async recoverFailedTurn(
    failure: NormalizedError,
    turnId: TurnId | undefined,
    recoveryDeadline: number,
    expectedStatus?: Turn["status"],
    lateTurnId?: Promise<TurnId | undefined>,
    terminalRequest?: EndTurnRequest,
  ): Promise<TerminalTurn | null> {
    const deadline = recoveryDeadline;
    const criticalWriteTimeoutMs =
      this.#options.runtime.durablePolicy?.criticalWriteTimeoutMs ?? 2_000;
    const terminalWriteCutoff = Math.max(
      this.#persistenceRecoveryStartedAtMs ?? Date.now(),
      deadline - criticalWriteTimeoutMs,
    );
    let candidateTurnId = turnId;
    if (!candidateTurnId && lateTurnId) {
      const lateStart = await settleBy(() => lateTurnId, deadline);
      if (lateStart.status === "timeout") {
        this.#trackPendingPersistenceSettlement(lateTurnId);
        return null;
      }
      if (lateStart.status === "completed") candidateTurnId = lateStart.value;
    }
    if (!candidateTurnId) return null;

    let nextTerminalWriteAttemptAt = terminalWriteCutoff;
    let terminalWriteRetryDisabled = false;

    while (true) {
      const pendingWrites = [...this.#pendingPersistenceWriteSettlements];
      if (pendingWrites.length > 0) {
        const settlement = await settleBy(
          () => Promise.all(pendingWrites).then(() => undefined),
          deadline,
        );
        if (settlement.status === "timeout") break;
        for (const pendingWrite of pendingWrites) {
          this.#pendingPersistenceWriteSettlements.delete(pendingWrite);
        }
      }

      let snapshot: Awaited<ReturnType<Runtime["inspectSession"]>> | undefined;
      const inspection = await settleBy(
        () => this.#options.runtime.inspectSession(this.#options.sessionId),
        deadline,
      );
      if (inspection.status === "completed") snapshot = inspection.value;
      if (inspection.status === "timeout") break;

      if (candidateTurnId) {
        const persisted = snapshot?.turns.find((candidate) => candidate.id === candidateTurnId);
        if (persisted && isTerminalTurn(persisted)) return persisted;
        const mayTerminalize =
          (expectedStatus !== undefined && persisted?.status === expectedStatus) ||
          Date.now() >= terminalWriteCutoff;
        if (
          mayTerminalize &&
          !terminalWriteRetryDisabled &&
          Date.now() >= nextTerminalWriteAttemptAt
        ) {
          let terminalizationOperation: Promise<TerminalTurn>;
          try {
            terminalizationOperation = this.#options.runtime.endTurn(
              this.#options.sessionId,
              candidateTurnId!,
              terminalRequest ?? { reason: "failed", error: failure },
            );
          } catch (error) {
            this.onWriteFailure("turn_terminal", error);
            if (isBackendUnavailableError(error) && !isCriticalWriteTimeoutError(error)) {
              nextTerminalWriteAttemptAt = Date.now() + 25;
            } else {
              terminalWriteRetryDisabled = true;
            }
            continue;
          }

          const terminalization = await settleBy(() => terminalizationOperation, deadline);
          if (terminalization.status === "completed") {
            if (isTerminalTurn(terminalization.value)) return terminalization.value;
          } else if (terminalization.status === "timeout") {
            const pendingSettlement = terminalizationOperation.then(
              () => undefined,
              async (error: unknown) => {
                this.onWriteFailure("turn_terminal", error);
                const lateSettlement = criticalWriteLateSettlement(error);
                if (lateSettlement) await lateSettlement;
              },
            );
            this.#trackPendingPersistenceSettlement(pendingSettlement);
            terminalWriteRetryDisabled = true;
            break;
          } else {
            this.onWriteFailure("turn_terminal", terminalization.error);
            if (
              isBackendUnavailableError(terminalization.error) &&
              !isCriticalWriteTimeoutError(terminalization.error)
            ) {
              nextTerminalWriteAttemptAt = Date.now() + 25;
            } else {
              terminalWriteRetryDisabled = true;
            }
          }
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }

    return null;
  }

  async endSessionAfterPersistenceFailure(
    failure: NormalizedError,
    pendingCheckpointWrite?: Promise<unknown>,
  ): Promise<void> {
    if (this.#persistenceSessionEnding) return;
    this.#persistenceSessionEnding = true;
    this.#options.onSessionFailure(failure);
    if (pendingCheckpointWrite) {
      this.#trackPendingPersistenceSettlement(pendingCheckpointWrite);
      void pendingCheckpointWrite.catch((error: unknown) =>
        this.#trackPendingPersistenceWrite(error),
      );
    }

    let initialSessionEnd: Promise<Awaited<ReturnType<Runtime["endSession"]>>>;
    try {
      initialSessionEnd = this.#options.runtime.endSession(this.#options.sessionId, {
        reason: "failed",
        error: failure,
        terminalSource: "runtime_recovery",
      });
    } catch (error) {
      initialSessionEnd = Promise.reject(error);
    }
    const terminalizationPromise = this.#terminalizeFailedSession(failure, initialSessionEnd);

    const criticalWriteTimeoutMs =
      this.#options.runtime.durablePolicy?.criticalWriteTimeoutMs ?? 2_000;
    const closeResult = await settleBy(
      () => this.#options.closeCall(),
      Date.now() + criticalWriteTimeoutMs,
    );
    if (closeResult.status !== "completed") {
      const closeError =
        closeResult.status === "timeout"
          ? timeoutError(
              "voice_runtime.call_close_timeout",
              "The call transport did not confirm closure before its deadline",
              { retriable: true },
            )
          : normalizeUnknownError(closeResult.error, {
              code: "voice_runtime.call_close_failed",
              category: "network",
              retriable: true,
            });
      this.#options.emitError(closeError, false);
      this.#options.abortRun(closeError);
    }
    const terminalization = await terminalizationPromise;
    if (!terminalization.confirmed) {
      this.#emitSessionTerminalizationUnconfirmed(
        failure,
        terminalization.outcome,
        terminalization.deferred,
      );
    }
  }

  async #terminalizeFailedSession(
    failure: NormalizedError,
    initialAttempt: Promise<Awaited<ReturnType<Runtime["endSession"]>>>,
  ): Promise<{
    readonly outcome?: string;
    readonly confirmed: boolean;
    readonly deferred: boolean;
  }> {
    const criticalWriteTimeoutMs =
      this.#options.runtime.durablePolicy?.criticalWriteTimeoutMs ?? 2_000;
    const terminalizationDeadline = Date.now() + criticalWriteTimeoutMs;
    let terminalizationOutcome: string | undefined;
    let terminalizationConfirmed = false;
    let deferred = false;
    let nextAttempt: Promise<Awaited<ReturnType<Runtime["endSession"]>>> | undefined =
      initialAttempt;
    while (Date.now() < terminalizationDeadline) {
      const terminalization = await settleBy(() => {
        const attempt = nextAttempt;
        nextAttempt = undefined;
        return (
          attempt ??
          this.#options.runtime.endSession(this.#options.sessionId, {
            reason: "failed",
            error: failure,
            terminalSource: "runtime_recovery",
          })
        );
      }, terminalizationDeadline);
      if (terminalization.status === "completed") {
        terminalizationOutcome = terminalization.value.status;
        terminalizationConfirmed =
          terminalization.value.status === "failed" &&
          terminalization.value.error.code === failure.code;
        break;
      }
      if (terminalization.status === "timeout") {
        deferred = true;
        break;
      }
      if (
        isCriticalWriteTimeoutError(terminalization.error) ||
        !isBackendUnavailableError(terminalization.error)
      ) {
        deferred = isCriticalWriteTimeoutError(terminalization.error);
        break;
      }
      const remainingMs = terminalizationDeadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
    }
    return {
      ...(terminalizationOutcome ? { outcome: terminalizationOutcome } : {}),
      confirmed: terminalizationConfirmed,
      deferred,
    };
  }

  #emitSessionTerminalizationUnconfirmed(
    failure: NormalizedError,
    terminalizationOutcome?: string,
    deferred = false,
  ): void {
    this.#options.emitError(
      {
        ...failure,
        message: "The failed session outcome was not confirmed in durable storage",
        metadata: {
          ...(failure.metadata ?? {}),
          sessionTerminalizationConfirmed: false,
          ...(terminalizationOutcome
            ? { sessionTerminalizationOutcome: terminalizationOutcome }
            : {}),
          ...(deferred ? { sessionTerminalizationDeferred: true } : {}),
        },
      },
      false,
    );
  }

  beginRecoveryWindow(): number {
    if (this.#persistenceRecoveryDeadlineMs === undefined) {
      this.#persistenceRecoveryStartedAtMs = Date.now();
      const policy = this.#options.runtime.durablePolicy;
      const criticalWriteTimeoutMs = policy?.criticalWriteTimeoutMs ?? 2_000;
      const probeBudgetMs = policy?.bargeCheckpointRetryBudgetMs ?? 500;
      const graceMs = Math.max(
        policy?.persistenceRecoveryGraceMs ?? 2_000,
        criticalWriteTimeoutMs + probeBudgetMs,
      );
      this.#persistenceRecoveryDeadlineMs = this.#persistenceRecoveryStartedAtMs + graceMs;
    }
    return this.#persistenceRecoveryDeadlineMs;
  }

  #markCheckpointPersistenceDegraded(error: unknown): number {
    const wasDegraded = this.#persistenceDegraded;
    const recoveryDeadlineMs = this.beginRecoveryWindow();
    this.#trackPendingPersistenceWrite(error);
    this.#checkpointPersistenceDegraded = true;
    this.#lastPersistenceFailure = this.failure(error, "interruption_checkpoint");
    this.#syncPersistenceHealth();
    if (!wasDegraded) {
      this.#emitPersistenceFailure(
        this.#lastPersistenceFailure,
        isRetryablePersistenceFailure(error),
      );
    }
    return recoveryDeadlineMs;
  }

  #recoverCheckpointPersistence(): void {
    this.#checkpointPersistenceDegraded = false;
    this.#syncPersistenceHealth();
  }

  #emitPersistenceFailure(error: NormalizedError, recoverable: boolean): void {
    this.#options.emitError(error, recoverable);
  }

  #trackPendingPersistenceWrite(error: unknown): void {
    const pendingWrite = criticalWriteLateSettlement(error);
    if (!pendingWrite) return;
    this.#trackPendingPersistenceSettlement(pendingWrite);
  }

  #trackPendingPersistenceSettlement(pendingWrite: Promise<unknown>): void {
    if (this.#pendingPersistenceWriteSettlements.has(pendingWrite)) return;
    this.#pendingPersistenceWriteSettlements.add(pendingWrite);
    void pendingWrite.then(
      () => this.#pendingPersistenceWriteSettlements.delete(pendingWrite),
      () => this.#pendingPersistenceWriteSettlements.delete(pendingWrite),
    );
  }

  #syncPersistenceHealth(): void {
    this.#persistenceDegraded =
      this.#nonCheckpointPersistenceDegraded || this.#checkpointPersistenceDegraded;
    if (!this.#persistenceDegraded) {
      this.#persistenceRecoveryStartedAtMs = undefined;
      this.#persistenceRecoveryDeadlineMs = undefined;
    }
    try {
      this.#options.runtime.setPersistenceHealth(
        this.#options.sessionId,
        this.#persistenceDegraded,
      );
    } catch {
    } finally {
      if (this.#persistenceDegraded) this.#options.abortActiveTurn();
    }
  }
}

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
  readonly onDegraded: (error: unknown) => number;
  readonly onRecovered: () => void;
  readonly onFatal: (error: unknown, pendingWrite?: Promise<unknown>) => void | Promise<void>;
}): Promise<boolean> {
  const policy = input.runtime.durablePolicy;
  const criticalWriteTimeoutMs = policy?.criticalWriteTimeoutMs ?? 2_000;
  const maxAttempts = policy?.bargeCheckpointMaxAttempts ?? 3;
  const retryBudgetMs = policy?.bargeCheckpointRetryBudgetMs ?? 500;
  const startedAt = Date.now();
  const initialRetryDeadline = startedAt + retryBudgetMs;
  let lastError: unknown;
  let pendingCheckpointWrite: Promise<unknown> | undefined;
  let recoveryDeadlineMs: number | undefined;

  const checkpoint = (): Promise<unknown> =>
    input.runtime.checkpointTurnInterruption(input.sessionId, input.turnId, input.cause);
  const markDegraded = (error: unknown): number => {
    recoveryDeadlineMs ??= input.onDegraded(error);
    return recoveryDeadlineMs;
  };
  const attemptCheckpoint = async (deadlineMs?: number): Promise<PromiseOutcome<unknown>> => {
    const attemptDeadlineMs = deadlineMs ?? Date.now() + criticalWriteTimeoutMs;
    let pending: Promise<unknown>;
    try {
      pending = checkpoint();
    } catch (error) {
      return { status: "rejected", error };
    }
    const result = await settleBy(() => pending, attemptDeadlineMs);
    if (result.status !== "timeout") return result;
    return { status: "timeout", pending };
  };

  const waitForLateCheckpoint = async (
    error: unknown,
    pendingCheckpoint?: Promise<unknown>,
  ): Promise<"none" | "settled" | "timed_out" | "recovered"> => {
    const deadline = recoveryDeadlineMs ?? markDegraded(error);
    if (pendingCheckpoint) {
      pendingCheckpointWrite = pendingCheckpoint;
      const checkpointSettlement = await settleBy(() => pendingCheckpoint, deadline);
      if (checkpointSettlement.status === "timeout") return "timed_out";
      pendingCheckpointWrite = undefined;
      if (checkpointSettlement.status === "completed") {
        input.onRecovered();
        return "recovered";
      }
      error = checkpointSettlement.error;
      lastError = error;
    }

    const pendingWrite = criticalWriteLateSettlement(error);
    if (!pendingWrite) return "none";
    pendingCheckpointWrite = pendingWrite;
    const settlement = await settleBy(() => pendingWrite, deadline);
    if (settlement.status === "timeout") return "timed_out";
    pendingCheckpointWrite = undefined;
    const outcome =
      settlement.status === "completed" ? settlement.value : { error: settlement.error };
    if (!("error" in outcome)) {
      input.onRecovered();
      return "recovered";
    }
    lastError = outcome.error;
    return "settled";
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
        "Interruption checkpoint did not settle before the critical write timeout",
      );
      pendingCheckpointWrite = result.pending;
      markDegraded(lastError);
      const lateCheckpoint = await waitForLateCheckpoint(lastError, result.pending);
      if (lateCheckpoint === "recovered") return true;
      if (lateCheckpoint === "timed_out" || !isRetryablePersistenceFailure(lastError)) break;
      continue;
    }

    lastError = result.error;
    markDegraded(lastError);
    if (!isRetryablePersistenceFailure(lastError)) break;
    const lateCheckpoint = await waitForLateCheckpoint(lastError);
    if (lateCheckpoint === "recovered") return true;
    if (lateCheckpoint === "timed_out" || !isRetryablePersistenceFailure(lastError)) break;
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
  const deadline = recoveryDeadlineMs ?? markDegraded(lastError);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await waitMs(Math.min(50, Math.max(1, remaining)));
    if (Date.now() >= deadline) break;

    const result = await attemptCheckpoint(deadline);
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
    const lateCheckpoint = await waitForLateCheckpoint(lastError);
    if (lateCheckpoint === "recovered") return true;
    if (lateCheckpoint === "timed_out" || !isRetryablePersistenceFailure(lastError)) break;
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

function waitMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function isBackendUnavailableError(error: unknown): boolean {
  if (error instanceof BackendUnavailableError) {
    return true;
  }
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "BACKEND_UNAVAILABLE"
    );
  } catch {
    return false;
  }
}
