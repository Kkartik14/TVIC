import { describe, expect, it } from "vitest";

import type { MemoryRef, UserId } from "@tvic/core";

import { createInMemoryMemory } from "../src/index.js";

const userA: MemoryRef = { scope: "user", userId: "user_a" as UserId };
const userB: MemoryRef = { scope: "user", userId: "user_b" as UserId };

describe("InMemoryMemory", () => {
  it("isolates identical keys by MemoryRef", async () => {
    const memory = createInMemoryMemory();

    await memory.put(userA, "timezone", "fact", "Asia/Kolkata");
    await memory.put(userB, "timezone", "fact", "America/New_York");

    await expect(memory.get(userA, "timezone", "fact")).resolves.toMatchObject({
      value: "Asia/Kolkata",
    });
    await expect(memory.get(userB, "timezone", "fact")).resolves.toMatchObject({
      value: "America/New_York",
    });
  });

  it("put with a list value round-trips", async () => {
    const memory = createInMemoryMemory();
    const first = await memory.put(userA, "notes", "raw", ["first"]);
    expect(first.value).toEqual(["first"]);
    const got = await memory.get(userA, "notes", "raw");
    expect(got?.value).toEqual(["first"]);
  });

  it("conflicting put with a different value throws", async () => {
    const memory = createInMemoryMemory();
    await memory.put(userA, "notes", "raw", ["first"]);
    await expect(memory.put(userA, "notes", "raw", ["first", "second"])).rejects.toThrow(
      /conflict/i,
    );
  });

  it("expires entries with ttlMs", async () => {
    let now = new Date("2026-05-20T00:00:00.000Z");
    const memory = createInMemoryMemory({ now: () => now });

    await memory.put(userA, "temporary", "raw", true, { ttlMs: 10 });
    now = new Date("2026-05-20T00:00:00.011Z");

    await expect(memory.get(userA, "temporary", "raw")).resolves.toBeNull();
  });
});
