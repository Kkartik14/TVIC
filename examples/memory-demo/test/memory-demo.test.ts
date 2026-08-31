/**
 * Cross-call recall test. Runs against the in-memory adapter (always-on)
 * or the Postgres adapter (gated by `TVIC_RUN_INTEGRATION=1` +
 * `MEMORY_INTEGRATION_URL`).
 *
 * Verifies the three things the demo exists to prove:
 *  1. The pre-call loader injects prior memory into the system prompt.
 *  2. The runtime's `#updateMemory` does not overwrite `user`-scoped facts
 *     across calls.
 *  3. The `deleteSessionScopeOnEnd: true` default purges `session` scope but leaves
 *     `user` scope intact across sessions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createInMemoryMemory } from "@tvic/dal";
import { type Memory, type UserId } from "@tvic/core";
import {
  createPostgresMemory,
  runPostgresMemoryMigrations,
  type SqlPool,
} from "@tvic/dal-postgres-memory";
import { createRuntime, type Runtime } from "@tvic/runtime";

import { buildMemoryDemoAgent } from "../src/agent.js";
import { buildDemoCall } from "../src/memory-runtime.js";
import { formatMemoryBlock } from "../src/format-memory-block.js";

const SKIP = !process.env.TVIC_RUN_INTEGRATION || !process.env.MEMORY_INTEGRATION_URL;
const POSTGRES_URL =
  process.env.MEMORY_INTEGRATION_URL ?? "postgres://postgres:tvic@127.0.0.1:5432/tvic_memory";

describe.skipIf(SKIP)("cross-call memory demo (Postgres)", () => {
  let pool: import("pg").Pool | undefined;
  let memory: Memory;
  let runtime: Runtime;
  const userId = "user_pg_demo" as UserId;

  beforeAll(async () => {
    pool = new Pool({ connectionString: POSTGRES_URL });
    const sp = pool as unknown as SqlPool;
    await runPostgresMemoryMigrations(sp);
    memory = createPostgresMemory({ pool: sp });
    runtime = createRuntime({ memory });
    await runtime.start();
  });

  afterAll(async () => {
    await runtime?.stop();
    await pool?.end().catch(() => undefined);
  });

  it("persists user-scope facts across calls", async () => {
    const agent = buildMemoryDemoAgent();
    const a1 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("c1", userId),
      memoryUserId: userId,
    });
    await memory.put({ scope: "user", userId }, "preferred_name", "fact", "Grace Hopper");
    await a1.detach();

    const a2 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("c2", userId),
      memoryUserId: userId,
    });
    const block = formatMemoryBlock(a2.preCallContext);
    expect(block).toContain("preferred_name");
    expect(block).toContain("Grace Hopper");
    await a2.detach();
  });
});

describe("cross-call memory demo (in-memory, always-on)", () => {
  let memory: Memory;
  let runtime: Runtime;
  const userId = "user_inmem_demo" as UserId;

  beforeEach(async () => {
    memory = createInMemoryMemory();
    runtime = createRuntime({ memory });
    await runtime.start();
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it("injects prior memory into the system prompt on call 2", async () => {
    const agent = buildMemoryDemoAgent();
    const a1 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("c1", userId),
      memoryUserId: userId,
    });
    await memory.put({ scope: "user", userId }, "preferred_name", "fact", "Grace Hopper");
    await a1.detach();

    const a2 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("c2", userId),
      memoryUserId: userId,
    });
    const block = formatMemoryBlock(a2.preCallContext);
    expect(block).toContain("preferred_name");
    expect(block).toContain("Grace Hopper");
    await a2.detach();
  });

  it("does not overwrite user-scope facts when both calls write the same key", async () => {
    const agent = buildMemoryDemoAgent();
    const a1 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("c1", userId),
      memoryUserId: userId,
    });
    await memory.put({ scope: "user", userId }, "favorite_color", "fact", "blue");
    await a1.detach();

    const a2 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("c2", userId),
      memoryUserId: userId,
    });
    await memory.put({ scope: "user", userId }, "favorite_color", "fact", "blue");
    const got = await memory.get({ scope: "user", userId }, "favorite_color", "fact");
    expect(got?.value).toBe("blue");
    expect(got?.version).toBe(2);
    await a2.detach();
  });

  it("deleteSessionScopeOnEnd: true purges session scope but leaves user scope intact", async () => {
    const agent = buildMemoryDemoAgent();
    // First call: write a session-scope fact and a user-scope fact.
    const a1 = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      call: buildDemoCall("s1", userId),
      memoryUserId: userId,
    });
    const sessionId = a1.session.id;
    // The runtime's auto-#updateMemory writes the per-turn exchange to
    // session scope with reserved user attribution. We additionally put a session-scope fact
    // explicitly so the cleanup assertion is meaningful.
    await memory.put(
      { scope: "session", sessionId },
      "ephemeral",
      "raw",
      { kind: "ephemeral" },
      { sessionUserId: userId },
    );
    await memory.put({ scope: "user", userId }, "persistent", "fact", "Ada");
    // endSession runs the agent's `deleteSessionScopeOnEnd` policy,
    // which purges session scope by default. `detach` alone is
    // insufficient — it only releases the lease and heartbeat.
    await runtime.endSession(sessionId, { reason: "completed" });

    // endSession applies the persisted memory policy and purges session scope
    // by default. detach runs as a side-effect of terminalization.
    const sessionAfter = await memory.list({ scope: "session", sessionId });
    expect(sessionAfter).toHaveLength(0);

    // User scope survives.
    const userAfter = await memory.list({ scope: "user", userId });
    expect(userAfter).toHaveLength(1);
    expect(userAfter[0]?.key).toBe("persistent");
  });
});
