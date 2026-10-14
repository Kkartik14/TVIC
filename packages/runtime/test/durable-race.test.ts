import { describe, expect, it, vi } from "vitest";

import {
  BackendUnavailableError,
  internalError,
  LeaseUnavailableError,
  toolError,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type OrganizationId,
  type RunningToolCall,
  type SessionLease,
  type SessionId,
  type TerminalToolCall,
  type TurnId,
  type ToolCallId,
  type ToolId,
  type ToolIdempotencyRecord,
  type ToolName,
  type Timestamp,
  type UserId,
  type WorkflowId,
} from "@tvic/core";
import { createInMemoryDurableRuntimeStore } from "@tvic/dal";
import {
  InMemoryToolIdempotencyStore,
  executeTool,
  idempotencyKeyFor,
  idempotencyRequestHashFor,
} from "@tvic/tools";
import { legacyIdempotencyForRecovery } from "../../tools/src/idempotency.js";

import { InMemoryRuntime } from "../src/create-runtime.js";
import { replayRecoveredToolCall } from "../src/tool-recovery.js";
import { buildAgent } from "./harness.js";
import { defineTool } from "../src/index.js";
import { ControllableDurableStore } from "./controllable-durable-store.js";

describe("durable write races", () => {
  const delayedWritePolicy = {
    criticalWriteTimeoutMs: 10,
    leaseTtlMs: 30_000,
    leaseHeartbeatMs: 10_000,
  } as const;

  it("holds attach admission until a timed-out lease acquisition is released", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const originalAcquire = durableStore.leases.acquire.bind(durableStore.leases);
    const originalRelease = durableStore.leases.release.bind(durableStore.leases);
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    let allowAcquireToReturn!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      allowAcquireToReturn = resolve;
    });
    let signalLateReleaseStarted!: () => void;
    const lateReleaseStarted = new Promise<void>((resolve) => {
      signalLateReleaseStarted = resolve;
    });
    let allowLateRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      allowLateRelease = resolve;
    });
    let signalLateReleaseFinished!: () => void;
    const lateReleaseFinished = new Promise<void>((resolve) => {
      signalLateReleaseFinished = resolve;
    });
    let acquiredLease: Pick<SessionLease, "fence" | "generationId"> | undefined;
    let resolveAcquiredLease!: (lease: Pick<SessionLease, "fence" | "generationId">) => void;
    const acquiredLeaseResult = new Promise<Pick<SessionLease, "fence" | "generationId">>(
      (resolve) => {
        resolveAcquiredLease = resolve;
      },
    );
    let acquireCalls = 0;
    vi.spyOn(durableStore.leases, "acquire").mockImplementation(
      async (sessionId, holder, ttlMs) => {
        const lease = await originalAcquire(sessionId, holder, ttlMs);
        acquireCalls += 1;
        if (acquireCalls === 1) {
          if (!lease)
            throw new Error("the initial in-memory lease acquisition unexpectedly failed");
          acquiredLease = { fence: lease.fence, generationId: lease.generationId };
          resolveAcquiredLease(acquiredLease);
          signalAcquired();
          await acquireGate;
        }
        return lease;
      },
    );
    vi.spyOn(durableStore.leases, "release").mockImplementation(
      async (sessionId, holder, fence, generationId) => {
        if (
          acquiredLease &&
          fence === acquiredLease.fence &&
          generationId === acquiredLease.generationId
        ) {
          signalLateReleaseStarted();
          await releaseGate;
          await originalRelease(sessionId, holder, fence, generationId);
          signalLateReleaseFinished();
          return;
        }
        await originalRelease(sessionId, holder, fence, generationId);
      },
    );

    const firstAttach = runtime.attachSession(buildAgent(), session.id);
    try {
      await acquired;
      await expect(firstAttach).rejects.toBeInstanceOf(BackendUnavailableError);
      await expect(runtime.attachSession(buildAgent(), session.id)).rejects.toBeInstanceOf(
        LeaseUnavailableError,
      );

      allowAcquireToReturn();
      await lateReleaseStarted;
      await expect(runtime.attachSession(buildAgent(), session.id)).rejects.toBeInstanceOf(
        LeaseUnavailableError,
      );

      allowLateRelease();
      await lateReleaseFinished;
      await wait(0);
      expect(await durableStore.leases.get(session.id)).toBeNull();

      const firstLease = await acquiredLeaseResult;
      const attachment = await runtime.attachSession(buildAgent(), session.id);
      expect(attachment.lease?.fence).toBeGreaterThan(firstLease.fence);
      await attachment.detach();
    } finally {
      allowAcquireToReturn();
      allowLateRelease();
      await firstAttach.catch(() => undefined);
      await runtime.stop();
    }
  });

  it("holds attach admission until a timed-out recovery transaction releases its lease", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const originalTransaction = durableStore.runSessionTransaction.bind(durableStore);
    const originalRelease = durableStore.leases.release.bind(durableStore.leases);
    let signalRecoveryCommitted!: () => void;
    const recoveryCommitted = new Promise<void>((resolve) => {
      signalRecoveryCommitted = resolve;
    });
    let allowRecoveryToReturn!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      allowRecoveryToReturn = resolve;
    });
    let signalLateReleaseStarted!: () => void;
    const lateReleaseStarted = new Promise<void>((resolve) => {
      signalLateReleaseStarted = resolve;
    });
    let allowLateRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      allowLateRelease = resolve;
    });
    let signalLateReleaseFinished!: () => void;
    const lateReleaseFinished = new Promise<void>((resolve) => {
      signalLateReleaseFinished = resolve;
    });
    let pauseRecoveryReturn = true;
    vi.spyOn(durableStore, "runSessionTransaction").mockImplementation(
      async <T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> => {
        const result = await originalTransaction<T>(sessionId, lease, operation);
        if (pauseRecoveryReturn) {
          pauseRecoveryReturn = false;
          signalRecoveryCommitted();
          await recoveryGate;
        }
        return result;
      },
    );

    const firstAttach = runtime.attachSession(buildAgent(), session.id);
    let firstLease: Pick<SessionLease, "fence" | "generationId"> | undefined;
    let retryAttachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await recoveryCommitted;
      const currentLease = await durableStore.leases.get(session.id);
      if (!currentLease) throw new Error("the recovery transaction unexpectedly lost its lease");
      firstLease = { fence: currentLease.fence, generationId: currentLease.generationId };
      vi.spyOn(durableStore.leases, "release").mockImplementation(
        async (sessionId, holder, fence, generationId) => {
          if (
            firstLease &&
            fence === firstLease.fence &&
            generationId === firstLease.generationId
          ) {
            signalLateReleaseStarted();
            await releaseGate;
            await originalRelease(sessionId, holder, fence, generationId);
            signalLateReleaseFinished();
            return;
          }
          await originalRelease(sessionId, holder, fence, generationId);
        },
      );

      await expect(firstAttach).rejects.toBeInstanceOf(BackendUnavailableError);
      await expect(runtime.attachSession(buildAgent(), session.id)).rejects.toBeInstanceOf(
        LeaseUnavailableError,
      );

      allowRecoveryToReturn();
      await lateReleaseStarted;
      await expect(runtime.attachSession(buildAgent(), session.id)).rejects.toBeInstanceOf(
        LeaseUnavailableError,
      );

      allowLateRelease();
      await lateReleaseFinished;
      await wait(0);
      expect(await durableStore.leases.get(session.id)).toBeNull();

      retryAttachment = await runtime.attachSession(buildAgent(), session.id);
      expect(retryAttachment.lease?.fence).toBeGreaterThan(firstLease.fence);
      await retryAttachment.detach();
    } finally {
      allowRecoveryToReturn();
      allowLateRelease();
      await firstAttach.catch(() => undefined);
      await retryAttachment?.detach().catch(() => undefined);
      await runtime.stop();
    }
  });

  it("holds attach admission until a timed-out detach release settles", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      holderId: "detach_release_owner",
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const sessionId = attachment.session.id;
    const originalRelease = durableStore.leases.release.bind(durableStore.leases);
    let signalReleaseStarted!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      signalReleaseStarted = resolve;
    });
    let allowRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      allowRelease = resolve;
    });
    let signalReleaseFinished!: () => void;
    const releaseFinished = new Promise<void>((resolve) => {
      signalReleaseFinished = resolve;
    });
    vi.spyOn(durableStore.leases, "release").mockImplementation(
      async (releasedSessionId, holder, fence, generationId) => {
        signalReleaseStarted();
        await releaseGate;
        await originalRelease(releasedSessionId, holder, fence, generationId);
        signalReleaseFinished();
      },
    );

    let detach: Promise<void> | undefined;
    let retryAttachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      detach = attachment.detach();
      await releaseStarted;
      await wait(1_050);
      await detach;

      await expect(runtime.attachSession(buildAgent(), sessionId)).rejects.toBeInstanceOf(
        LeaseUnavailableError,
      );

      allowRelease();
      await releaseFinished;
      await wait(0);
      retryAttachment = await runtime.attachSession(buildAgent(), sessionId);
      expect(retryAttachment.lease?.fence).toBeGreaterThan(attachment.lease!.fence);
      await retryAttachment.detach();
    } finally {
      allowRelease();
      await detach?.catch(() => undefined);
      await releaseFinished.catch(() => undefined);
      await retryAttachment?.detach().catch(() => undefined);
      await runtime.stop();
    }
  });

  it("keeps a late completed terminal turn from being overwritten by a retry", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      holderId: "race_owner",
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "race", mediaEventIds: [] },
    });

    controlled.delayNextTransaction(30);
    await expect(
      runtime.endTurn(attachment.session.id, turn.id, {
        reason: "completed",
        output: { text: "done", mediaEventIds: [] },
      }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);

    await wait(40);
    await expect(
      runtime.endTurn(attachment.session.id, turn.id, {
        reason: "failed",
        error: internalError("test.late_retry", "must not replace the late winner"),
      }),
    ).resolves.toMatchObject({ status: "completed", output: { text: "done" } });
    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      turns: [{ id: turn.id, status: "completed" }],
    });
    await attachment.detach();
  });

  it("reconciles a session created after the caller deadline", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const ended: string[] = [];
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      durablePolicy: delayedWritePolicy,
      onSessionEnd: ({ session }) => {
        ended.push(session.id);
      },
    });
    await runtime.start();
    controlled.delayNextUnfencedTransaction(30);

    await expect(
      runtime.startSession(buildAgent(), { channel: "simulated" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    await wait(60);

    const sessions = await controlled.sessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session.status).toBe("failed");
    expect(ended).toEqual([sessions[0]!.session.id]);
  });

  it("waits for a late session cleanup before closing the runtime store", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    let statusAtClose: string | undefined;
    const closeStore = controlled.close.bind(controlled);
    vi.spyOn(controlled, "close").mockImplementation(async () => {
      statusAtClose = (await controlled.base.sessions.list())[0]?.session.status;
      await closeStore();
    });
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    controlled.delayNextUnfencedTransaction(30);

    await expect(
      runtime.startSession(buildAgent(), { channel: "simulated" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);

    await runtime.stop();
    expect(statusAtClose).toBe("failed");
  });

  it("finishes a late attached session end without losing its lease or turn duration", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      holderId: "late_end_owner",
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "late end", mediaEventIds: [] },
    });

    controlled.delayNextTransaction(30);
    await expect(
      runtime.endSession(attachment.session.id, { reason: "completed" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(runtime.attachSession(buildAgent(), attachment.session.id)).rejects.toBeInstanceOf(
      LeaseUnavailableError,
    );

    await wait(70);
    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      session: { status: "completed" },
      turns: [
        {
          id: turn.id,
          status: "cancelled",
          reason: "explicit",
          latency: { totalMs: expect.any(Number) },
        },
      ],
    });
    expect(await controlled.leases.get(attachment.session.id)).toBeNull();
    await expect(runtime.attachSession(buildAgent(), attachment.session.id)).rejects.toThrow(
      /Cannot attach completed session/,
    );
    await runtime.stop();
  });

  it("reconciles a late turn start instead of leaving an open turn", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    controlled.delayNextTransaction(30);

    await expect(
      runtime.startTurn({
        sessionId: attachment.session.id,
        input: { transcript: "late", mediaEventIds: [] },
      }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    await wait(60);

    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      turns: [{ status: "cancelled", reason: "runtime_restarted" }],
    });
    await attachment.detach();
  });

  it("reconciles a session attachment created after the caller deadline", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const fencedCleanup = vi.spyOn(controlled, "runSessionTransaction");
    const unfencedCleanup = vi.spyOn(controlled, "runUnfencedSessionTransaction");
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    controlled.delayNextSessionCreation(30);

    await expect(
      runtime.startAttachedSession(buildAgent(), { channel: "simulated" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    await wait(70);

    const sessions = await controlled.sessions.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.session.status).toBe("failed");
    expect(await controlled.leases.get(sessions[0]!.session.id)).toBeNull();
    expect(fencedCleanup).toHaveBeenCalledWith(
      sessions[0]!.session.id,
      expect.objectContaining({ fence: 1 }),
      expect.any(Function),
    );
    expect(unfencedCleanup).not.toHaveBeenCalled();
  });

  it("uses a lease to clean up a late legacy session start", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const fencedCleanup = vi.spyOn(controlled, "runSessionTransaction");
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    controlled.delayNextUnfencedTransaction(30);

    await expect(
      runtime.startSession(buildAgent(), { channel: "simulated" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    await wait(70);

    const [record] = await controlled.sessions.list();
    expect(record?.session).toMatchObject({
      status: "failed",
      error: { code: "runtime.session_start_timed_out" },
    });
    expect(fencedCleanup).toHaveBeenCalledWith(
      record!.session.id,
      expect.objectContaining({ fence: 1 }),
      expect.any(Function),
    );
    expect(await controlled.leases.get(record!.session.id)).toBeNull();
    await runtime.stop();
  });

  it("terminalizes a legacy start that finishes after shutdown begins", async () => {
    const base = createInMemoryDurableRuntimeStore();
    let signalPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => {
      signalPersisted = resolve;
    });
    let allowReturn!: () => void;
    const returnGate = new Promise<void>((resolve) => {
      allowReturn = resolve;
    });
    const durableStore = createLegacyDurableStore(base, {
      afterUnfencedTransaction: async () => {
        signalPersisted();
        await returnGate;
      },
      beforeClose: async () => {
        const [record] = await base.sessions.list();
        expect(record?.session).toMatchObject({
          status: "cancelled",
          cancelReason: "shutdown",
          terminalSource: "runtime_shutdown",
        });
      },
    });
    const runtime = new InMemoryRuntime({ durableStore });
    await runtime.start();

    const starting = runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    await persisted;
    const [record] = await base.sessions.list();
    expect(record?.session.status).toBe("active");

    const stopping = runtime.stop();
    allowReturn();

    await expect(starting).rejects.toThrow("Runtime is not running");
    await stopping;
  });

  it("terminalizes a direct legacy session start that finishes after shutdown begins", async () => {
    const base = createInMemoryDurableRuntimeStore();
    let signalPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => {
      signalPersisted = resolve;
    });
    let allowReturn!: () => void;
    const returnGate = new Promise<void>((resolve) => {
      allowReturn = resolve;
    });
    const durableStore = createLegacyDurableStore(base, {
      afterUnfencedTransaction: async () => {
        signalPersisted();
        await returnGate;
      },
      beforeClose: async () => {
        const [record] = await base.sessions.list();
        expect(record?.session).toMatchObject({
          status: "cancelled",
          cancelReason: "shutdown",
          terminalSource: "runtime_shutdown",
        });
      },
    });
    const runtime = new InMemoryRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 10_000 },
    });
    await runtime.start();

    const starting = runtime.startSession(buildAgent(), { channel: "simulated" });
    await persisted;
    const [record] = await base.sessions.list();
    expect(record?.session.status).toBe("active");

    const stopping = runtime.stop();
    allowReturn();

    await expect(starting).rejects.toThrow("Runtime is not running");
    await stopping;
    expect(runtime.debugStats().activeSessionClocks).toBe(0);
  });

  it("terminalizes a legacy session start that finishes after shutdown hard-stops", async () => {
    vi.useFakeTimers();
    try {
      const base = createInMemoryDurableRuntimeStore();
      let signalPersisted!: () => void;
      const persisted = new Promise<void>((resolve) => {
        signalPersisted = resolve;
      });
      let allowReturn!: () => void;
      const returnGate = new Promise<void>((resolve) => {
        allowReturn = resolve;
      });
      const durableStore = createLegacyDurableStore(base, {
        afterUnfencedTransaction: async () => {
          signalPersisted();
          await returnGate;
        },
      });
      const runtime = new InMemoryRuntime({
        durableStore,
        durableStoreOwnership: "caller",
        durablePolicy: { criticalWriteTimeoutMs: 60_000 },
      });
      await runtime.start();

      const starting = runtime.startSession(buildAgent(), { channel: "simulated" });
      await persisted;
      let finishPipeline!: () => void;
      const pipeline = new Promise<void>((resolve) => {
        finishPipeline = resolve;
      });
      runtime.registerPipelineRun(pipeline, () => undefined);

      const stopping = runtime.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(
        runtime.endSession("hard_stop_probe" as SessionId, { reason: "completed" }),
      ).rejects.toThrow("Runtime shutdown hard-stop deadline exceeded");

      allowReturn();
      await expect(starting).rejects.toThrow("Runtime is not running");
      await stopping;
      finishPipeline();

      const [record] = await base.sessions.list();
      expect(record?.session).toMatchObject({
        status: "cancelled",
        cancelReason: "shutdown",
        terminalSource: "runtime_shutdown",
      });
      expect(await base.leases.get(record!.session.id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminalizes an atomically created session when attach setup fails", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const fencedCleanup = vi.spyOn(durableStore, "runSessionTransaction");
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      preCallContextResolver: async () => {
        throw new Error("pre-call context unavailable");
      },
    });
    await runtime.start();

    await expect(
      runtime.startAttachedSession(buildAgent(), { channel: "simulated" }),
    ).rejects.toThrow("pre-call context unavailable");

    const [record] = await durableStore.sessions.list();
    expect(record?.session).toMatchObject({
      status: "failed",
      error: { code: "runtime.session_attach_failed" },
    });
    expect(fencedCleanup).toHaveBeenCalledWith(
      record!.session.id,
      expect.objectContaining({ fence: 1 }),
      expect.any(Function),
    );
    expect(await durableStore.leases.get(record!.session.id)).toBeNull();
    await runtime.stop();
  });

  it("does not recover a running tool while another runtime owns its lease", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const owner = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      holderId: "tool_recovery_owner",
    });
    const recovery = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      holderId: "tool_recovery_other",
    });
    await Promise.all([owner.start(), recovery.start()]);
    const attachment = await owner.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await owner.startTurn({ sessionId: attachment.session.id });
    const running = await owner.startToolCall({
      toolCallId: "live_owned_recovery_call" as ToolCallId,
      toolId: "live_owned_recovery_tool" as ToolId,
      toolName: "live_owned_recovery_tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: { action: "complete" },
      attempts: 1,
      queuedAt: "2026-01-01T00:00:00.000Z" as Timestamp,
      status: "queued",
    });
    const unfencedRecovery = vi.spyOn(durableStore, "runUnfencedSessionTransaction");

    await expect(recovery.recoverToolCalls(attachment.session.id)).rejects.toThrow(
      `Session lease unavailable: ${attachment.session.id}`,
    );
    expect(unfencedRecovery).not.toHaveBeenCalled();

    const succeeded: TerminalToolCall = {
      ...running,
      status: "succeeded",
      endedAt: "2026-01-01T00:00:01.000Z" as Timestamp,
      output: { result: "owner result" },
    };
    await expect(owner.finishToolCall(succeeded)).resolves.toMatchObject({
      status: "succeeded",
      output: { result: "owner result" },
    });
    await attachment.detach();
    await Promise.all([owner.stop(), recovery.stop()]);
  });

  it("compensates a legacy start when its initial attachment read fails", async () => {
    const base = createInMemoryDurableRuntimeStore();
    let failAttachmentRead = false;
    const originalGet = base.sessions.get.bind(base.sessions);
    vi.spyOn(base.sessions, "get").mockImplementation(async (sessionId) => {
      const record = await originalGet(sessionId);
      if (failAttachmentRead) {
        failAttachmentRead = false;
        throw new Error("temporary session read failure");
      }
      return record;
    });
    const fencedCleanup = vi.spyOn(base, "runSessionTransaction");
    const durableStore = createLegacyDurableStore(base, {
      afterUnfencedTransaction: async () => {
        failAttachmentRead = true;
      },
    });
    const runtime = new InMemoryRuntime({ durableStore });
    await runtime.start();

    await expect(
      runtime.startAttachedSession(buildAgent(), { channel: "simulated" }),
    ).rejects.toThrow("temporary session read failure");

    const [record] = await base.sessions.list();
    expect(record?.session).toMatchObject({
      status: "failed",
      error: { code: "runtime.session_attach_failed" },
    });
    expect(fencedCleanup).toHaveBeenCalledWith(
      record!.session.id,
      expect.objectContaining({ fence: 1 }),
      expect.any(Function),
    );
    expect(await base.leases.get(record!.session.id)).toBeNull();
    await runtime.stop();
  });

  it("drains an attachment admitted before shutdown", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let allowReadToFinish!: () => void;
    const readGate = new Promise<void>((resolve) => {
      allowReadToFinish = resolve;
    });
    const originalGet = durableStore.sessions.get.bind(durableStore.sessions);
    let pauseNextRead = true;
    vi.spyOn(durableStore.sessions, "get").mockImplementation(async (sessionId) => {
      const record = await originalGet(sessionId);
      if (pauseNextRead) {
        pauseNextRead = false;
        signalReadStarted();
        await readGate;
      }
      return record;
    });

    const attaching = runtime.attachSession(buildAgent(), session.id);
    await readStarted;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await wait(0);
    expect(stopped).toBe(false);

    allowReadToFinish();
    await expect(attaching).rejects.toThrow("Runtime is not running");
    await stopping;
    expect(stopped).toBe(true);
    expect(await durableStore.leases.get(session.id)).toBeNull();
  });

  it("drains a turn start while its initial session read is pending", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let allowReadToFinish!: () => void;
    const readGate = new Promise<void>((resolve) => {
      allowReadToFinish = resolve;
    });
    const originalGet = durableStore.sessions.get.bind(durableStore.sessions);
    let pauseNextRead = true;
    vi.spyOn(durableStore.sessions, "get").mockImplementation(async (sessionId) => {
      const record = await originalGet(sessionId);
      if (pauseNextRead) {
        pauseNextRead = false;
        signalReadStarted();
        await readGate;
      }
      return record;
    });

    const startingTurn = runtime.startTurn({ sessionId: attachment.session.id });
    await readStarted;
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await wait(0);
    expect(stopped).toBe(false);

    allowReadToFinish();
    const turn = await startingTurn;
    await stopping;
    expect(stopped).toBe(true);
    await expect(durableStore.turns.get(attachment.session.id, turn.id)).resolves.toMatchObject({
      turn: { status: "started" },
    });
  });

  it("does not let a turn start downgrade to unfenced after its attachment is detached", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const agent = buildAgent();
    const firstRuntime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      holderId: "turn_start_old_owner",
    });
    const secondRuntime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      holderId: "turn_start_new_owner",
    });
    await Promise.all([firstRuntime.start(), secondRuntime.start()]);
    const attachment = await firstRuntime.startAttachedSession(agent, { channel: "simulated" });
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let allowReadToFinish!: () => void;
    const readGate = new Promise<void>((resolve) => {
      allowReadToFinish = resolve;
    });
    const originalGet = durableStore.sessions.get.bind(durableStore.sessions);
    let pauseNextRead = true;
    vi.spyOn(durableStore.sessions, "get").mockImplementation(async (sessionId) => {
      const record = await originalGet(sessionId);
      if (pauseNextRead) {
        pauseNextRead = false;
        signalReadStarted();
        await readGate;
      }
      return record;
    });

    let secondAttachment: Awaited<ReturnType<typeof secondRuntime.attachSession>> | undefined;
    const startingTurn = firstRuntime.startTurn({ sessionId: attachment.session.id });
    try {
      await readStarted;
      await attachment.detach();
      allowReadToFinish();

      await expect(startingTurn).rejects.toThrow();
      secondAttachment = await secondRuntime.attachSession(agent, attachment.session.id);
      expect(secondAttachment.snapshot.turns).toHaveLength(0);
    } finally {
      allowReadToFinish();
      await startingTurn.catch(() => undefined);
      await secondAttachment?.detach();
      await Promise.all([firstRuntime.stop(), secondRuntime.stop()]);
    }
  });

  it("does not detach a new attachment when an unfenced end fails", async () => {
    const durableStore = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    const agent = buildAgent();
    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const originalRunUnfenced = durableStore.runUnfencedSessionTransaction.bind(durableStore);
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let allowWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      allowWrite = resolve;
    });
    durableStore.runUnfencedSessionTransaction = async (sessionId, operation) => {
      signalWriteStarted();
      await writeGate;
      return originalRunUnfenced(sessionId, operation);
    };

    const ending = runtime.endSession(session.id, { reason: "completed" });
    void ending.catch(() => undefined);
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await writeStarted;
      attachment = await runtime.attachSession(agent, session.id);
      allowWrite();

      await expect(ending).rejects.toThrow();
      expect(attachment.health).toBe("healthy");
      await expect(runtime.getSession(session.id)).resolves.toMatchObject({ status: "active" });
    } finally {
      allowWrite();
      await ending.catch(() => undefined);
      await attachment?.detach();
      await runtime.stop();
    }
  });

  it("waits for admitted unfenced turn writes before attaching", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let allowWriteToFinish!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      allowWriteToFinish = resolve;
    });
    const transactionStore = durableStore as DurableRuntimeStore & {
      runUnfencedSessionTransaction: NonNullable<
        DurableRuntimeStore["runUnfencedSessionTransaction"]
      >;
    };
    const originalUnfenced = transactionStore.runUnfencedSessionTransaction.bind(transactionStore);
    const attachTransaction = vi.spyOn(durableStore, "runSessionTransaction");
    vi.spyOn(transactionStore, "runUnfencedSessionTransaction").mockImplementation(
      async <T>(
        sessionId: SessionId,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> => {
        signalWriteStarted();
        await writeGate;
        return originalUnfenced<T>(sessionId, operation);
      },
    );

    const startingTurn = runtime.startTurn({ sessionId: session.id });
    let attaching: ReturnType<typeof runtime.attachSession> | undefined;
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await writeStarted;
      attaching = runtime.attachSession(buildAgent(), session.id);
      await wait(0);
      expect(attachTransaction).not.toHaveBeenCalled();
      await expect(durableStore.leases.get(session.id)).resolves.toBeNull();

      allowWriteToFinish();
      const turn = await startingTurn;
      attachment = await attaching;
      expect(attachment.snapshot.turns).toMatchObject([
        { id: turn.id, status: "cancelled", reason: "runtime_restarted" },
      ]);
    } finally {
      allowWriteToFinish();
      await startingTurn.catch(() => undefined);
      const resolvedAttachment = await attaching?.catch(() => undefined);
      await (attachment ?? resolvedAttachment)?.detach();
      await runtime.stop();
    }
  });

  it("waits for admitted unfenced open tool records before attaching", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({ sessionId: session.id });
    const running: RunningToolCall = {
      status: "running",
      toolCallId: "attachment_admission_tool_call" as ToolCallId,
      toolId: "attachment_admission_tool" as RunningToolCall["toolId"],
      toolName: "attachment_admission_tool" as ToolName,
      sessionId: session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: "2026-10-12T00:00:00.000Z" as Timestamp,
      startedAt: "2026-10-12T00:00:01.000Z" as Timestamp,
    };
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let allowWriteToFinish!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      allowWriteToFinish = resolve;
    });
    const transactionStore = durableStore as DurableRuntimeStore & {
      runUnfencedSessionTransaction: NonNullable<
        DurableRuntimeStore["runUnfencedSessionTransaction"]
      >;
    };
    const originalUnfenced = transactionStore.runUnfencedSessionTransaction.bind(transactionStore);
    vi.spyOn(transactionStore, "runUnfencedSessionTransaction").mockImplementation(
      async <T>(
        sessionId: SessionId,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> => {
        signalWriteStarted();
        await writeGate;
        return originalUnfenced<T>(sessionId, operation);
      },
    );
    const attachTransaction = vi.spyOn(durableStore, "runSessionTransaction");

    const recording = runtime.recordToolCall(running);
    let attaching: ReturnType<typeof runtime.attachSession> | undefined;
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await writeStarted;
      attaching = runtime.attachSession(buildAgent(), session.id);
      await wait(0);
      expect(attachTransaction).not.toHaveBeenCalled();
      await expect(durableStore.leases.get(session.id)).resolves.toBeNull();

      allowWriteToFinish();
      await recording;
      attachment = await attaching;
      expect(attachment.snapshot.toolCalls).toMatchObject([
        {
          toolCallId: running.toolCallId,
          status: "failed",
          error: { code: "tool.runtime_restarted" },
        },
      ]);
    } finally {
      allowWriteToFinish();
      await recording.catch(() => undefined);
      const resolvedAttachment = await attaching?.catch(() => undefined);
      await (attachment ?? resolvedAttachment)?.detach();
      await runtime.stop();
    }
  });

  it("rejects an open tool record admitted during attachment recovery", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const running: RunningToolCall = {
      status: "running",
      toolCallId: "attachment_recovery_racing_tool_call" as ToolCallId,
      toolId: "attachment_recovery_racing_tool" as RunningToolCall["toolId"],
      toolName: "attachment_recovery_racing_tool" as ToolName,
      sessionId: session.id,
      turnId: "attachment_recovery_racing_turn" as TurnId,
      input: {},
      attempts: 1,
      queuedAt: "2026-10-12T00:00:00.000Z" as Timestamp,
      startedAt: "2026-10-12T00:00:01.000Z" as Timestamp,
    };
    let signalRecoveryRead!: () => void;
    const recoveryReadStarted = new Promise<void>((resolve) => {
      signalRecoveryRead = resolve;
    });
    let allowRecoveryToContinue!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      allowRecoveryToContinue = resolve;
    });
    const originalList = durableStore.toolCalls.listBySession.bind(durableStore.toolCalls);
    vi.spyOn(durableStore.toolCalls, "listBySession").mockImplementation(async (sessionId) => {
      const records = await originalList(sessionId);
      signalRecoveryRead();
      await recoveryGate;
      return records;
    });

    let attaching: ReturnType<typeof runtime.attachSession> | undefined;
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      attaching = runtime.attachSession(buildAgent(), session.id);
      await recoveryReadStarted;
      await expect(runtime.recordToolCall(running)).rejects.toThrow(
        "Session attachment is starting",
      );
      allowRecoveryToContinue();
      attachment = await attaching;
      expect(attachment.snapshot.toolCalls).toEqual([]);
      await expect(durableStore.toolCalls.listBySession(session.id)).resolves.toEqual([]);
    } finally {
      allowRecoveryToContinue();
      const resolvedAttachment = await attaching?.catch(() => undefined);
      await (attachment ?? resolvedAttachment)?.detach();
      await runtime.stop();
    }
  });

  it("rejects a turn read that resumes during attachment recovery", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let allowReadToFinish!: () => void;
    const readGate = new Promise<void>((resolve) => {
      allowReadToFinish = resolve;
    });
    const originalGet = durableStore.sessions.get.bind(durableStore.sessions);
    let pauseNextRead = true;
    vi.spyOn(durableStore.sessions, "get").mockImplementation(async (sessionId) => {
      const record = await originalGet(sessionId);
      if (pauseNextRead) {
        pauseNextRead = false;
        signalReadStarted();
        await readGate;
      }
      return record;
    });
    let signalRecoveryCommitted!: () => void;
    const recoveryCommitted = new Promise<void>((resolve) => {
      signalRecoveryCommitted = resolve;
    });
    let allowAttachmentToContinue!: () => void;
    const attachmentGate = new Promise<void>((resolve) => {
      allowAttachmentToContinue = resolve;
    });
    const originalFenced = durableStore.runSessionTransaction.bind(durableStore);
    let pauseRecovery = true;
    vi.spyOn(durableStore, "runSessionTransaction").mockImplementation(
      async <T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> => {
        const result = await originalFenced<T>(sessionId, lease, operation);
        if (pauseRecovery) {
          pauseRecovery = false;
          signalRecoveryCommitted();
          await attachmentGate;
        }
        return result;
      },
    );

    const startingTurn = runtime.startTurn({ sessionId: session.id });
    let attaching: ReturnType<typeof runtime.attachSession> | undefined;
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await readStarted;
      attaching = runtime.attachSession(buildAgent(), session.id);
      await recoveryCommitted;
      allowReadToFinish();
      await expect(startingTurn).rejects.toThrow("Session attachment is starting");
      await expect(durableStore.turns.listBySession(session.id)).resolves.toHaveLength(0);

      allowAttachmentToContinue();
      attachment = await attaching;
      expect(attachment.snapshot.turns).toHaveLength(0);
    } finally {
      allowReadToFinish();
      allowAttachmentToContinue();
      await startingTurn.catch(() => undefined);
      const resolvedAttachment = await attaching?.catch(() => undefined);
      await (attachment ?? resolvedAttachment)?.detach();
      await runtime.stop();
    }
  });

  it("reconciles a late tool start instead of leaving a running call", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      durablePolicy: delayedWritePolicy,
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({ sessionId: attachment.session.id });
    const queued = {
      status: "queued" as const,
      toolCallId: "late_tool_start" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    };
    controlled.delayNextTransaction(30);

    await expect(runtime.startToolCall(queued)).rejects.toBeInstanceOf(BackendUnavailableError);
    await wait(70);

    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      toolCalls: [{ toolCallId: "late_tool_start", status: "cancelled" }],
      session: { state: { pendingToolCallIds: [] } },
    });
    await attachment.detach();
  });

  it("commits queued, running, and pending-state changes as one tool transaction", async () => {
    const base = createInMemoryDurableRuntimeStore();
    const controlled = new ControllableDurableStore(base);
    const runtime = new InMemoryRuntime({ durableStore: controlled, holderId: "tool_owner" });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "tool", mediaEventIds: [] },
    });
    const queued = {
      status: "queued" as const,
      toolCallId: "tool_atomic" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    };

    await runtime.startToolCall(queued);
    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      toolCalls: [{ toolCallId: "tool_atomic", status: "running" }],
      session: { state: { pendingToolCallIds: ["tool_atomic"] } },
    });
    await runtime.finishToolCall({
      ...queued,
      status: "succeeded",
      startedAt: queued.queuedAt,
      endedAt: queued.queuedAt,
      output: { ok: true },
    });
    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      session: { state: { pendingToolCallIds: [] } },
    });
    await attachment.detach();
  });

  it("replays a durable idempotent success when recovering a running tool", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const idempotencyStore = new InMemoryToolIdempotencyStore(
      () => Date.now(),
      (sessionId) => durableStore.currentLease(sessionId),
    );
    const tool = defineTool({
      id: "recovery_tool",
      name: "recovery_tool",
      description: "A recoverable tool",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        throw new Error("the recovered executor must not run");
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const first = new InMemoryRuntime({
      durableStore,
      toolIdempotencyStore: idempotencyStore,
      holderId: "replay_first",
    });
    await first.start();
    const tenant = {
      userId: "recovery_user" as UserId,
      organizationId: "recovery_org" as OrganizationId,
      workflowId: "recovery_workflow" as WorkflowId,
    };
    const firstAttachment = await first.startAttachedSession(agent, {
      channel: "simulated",
      memoryUserId: tenant.userId,
      organizationId: tenant.organizationId,
      workflowId: tenant.workflowId,
    });
    const turn = await first.startTurn({
      sessionId: firstAttachment.session.id,
      input: { transcript: "recover", mediaEventIds: [] },
    });
    const toolCallId = "recovery_tool_call" as ToolCallId;
    const queued = {
      status: "queued" as const,
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: firstAttachment.session.id,
      turnId: turn.id,
      input: { reservation: "r1" },
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    };
    const idempotencyInput = {
      tool,
      input: queued.input,
      sessionId: queued.sessionId,
      turnId: queued.turnId,
      toolCallId: queued.toolCallId,
      tenant,
    };
    const key = idempotencyKeyFor(idempotencyInput);
    if (!key || !firstAttachment.lease) throw new Error("expected a lease-backed idempotency key");
    await first.startToolCall(queued);
    await expect(
      durableStore.toolCalls.get(queued.sessionId, queued.toolCallId),
    ).resolves.toMatchObject({
      toolCall: { status: "running", toolId: queued.toolId },
    });
    const requestHash = idempotencyRequestHashFor(idempotencyInput);
    await idempotencyStore.claim({
      key,
      lease: firstAttachment.lease,
      toolId: tool.id,
      toolVersion: tool.version,
      requestHash,
      owner: toolCallId,
      ttlMs: 10_000,
    });
    await idempotencyStore.complete(key, requestHash, {
      status: "succeeded",
      owner: toolCallId,
      ttlMs: 10_000,
      lease: firstAttachment.lease,
      output: { confirmed: true },
    });
    await expect(
      idempotencyStore.lookup(key, requestHash, queued.sessionId, firstAttachment.lease),
    ).resolves.toMatchObject({
      status: "found",
      record: { key, sessionId: queued.sessionId, requestHash, status: "succeeded" },
    });
    await firstAttachment.detach();

    let transactionCallbackActive = false;
    const originalRunSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    const runSessionTransaction: typeof durableStore.runSessionTransaction = async (
      sessionId,
      lease,
      operation,
    ) =>
      originalRunSessionTransaction(sessionId, lease, async (tx: DurableSessionTransaction) => {
        transactionCallbackActive = true;
        try {
          return await operation(tx);
        } finally {
          transactionCallbackActive = false;
        }
      });
    const guardedDurableStore = { ...durableStore, runSessionTransaction };

    const second = new InMemoryRuntime({
      durableStore: guardedDurableStore,
      toolIdempotencyStore: idempotencyStore,
      holderId: "replay_second",
    });
    const originalLookup = idempotencyStore.lookup.bind(idempotencyStore);
    const recoveryLookup = vi
      .spyOn(idempotencyStore, "lookup")
      .mockImplementation(async (...args) => {
        expect(transactionCallbackActive).toBe(false);
        return originalLookup(...args);
      });
    await second.start();
    const recovered = await second.attachSession(agent, firstAttachment.session.id, {
      holderId: "replay_second",
    });
    expect(recoveryLookup).toHaveBeenCalledWith(
      key,
      requestHash,
      queued.sessionId,
      expect.objectContaining({ sessionId: queued.sessionId }),
    );
    const replayed = recovered.snapshot.toolCalls.find((call) => call.toolCallId === toolCallId);
    expect(replayed).toMatchObject({
      status: "succeeded",
      output: { confirmed: true },
      metadata: { recovery: "idempotent_replay", idempotentHit: true },
    });
    expect(replayed).not.toHaveProperty("idempotencyKey");
    await recovered.detach();
  });

  it("terminalizes a stale claimed idempotency key after ambiguous recovery", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const idempotencyStore = new InMemoryToolIdempotencyStore(
      () => Date.now(),
      (sessionId) => durableStore.currentLease(sessionId),
    );
    let executions = 0;
    const tool = defineTool({
      id: "ambiguous_recovery_tool",
      name: "ambiguous_recovery_tool",
      description: "An idempotent external action",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        executions += 1;
        return { confirmed: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const first = new InMemoryRuntime({ durableStore, toolIdempotencyStore: idempotencyStore });
    await first.start();
    const firstAttachment = await first.startAttachedSession(agent, { channel: "simulated" });
    const turn = await first.startTurn({
      sessionId: firstAttachment.session.id,
      input: { transcript: "recover ambiguous action", mediaEventIds: [] },
    });
    const toolCallId = "ambiguous_recovery_call" as ToolCallId;
    const input = { reservation: "r2" };
    const queued = {
      status: "queued" as const,
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: firstAttachment.session.id,
      turnId: turn.id,
      input,
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    };
    await first.startToolCall(queued);
    const idempotencyInput = {
      tool,
      input,
      sessionId: queued.sessionId,
      turnId: queued.turnId,
      toolCallId: queued.toolCallId,
    };
    const key = idempotencyKeyFor(idempotencyInput);
    const requestHash = idempotencyRequestHashFor(idempotencyInput);
    if (!key || !firstAttachment.lease) throw new Error("expected a leased claim");
    await idempotencyStore.claim({
      key,
      lease: firstAttachment.lease,
      toolId: tool.id,
      toolVersion: tool.version,
      requestHash,
      owner: toolCallId,
      ttlMs: 10_000,
    });

    const terminalToolCallId = "persisted_timeout_call" as ToolCallId;
    const terminalInput = { reservation: "r3" };
    const terminalQueued = {
      ...queued,
      toolCallId: terminalToolCallId,
      input: terminalInput,
    };
    await first.startToolCall(terminalQueued);
    const terminalIdentityInput = {
      tool,
      input: terminalInput,
      sessionId: queued.sessionId,
      turnId: queued.turnId,
      toolCallId: terminalToolCallId,
    };
    const terminalKey = idempotencyKeyFor(terminalIdentityInput);
    const terminalRequestHash = idempotencyRequestHashFor(terminalIdentityInput);
    if (!terminalKey) throw new Error("expected the terminal tool to have an idempotency key");
    await idempotencyStore.claim({
      key: terminalKey,
      lease: firstAttachment.lease,
      toolId: tool.id,
      toolVersion: tool.version,
      requestHash: terminalRequestHash,
      owner: terminalToolCallId,
      ttlMs: 10_000,
    });
    await idempotencyStore.complete(terminalKey, terminalRequestHash, {
      status: "timed_out",
      owner: terminalToolCallId,
      ttlMs: 10_000,
      lease: firstAttachment.lease,
      error: toolError("tool.timeout", "Tool timed out", { retriable: true }),
    });
    await firstAttachment.detach();

    const second = new InMemoryRuntime({ durableStore, toolIdempotencyStore: idempotencyStore });
    await second.start();
    const recovered = await second.attachSession(agent, queued.sessionId, { holderId: "recovery" });
    if (!recovered.lease) throw new Error("expected a lease on the recovered attachment");
    expect(recovered.snapshot.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId,
          status: "failed",
          metadata: { recovery: "ambiguous" },
        }),
        expect.objectContaining({
          toolCallId: terminalToolCallId,
          status: "timed_out",
          error: expect.objectContaining({ code: "tool.timeout", retriable: false }),
          metadata: expect.objectContaining({ recovery: "idempotent_replay", idempotentHit: true }),
        }),
      ]),
    );
    await expect(
      idempotencyStore.lookup(key, requestHash, queued.sessionId, recovered.lease),
    ).resolves.toMatchObject({
      status: "found",
      record: { status: "failed", error: { code: "tool.runtime_restarted" } },
    });

    await expect(
      executeTool({
        tool,
        input,
        sessionId: queued.sessionId,
        turnId: queued.turnId,
        toolCallId: "ambiguous_recovery_retry" as ToolCallId,
        idempotencyStore,
        lease: recovered.lease!,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "tool.runtime_restarted" },
      metadata: { recoveryPolicy: "do_not_replay" },
    });
    await expect(
      executeTool({
        tool,
        input: terminalInput,
        sessionId: queued.sessionId,
        turnId: queued.turnId,
        toolCallId: "persisted_timeout_retry" as ToolCallId,
        idempotencyStore,
        lease: recovered.lease,
      }),
    ).resolves.toMatchObject({
      status: "timed_out",
      error: { code: "tool.timeout", retriable: false },
      metadata: { idempotentHit: true, recoveryPolicy: "do_not_replay" },
    });
    expect(executions).toBe(0);
    await recovered.detach();
  });

  it("rejects manual recovery while a tool call is executing", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore });
    const tool = defineTool({
      id: "live_recovery_guard_tool",
      name: "live_recovery_guard_tool",
      description: "A live idempotent call that must not be mistaken for a stale call.",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        return { ok: true };
      },
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent({ tools: [tool] }), {
      channel: "simulated",
    });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "run the tool", mediaEventIds: [] },
    });
    const toolCallId = "live_recovery_guard_call" as ToolCallId;
    const input = { reservation: "live" };
    const running = await runtime.startToolCall({
      status: "queued",
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input,
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    });
    const identity = {
      tool,
      input,
      sessionId: attachment.session.id,
      turnId: turn.id,
      toolCallId,
    };
    const key = idempotencyKeyFor(identity);
    if (!key || !attachment.lease || !runtime.toolIdempotencyStore) {
      throw new Error("expected an active fenced tool call");
    }
    const requestHash = idempotencyRequestHashFor(identity);
    await runtime.toolIdempotencyStore.claim({
      key,
      sessionId: attachment.session.id,
      toolId: tool.id,
      toolVersion: tool.version,
      requestHash,
      owner: toolCallId,
      ttlMs: 10_000,
      lease: attachment.lease,
    });

    await expect(runtime.recoverToolCalls(attachment.session.id)).rejects.toThrow(
      "Tool-call recovery is unavailable while a call is executing",
    );
    await expect(
      runtime.toolIdempotencyStore.lookup(
        key,
        requestHash,
        attachment.session.id,
        attachment.lease,
      ),
    ).resolves.toMatchObject({ status: "found", record: { status: "claimed" } });

    await runtime.toolIdempotencyStore.complete(key, requestHash, {
      status: "succeeded",
      owner: toolCallId,
      ttlMs: 10_000,
      lease: attachment.lease,
      output: { ok: true },
    });
    await runtime.finishToolCall({
      ...running,
      status: "succeeded",
      endedAt: "2026-05-20T00:00:01.000Z" as Timestamp,
      output: { ok: true },
    });
    await attachment.detach();
    await runtime.stop();
  });

  it("requires an attached agent before recovering a persisted running call", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const firstRuntime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    const secondRuntime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      toolIdempotencyStore: firstRuntime.toolIdempotencyStore,
    });
    let executions = 0;
    const tool = defineTool({
      id: "unattached_recovery_tool",
      name: "unattached_recovery_tool",
      description: "Must not be recovered without its agent definition.",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        executions += 1;
        return { ok: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    let firstAttachment: Awaited<ReturnType<typeof firstRuntime.startAttachedSession>> | undefined;
    try {
      await firstRuntime.start();
      firstAttachment = await firstRuntime.startAttachedSession(agent, { channel: "simulated" });
      const turn = await firstRuntime.startTurn({ sessionId: firstAttachment.session.id });
      const toolCallId = "unattached_recovery_call" as ToolCallId;
      const input = { reservation: "detached" };
      await firstRuntime.startToolCall({
        status: "queued",
        toolCallId,
        toolId: tool.id,
        toolName: tool.name,
        sessionId: firstAttachment.session.id,
        turnId: turn.id,
        input,
        attempts: 1,
        queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
      });
      const identity = {
        tool,
        input,
        sessionId: firstAttachment.session.id,
        turnId: turn.id,
        toolCallId,
      };
      const key = idempotencyKeyFor(identity);
      const requestHash = idempotencyRequestHashFor(identity);
      if (!key || !firstAttachment.lease || !firstRuntime.toolIdempotencyStore) {
        throw new Error("expected an active fenced tool call");
      }
      await firstRuntime.toolIdempotencyStore.claim({
        key,
        sessionId: firstAttachment.session.id,
        toolId: tool.id,
        toolVersion: tool.version,
        requestHash,
        owner: toolCallId,
        ttlMs: 10_000,
        lease: firstAttachment.lease,
      });
      await firstAttachment.detach();

      await secondRuntime.start();
      await expect(secondRuntime.recoverToolCalls(firstAttachment.session.id)).rejects.toThrow(
        `Attach the session with its agent before recovering running tool calls: ${firstAttachment.session.id}`,
      );
      await expect(
        secondRuntime.toolIdempotencyStore.lookup(key, requestHash, firstAttachment.session.id),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "claimed", owner: toolCallId },
      });
      await expect(secondRuntime.inspectSession(firstAttachment.session.id)).resolves.toMatchObject(
        {
          toolCalls: [{ toolCallId, status: "running" }],
        },
      );
      expect(executions).toBe(0);
    } finally {
      await firstAttachment?.detach().catch(() => undefined);
      await Promise.all([firstRuntime.stop(), secondRuntime.stop()]);
    }
  });

  it("scopes the active recovery guard by session when call IDs repeat", async () => {
    const runtime = new InMemoryRuntime({ durableStore: createInMemoryDurableRuntimeStore() });
    const tool = defineTool({
      id: "session_scoped_recovery_guard_tool",
      name: "session_scoped_recovery_guard_tool",
      description: "A running call whose ID may be reused by another session.",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });
    await runtime.start();
    const agent = buildAgent({ tools: [tool] });
    const firstAttachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const secondAttachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const firstTurn = await runtime.startTurn({
      sessionId: firstAttachment.session.id,
      input: { transcript: "first", mediaEventIds: [] },
    });
    const secondTurn = await runtime.startTurn({
      sessionId: secondAttachment.session.id,
      input: { transcript: "second", mediaEventIds: [] },
    });
    const repeatedId = "session_scoped_call" as ToolCallId;
    const startedAt = "2026-05-20T00:00:00.000Z" as Timestamp;
    const firstRunning = await runtime.startToolCall({
      status: "queued",
      toolCallId: repeatedId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: firstAttachment.session.id,
      turnId: firstTurn.id,
      input: {},
      attempts: 1,
      queuedAt: startedAt,
    });
    const secondRunning = await runtime.startToolCall({
      status: "queued",
      toolCallId: repeatedId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: secondAttachment.session.id,
      turnId: secondTurn.id,
      input: {},
      attempts: 1,
      queuedAt: startedAt,
    });

    await expect(runtime.recoverToolCalls(firstAttachment.session.id)).rejects.toThrow(
      "Tool-call recovery is unavailable while a call is executing",
    );
    await expect(runtime.inspectSession(firstAttachment.session.id)).resolves.toMatchObject({
      toolCalls: [{ toolCallId: repeatedId, status: "running" }],
    });

    await Promise.all([
      runtime.finishToolCall({
        ...firstRunning,
        status: "succeeded",
        endedAt: "2026-05-20T00:00:01.000Z" as Timestamp,
        output: { ok: true },
      }),
      runtime.finishToolCall({
        ...secondRunning,
        status: "succeeded",
        endedAt: "2026-05-20T00:00:01.000Z" as Timestamp,
        output: { ok: true },
      }),
    ]);
    await firstAttachment.detach();
    await secondAttachment.detach();
    await runtime.stop();
  });

  it("does not clear another active call when a terminal write is retried", async () => {
    const runtime = new InMemoryRuntime({ durableStore: createInMemoryDurableRuntimeStore() });
    const tool = defineTool({
      id: "active_recovery_count_tool",
      name: "active_recovery_count_tool",
      description: "Two calls in one session with independent completion state.",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent({ tools: [tool] }), {
      channel: "simulated",
    });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "two calls", mediaEventIds: [] },
    });
    const queuedAt = "2026-05-20T00:00:00.000Z" as Timestamp;
    const start = (toolCallId: ToolCallId) =>
      runtime.startToolCall({
        status: "queued",
        toolCallId,
        toolId: tool.id,
        toolName: tool.name,
        sessionId: attachment.session.id,
        turnId: turn.id,
        input: {},
        attempts: 1,
        queuedAt,
      });
    const firstRunning = await start("first_active_call" as ToolCallId);
    const secondRunning = await start("second_active_call" as ToolCallId);
    const finishFirst = {
      ...firstRunning,
      status: "succeeded" as const,
      endedAt: "2026-05-20T00:00:01.000Z" as Timestamp,
      output: { ok: true },
    };
    await runtime.finishToolCall(finishFirst);
    await runtime.finishToolCall(finishFirst);

    await expect(runtime.recoverToolCalls(attachment.session.id)).rejects.toThrow(
      "Tool-call recovery is unavailable while a call is executing",
    );
    await runtime.finishToolCall({
      ...secondRunning,
      status: "succeeded",
      endedAt: "2026-05-20T00:00:02.000Z" as Timestamp,
      output: { ok: true },
    });
    await attachment.detach();
    await runtime.stop();
  });

  it("rejects starts and manual recovery until attachment recovery finishes", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const firstIdempotencyStore = new InMemoryToolIdempotencyStore();
    const tool = defineTool({
      id: "attachment_recovery_guard_tool",
      name: "attachment_recovery_guard_tool",
      description: "A recovered call that must use the attached agent context.",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        return { ok: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const firstRuntime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      toolIdempotencyStore: firstIdempotencyStore,
    });
    await firstRuntime.start();
    const firstAttachment = await firstRuntime.startAttachedSession(agent, {
      channel: "simulated",
    });
    const turn = await firstRuntime.startTurn({
      sessionId: firstAttachment.session.id,
      input: { transcript: "leave a running tool", mediaEventIds: [] },
    });
    const toolCallId = "attachment_recovery_call" as ToolCallId;
    const toolInput = { reservation: "hold" };
    const queued = {
      status: "queued" as const,
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: firstAttachment.session.id,
      turnId: turn.id,
      input: toolInput,
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    };
    await firstRuntime.startToolCall(queued);
    await firstAttachment.detach();
    await firstRuntime.stop();

    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      signalLookupStarted = resolve;
    });
    let releaseLookup: (() => void) | undefined;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const recoveryIdempotencyStore = new InMemoryToolIdempotencyStore();
    const identity = {
      tool,
      input: toolInput,
      sessionId: firstAttachment.session.id,
      turnId: turn.id,
      toolCallId,
    };
    const key = idempotencyKeyFor(identity);
    if (!key) throw new Error("expected an idempotency key");
    const requestHash = idempotencyRequestHashFor(identity);
    vi.spyOn(recoveryIdempotencyStore, "lookup").mockImplementation(async () => {
      signalLookupStarted?.();
      await lookupGate;
      return {
        status: "found",
        record: {
          key,
          sessionId: firstAttachment.session.id,
          toolId: tool.id,
          toolVersion: tool.version,
          requestHash,
          status: "succeeded",
          owner: String(toolCallId),
          expiresAtMs: Date.now() + 10_000,
          output: { confirmed: true },
        } satisfies ToolIdempotencyRecord,
      };
    });
    const secondRuntime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      toolIdempotencyStore: recoveryIdempotencyStore,
    });
    await secondRuntime.start();
    let attachPending: ReturnType<typeof secondRuntime.attachSession> | undefined;
    let recoveredAttachment: Awaited<ReturnType<typeof secondRuntime.attachSession>> | undefined;
    try {
      attachPending = secondRuntime.attachSession(agent, firstAttachment.session.id);
      await lookupStarted;

      await expect(secondRuntime.recoverToolCalls(firstAttachment.session.id)).rejects.toThrow();
      await expect(
        secondRuntime.startToolCall({
          ...queued,
          toolCallId: "attachment_recovery_racing_call" as ToolCallId,
        }),
      ).rejects.toThrow();
    } finally {
      releaseLookup?.();
      recoveredAttachment = await attachPending?.catch(() => undefined);
      await recoveredAttachment?.detach();
      await secondRuntime.stop();
    }

    expect(recoveredAttachment?.snapshot.toolCalls).toMatchObject([
      { toolCallId, status: "succeeded", output: { confirmed: true } },
    ]);
  });

  it("does not attach while manual recovery is already running", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore, durableStoreOwnership: "caller" });
    const agent = buildAgent();
    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    let signalRecoveryRead: (() => void) | undefined;
    const recoveryReadStarted = new Promise<void>((resolve) => {
      signalRecoveryRead = resolve;
    });
    let releaseRecoveryRead: (() => void) | undefined;
    const recoveryReadGate = new Promise<void>((resolve) => {
      releaseRecoveryRead = resolve;
    });
    const originalList = durableStore.toolCalls.listBySession.bind(durableStore.toolCalls);
    let pauseFirstRead = true;
    vi.spyOn(durableStore.toolCalls, "listBySession").mockImplementation(async (sessionId) => {
      const records = await originalList(sessionId);
      if (pauseFirstRead) {
        pauseFirstRead = false;
        signalRecoveryRead?.();
        await recoveryReadGate;
      }
      return records;
    });

    let recoveryPending: ReturnType<typeof runtime.recoverToolCalls> | undefined;
    let attachPending: ReturnType<typeof runtime.attachSession> | undefined;
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      recoveryPending = runtime.recoverToolCalls(session.id);
      await recoveryReadStarted;
      attachPending = runtime.attachSession(agent, session.id);
      const attachOutcome = await attachPending.then(
        (result) => {
          attachment = result;
          return "attached" as const;
        },
        () => "rejected" as const,
      );
      expect(attachOutcome).toBe("rejected");
    } finally {
      releaseRecoveryRead?.();
      await recoveryPending?.catch(() => undefined);
      attachment ??= await attachPending?.catch(() => undefined);
      await attachment?.detach();
      await runtime.stop();
    }
  });

  it("does not attach and recover a call that started before attachment", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore, durableStoreOwnership: "caller" });
    const tool = defineTool({
      id: "pre-attachment_call_guard_tool",
      name: "pre-attachment_call_guard_tool",
      description: "A live call started before an attachment is established.",
      inputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "start before attach", mediaEventIds: [] },
    });
    const running = await runtime.startToolCall({
      status: "queued",
      toolCallId: "pre_attachment_live_call" as ToolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    });
    const attachPending = runtime.attachSession(agent, session.id);
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await expect(attachPending).rejects.toThrow();
    } finally {
      attachment = await attachPending.catch(() => undefined);
      await attachment?.detach();
      await runtime
        .finishToolCall({
          ...running,
          status: "cancelled",
          endedAt: "2026-05-20T00:00:01.000Z" as Timestamp,
          error: toolError("tool.execution_cancelled", "test cleanup"),
        })
        .catch(() => undefined);
      await runtime.stop();
    }
  });

  it("does not let delayed tool recovery downgrade to unfenced after detach", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const running: RunningToolCall = {
      status: "running",
      toolCallId: "delayed_recovery_fence" as ToolCallId,
      toolId: "delayed_recovery_tool" as ToolId,
      toolName: "delayed_recovery_tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: "delayed_recovery_turn" as TurnId,
      input: {},
      attempts: 1,
      queuedAt: "2026-10-12T00:00:00.000Z" as Timestamp,
      startedAt: "2026-10-12T00:00:01.000Z" as Timestamp,
    };
    await runtime.recordToolCall(running);

    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let allowReadToFinish!: () => void;
    const readGate = new Promise<void>((resolve) => {
      allowReadToFinish = resolve;
    });
    const originalList = durableStore.toolCalls.listBySession.bind(durableStore.toolCalls);
    let pauseNextRead = true;
    vi.spyOn(durableStore.toolCalls, "listBySession").mockImplementation(async (sessionId) => {
      const records = await originalList(sessionId);
      if (pauseNextRead) {
        pauseNextRead = false;
        signalReadStarted();
        await readGate;
      }
      return records;
    });

    const recovering = runtime.recoverToolCalls(attachment.session.id);
    try {
      await readStarted;
      await attachment.detach();
      allowReadToFinish();

      await expect(recovering).rejects.toThrow();
      await expect(
        durableStore.toolCalls.get(attachment.session.id, running.toolCallId),
      ).resolves.toMatchObject({ toolCall: { status: "running" } });
    } finally {
      allowReadToFinish();
      await recovering.catch(() => undefined);
      await runtime.stop();
    }
  });

  it("uses a distinct lease holder for each runtime incarnation", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const agent = buildAgent();
    const first = new InMemoryRuntime({ durableStore, holderId: "shared-worker-label" });
    const second = new InMemoryRuntime({ durableStore, holderId: "shared-worker-label" });
    await Promise.all([first.start(), second.start()]);
    const attachment = await first.startAttachedSession(agent, { channel: "simulated" });

    await expect(
      second.attachSession(agent, attachment.session.id, { holderId: "shared-worker-label" }),
    ).rejects.toThrow(/session lease unavailable/i);

    await attachment.detach();
    const replacement = await second.attachSession(agent, attachment.session.id, {
      holderId: "shared-worker-label",
    });
    expect(replacement.lease?.generationId).not.toBe(attachment.lease?.generationId);

    await replacement.detach();
    await Promise.all([first.stop(), second.stop()]);
  });

  it("bounds parallel idempotency lookups and reuses the recovery snapshot", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const tool = defineTool({
      id: "bounded_recovery_tool",
      name: "bounded_recovery_tool",
      description: "A tool call used to bound attachment recovery lookups.",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        return { ok: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const runtime = new InMemoryRuntime({ durableStore });
    const idempotencyStore = runtime.toolIdempotencyStore;
    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "many interrupted calls", mediaEventIds: [] },
    });
    const queuedAt = "2026-10-12T00:00:00.000Z" as Timestamp;
    for (let index = 0; index < 17; index += 1) {
      await runtime.recordToolCall({
        status: "running",
        toolCallId: `bounded_recovery_${index}` as ToolCallId,
        toolId: tool.id,
        toolName: tool.name,
        sessionId: session.id,
        turnId: turn.id,
        input: { index },
        attempts: 1,
        queuedAt,
        startedAt: queuedAt,
      });
    }

    let signalBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => {
      signalBatchStarted = resolve;
    });
    let allowLookups!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      allowLookups = resolve;
    });
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const originalLookup = idempotencyStore.lookup.bind(idempotencyStore);
    vi.spyOn(idempotencyStore, "lookup").mockImplementation(async (...args) => {
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (started === 16) signalBatchStarted();
      await lookupGate;
      try {
        return await originalLookup(...args);
      } finally {
        inFlight -= 1;
      }
    });
    const listToolCalls = vi.spyOn(durableStore.toolCalls, "listBySession");

    let attach: Promise<Awaited<ReturnType<typeof runtime.attachSession>>> | undefined;
    let attachment: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      attach = runtime.attachSession(agent, session.id);
      await batchStarted;
      await wait(0);
      expect(started).toBe(16);
      allowLookups();
      attachment = await attach;
      expect(started).toBe(17);
      expect(maxInFlight).toBe(16);
      expect(listToolCalls).toHaveBeenCalledTimes(3);
      expect(attachment.snapshot.toolCalls).toHaveLength(17);
    } finally {
      allowLookups();
      attachment ??= await attach?.catch(() => undefined);
      await attachment?.detach();
      await runtime.stop();
    }
  });

  it("does not replay legacy idempotency records that lack tenant identity", async () => {
    const sessionA = "legacy_recovery_a" as SessionId;
    const sessionB = "legacy_recovery_b" as SessionId;
    const leaseA = {
      sessionId: sessionA,
      holder: "legacy_owner",
      fence: 1,
      generationId: "legacy_generation",
      expiresAtMs: 10_000,
    };
    const idempotencyStore = new InMemoryToolIdempotencyStore(
      () => 100,
      (candidate) => (candidate === sessionA ? leaseA : null),
    );
    const tool = defineTool({
      id: "legacy_recovery_tool",
      name: "legacy_recovery_tool",
      description: "A tool with a pre-session-scoped durable key",
      inputSchema: { type: "object" },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        throw new Error("recovery must not execute the tool");
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const toolCall: RunningToolCall = {
      status: "running",
      toolCallId: "legacy_recovery_call" as ToolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: sessionA,
      turnId: "legacy_recovery_turn" as TurnId,
      input: { reservation: "r1" },
      attempts: 1,
      queuedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
      startedAt: "2026-05-20T00:00:00.000Z" as Timestamp,
    };
    const oldKey = legacyIdempotencyForRecovery({
      tool,
      input: toolCall.input,
      sessionId: toolCall.sessionId,
      turnId: toolCall.turnId,
      toolCallId: toolCall.toolCallId,
    });
    if (!oldKey) throw new Error("expected legacy key for idempotent tool");
    await idempotencyStore.claim({
      key: oldKey.key,
      requestHash: oldKey.requestHash,
      owner: toolCall.toolCallId,
      ttlMs: 10_000,
      lease: leaseA,
    });
    await idempotencyStore.complete(oldKey.key, oldKey.requestHash, {
      status: "succeeded",
      owner: toolCall.toolCallId,
      output: { confirmed: true },
      ttlMs: 10_000,
      lease: leaseA,
    });

    await expect(
      replayRecoveredToolCall(toolCall, agent, idempotencyStore, toolCall.queuedAt),
    ).resolves.toBeNull();
    const input = {
      tool,
      input: toolCall.input,
      sessionId: toolCall.sessionId,
      turnId: toolCall.turnId,
      toolCallId: toolCall.toolCallId,
    };
    const currentKey = idempotencyKeyFor(input);
    if (!currentKey) throw new Error("expected a current idempotency key");
    const replayedLegacyKey = await replayRecoveredToolCall(
      { ...toolCall, idempotencyKey: oldKey.key },
      agent,
      idempotencyStore,
      toolCall.queuedAt,
    );
    expect(replayedLegacyKey).toBeNull();
    await expect(
      replayRecoveredToolCall(
        { ...toolCall, sessionId: sessionB },
        agent,
        idempotencyStore,
        toolCall.queuedAt,
      ),
    ).resolves.toBeNull();
    await expect(
      replayRecoveredToolCall(toolCall, agent, idempotencyStore, toolCall.queuedAt, {
        userId: "changed_legacy_user" as UserId,
      }),
    ).resolves.toBeNull();
  });
});

