import { describe, expect, it, vi } from "vitest";

import type {
  AgentId,
  SessionId,
  StoredSessionRecord,
  Timestamp,
  ToolIdempotencyOutcome,
} from "@tvic/core";
import { providerError, TvicThrowableError } from "@tvic/core";

import {
  createPostgresDurableRuntimeStore,
  PostgresOutboxWorker,
  PostgresToolIdempotencyStore,
  type SqlResult,
  type SqlClient,
  type SqlPool,
} from "../src/index.js";

function fakePool(): SqlPool {
  const client: SqlClient & { readonly release: () => void } = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => undefined,
  };
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => client,
  };
}

describe("PostgreSQL durable store composition", () => {
  it("exposes the complete durable store bundle without importing a driver", () => {
    const store = createPostgresDurableRuntimeStore({ pool: fakePool() });
    expect(store.sessions).toBeDefined();
    expect(store.turns).toBeDefined();
    expect(store.toolCalls).toBeDefined();
    expect(store.leases).toBeDefined();
    expect(store.toolIdempotencyStore).toBeDefined();
  });

  it("migrates legacy idempotency errors when reading PostgreSQL", async () => {
    const client: SqlClient = {
      query: async <Row extends Record<string, unknown>>(text: string): Promise<SqlResult<Row>> => {
        if (text.includes("SELECT floor")) {
          return { rows: [{ now_ms: 100 } as unknown as Row], rowCount: 1 };
        }
        return {
          rows: [
            {
              key: "legacy:key",
              request_hash: "hash",
              status: "failed",
              expires_at_ms: 1_000,
              error: {
                code: "provider.failed",
                category: "provider",
                message: "legacy provider failure",
                retriable: true,
              },
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      },
    };

    const store = new PostgresToolIdempotencyStore(client);
    await expect(store.lookup("legacy:key", "hash")).resolves.toMatchObject({
      error: {
        name: "ProviderError",
        category: "provider",
        code: "provider.failed",
      },
    });
  });

  it("uses the canonical serializer for throwable idempotency outcomes", async () => {
    let updateValues: readonly unknown[] | undefined;
    const client: SqlClient = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<SqlResult<Row>> => {
        if (text.includes("SELECT floor")) {
          return { rows: [{ now_ms: 100 } as unknown as Row], rowCount: 1 };
        }
        if (text.includes("SELECT key, session_id")) {
          return {
            rows: [
              {
                key: "key",
                request_hash: "hash",
                status: "claimed",
                owner: "owner",
                expires_at_ms: 1_000,
              } as unknown as Row,
            ],
            rowCount: 1,
          };
        }
        if (text.includes("UPDATE tvic_tool_idempotency")) {
          updateValues = values;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const store = new PostgresToolIdempotencyStore(client);
    const throwable = TvicThrowableError.from(providerError("tool.failed", "tool failed"));

    await store.complete("key", "hash", {
      status: "failed",
      ttlMs: 100,
      owner: "owner",
      output: { z: 1, a: 2 },
      error: throwable as unknown as NonNullable<ToolIdempotencyOutcome["error"]>,
    });

    expect(updateValues?.[3]).toBe('{"a":2,"z":1}');
    expect(updateValues?.[4]).toBe(
      '{"category":"provider","code":"tool.failed","message":"tool failed","name":"ProviderError","retriable":true}',
    );
  });

  it("allows an unfenced transaction to create a session", async () => {
    const sessionId = "session_created_unfenced" as SessionId;
    const timestamp = "2026-08-31T00:00:00.000Z" as Timestamp;
    const record = {
      session: {
        id: sessionId,
        agentId: "agent" as AgentId,
        status: "active" as const,
        channel: "simulated" as const,
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    };
    const store = createPostgresDurableRuntimeStore({ pool: fakePoolReturningSession(record) });

    await expect(
      store.runUnfencedSessionTransaction(sessionId, async (tx) => {
        await tx.putSession(record);
        return "created";
      }),
    ).resolves.toBe("created");
  });

  it("updates denormalized session lifecycle columns with the payload", async () => {
    const sessionId = "session_lifecycle_columns" as SessionId;
    const timestamp = "2026-08-31T00:00:00.000Z" as Timestamp;
    const endedAt = "2026-08-31T00:01:00.000Z" as Timestamp;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: "agent" as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    };
    const terminal = {
      ...record.session,
      status: "completed",
      endedAt,
    } as StoredSessionRecord["session"];
    const updates: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
    const query = async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<SqlResult<Row>> => {
      if (text.includes("UPDATE tvic_sessions SET payload")) {
        updates.push({ text, values: values ?? [] });
      }
      if (text.includes("SELECT id, payload, runtime, version")) {
        return {
          rows: [
            {
              id: record.session.id,
              payload: record.session,
              runtime: record.runtime,
              version: 1,
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    const client: SqlClient & { readonly release: () => void } = {
      query,
      release: () => undefined,
    };
    const pool: SqlPool = { query, connect: async () => client };
    const store = createPostgresDurableRuntimeStore({ pool });

    await store.runUnfencedSessionTransaction(sessionId, async (tx) => {
      await tx.updateSession(sessionId, (current) => ({ ...current, session: terminal }));
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).toContain("started_at = $5");
    expect(updates[0]?.text).toContain("ended_at = $6");
    expect(updates[0]?.values[4]).toBe(timestamp);
    expect(updates[0]?.values[5]).toBe(endedAt);
  });

  it("closes an owned SQL pool when the durable store closes", async () => {
    const end = vi.fn(async () => undefined);
    const store = createPostgresDurableRuntimeStore({
      pool: { ...fakePool(), end },
    });

    await Promise.all([store.close(), store.close()]);

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight outbox poll before stopping", async () => {
    let releaseRows!: () => void;
    const rowsReady = new Promise<void>((resolve) => {
      releaseRows = resolve;
    });
    const connection: SqlClient & { readonly release: () => void } = {
      query: async <Row extends Record<string, unknown>>(text: string): Promise<SqlResult<Row>> => {
        if (text.includes("WITH candidates")) await rowsReady;
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool: SqlPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => connection,
    };
    const worker = new PostgresOutboxWorker({
      pool,
      workerId: "adapter-test-worker",
      deliver: async () => undefined,
    });
    const run = worker.runOnce();
    await Promise.resolve();
    const stop = Promise.resolve(worker.stop());
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseRows();
    await run;
    await stop;
    expect(stopped).toBe(true);
  });
});

function fakePoolReturningSession(record: StoredSessionRecord): SqlPool {
  const client: SqlClient & { readonly release: () => void } = {
    query: async <Row extends Record<string, unknown>>(text: string): Promise<SqlResult<Row>> => {
      if (text.includes("SELECT id, payload, runtime, version")) {
        return {
          rows: [
            {
              id: record.session.id,
              payload: record.session,
              runtime: record.runtime,
              version: 1,
            } as unknown as Row,
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => client,
  };
}
