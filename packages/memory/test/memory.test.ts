import { describe, expect, it } from "vitest";

import type { MemoryRef, UserId } from "@tvic/core";

import { createInMemoryMemory } from "../src/index.js";

const userA: MemoryRef = { scope: "user", userId: "user_a" as UserId };
const userB: MemoryRef = { scope: "user", userId: "user_b" as UserId };

describe("InMemoryMemory", () => {
  it("isolates identical keys by MemoryRef", async () => {
    const memory = createInMemoryMemory();

    await memory.put(userA, "timezone", "Asia/Kolkata");
    await memory.put(userB, "timezone", "America/New_York");

    await expect(memory.get(userA, "timezone")).resolves.toMatchObject({
      value: "Asia/Kolkata",
    });
    await expect(memory.get(userB, "timezone")).resolves.toMatchObject({
      value: "America/New_York",
    });
  });

  it("appends values without overwriting existing entries", async () => {
    const memory = createInMemoryMemory();

    await memory.append(userA, "notes", "first");
    const entry = await memory.append(userA, "notes", "second");

    expect(entry.value).toEqual(["first", "second"]);
  });

  it("expires entries with ttlMs", async () => {
    let now = new Date("2026-05-20T00:00:00.000Z");
    const memory = createInMemoryMemory({ now: () => now });

    await memory.put(userA, "temporary", true, { ttlMs: 10 });
    now = new Date("2026-05-20T00:00:00.011Z");

    await expect(memory.get(userA, "temporary")).resolves.toBeNull();
  });
});
