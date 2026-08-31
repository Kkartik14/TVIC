import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  createPostgresMemory,
  runPostgresMemoryMigrations,
  type SqlPool,
} from "@tvic/dal-postgres-memory";

import { memorySpecTest } from "../src/index.js";

const SKIP = !process.env.TVIC_RUN_INTEGRATION || !process.env.MEMORY_INTEGRATION_URL;
const DB_URL =
  process.env.MEMORY_INTEGRATION_URL ?? "postgres://postgres:tvic@127.0.0.1:5432/tvic_memory";

describe.skipIf(SKIP)("PostgresMemory contract", () => {
  let pool: SqlPool | undefined;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL }) as unknown as SqlPool;
    await runPostgresMemoryMigrations(pool);
  });
  memorySpecTest(
    {
      name: "PostgresMemory",
      async createMemory() {
        if (!pool) throw new Error("PostgresMemory contract pool was not initialized");
        const memory = createPostgresMemory({ pool });
        // Each test starts on a clean DB so writes from one scenario
        // don't leak into the next. Without this, the per-test ordering
        // is order-dependent and CI fails on the second run.
        await pool.query("DELETE FROM tvic_memory_entries");
        return memory;
      },
      async teardown() {
        // Drain rows between tests for the same reason.
        if (pool) {
          await pool.query("DELETE FROM tvic_memory_entries").catch(() => undefined);
        }
      },
    },
    { expect, it },
  );
  afterAll(async () => {
    await pool?.end?.();
    pool = undefined;
  });
});
