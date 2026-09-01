import { describe, expect, it } from "vitest";

import { InvalidArgumentError, type UserId } from "@tvic/core";
import { createPostgresMemory, type SqlPool } from "../src/index.js";

describe("PostgresMemory input boundary", () => {
  it("rejects non-JSON values before opening a database transaction", async () => {
    let calls = 0;
    const pool: SqlPool = {
      query: async <TRow extends Record<string, unknown>>(
        _text: string,
        _params?: readonly unknown[],
      ): Promise<{ rows: readonly TRow[]; rowCount: number }> => {
        calls += 1;
        throw new Error("database should not be reached");
      },
      connect: async () => {
        calls += 1;
        throw new Error("database should not be reached");
      },
    };
    const memory = createPostgresMemory({ pool });
    const ref = { scope: "user" as const, userId: "unit_user" as UserId };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const [index, value] of [undefined, Number.NaN, new Date(), new Map(), cyclic].entries()) {
      await expect(memory.put(ref, `invalid_${index}`, "raw", value)).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    }
    await expect(
      memory.put(ref, "invalid_metadata", "raw", "v", {
        metadata: { unsupported: undefined },
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      memory.put(ref, "invalid_tags", "raw", "v", {
        tags: [1 as unknown as string],
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    expect(calls).toBe(0);
  });
});
