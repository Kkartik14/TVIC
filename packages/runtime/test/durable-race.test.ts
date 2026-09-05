import { describe, expect, it, vi } from "vitest";

import {
  BackendUnavailableError,
  internalError,
  type ToolCallId,
  type ToolId,
  type ToolName,
  type Timestamp,
} from "@tvic/core";
import { createInMemoryDurableRuntimeStore } from "@tvic/dal";
import {
  InMemoryToolIdempotencyStore,
  idempotencyKeyFor,
  idempotencyRequestHashFor,
} from "@tvic/tools";

import { InMemoryRuntime } from "../src/create-runtime.js";
import { buildAgent } from "./harness.js";
import { defineTool } from "../src/index.js";
import { ControllableDurableStore } from "./controllable-durable-store.js";

describe("durable write races", () => {
  it("keeps a late completed terminal turn from being overwritten by a retry", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      holderId: "race_owner",
      durablePolicy: { criticalWriteTimeoutMs: 10 },
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
      durablePolicy: { criticalWriteTimeoutMs: 10 },
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

  it("finishes a late attached session end without losing its lease or turn duration", async () => {
    const controlled = new ControllableDurableStore(createInMemoryDurableRuntimeStore());
    const runtime = new InMemoryRuntime({
      durableStore: controlled,
      holderId: "late_end_owner",
      durablePolicy: { criticalWriteTimeoutMs: 10 },
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
      durablePolicy: { criticalWriteTimeoutMs: 10 },
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
      durablePolicy: { criticalWriteTimeoutMs: 10 },
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
      durablePolicy: { criticalWriteTimeoutMs: 10 },
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
    const firstAttachment = await first.startAttachedSession(agent, { channel: "simulated" });
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
    };
    const key = idempotencyKeyFor(idempotencyInput);
    if (!key || !firstAttachment.lease) throw new Error("expected a lease-backed idempotency key");
    // Older runtimes persisted the call before they added the derived key.
    // Recovery may use the key for lookup, but must preserve that legacy shape.
    await first.startToolCall(queued);
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
    await firstAttachment.detach();

    const second = new InMemoryRuntime({
      durableStore,
      toolIdempotencyStore: idempotencyStore,
      holderId: "replay_second",
    });
    await second.start();
    const recovered = await second.attachSession(agent, firstAttachment.session.id, {
      holderId: "replay_second",
    });
    const replayed = recovered.snapshot.toolCalls.find((call) => call.toolCallId === toolCallId);
    expect(replayed).toMatchObject({
      status: "succeeded",
      output: { confirmed: true },
      metadata: { recovery: "idempotent_replay", idempotentHit: true },
    });
    expect(replayed).not.toHaveProperty("idempotencyKey");
    await recovered.detach();
  });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
