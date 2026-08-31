import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  createPostgresMemory,
  runPostgresMemoryMigrations,
  type PostgresMemory,
  type SqlPool,
} from "@tvic/dal-postgres-memory";
import { RecordConflictError, type UserId } from "@tvic/core";

const SKIP = !process.env.TVIC_RUN_INTEGRATION || !process.env.MEMORY_INTEGRATION_URL;

const DB_URL =
  process.env.MEMORY_INTEGRATION_URL ?? "postgres://postgres:tvic@127.0.0.1:5432/tvic_memory";

describe.skipIf(SKIP)("PostgresMemory integration", () => {
  let pool: SqlPool;
  let memory: PostgresMemory;
  const userA = "user_int_a" as UserId;
  const userB = "user_int_b" as UserId;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL }) as unknown as SqlPool;
    await runPostgresMemoryMigrations(pool);
    memory = createPostgresMemory({ pool });
  });

  afterAll(async () => {
    await pool.end?.();
  });

  it("round-trips put / get / list / delete", async () => {
    const ref = { scope: "user" as const, userId: userA };
    await memory.put(ref, "preferred_name", "fact", "Ada");
    const entry = await memory.get(ref, "preferred_name", "fact");
    expect(entry?.value).toBe("Ada");
    expect(entry?.version).toBe(1);

    const list = await memory.list(ref, { kind: "fact" });
    expect(list.length).toBeGreaterThanOrEqual(1);

    const ok = await memory.delete(ref, "preferred_name", "fact");
    expect(ok).toBe(true);
    const gone = await memory.get(ref, "preferred_name", "fact");
    expect(gone).toBeNull();
  });

  it("rejects conflicting puts with a RecordConflictError", async () => {
    const ref = { scope: "user" as const, userId: userA };
    await memory.put(ref, "k", "fact", "v1");
    try {
      await memory.put(ref, "k", "fact", "v2");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordConflictError);
      expect(String(error)).toMatch(/conflict/i);
    }
    await memory.delete(ref, "k", "fact");
  });

  it("respects ttlMs on read", async () => {
    const ref = { scope: "user" as const, userId: userA };
    await memory.put(ref, "ephemeral", "raw", "x", { ttlMs: 50 });
    expect((await memory.get(ref, "ephemeral"))?.value).toBe("x");
    await new Promise((r) => setTimeout(r, 200));
    expect(await memory.get(ref, "ephemeral")).toBeNull();
  });

  it("deleteForUser removes user-owned data but preserves shared scopes", async () => {
    const refA = { scope: "user" as const, userId: userA };
    const refB = { scope: "user" as const, userId: userB };
    await memory.put(refA, "k1", "raw", "v");
    await memory.put(refB, "k2", "raw", "v");
    await memory.put(
      { scope: "organization" as const, organizationId: "org_int_a" as never },
      "k3",
      "raw",
      "v",
    );
    await memory.put(
      { scope: "workflow" as const, workflowId: "wf_int_a" as never },
      "k4",
      "raw",
      "v",
    );
    const sessionRef = { scope: "session" as const, sessionId: "session_int_a" as never };
    await memory.put(sessionRef, "k5", "raw", "v", { sessionUserId: userA });
    await memory.put(sessionRef, "k5", "raw", "v", { metadata: { source: "updated" } });
    const deleted = await memory.deleteForUser(userA);
    expect(deleted).toBe(2);
    expect(await memory.get(refA, "k1")).toBeNull();
    expect(await memory.get(refB, "k2")).not.toBeNull();
    expect(await memory.get(sessionRef, "k5")).toBeNull();
    expect(
      await memory.get(
        { scope: "organization" as const, organizationId: "org_int_a" as never },
        "k3",
      ),
    ).not.toBeNull();
    expect(
      await memory.get({ scope: "workflow" as const, workflowId: "wf_int_a" as never }, "k4"),
    ).not.toBeNull();
  });

  it("accounts canonical UTF-8 bytes for object and array values", async () => {
    const sessionRef = { scope: "session" as const, sessionId: "session_int_quota" as never };
    const objectValue = { z: "🤖", a: ["é", "x"] };
    const arrayValue = ["東京", { nested: true }];
    const byteCount = async (value: unknown): Promise<number> => {
      const result = await pool.query<{ value_bytes: number | string } & Record<string, unknown>>(
        "SELECT octet_length(convert_to($1::jsonb::text, 'UTF8'))::numeric AS value_bytes",
        [JSON.stringify(value)],
      );
      return Number(result.rows[0]!.value_bytes);
    };

    const objectBytes = await byteCount(objectValue);
    await expect(
      memory.put(sessionRef, "object-too-small", "raw", objectValue, {
        maxSessionBytes: objectBytes - 1,
      }),
    ).rejects.toThrow(/quota/i);
    await memory.put(sessionRef, "object", "raw", objectValue, {
      maxSessionBytes: objectBytes,
    });
    await memory.deleteAll(sessionRef);

    const arrayBytes = await byteCount(arrayValue);
    await memory.put(sessionRef, "array", "raw", arrayValue, { maxSessionBytes: arrayBytes });
    await memory.deleteAll(sessionRef);
  });
});
