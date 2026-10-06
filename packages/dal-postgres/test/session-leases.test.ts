import { describe, expect, it } from "vitest";

import { LeaseLostError } from "@tvic/core";
import type { SessionId, SessionLease } from "@tvic/core";

import {
  createPostgresDurableRuntimeStore,
  PostgresToolIdempotencyStore,
  type SqlClient,
  type SqlPool,
  type SqlResult,
} from "../src/index.js";
import { PostgresSessionLeaseStore } from "../src/session-leases.js";

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

    expect(fake.events.indexOf("lease-lock")).toBeLessThan(fake.events.indexOf("clock"));
    expect(fake.events).toContain("idempotency-write");
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
    if (sql.includes("SELECT floor")) {
      events.push("clock");
      return { rows: [{ now_ms: nowMs } as unknown as Row], rowCount: 1 };
    }
    if (sql.includes("FROM tvic_sessions")) {
      if (sql.includes("FOR UPDATE")) events.push("session-lock");
      return { rows: [{ id: sessionId } as unknown as Row], rowCount: 1 };
    }
    if (sql.includes("FROM tvic_session_leases") && sql.includes("FOR UPDATE")) {
      events.push("lease-lock");
      nowMs = 101;
      return { rows: [leaseRow as unknown as Row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE tvic_session_leases SET renewed_at_ms")) {
      events.push("renew");
      // This models the lock wait inside UPDATE: its expiry predicate still
      // receives the caller's earlier timestamp under the buggy ordering.
      nowMs = 101;
      const sampledNow = Number(values[3]);
      if (expiredLease.expiresAtMs <= sampledNow) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            ...leaseRow,
            renewed_at_ms: sampledNow,
            expires_at_ms: Number(values[4]),
          } as unknown as Row,
        ],
        rowCount: 1,
      };
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
