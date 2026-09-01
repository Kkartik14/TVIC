import { describe, expect, it } from "vitest";

import { createPostgresMemory, type SqlClient, type SqlPool } from "../src/index.js";

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

describe("PostgreSQL memory composition", () => {
  it("exposes the memory contract without importing a driver", () => {
    const memory = createPostgresMemory({ pool: fakePool() });
    expect(memory.name).toBe("postgres");
    expect(memory.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(memory.capabilities.search.exact).toBe(true);
    expect(memory.capabilities.search.vector).toBe(false);
    expect(memory.capabilities.purge.tenant).toBe(true);
  });
});
