import { describe, expect, it, vi } from "vitest";

import {
  createSystemClock,
  DEFAULT_DURABLE_RUNTIME_POLICY,
  RecordConflictError,
  type DurableRuntimePolicy,
  type SessionId,
  type TurnId,
} from "@tvic/core";
import { criticalWrite } from "../src/runtime-support.js";
import { persistInterruptionCheckpoint } from "../src/durable-write-recovery.js";

describe("persistInterruptionCheckpoint", () => {
  it("does not retry a checkpoint while its timed-out write is still in flight", async () => {
    const policy: DurableRuntimePolicy = {
      ...DEFAULT_DURABLE_RUNTIME_POLICY,
      criticalWriteTimeoutMs: 10,
      bargeCheckpointRetryBudgetMs: 80,
      bargeCheckpointMaxAttempts: 4,
      persistenceRecoveryGraceMs: 100,
    };
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let checkpointAttempts = 0;
    let operationSettled = false;
    const runtime = {
      durablePolicy: policy,
      checkpointTurnInterruption: async () =>
        criticalWrite(
          createSystemClock(),
          policy,
          async () => {
            checkpointAttempts += 1;
            activeWrites += 1;
            maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
            activeWrites -= 1;
            operationSettled = true;
          },
          () => undefined,
        ),
    };
    const onDegraded = vi.fn(() => Date.now() + policy.persistenceRecoveryGraceMs);
    const onRecovered = vi.fn();
    const onFatal = vi.fn();

    await expect(
      persistInterruptionCheckpoint({
        runtime,
        sessionId: "checkpoint_timeout_session" as SessionId,
        turnId: "checkpoint_timeout_turn" as TurnId,
        cause: "barge_in",
        onDegraded,
        onRecovered,
        onFatal,
      }),
    ).resolves.toBe(false);

    expect(checkpointAttempts).toBe(1);
    expect(activeWrites).toBe(1);
    expect(maximumActiveWrites).toBe(1);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(operationSettled).toBe(true), { timeout: 500 });
  });

  it("gives a healthy checkpoint the full critical write timeout even when grace is shorter", async () => {
    const policy: DurableRuntimePolicy = {
      ...DEFAULT_DURABLE_RUNTIME_POLICY,
      criticalWriteTimeoutMs: 500,
      bargeCheckpointRetryBudgetMs: 80,
      bargeCheckpointMaxAttempts: 4,
      persistenceRecoveryGraceMs: 100,
    };
    let activeWrites = 0;
    let checkpointAttempts = 0;
    let operationSettled = false;
    const runtime = {
      durablePolicy: policy,
      checkpointTurnInterruption: async () =>
        criticalWrite(
          createSystemClock(),
          policy,
          async () => {
            checkpointAttempts += 1;
            activeWrites += 1;
            await new Promise<void>((resolve) => setTimeout(resolve, 300));
            activeWrites -= 1;
            operationSettled = true;
          },
          () => undefined,
        ),
    };
    const recovered = vi.fn();
    const fatal = vi.fn();

    await expect(
      persistInterruptionCheckpoint({
        runtime,
        sessionId: "checkpoint_outer_deadline_session" as SessionId,
        turnId: "checkpoint_outer_deadline_turn" as TurnId,
        cause: "barge_in",
        onDegraded: () => Date.now() + policy.persistenceRecoveryGraceMs,
        onRecovered: recovered,
        onFatal: fatal,
      }),
    ).resolves.toBe(true);

    expect(checkpointAttempts).toBe(1);
    expect(activeWrites).toBe(0);
    expect(operationSettled).toBe(true);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(fatal).not.toHaveBeenCalled();
  });

  it("bounds the first checkpoint when a Runtime implementation never settles", async () => {
    const policy: DurableRuntimePolicy = {
      ...DEFAULT_DURABLE_RUNTIME_POLICY,
      criticalWriteTimeoutMs: 20,
      bargeCheckpointRetryBudgetMs: 0,
      bargeCheckpointMaxAttempts: 1,
      persistenceRecoveryGraceMs: 5,
    };
    let finishCheckpoint!: (value: unknown) => void;
    const pendingCheckpoint = new Promise<unknown>((resolve) => {
      finishCheckpoint = resolve;
    });
    let checkpointAttempts = 0;
    let fatalPendingWrite: Promise<unknown> | undefined;
    const runtime = {
      durablePolicy: policy,
      checkpointTurnInterruption() {
        checkpointAttempts += 1;
        return pendingCheckpoint;
      },
    };
    const onDegraded = vi.fn(
      () =>
        Date.now() +
        Math.max(
          policy.persistenceRecoveryGraceMs,
          policy.criticalWriteTimeoutMs + policy.bargeCheckpointRetryBudgetMs,
        ),
    );
    const onFatal = vi.fn((_error: unknown, pendingWrite?: Promise<unknown>) => {
      fatalPendingWrite = pendingWrite;
    });

    try {
      await expect(
        persistInterruptionCheckpoint({
          runtime,
          sessionId: "checkpoint_unbounded_runtime_session" as SessionId,
          turnId: "checkpoint_unbounded_runtime_turn" as TurnId,
          cause: "barge_in",
          onDegraded,
          onRecovered: vi.fn(),
          onFatal,
        }),
      ).resolves.toBe(false);

      expect(checkpointAttempts).toBe(1);
      expect(onDegraded).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(fatalPendingWrite).toBe(pendingCheckpoint);
    } finally {
      finishCheckpoint(undefined);
    }
  }, 1_000);

  it("counts synchronous checkpoint invocation time against the critical write timeout", async () => {
    const policy: DurableRuntimePolicy = {
      ...DEFAULT_DURABLE_RUNTIME_POLICY,
      criticalWriteTimeoutMs: 20,
      bargeCheckpointRetryBudgetMs: 0,
      bargeCheckpointMaxAttempts: 1,
      persistenceRecoveryGraceMs: 5,
    };
    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let checkpointAttempts = 0;
    const runtime = {
      durablePolicy: policy,
      checkpointTurnInterruption() {
        checkpointAttempts += 1;
        nowMs += 21;
        return Promise.resolve("late checkpoint commit");
      },
    };
    const onDegraded = vi.fn(
      () =>
        Date.now() +
        Math.max(
          policy.persistenceRecoveryGraceMs,
          policy.criticalWriteTimeoutMs + policy.bargeCheckpointRetryBudgetMs,
        ),
    );
    const onRecovered = vi.fn();
    const onFatal = vi.fn();

    try {
      await expect(
        persistInterruptionCheckpoint({
          runtime,
          sessionId: "checkpoint_sync_timeout_session" as SessionId,
          turnId: "checkpoint_sync_timeout_turn" as TurnId,
          cause: "barge_in",
          onDegraded,
          onRecovered,
          onFatal,
        }),
      ).resolves.toBe(true);

      expect(checkpointAttempts).toBe(1);
      expect(onDegraded).toHaveBeenCalledTimes(1);
      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(onFatal).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("fails immediately on non-retriable durable errors", async () => {
    const policy: DurableRuntimePolicy = {
      ...DEFAULT_DURABLE_RUNTIME_POLICY,
      bargeCheckpointRetryBudgetMs: 80,
      bargeCheckpointMaxAttempts: 4,
      persistenceRecoveryGraceMs: 100,
    };
    let checkpointAttempts = 0;
    const runtime = {
      durablePolicy: policy,
      async checkpointTurnInterruption() {
        checkpointAttempts += 1;
        throw new RecordConflictError("turn:checkpoint");
      },
    };
    const onFatal = vi.fn();

    await expect(
      persistInterruptionCheckpoint({
        runtime,
        sessionId: "checkpoint_conflict_session" as SessionId,
        turnId: "checkpoint_conflict_turn" as TurnId,
        cause: "barge_in",
        onDegraded: () => Date.now() + policy.persistenceRecoveryGraceMs,
        onRecovered: vi.fn(),
        onFatal,
      }),
    ).resolves.toBe(false);

    expect(checkpointAttempts).toBe(1);
    expect(onFatal).toHaveBeenCalledWith(expect.any(RecordConflictError), undefined);
  });
});
