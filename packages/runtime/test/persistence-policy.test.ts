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
    const onDegraded = vi.fn();
    const onRecovered = vi.fn();
    const onFatal = vi.fn();
    const startedAt = Date.now();

    await expect(
      persistInterruptionCheckpoint({
        runtime,
        sessionId: "checkpoint_timeout_session" as SessionId,
        turnId: "checkpoint_timeout_turn" as TurnId,
        cause: "barge_in",
        recoveryDeadlineMs: startedAt + policy.persistenceRecoveryGraceMs,
        onDegraded,
        onRecovered,
        onFatal,
      }),
    ).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(checkpointAttempts).toBe(1);
    expect(activeWrites).toBe(1);
    expect(maximumActiveWrites).toBe(1);
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(operationSettled).toBe(true), { timeout: 500 });
  });

  it("passes an in-flight checkpoint write to fatal cleanup when the recovery deadline wins", async () => {
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
    let fatalPendingWrite: Promise<unknown> | undefined;
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
    const startedAt = Date.now();
    const fatal = vi.fn((_error: unknown, pendingWrite?: Promise<unknown>) => {
      fatalPendingWrite = pendingWrite;
    });

    await expect(
      persistInterruptionCheckpoint({
        runtime,
        sessionId: "checkpoint_outer_deadline_session" as SessionId,
        turnId: "checkpoint_outer_deadline_turn" as TurnId,
        cause: "barge_in",
        recoveryDeadlineMs: startedAt + policy.persistenceRecoveryGraceMs,
        onDegraded: vi.fn(),
        onRecovered: vi.fn(),
        onFatal: fatal,
      }),
    ).resolves.toBe(false);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(checkpointAttempts).toBe(1);
    expect(activeWrites).toBe(1);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatalPendingWrite).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(operationSettled).toBe(true), { timeout: 500 });
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
        recoveryDeadlineMs: Date.now() + policy.persistenceRecoveryGraceMs,
        onDegraded: vi.fn(),
        onRecovered: vi.fn(),
        onFatal,
      }),
    ).resolves.toBe(false);

    expect(checkpointAttempts).toBe(1);
    expect(onFatal).toHaveBeenCalledWith(expect.any(RecordConflictError), undefined);
  });
});
