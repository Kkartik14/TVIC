import {
  BackendUnavailableError,
  DurableError,
  isNormalizedError,
  isTerminalTurn,
  normalizeUnknownError,
  timeoutError,
} from "@tvic/core";
import type {
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
  readonly #pendingPersistenceWriteSettlements = new Set<Promise<void>>();
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

  onWriteFailure(source: string, error: unknown): number {
    const wasDegraded = this.#persistenceDegraded;
    if (!this.#nonCheckpointPersistenceDegraded) {
      this.#nonCheckpointPersistenceGeneration += 1;
      this.beginRecoveryWindow();
    }
    this.#nonCheckpointPersistenceDegraded = true;
    this.#trackPendingPersistenceWrite(error);
    this.#lastPersistenceFailure = this.failure(error, source);
    this.#syncPersistenceHealth();
    if (!wasDegraded) this.#emitPersistenceFailure(this.#lastPersistenceFailure);
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
    return {
      ...normalized,
      code: "durable.write.failure",
      category: "internal",
      metadata: { ...(normalized.metadata ?? {}), degraded: true, source },
    };
  }

  onInterrupt(turnId: TurnId, cause: TurnCancellationReason): Promise<boolean> {
    const checkpoint = persistInterruptionCheckpoint({
      runtime: this.#options.runtime,
      sessionId: this.#options.sessionId,
      turnId,
      cause,
      recoveryDeadlineMs: this.beginRecoveryWindow(),
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
    afterSequence: number,
    recoveryDeadline: number,
    expectedStatus?: Turn["status"],
  ): Promise<TerminalTurn | null> {
    const deadline = recoveryDeadline;
    const criticalWriteTimeoutMs =
      this.#options.runtime.durablePolicy?.criticalWriteTimeoutMs ?? 2_000;
    const terminalWriteCutoff = Math.max(
      this.#persistenceRecoveryStartedAtMs ?? Date.now(),
      deadline - criticalWriteTimeoutMs,
    );
    let candidateTurnId = turnId;
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

      if (!candidateTurnId && snapshot) {
        const currentTurnId = snapshot.session.state.currentTurnId;
        const lateTurn = currentTurnId
          ? snapshot.turns.find(
              (candidate) => candidate.id === currentTurnId && candidate.sequence > afterSequence,
            )
          : snapshot.turns.find((candidate) => candidate.sequence > afterSequence);
        if (lateTurn) candidateTurnId = lateTurn.id;
      }

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
          const terminalization = await settleBy(
            () =>
              this.#options.runtime.endTurn(this.#options.sessionId, candidateTurnId!, {
                reason: "failed",
                error: failure,
              }),
            deadline,
          );
          if (terminalization.status === "completed" && isTerminalTurn(terminalization.value)) {
            return terminalization.value;
          }
          if (terminalization.status === "rejected") {
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
          if (terminalization.status === "timeout") {
            break;
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
    if (pendingCheckpointWrite) {
      void pendingCheckpointWrite.catch((error: unknown) =>
        this.#trackPendingPersistenceWrite(error),
      );
      const checkpointSettlement = await settleBy(
        () => pendingCheckpointWrite,
        Date.now() + criticalWriteTimeoutMs,
      );
      if (checkpointSettlement.status === "rejected") {
        this.#trackPendingPersistenceWrite(checkpointSettlement.error);
      }
    }
    const pendingWrites = [...this.#pendingPersistenceWriteSettlements];
    if (pendingWrites.length > 0) {
      await settleBy(
        () => Promise.all(pendingWrites).then(() => undefined),
        Date.now() + criticalWriteTimeoutMs,
      );
    }
    const terminalizationDeadline = Date.now() + criticalWriteTimeoutMs;
    let terminalizationOutcome: string | undefined;
    let terminalizationConfirmed = false;
    while (Date.now() < terminalizationDeadline) {
      const terminalization = await settleBy(
        () =>
          this.#options.runtime.endSession(this.#options.sessionId, {
            reason: "failed",
            error: failure,
          }),
        terminalizationDeadline,
      );
      if (terminalization.status === "completed") {
        terminalizationOutcome = terminalization.value.status;
        terminalizationConfirmed =
          terminalization.value.status === "failed" &&
          terminalization.value.error.code === failure.code;
        break;
      }
      if (terminalization.status === "timeout") break;
      if (
        isCriticalWriteTimeoutError(terminalization.error) ||
        !isBackendUnavailableError(terminalization.error)
      ) {
        break;
      }
      const remainingMs = terminalizationDeadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remainingMs)));
    }
    if (!terminalizationConfirmed) {
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
          },
        },
        false,
      );
    }
  }

  beginRecoveryWindow(): number {
    if (this.#persistenceRecoveryDeadlineMs === undefined) {
      this.#persistenceRecoveryStartedAtMs = Date.now();
      const graceMs = this.#options.runtime.durablePolicy?.persistenceRecoveryGraceMs ?? 2_000;
      this.#persistenceRecoveryDeadlineMs = this.#persistenceRecoveryStartedAtMs + graceMs;
    }
    return this.#persistenceRecoveryDeadlineMs;
  }

  #markCheckpointPersistenceDegraded(error: unknown): void {
    const wasDegraded = this.#persistenceDegraded;
    this.beginRecoveryWindow();
    this.#trackPendingPersistenceWrite(error);
    this.#checkpointPersistenceDegraded = true;
    this.#lastPersistenceFailure = this.failure(error, "interruption_checkpoint");
    this.#syncPersistenceHealth();
    if (!wasDegraded) this.#emitPersistenceFailure(this.#lastPersistenceFailure);
  }

  #recoverCheckpointPersistence(): void {
    this.#checkpointPersistenceDegraded = false;
    this.#syncPersistenceHealth();
  }

  #emitPersistenceFailure(error: NormalizedError): void {
    this.#options.emitError(error, error.retriable);
  }

  #trackPendingPersistenceWrite(error: unknown): void {
    const pendingWrite = criticalWriteLateSettlement(error);
    if (!pendingWrite || this.#pendingPersistenceWriteSettlements.has(pendingWrite)) return;
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
    const result = await settleBy(() => pending, input.recoveryDeadlineMs);
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
      const settlement = await settleBy(() => pendingWrite, input.recoveryDeadlineMs);
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
      const settlement = await settleBy(() => pendingWrite, input.recoveryDeadlineMs);
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
