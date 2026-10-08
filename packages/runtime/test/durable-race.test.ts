import { describe, expect, it, vi } from "vitest";

import {
  BackendUnavailableError,
  internalError,
  toolError,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type OrganizationId,
  type RunningToolCall,
  type SessionId,
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
import { replayRecoveredToolCall } from "../src/tool-lifecycle.js";
import { buildAgent } from "./harness.js";
import { defineTool } from "../src/index.js";
import { ControllableDurableStore } from "./controllable-durable-store.js";

describe("durable write races", () => {
  const delayedWritePolicy = {
    criticalWriteTimeoutMs: 10,
    // The injected delay is milliseconds; leave enough lease lifetime that
    // worker scheduling cannot turn this test into a lease-expiry test.
    leaseTtlMs: 30_000,
    leaseHeartbeatMs: 10_000,
  } as const;

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
      (sessionId) => durableStore.leases.get(sessionId),
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
    // Older runtimes persisted the call before they added the derived key.
    // Recovery may use the key for lookup, but must preserve that legacy shape.
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
      idempotencyStore.lookup(key, requestHash, queued.sessionId),
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
    expect(recoveryLookup).toHaveBeenCalledWith(key, requestHash, queued.sessionId);
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
      (sessionId) => durableStore.leases.get(sessionId),
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
      error: toolError("tool.timeout", "Tool timed out", { retriable: false }),
    });
    await firstAttachment.detach();

    const second = new InMemoryRuntime({ durableStore, toolIdempotencyStore: idempotencyStore });
    await second.start();
    const recovered = await second.attachSession(agent, queued.sessionId, { holderId: "recovery" });
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
          error: expect.objectContaining({ code: "tool.timeout" }),
          metadata: expect.objectContaining({ recovery: "idempotent_replay", idempotentHit: true }),
        }),
      ]),
    );
    await expect(
      idempotencyStore.lookup(key, requestHash, queued.sessionId),
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
      error: { code: "tool.idempotency_terminal" },
      metadata: { recoveryPolicy: "do_not_replay" },
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
      runtime.toolIdempotencyStore.lookup(key, requestHash, attachment.session.id),
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
    const backingStore = createInMemoryDurableRuntimeStore();
    const durableStore: DurableRuntimeStore = {
      ...backingStore,
      async runUnfencedSessionTransaction<T>(
        sessionId: SessionId,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        const activeLease = await backingStore.leases.get(sessionId);
        if (activeLease) {
          return backingStore.runSessionTransaction(sessionId, activeLease, operation);
        }
        return backingStore.runUnfencedSessionTransaction!(sessionId, operation);
      },
    };
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
      async (candidate) => (candidate === sessionA ? leaseA : null),
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
