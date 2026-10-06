import { describe, expect, it } from "vitest";

import {
  PostgresRetentionJob,
  type SqlClient,
  type SqlPool,
  type SqlResult,
} from "../src/index.js";

describe("PostgreSQL retention job", () => {
  it("removes expired claimed idempotency records and preserves unexpired claims", async () => {
    const nowMs = 10_000;
    const rows = new Map([
      ["expired-claim", { status: "claimed", expiresAtMs: 500 }],
      ["expired-result", { status: "failed", expiresAtMs: 600 }],
      ["active-claim", { status: "claimed", expiresAtMs: 20_000 }],
    ]);
    const query = async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<SqlResult<Row>> => {
      if (text.includes("DELETE FROM tvic_outbox")) return { rows: [], rowCount: 0 };
      if (text.includes("SELECT id FROM tvic_sessions")) return { rows: [], rowCount: 0 };
      if (text.includes("DELETE FROM tvic_tool_idempotency")) {
        const cutoff = nowMs - Number(values[0]);
        expect(text).toContain("status = 'claimed'");
        expect(text).toContain("status <> 'claimed'");
        let rowCount = 0;
        for (const [key, row] of rows) {
          const expiredClaim = row.status === "claimed" && row.expiresAtMs <= nowMs;
          const expiredResult = row.status !== "claimed" && row.expiresAtMs <= cutoff;
          if (expiredClaim || expiredResult) {
            rows.delete(key);
            rowCount += 1;
          }
        }
        return { rows: [], rowCount };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    };
    const client: SqlClient & { readonly release: () => void } = {
      query,
      release: () => undefined,
    };
    const pool: SqlPool = { query, connect: async () => client };

    const result = await new PostgresRetentionJob({
      pool,
      terminalRetentionMs: 1_000,
      hasLegalHold: async () => false,
    }).runOnce();

    expect(result.idempotencyDeleted).toBe(2);
    expect([...rows.keys()]).toEqual(["active-claim"]);
  });
});
