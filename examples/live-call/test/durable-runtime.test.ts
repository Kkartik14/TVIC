import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { adaptPool } from "../src/durable-runtime.js";

describe("live-call durable runtime wiring", () => {
  it("forwards shutdown to the PostgreSQL pool it creates", async () => {
    const end = vi.fn(async () => undefined);
    const pool = { end } as unknown as Pool;

    await adaptPool(pool).end?.();

    expect(end).toHaveBeenCalledTimes(1);
  });
});
