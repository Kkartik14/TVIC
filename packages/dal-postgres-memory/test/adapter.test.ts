import { describe, expect, it } from "vitest";

import type { UserId } from "@tvic/core";
import { createPostgresMemory, type SqlClient, type SqlPool } from "../src/index.js";

function fakePool(rowCount: number | null = 0): SqlPool {
  const client: SqlClient & { readonly release: () => void } = {
    query: async () => ({ rows: [], rowCount }),
    release: () => undefined,
  };
  return {
    query: async () => ({ rows: [], rowCount }),
    connect: async () => client,
  };
}

describe("PostgreSQL memory composition", () => {
  it("exposes the memory contract without importing a driver", () => {
    const memory = createPostgresMemory({ pool: fakePool() });
    expect(memory.name).toBe("postgres");
    expect(memory.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(memory.capabilities.search.exact).toBe(true);
    expect(memory.capabilities.search.vector).toBe(false);
    expect(memory.capabilities.purge.tenant).toBe(true);
  });

  it("treats a null database row count as zero", async () => {
    const memory = createPostgresMemory({ pool: fakePool(null) });
    const ref = { scope: "user" as const, userId: "row-count-user" as UserId };

    await expect(memory.delete(ref, "missing")).resolves.toBe(false);
    await expect(memory.deleteAll(ref)).resolves.toBe(0);
    await expect(memory.deleteForUser(ref.userId)).resolves.toBe(0);
  });
});
