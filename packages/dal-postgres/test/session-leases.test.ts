import { describe, expect, it } from "vitest";

import { CorruptRecordError, InvalidArgumentError, LeaseLostError } from "@tvic/core";
import type { SessionId, SessionLease } from "@tvic/core";

import {
  createPostgresDurableRuntimeStore,
  PostgresToolIdempotencyStore,
  type SqlClient,
  type SqlPool,
  type SqlResult,
} from "../src/index.js";
import { PostgresSessionLeaseStore } from "../src/session-leases.js";
import { decodeSessionRow, leaseFromRow, type LeaseRow } from "../src/postgres-records.js";

const sessionId = "lease-clock-race" as SessionId;
const expiredLease: SessionLease = {
  sessionId,
  holder: "old-worker",
  fence: 7,
  generationId: "generation-7",
  acquiredAtMs: 10,
  renewedAtMs: 50,
  expiresAtMs: 100,
};

describe("PostgreSQL lease expiry checks", () => {
  it("rejects persisted aggregate versions above JavaScript's safe integer range", () => {
    expect(() =>
      decodeSessionRow({
        id: "unsafe-version",
        payload: {
          id: "unsafe-version",
          agentId: "agent-1",
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
        version: "9007199254740992",
      }),
    ).toThrow(CorruptRecordError);
  });

  it("rejects oversized and out-of-range recovery cursors before querying PostgreSQL", async () => {
    let queryCount = 0;
    const pool: SqlPool = {
      query: async <Row extends Record<string, unknown>>() => {
        queryCount += 1;
        return { rows: [] as Row[] };
      },
      connect: async () => {
        throw new Error("unexpected connection");
      },
    };
    const store = new PostgresSessionLeaseStore(pool);
    for (const expiry of ["9223372036854775808", "-9223372036854775809", "9".repeat(21)]) {
      const cursor = `tvic_pg_recovery_v1:${Buffer.from(
        JSON.stringify([expiry, "session"]),
      ).toString("base64url")}`;
      await expect(
        store.listRecoveryCandidates({ nowMs: 0, limit: 1, cursor }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    }
    const oversizedCursor = `tvic_pg_recovery_v1:${"A".repeat(4_096)}`;
    await expect(
      store.listRecoveryCandidates({ nowMs: 0, limit: 1, cursor: oversizedCursor }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(queryCount).toBe(0);
  });

  it("rejects unsafe lease fences and fractional millisecond timestamps", () => {
    const row: LeaseRow = {
      session_id: sessionId,
      holder: "worker",
      fence: 1,
      generation_id: "generation-1",
      acquired_at_ms: 0,
      renewed_at_ms: 0,
      expires_at_ms: 1,
    };

    for (const invalid of [
      { session_id: "" },
      { fence: "9007199254740992" },
      { acquired_at_ms: "0.5" },
      { renewed_at_ms: "1.5" },
      { expires_at_ms: "1e100" },
    ]) {
      expect(() => leaseFromRow({ ...row, ...invalid })).toThrow(CorruptRecordError);
    }
  });

  it("does not renew a lease that expires while waiting for its row lock", async () => {
    const fake = leaseDatabase();
    const store = new PostgresSessionLeaseStore(fake.pool);

    await expect(
      store.renew(
        sessionId,
        expiredLease.holder,
        expiredLease.fence,
        500,
        expiredLease.generationId,
      ),
    ).resolves.toBeNull();

    expect(fake.events.indexOf("lease-lock")).toBeLessThan(fake.events.indexOf("clock"));
    expect(fake.events).not.toContain("renew");
  });

  it("does not return a lease that expires while waiting for its row lock", async () => {
    const fake = leaseDatabase();
    const store = new PostgresSessionLeaseStore(fake.pool);

    await expect(store.get(sessionId)).resolves.toBeNull();

    expect(fake.events.indexOf("lease-lock")).toBeLessThan(fake.events.indexOf("clock"));
  });

  it("does not run a fenced callback when the lease expires during lock acquisition", async () => {
    const fake = leaseDatabase();
    const store = createPostgresDurableRuntimeStore({ pool: fake.pool });
    let callbackRan = false;

    await expect(
      store.runSessionTransaction(sessionId, expiredLease, async () => {
        callbackRan = true;
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    expect(callbackRan).toBe(false);
    expect(fake.events.indexOf("session-lock")).toBeLessThan(fake.events.indexOf("lease-lock"));
    expect(fake.events.indexOf("lease-lock")).toBeLessThan(fake.events.indexOf("clock"));
  });

  it("allows takeover when the previous lease expires while waiting for its row lock", async () => {
    const fake = leaseDatabase();
    const store = new PostgresSessionLeaseStore(fake.pool);

    await expect(store.acquire(sessionId, "new-worker", 500)).resolves.toMatchObject({
      holder: "new-worker",
      fence: expiredLease.fence + 1,
      expiresAtMs: 601,
    });

    expect(fake.events.indexOf("session-lock")).toBeLessThan(fake.events.indexOf("lease-lock"));
    expect(fake.events.indexOf("lease-lock")).toBeLessThan(fake.events.indexOf("clock"));
  });

  it("rejects an idempotency claim when its lease expires during lock acquisition", async () => {
    const fake = leaseDatabase();
    const store = new PostgresToolIdempotencyStore(fake.pool);

    await expect(
      store.claim({
        key: "expired-lease-claim",
        requestHash: "request-hash",
        owner: "old-worker",
        ttlMs: 500,
        lease: expiredLease,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    expect(fake.events.indexOf("lease-lock")).toBeLessThan(fake.events.lastIndexOf("clock"));
    expect(fake.events).not.toContain("idempotency-write");
    expect(fake.events).toContain("rollback");
    expect(fake.idempotencyRows.has("expired-lease-claim")).toBe(false);
  });
});

function leaseDatabase(): {
  readonly pool: SqlPool;
  readonly events: string[];
  readonly idempotencyRows: Set<string>;
} {
  let nowMs = 99;
  const events: string[] = [];
  const idempotencyRows = new Set<string>();
  const insertedInTransaction = new Set<string>();
  let transactionOpen = false;
  const leaseRow = {
    session_id: sessionId,
    holder: expiredLease.holder,
    fence: expiredLease.fence,
    generation_id: expiredLease.generationId,
    acquired_at_ms: expiredLease.acquiredAtMs,
    renewed_at_ms: expiredLease.renewedAtMs,
    expires_at_ms: expiredLease.expiresAtMs,
  };

  const query = async <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql === "BEGIN") {
      transactionOpen = true;
      insertedInTransaction.clear();
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      transactionOpen = false;
      insertedInTransaction.clear();
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      events.push("rollback");
      for (const key of insertedInTransaction) idempotencyRows.delete(key);
      insertedInTransaction.clear();
      transactionOpen = false;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("WITH current_lease AS MATERIALIZED")) {
      events.push("lease-lock");
      nowMs = 101;
      events.push("clock");
      if (Number(leaseRow.expires_at_ms) <= nowMs) return { rows: [], rowCount: 0 };
      events.push("renew");
      return {
        rows: [
          {
            ...leaseRow,
            renewed_at_ms: nowMs,
            expires_at_ms: nowMs + Number(values[3]),
          } as unknown as Row,
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT floor")) {
      events.push("clock");
      return { rows: [{ now_ms: nowMs } as unknown as Row], rowCount: 1 };
    }
    if (sql.includes("FROM tvic_sessions")) {
      if (sql.includes("FOR UPDATE")) events.push("session-lock");
      return {
        rows: [{ id: sessionId, last_fence: expiredLease.fence, incarnation: 1 } as unknown as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM tvic_session_leases") && sql.includes("FOR UPDATE")) {
      events.push("lease-lock");
      nowMs = 101;
      return { rows: [leaseRow as unknown as Row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT session_id, holder, fence")) {
      return { rows: [leaseRow as unknown as Row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tvic_session_leases SET generation_id")) {
      return { rows: [], rowCount: 0 };
    }
    if (/^(INSERT INTO|UPDATE) tvic_tool_idempotency/.test(sql)) {
      events.push("idempotency-write");
      if (sql.startsWith("INSERT INTO")) {
        const key = String(values[0]);
        if (!idempotencyRows.has(key)) {
          idempotencyRows.add(key);
          if (transactionOpen) insertedInTransaction.add(key);
        }
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  const client: SqlClient & { readonly release: () => void } = {
    query,
    release: () => undefined,
  };
  return { pool: { query, connect: async () => client }, events, idempotencyRows };
}
