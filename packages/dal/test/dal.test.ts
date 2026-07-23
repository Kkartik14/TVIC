import { describe, expect, it } from "vitest";

import type { AgentId, SessionId, Timestamp } from "@tvic/core";

import { createInMemorySessionStore, createInMemoryTurnStore } from "../src/index.js";

describe("in-memory DAL stores", () => {
  it("persists session runtime metadata with the session record", async () => {
    const store = createInMemorySessionStore();
    const sessionId = "session_dal" as SessionId;

    await store.put({
      session: {
        id: sessionId,
        agentId: "agent_dal" as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: {
        monotonicStartedAtMs: 10,
      },
    });

    await store.update(sessionId, (record) => ({
      ...record,
      session: { ...record.session, status: "interrupted" } as typeof record.session,
    }));

    await expect(store.get(sessionId)).resolves.toMatchObject({
      session: { status: "interrupted" },
      runtime: { monotonicStartedAtMs: 10 },
    });
  });

  it("lists turns by session without leaking other sessions", async () => {
    const store = createInMemoryTurnStore();

    await store.put({
      turn: {
        id: "turn_1" as never,
        sessionId: "session_a" as SessionId,
        sequence: 1,
        status: "started",
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [],
        startedAt: timestamp,
        latency: {},
      },
      runtime: {
        monotonicStartedAtMs: 20,
      },
    });

    await expect(store.listBySession("session_a" as SessionId)).resolves.toHaveLength(1);
    await expect(store.listBySession("session_b" as SessionId)).resolves.toHaveLength(0);
  });
});

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