function createLegacyDurableStore(
  base: DurableRuntimeStore,
  hooks: {
    readonly afterUnfencedTransaction?: () => void | Promise<void>;
    readonly beforeClose?: () => void | Promise<void>;
  } = {},
): DurableRuntimeStore {
  return {
    sessions: base.sessions,
    turns: base.turns,
    toolCalls: base.toolCalls,
    leases: base.leases,
    ...(base.toolIdempotencyStore ? { toolIdempotencyStore: base.toolIdempotencyStore } : {}),
    async runSessionTransaction<T>(
      sessionId: SessionId,
      lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
      operation: (tx: DurableSessionTransaction) => Promise<T>,
    ): Promise<T> {
      return base.runSessionTransaction(sessionId, lease, operation);
    },
    async runUnfencedSessionTransaction<T>(
      sessionId: SessionId,
      operation: (tx: DurableSessionTransaction) => Promise<T>,
    ): Promise<T> {
      const run = base.runUnfencedSessionTransaction;
      if (!run) throw new Error("In-memory store has no unfenced transaction support");
      const result = await run.call(base, sessionId, operation);
      await hooks.afterUnfencedTransaction?.();
      return result as T;
    },
    async close(): Promise<void> {
      await hooks.beforeClose?.();
      await base.close?.();
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
