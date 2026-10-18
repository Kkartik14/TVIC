import { describe, expect, it } from "vitest";

import { RecordConflictError } from "@tvic/core";
import {
  PostgresToolIdempotencyStore,
  type SqlClient,
  type SqlPool,
  type SqlResult,
} from "../src/index.js";

const activeClaim = {
  key: "idempotency-clock-race",
  request_hash: "request-hash",
  status: "claimed" as const,
  owner: "old-owner",
  expires_at_ms: 100,
};

describe("PostgreSQL idempotency expiry checks", () => {
  it("checks a claim's expiry after acquiring its row lock", async () => {
    let nowMs = 99;
    const events: string[] = [];
    const pool = fakePool(async (sql, values = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM tvic_tool_idempotency") && sql.includes("FOR UPDATE")) {
        events.push("idempotency-lock");
        nowMs = 101;
        return { rows: [activeClaim], rowCount: 1 };
      }
      if (sql.includes("SELECT floor")) {
        events.push("clock");
        return { rows: [{ now_ms: nowMs }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO tvic_tool_idempotency")) {
        events.push("claim-write");
        expect(values[5]).toBe("new-owner");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await new PostgresToolIdempotencyStore(pool).claim({
      key: activeClaim.key,
      requestHash: activeClaim.request_hash,
      owner: "new-owner",
      ttlMs: 500,
    });

    expect(result.status).toBe("claimed");
    expect(events).toEqual(["idempotency-lock", "clock", "claim-write"]);
  });

  it("does not complete a claim whose TTL expires during its row-lock wait", async () => {
    let nowMs = 99;
    const events: string[] = [];
    const pool = fakePool(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM tvic_tool_idempotency") && sql.includes("FOR UPDATE")) {
        events.push("idempotency-lock");
        nowMs = 101;
        return { rows: [{ ...activeClaim, owner: "owner" }], rowCount: 1 };
      }
      if (sql.includes("SELECT floor")) {
        events.push("clock");
        return { rows: [{ now_ms: nowMs }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE tvic_tool_idempotency")) {
        events.push("complete-write");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(
      new PostgresToolIdempotencyStore(pool).complete(activeClaim.key, activeClaim.request_hash, {
        status: "succeeded",
        owner: "owner",
        ttlMs: 500,
        output: { ok: true },
      }),
    ).rejects.toBeInstanceOf(RecordConflictError);
    expect(events).toEqual(["idempotency-lock", "clock"]);
  });

  it("evaluates lookup expiry in the same statement as the record read", async () => {
    let nowMs = 99;
    const queries: string[] = [];
    const pool = fakePool(async (sql) => {
      queries.push(sql);
      if (sql.includes("SELECT floor")) {
        return { rows: [{ now_ms: nowMs }], rowCount: 1 };
      }
      if (!sql.includes("FROM tvic_tool_idempotency")) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      nowMs = 101;
      if (sql.includes("expires_at_ms >") && activeClaim.expires_at_ms <= nowMs) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [activeClaim], rowCount: 1 };
    });

    await expect(
      new PostgresToolIdempotencyStore(pool).lookup(activeClaim.key, activeClaim.request_hash),
    ).resolves.toEqual({ status: "missing" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("expires_at_ms >");
  });
});

function fakePool(
  handleQuery: (sql: string, values?: readonly unknown[]) => Promise<SqlResult>,
): SqlPool {
  const client: SqlClient & { readonly release: () => void } = {
    query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      (await handleQuery(text, values)) as SqlResult<Row>,
    release: () => undefined,
  };
  return {
    query: client.query,
    connect: async () => client,
  };
}
