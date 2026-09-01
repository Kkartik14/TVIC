import { describe, expect, it, vi } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import type { MemoryEntry, UserId } from "@tvic/core";

import { VectorMemorySkeleton, type VectorSearchFn } from "../src/index.js";

describe("VectorMemorySkeleton", () => {
  const userA: UserId = "user_a" as UserId;
  const userB: UserId = "user_b" as UserId;

  it("passes through non-vector queries to the inner adapter", async () => {
    const inner = createInMemoryMemory();
    const vectorSearch: VectorSearchFn = vi.fn(() => Promise.resolve([]));
    const memory = new VectorMemorySkeleton(inner, vectorSearch);

    await memory.put({ scope: "user", userId: userA }, "preferred_name", "fact", "Ada");
    const listed = await memory.list({ scope: "user", userId: userA });
    expect(listed.map((e) => e.value)).toEqual(["Ada"]);
    expect(vectorSearch).not.toHaveBeenCalled();
  });

  it("routes vector queries through the user-provided function", async () => {
    const inner = createInMemoryMemory();
    let captured: { query: string; kind: string | undefined; limit: number | undefined } | null =
      null;
    const vectorSearch: VectorSearchFn = (query, options) => {
      expect(options.ref).toEqual({ scope: "user", userId: userA });
      captured = { query, kind: options.kind, limit: options.limit };
      const entry: MemoryEntry = {
        id: "fake" as never,
        ref: { scope: "user", userId: userA },
        key: "vector_match",
        kind: "fact",
        value: "matched",
        version: 1,
        createdAt: "2026-08-29T00:00:00.000Z" as never,
        updatedAt: "2026-08-29T00:00:00.000Z" as never,
      };
      return Promise.resolve([entry]);
    };
    const memory = new VectorMemorySkeleton(inner, vectorSearch);

    const result = await memory.search({ scope: "user", userId: userA }, "Ada", {
      kind: "fact",
      limit: 5,
    });

    expect(captured).toEqual({ query: "Ada", kind: "fact", limit: 5 });
    expect(result.map((e) => e.value)).toEqual(["matched"]);
  });

  it("delegates delete / deleteAll / deleteForUser to the inner adapter", async () => {
    const inner = createInMemoryMemory();
    await inner.put({ scope: "user", userId: userA }, "k", "fact", "v");
    const memory = new VectorMemorySkeleton(inner, () => Promise.resolve([]));

    expect(await memory.delete({ scope: "user", userId: userA }, "k", "fact")).toBe(true);
    expect(await memory.list({ scope: "user", userId: userA })).toHaveLength(0);
    await memory.put({ scope: "user", userId: userB }, "x", "fact", "v");
    const n = await memory.deleteAll({ scope: "user", userId: userB });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("declares vector search as a capability", () => {
    const memory = new VectorMemorySkeleton(createInMemoryMemory(), () => Promise.resolve([]));
    expect(memory.capabilities.search.vector).toBe(true);
    expect(memory.capabilities.search.exact).toBe(true);
    expect(memory.capabilities.search.hybrid).toBe(false);
  });

  it("preserves the inner adapter's non-vector capability declarations", () => {
    const inner = createInMemoryMemory();
    Object.defineProperty(inner, "capabilities", {
      value: {
        ...inner.capabilities,
        retention: { ttl: false, policy: true },
        purge: { perEntry: false, perScope: true, tenant: false },
      },
    });
    const memory = new VectorMemorySkeleton(inner, () => Promise.resolve([]));

    expect(memory.capabilities.retention).toEqual({ ttl: false, policy: true });
    expect(memory.capabilities.purge).toEqual({ perEntry: false, perScope: true, tenant: false });
  });
});
