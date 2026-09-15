import { describe, expect, it } from "vitest";

import { createInMemorySessionStore } from "@tvic/dal";
import { createRuntime, defineAgent, defineTool } from "../src/index.js";
import { buildAgent } from "./harness.js";

/**
 * R2-01: lifecycle invariant table, locked by tests.
 * See LIFECYCLE-INVARIANTS.md. Corrected per red-team: only `active`
 * accepts turns/tools; queued-downgrade coerces; interrupted has two
 * writers with resurrection forbidden.
 */
describe("R2-01 lifecycle invariants", () => {
  it("session: only active accepts startTurn (interrupted/waiting_for_tool/ending throw)", async () => {
    const sessionStore = createInMemorySessionStore();
    const runtime = createRuntime({ sessionStore });
    await runtime.start();
    const agent = buildAgent();
    const now = new Date().toISOString() as never;
    const base = {
      agentId: agent.id,
      channel: "simulated" as const,
      memoryRefs: [],
      createdAt: now,
      startedAt: now,
      state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
    };
    for (const [status, shouldPass] of [
      ["active", true],
      ["interrupted", false],
      ["waiting_for_tool", false],
      ["ending", false],
    ] as const) {
      const id = `session_r201_${status}` as never;
      await sessionStore.put({
        session: { ...base, id, status } as never,
        runtime: { monotonicStartedAtMs: 0 },
      });
      if (shouldPass) {
        const turn = await runtime.startTurn({
          sessionId: id,
          input: { transcript: "hi", mediaEventIds: [] },
        });
        expect(turn.status).toBe("started");
      } else {
        await expect(
          runtime.startTurn({ sessionId: id, input: { transcript: "hi", mediaEventIds: [] } }),
        ).rejects.toThrow();
      }
    }
    await runtime.stop();
  });

  it("session: terminal end is idempotent and detaches", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const first = await runtime.endSession(session.id, { reason: "completed" });
    expect(first.status).toBe("completed");
    const second = await runtime.endSession(session.id, { reason: "completed" });
    expect(second.status).toBe("completed");
    expect(second.id).toBe(first.id);
    await runtime.stop();
  });

  it("session: terminal rejects startTurn, attach rejects terminal + agent mismatch + double attach", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    await runtime.endSession(session.id, { reason: "completed" });
    await expect(
      runtime.startTurn({ sessionId: session.id, input: { transcript: "hi", mediaEventIds: [] } }),
    ).rejects.toThrow();
    await expect(runtime.attachSession(agent, session.id)).rejects.toThrow();
    const other = defineAgent({ ...agent, id: "other_agent" } as never);
    const live = await runtime.startSession(agent, { channel: "simulated" });
    await expect(runtime.attachSession(other, live.id)).rejects.toThrow();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    await expect(runtime.attachSession(agent, attachment.session.id)).rejects.toThrow();
    await attachment.detach();
    await runtime.stop();
  });

  it("turn: terminal update transitions rejected, started is a validated read", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "hi", mediaEventIds: [] },
    });
    await expect(runtime.updateTurnStatus(session.id, turn.id, "completed")).rejects.toThrow(
      /requires a terminal turn request/,
    );
    await expect(runtime.updateTurnStatus(session.id, turn.id, "cancelled")).rejects.toThrow();
    await expect(runtime.updateTurnStatus(session.id, turn.id, "failed")).rejects.toThrow();
    const reread = await runtime.updateTurnStatus(session.id, turn.id, "started");
    expect(reread.id).toBe(turn.id);
    await expect(
      runtime.updateTurnStatus(session.id, "turn_missing" as never, "started"),
    ).rejects.toThrow();
    await runtime.stop();
  });

  it("turn: endTurn on terminal returns existing (no overwrite); terminal ignores updates", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "hi", mediaEventIds: [] },
    });
    const completed = await runtime.endTurn(session.id, turn.id, {
      reason: "completed",
      output: { text: "hello", mediaEventIds: [] },
    });
    expect(completed.status).toBe("completed");
    const again = await runtime.endTurn(session.id, turn.id, {
      reason: "failed",
      error: {
        name: "InternalError",
        code: "test.late",
        category: "internal",
        message: "late",
        retriable: false,
      },
    });
    expect(again.status).toBe("completed");
    const after = await runtime.updateTurnStatus(session.id, turn.id, "speaking");
    expect(after.status).toBe("completed");
    await runtime.stop();
  });

  it("turn: interrupted cannot resurrect via updateTurnStatus (only endTurn leaves it)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "hi", mediaEventIds: [] },
    });
    const interrupted = await runtime.checkpointTurnInterruption(session.id, turn.id, "barge_in");
    expect(interrupted.status).toBe("interrupted");
    // Repeat checkpoint is idempotent: keeps the first reason, no rewrite.
    const again = await runtime.checkpointTurnInterruption(session.id, turn.id, "timeout");
    expect(again.status).toBe("interrupted");
    for (const status of ["speaking", "thinking", "calling_tool", "listening"] as const) {
      const attempt = await runtime.updateTurnStatus(session.id, turn.id, status);
      expect(attempt.status).toBe("interrupted");
    }
    await expect(runtime.updateTurnStatus(session.id, turn.id, "interrupted")).rejects.toThrow(
      /checkpointTurnInterruption/,
    );
    const terminal = await runtime.endTurn(session.id, turn.id, {
      reason: "cancelled",
      cancelReason: "barge_in",
    });
    expect(terminal.status).toBe("cancelled");
    await runtime.stop();
  });

  it("media: CallHandle contract close effect applies once, send false after close", async () => {
    let effects = 0;
    let closed = false;
    const handle = {
      callId: "call_contract" as never,
      events: (async function* () {})(),
      async send() {
        return !closed;
      },
      async clear() {
        return undefined;
      },
      async close() {
        // Idempotent close: safe to call twice, effect applies once.
        if (!closed) {
          closed = true;
          effects += 1;
        }
        return undefined;
      },
    };
    await handle.close();
    await handle.close();
    expect(effects).toBe(1);
    // Contract under test: send-after-close resolves false, clear resolves.
    expect(await handle.send()).toBe(false);
    await expect(handle.clear()).resolves.toBeUndefined();
  });

  it("tool: queued->running->terminal idempotent finish with identity enforcement", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const tool = defineTool({
      id: "tool_lifecycle",
      name: "lookup",
      description: "lookup",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return {};
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "hi", mediaEventIds: [] },
    });
    const queued = {
      status: "queued" as const,
      toolCallId: "tool_call_test_1" as never,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: new Date().toISOString() as never,
    };
    const running = await runtime.startToolCall(queued);
    expect(running.status).toBe("running");
    const finished = await runtime.finishToolCall({
      ...running,
      status: "succeeded",
      endedAt: new Date().toISOString() as never,
      output: { ok: true },
    });
    expect(finished.status).toBe("succeeded");
    const again = await runtime.finishToolCall({
      ...running,
      status: "failed",
      endedAt: new Date().toISOString() as never,
      error: {
        name: "ToolError",
        code: "tool.late",
        category: "tool",
        message: "late",
        retriable: false,
      },
    });
    expect(again.status).toBe("succeeded");
    await runtime.stop();
  });

  it("tool: running+queued record coerces to running; identity mismatch conflicts", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "hi", mediaEventIds: [] },
    });
    const open = {
      status: "queued" as const,
      toolCallId: "tool_call_coerce_1" as never,
      toolId: "tool_loop" as never,
      toolName: "check_availability" as never,
      sessionId: session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: new Date().toISOString() as never,
    };
    const started = await runtime.startToolCall(open);
    expect(started.status).toBe("running");
    // Downgrade attempt: recording queued over running keeps running.
    await runtime.recordToolCall(open);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.toolCalls.find((t) => t.toolCallId === open.toolCallId)?.status).toBe(
      "running",
    );
    await expect(
      runtime.recordToolCall({
        status: "succeeded",
        toolCallId: "tool_call_coerce_1" as never,
        toolId: "tool_loop" as never,
        toolName: "check_availability" as never,
        sessionId: session.id,
        turnId: turn.id,
        input: { different: true },
        attempts: 1,
        queuedAt: new Date().toISOString() as never,
        startedAt: new Date().toISOString() as never,
        endedAt: new Date().toISOString() as never,
        output: {},
      }),
    ).rejects.toThrow();
    await runtime.stop();
  });

  it("runtime: stop idempotent, restart forbidden", async () => {
    const runtime = createRuntime();
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    await expect(runtime.start()).rejects.toThrow();
  });
});
