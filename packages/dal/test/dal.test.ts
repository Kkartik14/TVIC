import { describe, expect, it } from "vitest";

import type { AgentId, OrganizationId, SessionId, Timestamp, UserId, WorkflowId } from "@tvic/core";

import {
  InMemoryMemory,
  InMemorySessionLeaseStore,
  createInMemoryDurableRuntimeStore,
  createInMemoryMemory,
  createInMemorySessionStore,
  createInMemoryTurnStore,
  createInMemoryToolCallStore,
} from "../src/index.js";

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

  it("makes duplicate puts retry-safe and rejects conflicting payloads", async () => {
    const store = createInMemoryTurnStore();
    const record = {
      turn: {
        id: "turn_retry" as never,
        sessionId: "session_retry" as SessionId,
        sequence: 1,
        status: "started" as const,
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [],
        startedAt: timestamp,
        latency: {},
      },
      runtime: { monotonicStartedAtMs: 1 },
    };
    await store.put(record);
    await store.put(record);
    await expect(store.listBySession("session_retry" as SessionId)).resolves.toHaveLength(1);
    await expect(
      store.put({
        ...record,
        turn: { ...record.turn, input: { mediaEventIds: ["different" as never] } },
      }),
    ).rejects.toThrow(/conflict/i);
  });

  it("keeps lease reacquisition idempotent for the same holder", async () => {
    let now = 100;
    const leases = new InMemorySessionLeaseStore(() => now);
    const first = await leases.acquire("session_lease" as SessionId, "holder_a", 1000);
    const retry = await leases.acquire("session_lease" as SessionId, "holder_a", 1000);
    expect(retry).toEqual(first);
    expect(await leases.acquire("session_lease" as SessionId, "holder_b", 1000)).toBeNull();
    now = 1200;
    const next = await leases.acquire("session_lease" as SessionId, "holder_b", 1000);
    expect(next?.fence).toBe((first?.fence ?? 0) + 1);
  });

  it("serializes concurrent session creation without deleting the winning record", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const record = {
      session: {
        id: "session_create_race" as SessionId,
        agentId: "agent_create_race" as AgentId,
        status: "active" as const,
        channel: "simulated" as const,
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    };
    const createSessionWithLease = store.createSessionWithLease;
    if (!createSessionWithLease) throw new Error("expected session creation primitive");

    const leases = await Promise.all([
      createSessionWithLease.call(store, record, "holder_a", 1_000),
      createSessionWithLease.call(store, record, "holder_b", 1_000),
    ]);

    expect(leases.filter(Boolean)).toHaveLength(1);
    await expect(store.sessions.get(record.session.id)).resolves.toMatchObject({
      session: { id: record.session.id },
    });
  });

  it("deduplicates tool call identities", async () => {
    const store = createInMemoryToolCallStore();
    const record = {
      toolCall: {
        status: "queued" as const,
        toolCallId: "tool_retry" as never,
        toolId: "tool" as never,
        toolName: "tool" as never,
        sessionId: "session_tool" as SessionId,
        turnId: "turn_tool" as never,
        input: {},
        attempts: 1,
        queuedAt: timestamp,
      },
      runtime: { monotonicQueuedAtMs: 1 },
    };
    await store.put(record);
    await store.put(record);
    await expect(store.listBySession("session_tool" as SessionId)).resolves.toHaveLength(1);
  });

  it("preserves fence tombstones after release", async () => {
    let now = 100;
    const leases = new InMemorySessionLeaseStore(() => now);
    const first = await leases.acquire("session_release" as SessionId, "holder_a", 1000);
    await leases.release("session_release" as SessionId, "holder_a", first!.fence);
    now = 101;
    const next = await leases.acquire("session_release" as SessionId, "holder_b", 1000);
    expect(next?.fence).toBe(2);
  });

  it("rolls back all aggregate writes and outbox events when a lease transaction fails", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const sessionId = "session_transaction" as SessionId;
    await store.sessions.put({
      session: {
        id: sessionId,
        agentId: "agent_transaction" as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    });
    const lease = await store.leases.acquire(sessionId, "holder", 1000);
    await expect(
      store.runSessionTransaction(sessionId, lease!, async (tx) => {
        const updated = await tx.updateSession(sessionId, (record) => ({
          ...record,
          session: { ...record.session, status: "interrupted" } as typeof record.session,
        }));
        await tx.appendOutbox({
          id: "transaction_event",
          aggregateType: "session",
          aggregateId: sessionId,
          sessionId,
          version: updated.version ?? 2,
          fence: lease!.fence,
          envelope: {
            kind: "session",
            schemaVersion: 1,
            payload: updated.session,
            runtime: updated.runtime,
            version: updated.version ?? 2,
          },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(store.sessions.get(sessionId)).resolves.toMatchObject({
      session: { status: "active" },
    });
    expect(store.outbox).toHaveLength(0);
  });

  it("rejects cross-session access through an aggregate transaction", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const sessionId = "session_scoped" as SessionId;
    const lease = await store.leases.acquire(sessionId, "holder", 1000);

    await expect(
      store.runSessionTransaction(sessionId, lease!, (tx) =>
        tx.getSession("other_session" as SessionId),
      ),
    ).rejects.toThrow(/cannot access other_session/);
  });
});

describe("InMemoryMemory", () => {
  const userA: UserId = "user_a" as UserId;
  const userB: UserId = "user_b" as UserId;
  const orgA: OrganizationId = "org_a" as OrganizationId;
  const wfA: WorkflowId = "wf_a" as WorkflowId;

  it("declares its name, version, and capabilities", () => {
    const memory = createInMemoryMemory();
    expect(memory.name).toBe("in-memory");
    expect(memory.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(memory.capabilities.search.exact).toBe(true);
    expect(memory.capabilities.search.vector).toBe(false);
    expect(memory.capabilities.purge.tenant).toBe(true);
  });

  it("stores entries keyed by (ref, key, kind) and discriminates by kind", async () => {
    const memory = createInMemoryMemory();
    await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    await memory.put({ scope: "user", userId: userA }, "name", "summary", "Ada the customer");

    const fact = await memory.get<{ toString(): string }>(
      { scope: "user", userId: userA },
      "name",
      "fact",
    );
    const summary = await memory.get<{ toString(): string }>(
      { scope: "user", userId: userA },
      "name",
      "summary",
    );
    expect(fact?.value.toString()).toBe("Ada");
    expect(summary?.value.toString()).toBe("Ada the customer");
  });

  it("is idempotent on identical value and throws on different value", async () => {
    const memory = createInMemoryMemory();
    const first = await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    const second = await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    expect(second.version).toBe(first.version + 1);
    expect(second.value).toBe("Ada");
    await expect(
      memory.put({ scope: "user", userId: userA }, "name", "fact", "Bob"),
    ).rejects.toThrow(/conflict/i);
  });

  it("ifNotExists: returns the existing entry unchanged on duplicate put", async () => {
    const memory = createInMemoryMemory();
    const first = await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    const second = await memory.put({ scope: "user", userId: userA }, "name", "fact", "Different", {
      ifNotExists: true,
    });
    expect(second).toEqual(first);
  });

  it("rejects conflicting puts with a RecordConflictError", async () => {
    const memory = createInMemoryMemory();
    await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    await expect(
      memory.put({ scope: "user", userId: userA }, "name", "fact", "Bob"),
    ).rejects.toThrow(/conflict/i);
  });

  it("filters list by kind, prefix, and tags", async () => {
    const memory = createInMemoryMemory();
    await memory.put({ scope: "user", userId: userA }, "preferred_name", "fact", "Ada", {
      tags: ["profile"],
    });
    await memory.put({ scope: "user", userId: userA }, "preferred_color", "fact", "blue", {
      tags: ["profile", "ui"],
    });
    await memory.put({ scope: "user", userId: userA }, "recent_order", "raw", "book-123");

    const facts = await memory.list({ scope: "user", userId: userA }, { kind: "fact" });
    expect(facts).toHaveLength(2);

    const withProfile = await memory.list({ scope: "user", userId: userA }, { tags: ["profile"] });
    expect(withProfile).toHaveLength(2);

    const byPrefix = await memory.list({ scope: "user", userId: userA }, { prefix: "preferred" });
    expect(byPrefix).toHaveLength(2);
  });

  it("deleteAll removes every entry for a ref", async () => {
    const memory = createInMemoryMemory();
    await memory.put({ scope: "user", userId: userA }, "a", "fact", "1");
    await memory.put({ scope: "user", userId: userA }, "b", "fact", "2");
    await memory.put({ scope: "user", userId: userB }, "x", "fact", "3");

    const deleted = await memory.deleteAll({ scope: "user", userId: userA });
    expect(deleted).toBe(2);
    expect(await memory.list({ scope: "user", userId: userA })).toHaveLength(0);
    expect(await memory.list({ scope: "user", userId: userB })).toHaveLength(1);
  });

  it("deleteForUser removes user-owned data but preserves shared scopes", async () => {
    const memory = new InMemoryMemory();
    await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    await memory.put({ scope: "organization", organizationId: orgA }, "name", "fact", "Acme Co");
    await memory.put({ scope: "workflow", workflowId: wfA }, "state", "raw", { step: 1 });
    const sessionRef = { scope: "session" as const, sessionId: "session_user_a" as never };
    await memory.put(
      sessionRef,
      "exchange",
      "raw",
      { assistant: "hello" },
      {
        sessionUserId: userA,
      },
    );
    await memory.put(
      sessionRef,
      "exchange",
      "raw",
      { assistant: "hello" },
      {
        metadata: { source: "later-update" },
      },
    );

    const deleted = await memory.deleteForUser(userA);
    expect(deleted).toBe(2);
    expect(await memory.list({ scope: "user", userId: userA })).toHaveLength(0);
    expect(await memory.list({ scope: "organization", organizationId: orgA })).toHaveLength(1);
    expect(await memory.list({ scope: "workflow", workflowId: wfA })).toHaveLength(1);
    expect(await memory.list(sessionRef)).toHaveLength(0);
  });

  it("deleteForUser does not treat caller metadata as session ownership", async () => {
    const memory = new InMemoryMemory();
    const sessionRef = { scope: "session" as const, sessionId: "session_metadata" as never };
    await memory.put({ scope: "user", userId: userA }, "name", "fact", "Ada");
    await memory.put(
      sessionRef,
      "exchange",
      "raw",
      { assistant: "hello" },
      {
        metadata: { userId: userA },
      },
    );

    expect(await memory.deleteForUser(userA)).toBe(1);
    expect(await memory.list({ scope: "user", userId: userA })).toHaveLength(0);
    expect(await memory.list(sessionRef)).toHaveLength(1);
  });

  it("expires entries past ttlMs on read", async () => {
    let now = 1000;
    const memory = new InMemoryMemory({ now: () => new Date(now) });
    await memory.put({ scope: "user", userId: userA }, "k", "fact", "v", { ttlMs: 500 });
    expect((await memory.get({ scope: "user", userId: userA }, "k", "fact"))?.value).toBe("v");
    now = 1600;
    expect(await memory.get({ scope: "user", userId: userA }, "k", "fact")).toBeNull();
  });

  it("enforces maxEntryBytes on put", async () => {
    const memory = new InMemoryMemory({ maxEntryBytes: 8 });
    await expect(
      memory.put({ scope: "user", userId: userA }, "k", "fact", "this is way too long"),
    ).rejects.toThrow(/exceeds cap/i);
  });

  it("enforces an inclusive UTF-8 session quota and tracks deletions", async () => {
    const memory = new InMemoryMemory();
    const sessionRef = { scope: "session" as const, sessionId: "quota_session" as never };
    const value = "é";
    const valueBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

    await memory.put(sessionRef, "accent", "raw", value, { maxSessionBytes: valueBytes });
    await expect(
      memory.put(sessionRef, "emoji", "raw", "🤖", { maxSessionBytes: valueBytes }),
    ).rejects.toMatchObject({ code: "MEMORY_SESSION_QUOTA_EXCEEDED" });

    await memory.delete(sessionRef, "accent", "raw");
    await expect(
      memory.put(sessionRef, "emoji", "raw", "🤖", { maxSessionBytes: 6 }),
    ).resolves.toMatchObject({ key: "emoji" });
  });

  it("counts pre-existing session entries and does not charge other scopes", async () => {
    const memory = new InMemoryMemory();
    const sessionRef = { scope: "session" as const, sessionId: "quota_existing" as never };
    await memory.put(sessionRef, "old", "raw", "1234");
    await memory.put({ scope: "user", userId: userA }, "user", "raw", "outside");

    await expect(
      memory.put(sessionRef, "new", "raw", "56", { maxSessionBytes: 6 }),
    ).rejects.toMatchObject({ code: "MEMORY_SESSION_QUOTA_EXCEEDED" });
    await expect(
      memory.put(sessionRef, "new", "raw", "", { maxSessionBytes: 8 }),
    ).resolves.toMatchObject({ key: "new" });
  });

  it("admits concurrent session writes without exceeding the quota", async () => {
    const memory = new InMemoryMemory();
    const sessionRef = { scope: "session" as const, sessionId: "quota_concurrent" as never };
    const results = await Promise.allSettled(
      ["a", "b", "c"].map((key) => memory.put(sessionRef, key, "raw", "x", { maxSessionBytes: 6 })),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(await memory.list(sessionRef)).toHaveLength(2);
  });

  it("treats a value's own version field as data", async () => {
    const memory = createInMemoryMemory();
    await memory.put({ scope: "user", userId: userA }, "profile", "fact", { version: 1 });
    await expect(
      memory.put({ scope: "user", userId: userA }, "profile", "fact", { version: 2 }),
    ).rejects.toThrow(/conflict/i);
  });

  it("isolates memory entries when ids and keys contain delimiters", async () => {
    const memory = createInMemoryMemory();
    const firstRef = { scope: "user", userId: "u" as UserId } as const;
    const secondRef = { scope: "user", userId: "u:fact:b" as UserId } as const;

    await memory.put(firstRef, "b:fact:c", "fact", "first");
    await memory.put(secondRef, "c", "fact", "second");

    await expect(memory.get(firstRef, "b:fact:c", "fact")).resolves.toMatchObject({
      value: "first",
    });
    await expect(memory.get(secondRef, "c", "fact")).resolves.toMatchObject({ value: "second" });
    await expect(memory.list(firstRef)).resolves.toHaveLength(1);
    await expect(memory.list(secondRef)).resolves.toHaveLength(1);

    await expect(memory.deleteAll(firstRef)).resolves.toBe(1);
    await expect(memory.get(secondRef, "c", "fact")).resolves.toMatchObject({ value: "second" });
  });
});

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
