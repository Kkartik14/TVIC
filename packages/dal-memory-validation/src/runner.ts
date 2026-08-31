import type { Memory, MemoryKind, OrganizationId, UserId, WorkflowId } from "@tvic/core";

import type { MemoryContractTestApi, MemoryContractTestInitializer } from "./types.js";

const userA: UserId = "user_a" as UserId;
const userB: UserId = "user_b" as UserId;
const orgA: OrganizationId = "org_a" as OrganizationId;
const orgB: OrganizationId = "org_b" as OrganizationId;
const wfA: WorkflowId = "wf_a" as WorkflowId;

function userScope(userId: UserId) {
  return { scope: "user" as const, userId };
}
function orgScope(organizationId: OrganizationId) {
  return { scope: "organization" as const, organizationId };
}
function workflowScope(workflowId: WorkflowId) {
  return { scope: "workflow" as const, workflowId };
}
function sessionScope(sessionId: string) {
  return { scope: "session" as const, sessionId: sessionId as never };
}

/**
 * Runs the full Memory contract test suite against an initializer. Any
 * `Memory` implementation that passes this suite is guaranteed to behave
 * identically to the in-memory reference for the documented scenarios.
 */
export function memorySpecTest(
  init: MemoryContractTestInitializer,
  testApi: MemoryContractTestApi,
): void {
  const { expect, it } = testApi;
  const make = async (): Promise<Memory> => {
    const m = await init.createMemory();
    expect(m.name, `${init.name} should declare a non-empty name`).toBeTruthy();
    expect(m.version, `${init.name} should declare a semver version`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.capabilities, `${init.name} should declare capabilities`).toBeDefined();
    return m;
  };
  const teardown = async (memory: Memory) => {
    if (init.teardown) await init.teardown(memory);
  };

  it(`${init.name}: put then get returns the entry`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "v");
      const got = await memory.get(userScope(userA), "k", "fact");
      expect(got?.value).toBe("v");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: get on a missing key returns null`, async () => {
    const memory = await make();
    try {
      expect(await memory.get(userScope(userA), "missing")).toBeNull();
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: get with a different kind returns null`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "v");
      expect(await memory.get(userScope(userA), "k", "summary")).toBeNull();
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: put with same value increments version`, async () => {
    const memory = await make();
    try {
      const first = await memory.put(userScope(userA), "k", "fact", "v");
      const second = await memory.put(userScope(userA), "k", "fact", "v");
      expect(second.version).toBe(first.version + 1);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: put with different value throws RecordConflictError`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "v1");
      await expect(memory.put(userScope(userA), "k", "fact", "v2")).rejects.toThrow(/conflict/i);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: ifNotExists returns existing entry unchanged`, async () => {
    const memory = await make();
    try {
      const first = await memory.put(userScope(userA), "k", "fact", "v");
      const second = await memory.put(userScope(userA), "k", "fact", "different", {
        ifNotExists: true,
      });
      expect(second).toEqual(first);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: put with ttlMs and tags and metadata round-trips`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "v", {
        ttlMs: 60_000,
        tags: ["profile"],
        metadata: { source: "test" },
      });
      const got = await memory.get(userScope(userA), "k", "fact");
      expect(got?.tags).toEqual(["profile"]);
      expect(got?.metadata).toEqual({ source: "test" });
      expect(got?.expiresAtMs).toBeGreaterThan(Date.now());
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: list filters by kind`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "a", "fact", "1");
      await memory.put(userScope(userA), "b", "summary", "2");
      await memory.put(userScope(userA), "c", "open_item", "3");
      const facts = await memory.list(userScope(userA), { kind: "fact" });
      expect(facts).toHaveLength(1);
      expect(facts[0]?.value).toBe("1");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: list filters by prefix and key`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "preferred_name", "fact", "Ada");
      await memory.put(userScope(userA), "preferred_color", "fact", "blue");
      await memory.put(userScope(userA), "recent_order", "raw", "x");
      const byPrefix = await memory.list(userScope(userA), { prefix: "preferred" });
      expect(byPrefix).toHaveLength(2);
      const byKey = await memory.list(userScope(userA), { key: "recent_order" });
      expect(byKey).toHaveLength(1);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: list respects limit`, async () => {
    const memory = await make();
    try {
      for (let i = 0; i < 5; i += 1) {
        await memory.put(userScope(userA), `k${i}`, "raw", i);
      }
      const page = await memory.list(userScope(userA), { limit: 2 });
      expect(page).toHaveLength(2);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: list filters by tags`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "a", "fact", "1", { tags: ["profile"] });
      await memory.put(userScope(userA), "b", "fact", "2", { tags: ["ui"] });
      await memory.put(userScope(userA), "c", "fact", "3", {
        tags: ["profile", "ui"],
      });
      const profile = await memory.list(userScope(userA), { tags: ["profile"] });
      expect(profile).toHaveLength(2);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: delete returns true on hit, false on miss`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "v");
      expect(await memory.delete(userScope(userA), "k", "fact")).toBe(true);
      expect(await memory.delete(userScope(userA), "k", "fact")).toBe(false);
      expect(await memory.delete(userScope(userA), "missing", "fact")).toBe(false);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: deleteAll removes every entry for a ref`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "a", "fact", "1");
      await memory.put(userScope(userA), "b", "raw", "2");
      await memory.put(userScope(userB), "x", "fact", "3");
      const deleted = await memory.deleteAll(userScope(userA));
      expect(deleted).toBe(2);
      expect(await memory.list(userScope(userA))).toHaveLength(0);
      expect(await memory.list(userScope(userB))).toHaveLength(1);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: cross-scope isolation — user A cannot see user B`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "a");
      await memory.put(userScope(userB), "k", "fact", "b");
      expect((await memory.get(userScope(userA), "k", "fact"))?.value).toBe("a");
      expect((await memory.get(userScope(userB), "k", "fact"))?.value).toBe("b");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: cross-scope isolation — org and workflow are independent`, async () => {
    const memory = await make();
    try {
      await memory.put(orgScope(orgA), "k", "fact", "org");
      await memory.put(workflowScope(wfA), "k", "fact", "wf");
      expect((await memory.get(orgScope(orgA), "k", "fact"))?.value).toBe("org");
      expect((await memory.get(workflowScope(wfA), "k", "fact"))?.value).toBe("wf");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: deleteAll on a scope does not affect other scopes' entries`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "u");
      await memory.put(orgScope(orgA), "k", "fact", "o");
      await memory.deleteAll(userScope(userA));
      expect(await memory.get(userScope(userA), "k", "fact")).toBeNull();
      expect((await memory.get(orgScope(orgA), "k", "fact"))?.value).toBe("o");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: deleteForUser removes user data but preserves shared scopes`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k1", "raw", "u");
      await memory.put(userScope(userB), "k2", "raw", "u");
      await memory.put(orgScope(orgA), "k3", "raw", "u");
      await memory.put(orgScope(orgB), "k4", "raw", "u");
      await memory.put(workflowScope(wfA), "k5", "raw", "u");
      const deleted = await memory.deleteForUser(userA);
      expect(deleted).toBe(1);
      expect(await memory.get(userScope(userA), "k1")).toBeNull();
      expect(await memory.get(userScope(userB), "k2")).not.toBeNull();
      expect(await memory.get(orgScope(orgA), "k3")).not.toBeNull();
      expect(await memory.get(orgScope(orgB), "k4")).not.toBeNull();
      expect(await memory.get(workflowScope(wfA), "k5")).not.toBeNull();
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: deleteForUser removes explicitly attributed sessions only`, async () => {
    const memory = await make();
    try {
      // User scope: should be deleted.
      await memory.put(userScope(userA), "user-k", "raw", "u");
      // Session scope with matching reserved attribution: should be deleted.
      const sessA = sessionScope("session_a");
      await memory.put(sessA, "session-k-a", "raw", "s", {
        sessionUserId: userA,
      });
      // Session scope with non-matching attribution: should NOT be deleted.
      const sessB = sessionScope("session_b");
      await memory.put(sessB, "session-k-b", "raw", "s", {
        sessionUserId: userB,
      });
      // Caller metadata is not ownership attribution.
      const sessC = sessionScope("session_c");
      await memory.put(sessC, "session-k-c", "raw", "s", { metadata: { userId: userA } });
      // Shared scopes are never part of the user cascade.
      await memory.put(orgScope(orgA), "org-k", "raw", "o");
      await memory.put(workflowScope(wfA), "wf-k", "raw", "w");
      // Other user's data: should NOT be deleted.
      await memory.put(userScope(userB), "user-b-k", "raw", "u");
      const deleted = await memory.deleteForUser(userA);
      expect(deleted).toBe(2); // user-k + session-k-a
      expect(await memory.get(userScope(userA), "user-k")).toBeNull();
      expect(await memory.get(sessA, "session-k-a")).toBeNull();
      expect(await memory.get(sessB, "session-k-b")).not.toBeNull();
      expect(await memory.get(sessC, "session-k-c")).not.toBeNull();
      expect(await memory.get(orgScope(orgA), "org-k")).not.toBeNull();
      expect(await memory.get(workflowScope(wfA), "wf-k")).not.toBeNull();
      expect(await memory.get(userScope(userB), "user-b-k")).not.toBeNull();
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: deleteForUser leaves unattributed sessions intact`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k1", "raw", "u");
      await memory.put(sessionScope("session_unattributed"), "k2", "raw", "u", {
        metadata: { userId: userA },
      });
      const deleted = await memory.deleteForUser(userA);
      expect(deleted).toBe(1);
      expect(await memory.get(sessionScope("session_unattributed"), "k2")).not.toBeNull();
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: session scope is independent of user scope`, async () => {
    const memory = await make();
    try {
      const session = sessionScope("session_x");
      await memory.put(userScope(userA), "k", "fact", "user");
      await memory.put(session, "k", "fact", "session");
      expect((await memory.get(userScope(userA), "k", "fact"))?.value).toBe("user");
      expect((await memory.get(session, "k", "fact"))?.value).toBe("session");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: round-trips a complex object`, async () => {
    const memory = await make();
    try {
      const value = { name: "Ada", prefs: { color: "blue", n: 42 }, tags: ["a", "b"] };
      await memory.put(userScope(userA), "obj", "fact", value);
      expect((await memory.get(userScope(userA), "obj", "fact"))?.value).toEqual(value);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: round-trips a string with special characters`, async () => {
    const memory = await make();
    try {
      const value = 'quote: "x" newline:\n tab:\t unicode: 🤖';
      await memory.put(userScope(userA), "s", "fact", value);
      expect((await memory.get(userScope(userA), "s", "fact"))?.value).toBe(value);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: capabilities are declared and structured`, async () => {
    const memory = await make();
    try {
      const cap = memory.capabilities;
      expect(cap).toBeDefined();
      expect(cap.search).toBeDefined();
      expect(cap.write).toBeDefined();
      expect(cap.retention).toBeDefined();
      expect(cap.purge).toBeDefined();
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: enforces and releases a session byte quota`, async () => {
    const memory = await make();
    try {
      const ref = sessionScope("quota_session");
      await expect(memory.put(ref, "first", "raw", "x", { maxSessionBytes: 2 })).rejects.toThrow(
        /quota/i,
      );
      await memory.put(ref, "first", "raw", "x", { maxSessionBytes: 3 });
      await expect(memory.put(ref, "second", "raw", "y", { maxSessionBytes: 3 })).rejects.toThrow(
        /quota/i,
      );
      expect(await memory.delete(ref, "first", "raw")).toBe(true);
      await memory.put(ref, "second", "raw", "y", { maxSessionBytes: 3 });
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: maxEntryBytes cap throws MemoryEntryTooLargeError`, async () => {
    const memory = await make();
    try {
      if (memory.capabilities.maxEntryBytes === undefined) {
        // Skip — implementation does not enforce a size cap.
        return;
      }
      const big = "x".repeat(memory.capabilities.maxEntryBytes + 1);
      await expect(memory.put(userScope(userA), "huge", "fact", big)).rejects.toThrow(
        /exceeds cap/i,
      );
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: rejects non-JSON values without a size cap`, async () => {
    const memory = await make();
    try {
      class CustomValue {
        readonly value = 1;
      }
      const invalidValues: unknown[] = [
        undefined,
        () => undefined,
        Symbol("value"),
        1n,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        new Date(),
        new Map(),
        new Set(),
        new CustomValue(),
        { nested: undefined },
        [undefined],
      ];
      for (const [index, value] of invalidValues.entries()) {
        await expect(
          memory.put(userScope(userA), `invalid_${index}`, "raw", value),
        ).rejects.toThrow(/JSON-compatible/);
      }
      expect(await memory.list(userScope(userA))).toHaveLength(0);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: snapshots JSON values instead of retaining caller references`, async () => {
    const memory = await make();
    try {
      const value = { nested: { count: 1 } };
      await memory.put(userScope(userA), "snapshot", "raw", value);
      value.nested.count = 2;
      const firstRead = await memory.get<{ nested: { count: number } }>(
        userScope(userA),
        "snapshot",
        "raw",
      );
      expect(firstRead?.value).toEqual({ nested: { count: 1 } });

      if (firstRead) firstRead.value.nested.count = 3;
      const secondRead = await memory.get<{ nested: { count: number } }>(
        userScope(userA),
        "snapshot",
        "raw",
      );
      expect(secondRead?.value).toEqual({ nested: { count: 1 } });
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: validates before an ifNotExists short-circuit`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "existing", "fact", "v");
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      await expect(
        memory.put(userScope(userA), "existing", "fact", cyclic, { ifNotExists: true }),
      ).rejects.toThrow(/JSON-compatible/);
      expect((await memory.get(userScope(userA), "existing", "fact"))?.value).toBe("v");
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: idempotency — stable put then unstable put is a conflict`, async () => {
    const memory = await make();
    try {
      await memory.put(userScope(userA), "k", "fact", "v1");
      await memory.put(userScope(userA), "k", "fact", "v1");
      await expect(memory.put(userScope(userA), "k", "fact", "v2")).rejects.toThrow(/conflict/i);
    } finally {
      await teardown(memory);
    }
  });

  it(`${init.name}: all six MemoryKinds are independent`, async () => {
    const memory = await make();
    try {
      const kinds: MemoryKind[] = [
        "fact",
        "summary",
        "open_item",
        "entity_ref",
        "raw",
        "working_memory",
      ];
      for (const k of kinds) {
        await memory.put(userScope(userA), "k", k, `value-for-${k}`);
      }
      for (const k of kinds) {
        expect((await memory.get(userScope(userA), "k", k))?.value).toBe(`value-for-${k}`);
      }
    } finally {
      await teardown(memory);
    }
  });
}
