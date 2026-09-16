import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { adaptPool, assertDurableRuntimeEnvironment } from "../src/durable-runtime.js";
import { createConfiguredMemory } from "../src/memory-runtime.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("live-call durable runtime wiring", () => {
  it("forwards shutdown to the PostgreSQL pool it creates", async () => {
    const end = vi.fn(async () => undefined);
    const pool = { end } as unknown as Pool;

    await adaptPool(pool).end?.();

    expect(end).toHaveBeenCalledTimes(1);
  });

  it("rejects partial durable configuration before any pool is created", () => {
    vi.stubEnv("DATABASE_URL", "postgres://example");
    vi.stubEnv("REDIS_URL", "");

    expect(() => assertDurableRuntimeEnvironment()).toThrow(
      /DATABASE_URL and REDIS_URL must be provided together/,
    );
  });

  it("treats whitespace-only memory configuration as unset", async () => {
    vi.stubEnv("DATABASE_URL", "   ");
    vi.stubEnv("REDIS_URL", "");
    const seed = { list: async () => [] } as never;

    const configured = await createConfiguredMemory(seed);

    expect(configured.memory).toBe(seed);
    await configured.stopExternalServices();
  });
});
