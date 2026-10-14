import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";

import type {
  Agent,
  AgentProviders,
  AgentId,
  DurableOutboxEvent,
  ProviderCapabilities,
  SessionId,
  SessionLease,
  SessionRecoveryCandidate,
  StoredToolCallRecord,
  StoredTurnRecord,
  StoredSessionRecord,
  Timestamp,
  ToolIdempotencyClaimResult,
  ToolCallId,
  TurnId,
  ToolId,
  ToolName,
} from "@tvic/core";
import {
  InvalidArgumentError,
  LeaseLostError,
  PCM16_16K_MONO,
  providerError,
  RecordConflictError,
  toolError,
} from "@tvic/core";
import {
  createPostgresDurableRuntimeStore,
  PostgresOutboxWorker,
  PostgresRetentionJob,
  runPostgresMigrations,
  type SqlResult,
  type SqlClient,
  type SqlPool,
} from "@tvic/dal-postgres";
import {
  createRedisDurableRuntimeStore,
  RedisOutboxCacheProjector,
  RedisToolCallStore,
  RedisTurnStore,
} from "@tvic/dal-redis";
import { createRuntime, defineAgent, defineTool } from "@tvic/runtime";
import { idempotencyKeyFor, idempotencyRequestHashFor } from "@tvic/tools";
import { FINALIZE_SESSION_CREATION_SCRIPT } from "../../dal-redis/src/redis-lease-scripts.js";
import { createPostgresRedisDurableRuntimeStore } from "../src/index.js";

const integrationEnabled =
  process.env.TVIC_RUN_INTEGRATION === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.REDIS_URL);

const redisIntegrationEnabled =
  process.env.TVIC_RUN_INTEGRATION === "1" && Boolean(process.env.REDIS_URL);
const postgresIntegrationEnabled =
  process.env.TVIC_RUN_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

const integrationRunId = randomUUID();
const integrationTestId = (value: string) => `${value}_${integrationRunId}`;
const integrationRedisPrefix = `tvic:test:composite-durability:${integrationRunId}:`;

async function updateIdempotencyWithLeaseContext(
  pool: Pool,
  lease: SessionLease,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('tvic.tool_idempotency_lease', $1, true)", [
      JSON.stringify({
        sessionId: lease.sessionId,
        fence: lease.fence,
        generationId: lease.generationId,
      }),
    ]);
    await client.query(sql, [...values]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!redisIntegrationEnabled)("real Redis projected child incarnations", () => {
  it("hides prior turn and tool-call records after a session ID is reused", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:projected-child-incarnation:${randomUUID()}:`;
    const redisClient = adaptRedis(redis);
    const projector = new RedisOutboxCacheProjector(redisClient, { prefix });
    const turns = new RedisTurnStore(redisClient, { prefix });
    const toolCalls = new RedisToolCallStore(redisClient, { prefix });
    const sessionId = `projected_reuse_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    const oldTurnId = `old_turn_${randomUUID()}` as TurnId;
    const oldToolCallId = `old_tool_${randomUUID()}` as ToolCallId;
    const newTurnId = `new_turn_${randomUUID()}` as TurnId;
    const newToolCallId = `new_tool_${randomUUID()}` as ToolCallId;
    const agentId = `projected_agent_${randomUUID()}` as AgentId;
    const turn = (id: TurnId, toolCallId: ToolCallId, sequence: number) => ({
      id,
      sessionId,
      sequence,
      status: "completed" as const,
      input: { transcript: `turn ${sequence}`, mediaEventIds: [] },
      output: { text: `reply ${sequence}`, mediaEventIds: [] },
      toolCallIds: [toolCallId],
      startedAt: timestamp,
      endedAt: timestamp,
      latency: {},
    });
    const toolCall = (id: ToolCallId, turnId: TurnId) => ({
      status: "running" as const,
      toolCallId: id,
      toolId: `projected_tool_${id}` as ToolId,
      toolName: "projected_tool" as ToolName,
      sessionId,
      turnId,
      input: {},
      attempts: 1,
      queuedAt: timestamp,
      startedAt: timestamp,
    });
    const projectSession = (incarnation: number, turnSequence: number) =>
      projector.apply({
        id: `session:${sessionId}:${incarnation}`,
        aggregateType: "session",
        aggregateId: sessionId,
        sessionId,
        version: 1,
        fence: 1,
        sessionIncarnation: incarnation,
        envelope: {
          kind: "session",
          schemaVersion: 1,
          payload: {
            id: sessionId,
            agentId,
            status: "active",
            channel: "simulated",
            memoryRefs: [],
            createdAt: timestamp,
            startedAt: timestamp,
            state: { variables: {}, pendingToolCallIds: [], turnSequence },
          },
          runtime: { monotonicStartedAtMs: turnSequence },
          version: 1,
        },
      });
    const projectTurn = (
      id: TurnId,
      toolCallId: ToolCallId,
      sequence: number,
      incarnation: number,
    ) =>
      projector.apply({
        id: `turn:${id}:${incarnation}`,
        aggregateType: "turn",
        aggregateId: id,
        sessionId,
        version: 1,
        fence: 1,
        sessionIncarnation: incarnation,
        envelope: {
          kind: "turn",
          schemaVersion: 1,
          payload: turn(id, toolCallId, sequence),
          runtime: { monotonicStartedAtMs: sequence },
          version: 1,
        },
      });
    const projectToolCall = (id: ToolCallId, turnId: TurnId, incarnation: number) =>
      projector.apply({
        id: `tool_call:${id}:${incarnation}`,
        aggregateType: "tool_call",
        aggregateId: id,
        sessionId,
        version: 1,
        fence: 1,
        sessionIncarnation: incarnation,
        envelope: {
          kind: "tool_call",
          schemaVersion: 1,
          payload: toolCall(id, turnId),
          runtime: { monotonicQueuedAtMs: 0 },
          version: 1,
        },
      });

    const encodedSessionId = encodeURIComponent(sessionId);
    const encodedOldTurnId = encodeURIComponent(oldTurnId);
    const encodedOldToolCallId = encodeURIComponent(oldToolCallId);
    const encodedNewTurnId = encodeURIComponent(newTurnId);
    const encodedNewToolCallId = encodeURIComponent(newToolCallId);
    try {
      await projectSession(0, 1);
      await projectTurn(oldTurnId, oldToolCallId, 1, 0);
      await projectToolCall(oldToolCallId, oldTurnId, 0);
      await redis.set(
        `${prefix}session:${encodedSessionId}:cache_meta`,
        JSON.stringify({ version: 1, fence: 1 }),
      );
      await redis.set(
        `${prefix}turn:${encodedSessionId}:${encodedOldTurnId}:cache_meta`,
        JSON.stringify({ version: 1, fence: 1 }),
      );
      await redis.set(
        `${prefix}tool_call:${encodedSessionId}:${encodedOldToolCallId}:cache_meta`,
        JSON.stringify({ version: 1, fence: 1 }),
      );
      await expect(turns.get(sessionId, oldTurnId)).resolves.toMatchObject({
        turn: { id: oldTurnId },
      });
      await expect(toolCalls.get(sessionId, oldToolCallId)).resolves.toMatchObject({
        toolCall: { toolCallId: oldToolCallId },
      });
      await expect(turns.listBySession(sessionId)).resolves.toHaveLength(1);
      await expect(toolCalls.listBySession(sessionId)).resolves.toHaveLength(1);

      await projectSession(1, 0);
      await expect(turns.get(sessionId, oldTurnId)).resolves.toBeNull();
      await expect(toolCalls.get(sessionId, oldToolCallId)).resolves.toBeNull();
      await expect(turns.listBySession(sessionId)).resolves.toEqual([]);
      await expect(toolCalls.listBySession(sessionId)).resolves.toEqual([]);

      await projectTurn(newTurnId, newToolCallId, 1, 1);
      await projectToolCall(newToolCallId, newTurnId, 1);
      await expect(turns.listBySession(sessionId)).resolves.toMatchObject([
        { turn: { id: newTurnId } },
      ]);
      await expect(toolCalls.listBySession(sessionId)).resolves.toMatchObject([
        { toolCall: { toolCallId: newToolCallId } },
      ]);
    } finally {
      await redis.del([
        `${prefix}session:${encodedSessionId}`,
        `${prefix}session:${encodedSessionId}:cache_meta`,
        `${prefix}sessions`,
        `${prefix}session:${encodedSessionId}:turns`,
        `${prefix}session:${encodedSessionId}:tools`,
        `${prefix}turn:${encodedSessionId}:${encodedOldTurnId}`,
        `${prefix}turn:${encodedSessionId}:${encodedOldTurnId}:cache_meta`,
        `${prefix}turn:${encodedSessionId}:${encodedNewTurnId}`,
        `${prefix}turn:${encodedSessionId}:${encodedNewTurnId}:cache_meta`,
        `${prefix}tool_call:${encodedSessionId}:${encodedOldToolCallId}`,
        `${prefix}tool_call:${encodedSessionId}:${encodedOldToolCallId}:cache_meta`,
        `${prefix}tool_call:${encodedSessionId}:${encodedNewToolCallId}`,
        `${prefix}tool_call:${encodedSessionId}:${encodedNewToolCallId}:cache_meta`,
      ]);
      await redis.quit();
    }
  });

  it("fails closed on malformed incarnation metadata and can reopen a rolled-back purge", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:cache-retention-recovery:${randomUUID()}:`;
    const sessionId = `cache_retention_${randomUUID()}` as SessionId;
    const encodedSessionId = encodeURIComponent(sessionId);
    const sessionKey = `${prefix}session:${encodedSessionId}`;
    const metadataKey = `${sessionKey}:cache_meta`;
    const timestamp = new Date().toISOString() as Timestamp;
    const projector = new RedisOutboxCacheProjector(adaptRedis(redis), { prefix });
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `cache_retention_agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
      version: 1,
    };
    const event: DurableOutboxEvent = {
      id: `session:${sessionId}:1:1`,
      aggregateType: "session",
      aggregateId: sessionId,
      sessionId,
      version: 1,
      fence: 1,
      sessionIncarnation: 1,
      envelope: {
        kind: "session",
        schemaVersion: 1,
        payload: record.session,
        runtime: record.runtime,
        version: 1,
      },
    };
    try {
      await projector.apply(event);
      await redis.set(
        metadataKey,
        JSON.stringify({ sessionIncarnation: "not-a-number", version: 1, fence: 1 }),
      );
      await expect(
        projector.apply({
          ...event,
          version: 2,
          fence: 2,
          envelope: { ...event.envelope, version: 2 },
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      await expect(
        projector.apply({ ...event, sessionIncarnation: null as unknown as number }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(
        projector.purgeSession({ sessionId, incarnation: 1, version: 1, fence: 1 }, "malformed"),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      await expect(
        projector.purgeSession(
          { sessionId, incarnation: null as unknown as number, version: 1, fence: 1 },
          "malformed-null",
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      await redis.set(metadataKey, JSON.stringify({ sessionIncarnation: 1, version: 1, fence: 1 }));
      const purgeToken = "rolled-back-purge";
      await projector.purgeSession({ sessionId, incarnation: 1, version: 1, fence: 1 }, purgeToken);
      expect(await redis.get(sessionKey)).toBeNull();
      expect(JSON.parse((await redis.get(metadataKey))!).retired).toBe(true);

      await projector.purgeSession(
        { sessionId, incarnation: 1, version: 1, fence: 1 },
        "newer-purge",
      );
      await projector.restoreSessionProjection(
        { sessionId, incarnation: 1, version: 1, fence: 1 },
        purgeToken,
        { session: record, turns: [], toolCalls: [] },
      );
      expect(JSON.parse((await redis.get(metadataKey))!).purgeToken).toBe("newer-purge");
      expect(JSON.parse((await redis.get(metadataKey))!).retired).toBe(true);
      await projector.restoreSessionProjection(
        { sessionId, incarnation: 1, version: 1, fence: 1 },
        "newer-purge",
        { session: record, turns: [], toolCalls: [] },
      );
      expect(JSON.parse((await redis.get(metadataKey))!).retired).toBe(false);
      expect(JSON.parse((await redis.get(sessionKey))!).payload).toEqual(record.session);
      await projector.apply({
        ...event,
        version: 2,
        fence: 2,
        envelope: { ...event.envelope, version: 2 },
      });
      expect((await redis.get(sessionKey)) ?? "").not.toBe("");
    } finally {
      await redis.del([sessionKey, metadataKey, `${prefix}sessions`]);
      await redis.quit();
    }
  });

  it("purges a large child index across bounded Redis scan batches", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:cache-retention-batches:${randomUUID()}:`;
    const sessionId = `cache_batch_${randomUUID()}` as SessionId;
    const encodedSessionId = encodeURIComponent(sessionId);
    const turnIndex = `${prefix}session:${encodedSessionId}:turns`;
    const count = 300;
    const turnKeys = Array.from(
      { length: count },
      (_, index) => `${prefix}turn:${encodedSessionId}:${index}`,
    );
    const batch = redis.multi();
    for (let index = 0; index < count; index += 1) {
      const key = turnKeys[index]!;
      batch.set(
        `${key}:cache_meta`,
        JSON.stringify({ sessionIncarnation: 2, version: 1, fence: 1 }),
      );
      batch.set(key, "cached");
      batch.zAdd(turnIndex, { score: index, value: key });
    }
    const projector = new RedisOutboxCacheProjector(adaptRedis(redis), { prefix });
    try {
      await batch.exec();
      await expect(redis.zCard(turnIndex)).resolves.toBe(count);
      await projector.purgeSession(
        { sessionId, incarnation: 2, version: 1, fence: 1 },
        "batch-purge",
      );
      await expect(redis.zCard(turnIndex)).resolves.toBe(0);
      await expect(redis.mGet(turnKeys)).resolves.toEqual(
        Array.from({ length: count }, () => null),
      );
    } finally {
      await redis.del([
        turnIndex,
        ...turnKeys,
        ...turnKeys.map((key) => `${key}:cache_meta`),
        `${prefix}session:${encodedSessionId}`,
        `${prefix}session:${encodedSessionId}:cache_meta`,
      ]);
      await redis.quit();
    }
  });
});

describe.skipIf(!redisIntegrationEnabled)("real Redis concurrent record updates", () => {
  it("does not lose concurrent session updates on the shared client", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:concurrent-record-update:${randomUUID()}:`;
    const sessionId = `concurrent_update_${randomUUID()}` as SessionId;
    const recordKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const indexKey = `${prefix}sessions`;
    const timestamp = new Date().toISOString() as Timestamp;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    try {
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `concurrent_update_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: { counter: 0 }, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
      });

      for (let round = 0; round < 20; round += 1) {
        await Promise.all(
          Array.from({ length: 2 }, () =>
            store.sessions.update(sessionId, (current) => ({
              ...current,
              session: {
                ...current.session,
                state: {
                  ...current.session.state,
                  variables: {
                    ...current.session.state.variables,
                    counter: Number(current.session.state.variables.counter) + 1,
                  },
                },
              },
            })),
          ),
        );
      }

      await expect(store.sessions.get(sessionId)).resolves.toMatchObject({
        session: { state: { variables: { counter: 40 } } },
      });
    } finally {
      await redis.del([recordKey, indexKey]);
      await redis.quit();
    }
  });
});

describe.skipIf(!redisIntegrationEnabled)("real Redis lease numeric validation", () => {
  it("rejects expiry overflow without creating a lease or index entry", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-expiry-range:${randomUUID()}:`;
    const sessionId = `expiry_range_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const leaseKey = `${prefix}lease:${encodeURIComponent(sessionId)}`;
    try {
      await expect(
        store.leases.acquire(sessionId, "expiry_range_holder", Number.MAX_SAFE_INTEGER),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(leaseKey)).toBeNull();
      expect(await redis.zCard(`${prefix}leases`)).toBe(0);
      expect(await redis.zCard(`${prefix}lease_recovery_candidates`)).toBe(0);
    } finally {
      await redis.del([leaseKey, `${prefix}leases`, `${prefix}lease_recovery_candidates`]);
      await redis.quit();
    }
  });

  it("rejects unsafe and exhausted fences before lease-index repair or takeover", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-fence-range:${randomUUID()}:`;
    const activeId = `active_${randomUUID()}` as SessionId;
    const expiredId = `expired_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const activeKey = `${prefix}lease:${encodeURIComponent(activeId)}`;
    const expiredKey = `${prefix}lease:${encodeURIComponent(expiredId)}`;
    const now = Date.now();
    const unsafeActive = JSON.stringify({
      sessionId: activeId,
      holder: "same_holder",
      fence: Number.MAX_SAFE_INTEGER + 1,
      generationId: "unsafe-generation",
      acquiredAtMs: now - 1,
      renewedAtMs: now - 1,
      expiresAtMs: now + 60_000,
    });
    const exhaustedExpired = JSON.stringify({
      sessionId: expiredId,
      holder: "old_holder",
      fence: Number.MAX_SAFE_INTEGER,
      generationId: "exhausted-generation",
      acquiredAtMs: now - 60_002,
      renewedAtMs: now - 60_002,
      expiresAtMs: now - 60_000,
    });
    try {
      await redis.set(activeKey, unsafeActive);
      await expect(store.leases.acquire(activeId, "same_holder", 1_000)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      expect(await redis.get(activeKey)).toBe(unsafeActive);

      await redis.set(expiredKey, exhaustedExpired);
      await expect(store.leases.acquire(expiredId, "next_holder", 1_000)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      expect(await redis.get(expiredKey)).toBe(exhaustedExpired);
      expect(await redis.zCard(`${prefix}leases`)).toBe(0);
      expect(await redis.zCard(`${prefix}lease_recovery_candidates`)).toBe(0);
    } finally {
      await redis.del([
        activeKey,
        expiredKey,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("rejects lease records whose session identity does not match the Redis key", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-identity:${randomUUID()}:`;
    const requestedId = `requested_${randomUUID()}` as SessionId;
    const storedId = `stored_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const sessionKey = `${prefix}session:${encodeURIComponent(requestedId)}`;
    const key = `${prefix}lease:${encodeURIComponent(requestedId)}`;
    const sessionRecord = {
      session: {
        id: requestedId,
        agentId: `lease_identity_agent_${randomUUID()}` as AgentId,
        status: "active" as const,
        channel: "simulated" as const,
        memoryRefs: [],
        createdAt: new Date().toISOString() as Timestamp,
        startedAt: new Date().toISOString() as Timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    };
    const lease = {
      sessionId: storedId,
      holder: "identity_holder",
      fence: 1,
      generationId: "identity_generation",
      acquiredAtMs: Date.now() - 1,
      renewedAtMs: Date.now() - 1,
      expiresAtMs: Date.now() + 60_000,
    };
    try {
      await store.sessions.put(sessionRecord);
      const existingSession = await redis.get(sessionKey);
      const existingSessionIndex = await redis.zRange(`${prefix}sessions`, 0, -1);
      await redis.set(key, JSON.stringify(lease));
      await expect(store.leases.get(requestedId)).rejects.toMatchObject({
        code: "CORRUPT_RECORD",
      });
      await expect(
        store.runSessionTransaction(
          requestedId,
          { holder: lease.holder, fence: lease.fence, generationId: lease.generationId },
          async (tx) =>
            tx.updateSession(requestedId, (current) => ({
              ...current,
              session: {
                ...current.session,
                state: { ...current.session.state, turnSequence: 1 },
              },
            })),
        ),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect((await store.sessions.get(requestedId))?.session.state.turnSequence).toBe(0);
      await expect(
        store.leases.renew(requestedId, lease.holder, lease.fence, 10_000, lease.generationId),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(key)).toBe(JSON.stringify(lease));
      expect(await redis.zCard(`${prefix}leases`)).toBe(0);

      await expect(
        store.leases.release(requestedId, lease.holder, lease.fence, lease.generationId),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(key)).toBe(JSON.stringify(lease));
      expect(await redis.zCard(`${prefix}leases`)).toBe(0);

      const finalizeResult = await redis.eval(FINALIZE_SESSION_CREATION_SCRIPT, {
        keys: [`${prefix}session:${encodeURIComponent(requestedId)}`, `${prefix}sessions`, key],
        arguments: [
          JSON.stringify({ session: { id: requestedId } }),
          lease.holder,
          String(requestedId),
          String(lease.fence),
          "",
          "",
          String(Date.now()),
          encodeURIComponent(String(requestedId)),
          lease.generationId,
        ],
      });
      expect(Number(finalizeResult)).toBe(0);
      expect(await redis.get(sessionKey)).toBe(existingSession);
      expect(await redis.zRange(`${prefix}sessions`, 0, -1)).toEqual(existingSessionIndex);
      expect(await redis.get(key)).toBe(JSON.stringify(lease));
    } finally {
      await redis.del([key, sessionKey, `${prefix}leases`, `${prefix}sessions`]);
      await redis.quit();
    }
  });

  it("rejects fenced idempotency operations when a lease row has the wrong session identity", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-lease-identity:${randomUUID()}:`;
    const requestedId = `requested_${randomUUID()}` as SessionId;
    const storedId = `stored_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const holder = `identity_holder_${randomUUID()}`;
    const generationId = `identity_generation_${randomUUID()}`;
    const lease = {
      sessionId: requestedId,
      holder,
      fence: 1,
      generationId,
      acquiredAtMs: Date.now() - 1,
      renewedAtMs: Date.now() - 1,
      expiresAtMs: Date.now() + 60_000,
    };
    const leaseRedisKey = `${prefix}lease:${encodeURIComponent(requestedId)}`;
    const claimLogicalKey = `claim_${randomUUID()}`;
    const completeLogicalKey = `complete_${randomUUID()}`;
    const quarantineLogicalKey = `quarantine_${randomUUID()}`;
    const claimRedisKey = `${prefix}idempotency:${encodeURIComponent(claimLogicalKey)}`;
    const completeRedisKey = `${prefix}idempotency:${encodeURIComponent(completeLogicalKey)}`;
    const quarantineRedisKey = `${prefix}idempotency:${encodeURIComponent(quarantineLogicalKey)}`;
    const requestHash = `request_${randomUUID()}`;
    const owner = `owner_${randomUUID()}`;
    const ttlMs = 60_000;
    const completeRecord = {
      key: completeLogicalKey,
      sessionId: requestedId,
      requestHash,
      status: "claimed",
      owner,
      claimedFence: lease.fence,
      claimedGenerationId: lease.generationId,
      expiresAtMs: Date.now() + ttlMs,
    };
    try {
      await redis.set(leaseRedisKey, JSON.stringify({ ...lease, sessionId: storedId }));

      await expect(
        store.toolIdempotencyStore.claim({
          key: claimLogicalKey,
          sessionId: requestedId,
          lease,
          requestHash,
          owner,
          ttlMs,
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(await redis.get(claimRedisKey)).toBeNull();

      await redis.set(completeRedisKey, JSON.stringify(completeRecord), { PX: ttlMs });
      await expect(
        store.toolIdempotencyStore.complete(completeLogicalKey, requestHash, {
          sessionId: requestedId,
          lease,
          owner,
          status: "succeeded",
          ttlMs,
          output: { value: "must-not-commit" },
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(JSON.parse((await redis.get(completeRedisKey)) ?? "null")).toEqual(completeRecord);

      await expect(
        store.toolIdempotencyStore.quarantine({
          key: quarantineLogicalKey,
          sessionId: requestedId,
          lease,
          toolId: "identity_tool" as ToolId,
          toolVersion: "1",
          requestHash,
          owner,
          ttlMs,
          error: providerError("vendor.identity_failure", "Lease identity mismatch"),
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(await redis.get(quarantineRedisKey)).toBeNull();
    } finally {
      await redis.del([leaseRedisKey, claimRedisKey, completeRedisKey, quarantineRedisKey]);
      await redis.quit();
    }
  });

  it("allows an identical retry after persisting a custom provider error", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:custom-error-retry:${randomUUID()}:`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const key = `custom_error_${randomUUID()}`;
    const requestHash = "custom-provider-error";
    const outcome = {
      owner: "custom_error_owner",
      status: "failed" as const,
      ttlMs: 60_000,
      error: providerError("vendor.operation_failed", "Provider failed", {
        retriable: true,
        metadata: {
          api_key: "secret-value",
          details: `upstream returned Bearer redis-error-token-${key}; Incorrect API key provided: redis-openai-key-${key}`,
        },
        cause: `Authorization: Bearer redis-message-token-${key}`,
      }),
    };
    const redisKey = `${prefix}idempotency:${encodeURIComponent(key)}`;
    try {
      await expect(
        store.toolIdempotencyStore.claim({ key, requestHash, owner: outcome.owner, ttlMs: 60_000 }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.toolIdempotencyStore.complete(key, requestHash, outcome);
      await expect(store.toolIdempotencyStore.complete(key, requestHash, outcome)).resolves.toBe(
        undefined,
      );
      const persisted = JSON.parse((await redis.get(redisKey)) ?? "null") as {
        errorJson: string;
        error?: unknown;
      };
      expect(persisted.error).toBeUndefined();
      const persistedError = JSON.parse(persisted.errorJson) as {
        retriable: boolean;
        metadata?: Record<string, unknown>;
      };
      expect(persistedError.retriable).toBe(true);
      expect(JSON.stringify(persistedError)).not.toContain("secret-value");
      expect(JSON.stringify(persistedError)).not.toContain(`redis-error-token-${key}`);
      expect(JSON.stringify(persistedError)).not.toContain(`redis-openai-key-${key}`);
      expect(JSON.stringify(persistedError)).not.toContain(`redis-message-token-${key}`);
      await expect(store.toolIdempotencyStore.lookup(key, requestHash)).resolves.toMatchObject({
        status: "found",
        record: { error: { retriable: false } },
      });
    } finally {
      await redis.del([redisKey]);
      await redis.quit();
    }
  });
});

describe.skipIf(!redisIntegrationEnabled)("real Redis legacy transaction compatibility", () => {
  it("updates a schema-v1 session using the exact stored value for its compare-and-set", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:legacy-session-cas:${randomUUID()}:`;
    const sessionId = `legacy_cas_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const sessionKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: new Date().toISOString() as Timestamp,
        startedAt: new Date().toISOString() as Timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
      version: 1,
    };
    try {
      await store.sessions.put(record);
      const stored = JSON.parse((await redis.get(sessionKey))!) as Record<string, unknown>;
      stored.schemaVersion = 1;
      await redis.set(sessionKey, JSON.stringify(stored));
      const lease = await store.leases.acquire(sessionId, "legacy_cas_owner", 60_000);

      await store.runSessionTransaction(sessionId, lease!, async (tx) => {
        await tx.updateSession(sessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            state: { ...current.session.state, turnSequence: 1 },
          },
        }));
      });

      const rewritten = JSON.parse((await redis.get(sessionKey))!) as {
        schemaVersion: number;
        version: number;
        payload: { state: { turnSequence: number } };
      };
      expect(rewritten.schemaVersion).toBe(2);
      expect(rewritten.version).toBe(2);
      expect(rewritten.payload.state.turnSequence).toBe(1);
    } finally {
      await redis.del([
        sessionKey,
        `${sessionKey}:cache_meta`,
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}sessions`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("rejects oversized transactions before committing any Redis records", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:transaction-write-bound:${randomUUID()}:`;
    const sessionId = `large_transaction_${randomUUID()}` as SessionId;
    const toolCalls = Array.from({ length: 1_001 }, (_, index) => ({
      toolCallId: `large_write_${index}` as ToolCallId,
      toolId: `large_write_tool_${index}` as ToolId,
      toolName: `large_write_tool_${index}` as ToolName,
    }));
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const timestamp = new Date().toISOString() as Timestamp;
    const sessionKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const toolCallKeys = toolCalls.map(
      (toolCall) =>
        `${prefix}tool_call:${encodeURIComponent(sessionId)}:${encodeURIComponent(toolCall.toolCallId)}`,
    );
    try {
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `large_transaction_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const lease = await store.leases.acquire(sessionId, "large_transaction_owner", 60_000);
      expect(lease).not.toBeNull();

      await expect(
        store.runSessionTransaction(sessionId, lease!, async (tx) => {
          for (const [index, toolCall] of toolCalls.entries()) {
            await tx.putToolCall({
              toolCall: {
                status: "running",
                ...toolCall,
                sessionId,
                turnId: `large_write_turn_${index}` as TurnId,
                input: {},
                attempts: 1,
                queuedAt: timestamp,
                startedAt: timestamp,
              },
              runtime: { monotonicQueuedAtMs: index },
              version: 1,
            });
          }
        }),
      ).rejects.toThrow("TVIC_TRANSACTION_TOO_LARGE");

      await expect(store.toolCalls.listBySession(sessionId)).resolves.toEqual([]);
      expect(await redis.zCard(`${prefix}session:${encodeURIComponent(sessionId)}:tools`)).toBe(0);
    } finally {
      const leaseKey = `${prefix}lease:${encodeURIComponent(sessionId)}`;
      const indexKeys = [
        `${prefix}sessions`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
        `${prefix}session:${encodeURIComponent(sessionId)}:tools`,
      ];
      await redis.del([sessionKey, leaseKey, ...indexKeys, ...toolCallKeys]);
      await redis.quit();
    }
  });
});

describe.skipIf(!redisIntegrationEnabled)("real Redis lease recovery paging", () => {
  it("atomically quarantines only an expired owner and preserves live or terminal claims", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-quarantine:${randomUUID()}:`;
    const sessionId = `quarantine_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const toolId = `quarantine_tool_${randomUUID()}` as ToolId;
    const toolVersion = "1.0.0";
    const ttlMs = 10_000;
    const error = toolError("tool.runtime_restarted", "The interrupted call will not be replayed");
    try {
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const firstLease = await store.leases.acquire(sessionId, "quarantine_owner_one", ttlMs);
      expect(firstLease).not.toBeNull();
      const key = `quarantine_claim_${randomUUID()}`;
      const requestHash = `hash_${randomUUID()}`;
      const owner = `tool_call_${randomUUID()}`;
      const claimInput = {
        key,
        sessionId,
        toolId,
        toolVersion,
        requestHash,
        owner,
        ttlMs,
        lease: firstLease!,
      };
      await store.toolIdempotencyStore.claim(claimInput);
      await expect(
        store.toolIdempotencyStore.quarantine({ ...claimInput, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { status: "claimed", owner } });

      await store.leases.release(
        sessionId,
        firstLease!.holder,
        firstLease!.fence,
        firstLease!.generationId,
      );
      const secondLease = await store.leases.acquire(sessionId, "quarantine_owner_two", ttlMs);
      expect(secondLease?.fence).toBe(firstLease!.fence + 1);
      const recoveryInput = { ...claimInput, lease: secondLease! };
      await expect(
        store.toolIdempotencyStore.quarantine({ ...recoveryInput, error }),
      ).resolves.toMatchObject({ status: "quarantined", record: { status: "failed", owner } });
      await expect(
        store.toolIdempotencyStore.lookup(key, requestHash, sessionId, recoveryInput.lease),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "failed", error: { code: "tool.runtime_restarted" } },
      });

      const sameFenceClaimKey = `quarantine_same_fence_claim_${randomUUID()}`;
      await redis.set(
        `${prefix}idempotency:${encodeURIComponent(sameFenceClaimKey)}`,
        JSON.stringify({
          key: sameFenceClaimKey,
          sessionId,
          toolId,
          toolVersion,
          requestHash,
          status: "claimed",
          owner,
          claimedFence: secondLease!.fence,
          claimedGenerationId: "retired-generation-with-reused-fence",
          expiresAtMs: Date.now() + ttlMs,
        }),
        { PX: ttlMs },
      );
      await expect(
        store.toolIdempotencyStore.claim({
          ...recoveryInput,
          key: sameFenceClaimKey,
          owner: `recovered_${owner}`,
        }),
      ).resolves.toMatchObject({
        status: "claimed",
        record: {
          claimedFence: secondLease!.fence,
          claimedGenerationId: secondLease!.generationId,
        },
      });

      const sameFenceQuarantineKey = `quarantine_same_fence_${randomUUID()}`;
      await redis.set(
        `${prefix}idempotency:${encodeURIComponent(sameFenceQuarantineKey)}`,
        JSON.stringify({
          key: sameFenceQuarantineKey,
          sessionId,
          toolId,
          toolVersion,
          requestHash,
          status: "claimed",
          owner,
          claimedFence: secondLease!.fence,
          claimedGenerationId: "retired-generation-with-reused-fence",
          expiresAtMs: Date.now() + ttlMs,
        }),
        { PX: ttlMs },
      );
      await expect(
        store.toolIdempotencyStore.quarantine({
          ...recoveryInput,
          key: sameFenceQuarantineKey,
          error,
        }),
      ).resolves.toMatchObject({
        status: "quarantined",
        record: {
          status: "failed",
          claimedFence: secondLease!.fence,
          claimedGenerationId: secondLease!.generationId,
        },
      });

      const activeKey = `quarantine_active_${randomUUID()}`;
      const activeOwner = `tool_call_${randomUUID()}`;
      const activeClaim = { ...recoveryInput, key: activeKey, owner: activeOwner };
      await store.toolIdempotencyStore.claim(activeClaim);
      await expect(
        store.toolIdempotencyStore.quarantine({ ...activeClaim, owner, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { owner: activeOwner } });
      await expect(
        store.toolIdempotencyStore.lookup(activeKey, requestHash, sessionId, activeClaim.lease),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "claimed", owner: activeOwner },
      });

      const succeededKey = `quarantine_succeeded_${randomUUID()}`;
      const succeededOwner = `tool_call_${randomUUID()}`;
      const succeededClaim = { ...recoveryInput, key: succeededKey, owner: succeededOwner };
      await store.toolIdempotencyStore.claim(succeededClaim);
      await store.toolIdempotencyStore.complete(succeededKey, requestHash, {
        status: "succeeded",
        owner: succeededOwner,
        ttlMs,
        lease: secondLease!,
        output: { reservation: "held" },
      });
      await expect(
        store.toolIdempotencyStore.quarantine({ ...succeededClaim, error }),
      ).resolves.toMatchObject({
        status: "succeeded",
        record: { output: { reservation: "held" } },
      });

      const legacyKey = `quarantine_legacy_${randomUUID()}`;
      await redis.set(
        `${prefix}idempotency:${encodeURIComponent(legacyKey)}`,
        JSON.stringify({
          key: legacyKey,
          sessionId,
          toolId,
          toolVersion,
          requestHash,
          status: "claimed",
          owner,
          claimedFence: secondLease!.fence,
          expiresAtMs: Date.now() + ttlMs,
        }),
        { PX: ttlMs },
      );
      await expect(
        store.toolIdempotencyStore.quarantine({ ...recoveryInput, key: legacyKey, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { status: "claimed", owner } });
      await store.leases.release(
        sessionId,
        secondLease!.holder,
        secondLease!.fence,
        secondLease!.generationId,
      );
      const thirdLease = await store.leases.acquire(sessionId, "quarantine_owner_three", ttlMs);
      expect(thirdLease?.fence).toBe(secondLease!.fence + 1);
      await expect(
        store.toolIdempotencyStore.quarantine({
          ...recoveryInput,
          lease: thirdLease!,
          key: legacyKey,
          error,
        }),
      ).resolves.toMatchObject({ status: "quarantined", record: { status: "failed", owner } });
    } finally {
      const keys: string[] = [];
      for await (const key of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
        keys.push(key);
      }
      if (keys.length > 0) await redis.del(keys);
      await redis.quit();
    }
  }, 15_000);

  it("acknowledges only the expired lease generation returned by a page", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery-ack:${randomUUID()}:`;
    const sessionId = `ack_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    try {
      const firstLease = await store.leases.acquire(sessionId, "first_holder", 60_000);
      expect(firstLease).not.toBeNull();
      await store.leases.release(
        sessionId,
        "first_holder",
        firstLease!.fence,
        firstLease!.generationId,
      );
      const firstPage = await store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 });
      expect(firstPage.candidates).toMatchObject([{ sessionId, fence: firstLease!.fence }]);
      expect(firstPage.candidates[0]?.generationId).toBe(firstLease!.generationId);

      await store.leases.acknowledgeRecoveryCandidate(firstPage.candidates[0]!);
      await store.leases.release(
        sessionId,
        "first_holder",
        firstLease!.fence,
        firstLease!.generationId,
      );
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toEqual({ candidates: [] });

      const secondLease = await store.leases.acquire(sessionId, "second_holder", 60_000);
      expect(secondLease?.fence).toBe(firstLease!.fence + 1);
      await store.leases.release(
        sessionId,
        "second_holder",
        secondLease!.fence,
        secondLease!.generationId,
      );
      const secondPage = await store.leases.listRecoveryCandidates({
        nowMs: Date.now(),
        limit: 10,
      });
      expect(secondPage.candidates).toMatchObject([{ sessionId, fence: secondLease!.fence }]);
      expect(secondPage.candidates[0]?.generationId).toBe(secondLease!.generationId);

      await store.leases.acknowledgeRecoveryCandidate(firstPage.candidates[0]!);
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({ candidates: [{ sessionId, fence: secondLease!.fence }] });

      await store.leases.acknowledgeRecoveryCandidate(secondPage.candidates[0]!);
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toEqual({ candidates: [] });
    } finally {
      await redis.del([
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("distinguishes a replacement lease when the session key and fence are reused", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-generation:${randomUUID()}:`;
    const sessionId = `generation_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: new Date().toISOString() as Timestamp,
        startedAt: new Date().toISOString() as Timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    };
    try {
      await store.sessions.put(record);
      const firstLease = await store.leases.acquire(sessionId, "same_holder", 60_000);
      await store.leases.release(
        sessionId,
        "same_holder",
        firstLease!.fence,
        firstLease!.generationId,
      );
      const firstPage = await store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 });
      const staleCandidate = firstPage.candidates[0]!;

      await redis.del(`${prefix}lease:${encodeURIComponent(sessionId)}`);
      const replacement = await store.leases.acquire(sessionId, "same_holder", 60_000);
      expect(replacement?.fence).toBe(firstLease!.fence);
      expect(replacement?.generationId).not.toBe(firstLease!.generationId);
      await expect(
        store.runSessionTransaction(sessionId, firstLease!, async () => undefined),
      ).rejects.toBeInstanceOf(LeaseLostError);

      await store.leases.release(
        sessionId,
        "same_holder",
        replacement!.fence,
        replacement!.generationId,
      );
      const replacementPage = await store.leases.listRecoveryCandidates({
        nowMs: Date.now(),
        limit: 10,
      });
      expect(replacementPage.candidates[0]?.generationId).toBe(replacement!.generationId);
      await store.leases.acknowledgeRecoveryCandidate(staleCandidate);
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({
        candidates: [
          { sessionId, fence: replacement!.fence, generationId: replacement!.generationId },
        ],
      });
    } finally {
      await redis.del([
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
        `${prefix}session:${encodeURIComponent(sessionId)}`,
        `${prefix}sessions`,
      ]);
      await redis.quit();
    }
  });

  it("pages active and expired leases, including legacy expiry-index entries", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery:${randomUUID()}:`;
    const sessionIds = ["a_active", "b_released", "c%_released"] as const;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    try {
      const leases = [];
      for (const [index, sessionId] of sessionIds.entries()) {
        leases.push(await store.leases.acquire(sessionId as SessionId, `holder_${index}`, 60_000));
      }
      await store.leases.release(
        sessionIds[2] as SessionId,
        "holder_2",
        leases[2]!.fence,
        leases[2]!.generationId,
      );

      const first = await store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 1 });
      expect(first.candidates).toMatchObject([{ sessionId: sessionIds[2], fence: 1 }]);

      await store.leases.release(
        sessionIds[1] as SessionId,
        "holder_1",
        leases[1]!.fence,
        leases[1]!.generationId,
      );
      const second = await store.leases.listRecoveryCandidates({
        nowMs: Date.now(),
        limit: 1,
      });
      expect(second.candidates).toMatchObject([{ sessionId: sessionIds[1], fence: 1 }]);
      expect(second.nextCursor).toBeDefined();

      const third = await store.leases.listRecoveryCandidates({
        nowMs: Date.now(),
        limit: 1,
        cursor: second.nextCursor!,
      });
      expect(third.candidates).toMatchObject([{ sessionId: sessionIds[2], fence: 1 }]);

      const legacyPrefix = `${prefix}legacy:`;
      const legacySessionId = "legacy_only";
      await redis.set(
        `${legacyPrefix}lease:${encodeURIComponent(legacySessionId)}`,
        JSON.stringify({
          sessionId: legacySessionId,
          holder: "legacy_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 1,
        }),
      );
      await redis.zAdd(`${legacyPrefix}leases`, {
        score: 1,
        value: encodeURIComponent(legacySessionId),
      });
      const legacyStore = createRedisDurableRuntimeStore(adaptRedis(redis), {
        prefix: legacyPrefix,
      });
      await expect(
        legacyStore.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({ candidates: [{ sessionId: legacySessionId, fence: 1 }] });
    } finally {
      await redis.del([
        ...sessionIds.map((id) => `${prefix}lease:${encodeURIComponent(id)}`),
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
        `${prefix}legacy:lease:${encodeURIComponent("legacy_only")}`,
        `${prefix}legacy:leases`,
        `${prefix}legacy:lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("skips malformed lease values and wrong-type lease keys without aborting a recovery page", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery-corrupt:${randomUUID()}:`;
    const emptySessionId = "";
    const validSessionId = "valid_expired";
    const malformedSessionId = "malformed_expired";
    const fractionalFenceSessionId = "fractional_fence_expired";
    const unsafeFenceSessionId = "unsafe_fence_expired";
    const nanExpirySessionId = "nan_expiry";
    const unsafeExpirySessionId = "unsafe_expiry";
    const fractionalTimestampSessionId = "fractional_timestamp";
    const wrongTypeSessionId = "wrong_type_expired";
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    try {
      await redis.set(
        `${prefix}lease:${encodeURIComponent(emptySessionId)}`,
        JSON.stringify({
          sessionId: emptySessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 1,
        }),
      );
      await redis.set(
        `${prefix}lease:${encodeURIComponent(validSessionId)}`,
        JSON.stringify({
          sessionId: validSessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 1,
        }),
      );
      await redis.set(`${prefix}lease:${encodeURIComponent(malformedSessionId)}`, "1");
      for (const [sessionId, fence] of [
        [fractionalFenceSessionId, 1.5],
        [unsafeFenceSessionId, 9_007_199_254_740_992],
      ] as const) {
        await redis.set(
          `${prefix}lease:${encodeURIComponent(sessionId)}`,
          JSON.stringify({
            sessionId,
            holder: "expired_holder",
            fence,
            acquiredAtMs: 0,
            renewedAtMs: 0,
            expiresAtMs: 1,
          }),
        );
      }
      for (const lease of [
        {
          sessionId: nanExpirySessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: "NaN",
        },
        {
          sessionId: unsafeExpirySessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 1e100,
        },
        {
          sessionId: fractionalTimestampSessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0.5,
          renewedAtMs: 0,
          expiresAtMs: 1,
        },
      ]) {
        await redis.set(
          `${prefix}lease:${encodeURIComponent(lease.sessionId)}`,
          JSON.stringify(lease),
        );
      }
      await redis.hSet(
        `${prefix}lease:${encodeURIComponent(wrongTypeSessionId)}`,
        "unexpected",
        "value",
      );
      await redis.zAdd(`${prefix}leases`, [
        { score: 1, value: encodeURIComponent(emptySessionId) },
        { score: 1, value: encodeURIComponent(validSessionId) },
        { score: 1, value: encodeURIComponent(malformedSessionId) },
        { score: 1, value: encodeURIComponent(fractionalFenceSessionId) },
        { score: 1, value: encodeURIComponent(unsafeFenceSessionId) },
        { score: 1, value: encodeURIComponent(nanExpirySessionId) },
        { score: 1, value: encodeURIComponent(unsafeExpirySessionId) },
        { score: 1, value: encodeURIComponent(fractionalTimestampSessionId) },
        { score: 1, value: encodeURIComponent(wrongTypeSessionId) },
      ]);

      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({
        candidates: [{ sessionId: validSessionId, fence: 1 }],
        corruptLeaseSessionIds: expect.arrayContaining([
          emptySessionId,
          malformedSessionId,
          fractionalFenceSessionId,
          unsafeFenceSessionId,
          nanExpirySessionId,
          unsafeExpirySessionId,
          fractionalTimestampSessionId,
          wrongTypeSessionId,
        ]),
      });
      for (const sessionId of [
        fractionalFenceSessionId,
        unsafeFenceSessionId,
        nanExpirySessionId,
        unsafeExpirySessionId,
        fractionalTimestampSessionId,
      ]) {
        await expect(
          redis.zScore(`${prefix}leases`, encodeURIComponent(sessionId)),
        ).resolves.toBeNull();
      }
      await expect(store.leases.get(unsafeFenceSessionId as SessionId)).rejects.toThrow(
        /invalid lease payload/,
      );
      await expect(store.leases.get(emptySessionId as SessionId)).rejects.toThrow(
        /invalid lease payload/,
      );

      await redis.del(`${prefix}lease:${encodeURIComponent(validSessionId)}`);
      await redis.hSet(
        `${prefix}lease:${encodeURIComponent(validSessionId)}`,
        "unexpected",
        "value",
      );
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({
        candidates: [],
        corruptLeaseSessionIds: [validSessionId],
      });
    } finally {
      await redis.del([
        `${prefix}lease:${encodeURIComponent(emptySessionId)}`,
        `${prefix}lease:${encodeURIComponent(validSessionId)}`,
        `${prefix}lease:${encodeURIComponent(malformedSessionId)}`,
        `${prefix}lease:${encodeURIComponent(fractionalFenceSessionId)}`,
        `${prefix}lease:${encodeURIComponent(unsafeFenceSessionId)}`,
        `${prefix}lease:${encodeURIComponent(nanExpirySessionId)}`,
        `${prefix}lease:${encodeURIComponent(unsafeExpirySessionId)}`,
        `${prefix}lease:${encodeURIComponent(fractionalTimestampSessionId)}`,
        `${prefix}lease:${encodeURIComponent(wrongTypeSessionId)}`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("returns candidates staged before the cursor on the next cursorless poll", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery-cursor:${randomUUID()}:`;
    const earlierSessionId = "a_new_candidate";
    const firstSessionId = "m_candidate";
    const laterSessionId = "z_candidate";
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const addExpiredLease = async (sessionId: string): Promise<void> => {
      await redis.set(
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        JSON.stringify({
          sessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 1,
        }),
      );
      await redis.zAdd(`${prefix}leases`, {
        score: 1,
        value: encodeURIComponent(sessionId),
      });
    };
    try {
      await addExpiredLease(firstSessionId);
      await addExpiredLease(laterSessionId);

      const first = await store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 1 });
      expect(first.candidates).toMatchObject([{ sessionId: firstSessionId, fence: 1 }]);
      expect(first.nextCursor).toBeDefined();

      await addExpiredLease(earlierSessionId);
      const second = await store.leases.listRecoveryCandidates({
        nowMs: Date.now(),
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.candidates).toEqual([]);
      expect(second.nextCursor).toBeDefined();

      const endOfCurrentScan = await store.leases.listRecoveryCandidates({
        nowMs: Date.now(),
        limit: 1,
        cursor: second.nextCursor!,
      });
      expect(endOfCurrentScan).toMatchObject({
        candidates: [{ sessionId: laterSessionId, fence: 1 }],
      });

      const nextPoll = await store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 1 });
      expect(nextPoll.candidates).toMatchObject([{ sessionId: earlierSessionId, fence: 1 }]);
    } finally {
      await redis.del([
        ...[earlierSessionId, firstSessionId, laterSessionId].map(
          (id) => `${prefix}lease:${encodeURIComponent(id)}`,
        ),
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("keeps due leases indexed if the recovery queue key has the wrong Redis type", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery-index-type:${randomUUID()}:`;
    const sessionId = "expired_lease";
    const encodedId = encodeURIComponent(sessionId);
    const expiryIndexKey = `${prefix}leases`;
    const candidatesKey = `${prefix}lease_recovery_candidates`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    try {
      await redis.set(
        `${prefix}lease:${encodedId}`,
        JSON.stringify({
          sessionId,
          holder: "expired_holder",
          fence: 1,
          acquiredAtMs: 0,
          renewedAtMs: 0,
          expiresAtMs: 1,
        }),
      );
      await redis.zAdd(expiryIndexKey, { score: 1, value: encodedId });
      await redis.set(candidatesKey, "wrong-type");

      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.zScore(expiryIndexKey, encodedId)).toBe(1);

      await redis.del(candidatesKey);
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({ candidates: [{ sessionId, fence: 1 }] });
    } finally {
      await redis.del([`${prefix}lease:${encodedId}`, expiryIndexKey, candidatesKey]);
      await redis.quit();
    }
  });

  it("repairs a stale due score without dropping an active lease", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery-stale-score:${randomUUID()}:`;
    const sessionId = "still_active";
    const encodedId = encodeURIComponent(sessionId);
    const expiryIndexKey = `${prefix}leases`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const futureExpiry = Date.now() + 60_000;
    try {
      await redis.set(
        `${prefix}lease:${encodedId}`,
        JSON.stringify({
          sessionId,
          holder: "active_holder",
          fence: 1,
          acquiredAtMs: Date.now(),
          renewedAtMs: Date.now(),
          expiresAtMs: futureExpiry,
        }),
      );
      await redis.zAdd(expiryIndexKey, { score: 1, value: encodedId });

      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toEqual({ candidates: [] });
      expect(await redis.zScore(expiryIndexKey, encodedId)).toBe(futureExpiry);
    } finally {
      await redis.del([
        `${prefix}lease:${encodedId}`,
        expiryIndexKey,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("fails lease mutations before changing leases when the candidate index has the wrong type", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-recovery-mutation-type:${randomUUID()}:`;
    const candidatesKey = `${prefix}lease_recovery_candidates`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const renewSessionId = "renew_existing" as SessionId;
    const newSessionId = "acquire_new" as SessionId;
    const createSessionId = "create_new" as SessionId;
    const existingLease = await store.leases.acquire(renewSessionId, "renew_holder", 60_000);
    const existingLeaseRaw = await redis.get(
      `${prefix}lease:${encodeURIComponent(renewSessionId)}`,
    );
    const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
    const record: StoredSessionRecord = {
      session: {
        id: createSessionId,
        agentId: "index_type_agent" as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
    };
    try {
      await redis.set(candidatesKey, "wrong-type");

      await expect(store.leases.acquire(newSessionId, "new_holder", 60_000)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      expect(await redis.get(`${prefix}lease:${encodeURIComponent(newSessionId)}`)).toBeNull();

      await expect(
        store.leases.renew(
          renewSessionId,
          "renew_holder",
          existingLease!.fence,
          120_000,
          existingLease!.generationId,
        ),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(`${prefix}lease:${encodeURIComponent(renewSessionId)}`)).toBe(
        existingLeaseRaw,
      );

      await expect(
        store.createSessionWithLease(record, "create_holder", 60_000),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(`${prefix}session:${encodeURIComponent(createSessionId)}`)).toBeNull();
      expect(await redis.get(`${prefix}lease:${encodeURIComponent(createSessionId)}`)).toBeNull();
    } finally {
      await redis.del([
        candidatesKey,
        `${prefix}leases`,
        `${prefix}session:${encodeURIComponent(createSessionId)}`,
        `${prefix}lease:${encodeURIComponent(renewSessionId)}`,
        `${prefix}lease:${encodeURIComponent(newSessionId)}`,
        `${prefix}lease:${encodeURIComponent(createSessionId)}`,
      ]);
      await redis.quit();
    }
  });
});

describe.skipIf(!redisIntegrationEnabled)("real Redis idempotency record validation", () => {
  it("atomically arbitrates concurrent claims on one shared Redis client", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-concurrent-claim:${randomUUID()}:`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const key = `concurrent_claim_${randomUUID()}`;
    const requestHash = `hash_${randomUUID()}`;
    const ttlMs = 60_000;
    const fencedSessionId = `fenced_claim_session_${randomUUID()}` as SessionId;
    const fencedKey = `fenced_claim_${randomUUID()}`;
    const fencedRequestHash = `fenced_hash_${randomUUID()}`;
    const fencedOwner = `fenced_owner_${randomUUID()}`;
    const lease = await store.leases.acquire(fencedSessionId, fencedOwner, ttlMs);
    expect(lease).not.toBeNull();
    try {
      const results = await Promise.all(
        ["owner_a", "owner_b"].map((owner) =>
          store.toolIdempotencyStore.claim({ key, requestHash, owner, ttlMs }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual(["claimed", "in_progress"]);

      const claim = results.find((result) => result.status === "claimed");
      if (!claim || claim.status !== "claimed") throw new Error("expected one winning claim");
      const claimOwner = claim.record.owner;
      if (!claimOwner) throw new Error("expected winning claim to have an owner");
      await expect(
        store.toolIdempotencyStore.releaseClaim({ key, requestHash, owner: claimOwner }),
      ).resolves.toBe(true);
      await expect(store.toolIdempotencyStore.lookup(key, requestHash)).resolves.toEqual({
        status: "missing",
      });

      await expect(
        store.toolIdempotencyStore.claim({
          key: fencedKey,
          sessionId: fencedSessionId,
          lease: lease!,
          requestHash: fencedRequestHash,
          owner: fencedOwner,
          ttlMs,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await expect(
        store.toolIdempotencyStore.releaseClaim({
          key: fencedKey,
          sessionId: fencedSessionId,
          lease: lease!,
          requestHash: fencedRequestHash,
          owner: fencedOwner,
        }),
      ).resolves.toBe(true);
      await expect(
        store.toolIdempotencyStore.lookup(fencedKey, fencedRequestHash, fencedSessionId, lease!),
      ).resolves.toEqual({ status: "missing" });
    } finally {
      if (lease) {
        await store.leases.release(fencedSessionId, lease.holder, lease.fence, lease.generationId);
      }
      await redis.del([
        `${prefix}idempotency:${encodeURIComponent(key)}`,
        `${prefix}idempotency:${encodeURIComponent(fencedKey)}`,
        `${prefix}lease:${encodeURIComponent(fencedSessionId)}`,
        `${prefix}leases`,
      ]);
      await redis.quit();
    }
  });

  it("preserves fenced replay outputs and accepts an identical completion", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-opaque-output:${randomUUID()}:`;
    const sessionId = `idempotency_opaque_output_${randomUUID()}` as SessionId;
    const key = `opaque_output_${randomUUID()}`;
    const requestHash = `hash_${randomUUID()}`;
    const owner = `owner_${randomUUID()}`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const lease = await store.leases.acquire(sessionId, owner, 60_000);
    expect(lease).not.toBeNull();
    const outcome = {
      sessionId,
      lease: lease!,
      owner,
      status: "succeeded" as const,
      ttlMs: 60_000,
      output: { items: [], id: 1_234_567_890_123_456 },
    };
    const redisKey = `${prefix}idempotency:${encodeURIComponent(key)}`;
    try {
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: lease!,
          requestHash,
          owner,
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.toolIdempotencyStore.complete(key, requestHash, outcome);

      await expect(
        store.toolIdempotencyStore.lookup(key, requestHash, sessionId, lease!),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "succeeded", output: { items: [], id: 1_234_567_890_123_456 } },
      });
      await expect(store.toolIdempotencyStore.complete(key, requestHash, outcome)).resolves.toBe(
        undefined,
      );
      const persisted = JSON.parse((await redis.get(redisKey)) ?? "null") as {
        outputJson: string;
        output?: unknown;
      };
      expect(persisted.outputJson).toContain('"id":1234567890123456');
      expect(persisted.outputJson).toContain('"items":[]');
      expect(persisted.output).toBeUndefined();
    } finally {
      await store.leases.release(sessionId, lease!.holder, lease!.fence, lease!.generationId);
      await redis.del([
        redisKey,
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}leases`,
      ]);
      await redis.quit();
    }
  });

  it("rejects mismatched logical keys inside fenced Lua mutations", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-logical-key:${randomUUID()}:`;
    const sessionId = `idempotency_key_guard_${randomUUID()}` as SessionId;
    const claimKey = `claim_${randomUUID()}`;
    const completeKey = `complete_${randomUUID()}`;
    const quarantineKey = `quarantine_${randomUUID()}`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const keys = [claimKey, completeKey, quarantineKey];
    const lease = await store.leases.acquire(sessionId, "logical-key-owner", 60_000);
    expect(lease).not.toBeNull();
    const malformedRecord = (requestedKey: string) => ({
      key: `wrong:${requestedKey}`,
      sessionId,
      toolId: "tool" as ToolId,
      toolVersion: "1",
      requestHash: "request-hash",
      status: "claimed",
      owner: "logical-key-owner",
      claimedFence: lease!.fence,
      claimedGenerationId: lease!.generationId,
      expiresAtMs: Date.now() + 60_000,
    });
    try {
      for (const key of keys) {
        await redis.set(
          `${prefix}idempotency:${encodeURIComponent(key)}`,
          JSON.stringify(malformedRecord(key)),
          { PX: 60_000 },
        );
      }
      const claimRedisKey = `${prefix}idempotency:${encodeURIComponent(claimKey)}`;
      const claimRaw = await redis.get(claimRedisKey);
      await expect(
        store.toolIdempotencyStore.claim({
          key: claimKey,
          sessionId,
          lease: lease!,
          requestHash: "request-hash",
          owner: "logical-key-owner",
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(claimRedisKey)).toBe(claimRaw);

      const completeRedisKey = `${prefix}idempotency:${encodeURIComponent(completeKey)}`;
      const completeRaw = await redis.get(completeRedisKey);
      await expect(
        store.toolIdempotencyStore.complete(completeKey, "request-hash", {
          sessionId,
          lease: lease!,
          owner: "logical-key-owner",
          status: "succeeded",
          ttlMs: 60_000,
          output: { unexpected: true },
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(completeRedisKey)).toBe(completeRaw);

      const quarantineRedisKey = `${prefix}idempotency:${encodeURIComponent(quarantineKey)}`;
      const quarantineRaw = await redis.get(quarantineRedisKey);
      await expect(
        store.toolIdempotencyStore.quarantine({
          key: quarantineKey,
          sessionId,
          lease: lease!,
          toolId: "tool" as ToolId,
          toolVersion: "1",
          requestHash: "request-hash",
          owner: "logical-key-owner",
          ttlMs: 60_000,
          error: toolError("tool.execution_failed", "tool failed"),
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(quarantineRedisKey)).toBe(quarantineRaw);
    } finally {
      await redis.del([
        ...keys.map((key) => `${prefix}idempotency:${encodeURIComponent(key)}`),
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
    }
  });

  it("fails closed on malformed persisted fences and expiry before stale takeover", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-record-validation:${randomUUID()}:`;
    const sessionId = `idempotency_record_${randomUUID()}` as SessionId;
    const key = `idempotency_record_${randomUUID()}`;
    const requestHash = `request_${randomUUID()}`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const leaseKey = `${prefix}lease:${encodeURIComponent(sessionId)}`;
    const redisKey = `${prefix}idempotency:${encodeURIComponent(key)}`;
    try {
      const firstLease = await store.leases.acquire(sessionId, "record_owner_one", 60_000);
      expect(firstLease).not.toBeNull();
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: firstLease!,
          requestHash,
          owner: "tool_owner_one",
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.leases.release(
        sessionId,
        firstLease!.holder,
        firstLease!.fence,
        firstLease!.generationId,
      );
      const secondLease = await store.leases.acquire(sessionId, "record_owner_two", 60_000);
      expect(secondLease?.fence).toBe(firstLease!.fence + 1);

      const invalidFence = {
        key,
        sessionId,
        requestHash,
        status: "claimed",
        owner: "tool_owner_one",
        claimedFence: 0,
        expiresAtMs: Date.now() + 60_000,
      };
      const invalidFenceRaw = JSON.stringify(invalidFence);
      await redis.set(redisKey, invalidFenceRaw, { PX: 60_000 });
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: secondLease!,
          requestHash,
          owner: "tool_owner_two",
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(redisKey)).toBe(invalidFenceRaw);

      const invalidExpiryRaw = JSON.stringify({
        ...invalidFence,
        claimedFence: firstLease!.fence,
        expiresAtMs: Number.MAX_SAFE_INTEGER + 1,
      });
      await redis.set(redisKey, invalidExpiryRaw, { PX: 60_000 });
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: secondLease!,
          requestHash,
          owner: "tool_owner_two",
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(redisKey)).toBe(invalidExpiryRaw);

      const negativeExpiryRaw = JSON.stringify({
        ...invalidFence,
        claimedFence: firstLease!.fence,
        expiresAtMs: -1,
      });
      await redis.set(redisKey, negativeExpiryRaw, { PX: 60_000 });
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: secondLease!,
          requestHash,
          owner: "tool_owner_two",
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(redisKey)).toBe(negativeExpiryRaw);
    } finally {
      await redis.del([leaseKey, redisKey]);
      await redis.quit();
    }
  });

  it("rejects overflowed expiry arithmetic before unfenced claim or completion writes", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:idempotency-expiry-overflow:${randomUUID()}:`;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const requestHash = `request_${randomUUID()}`;
    const claimKey = `overflow_claim_${randomUUID()}`;
    const completionKey = `overflow_complete_${randomUUID()}`;
    const redisKeys = [claimKey, completionKey].map(
      (key) => `${prefix}idempotency:${encodeURIComponent(key)}`,
    );
    try {
      await expect(
        store.toolIdempotencyStore.claim({
          key: claimKey,
          requestHash,
          owner: "overflow_owner",
          ttlMs: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(await redis.get(redisKeys[0]!)).toBeNull();

      await store.toolIdempotencyStore.claim({
        key: completionKey,
        requestHash,
        owner: "overflow_owner",
        ttlMs: 60_000,
      });
      const before = await redis.get(redisKeys[1]!);
      await expect(
        store.toolIdempotencyStore.complete(completionKey, requestHash, {
          owner: "overflow_owner",
          status: "failed",
          ttlMs: Number.MAX_SAFE_INTEGER,
          error: providerError("vendor.operation_failed", "provider failed"),
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(await redis.get(redisKeys[1]!)).toBe(before);
    } finally {
      await redis.del(redisKeys);
      await redis.quit();
    }
  });
});

describe.skipIf(!redisIntegrationEnabled)("real Redis lease numeric record validation", () => {
  it("rejects string-encoded persisted lease numbers before renewing or indexing", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:lease-numeric-types:${randomUUID()}:`;
    const sessionId = `lease_numeric_types_${randomUUID()}` as SessionId;
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    const leaseKey = `${prefix}lease:${encodeURIComponent(sessionId)}`;
    try {
      const lease = await store.leases.acquire(sessionId, "numeric_types_owner", 60_000);
      expect(lease).not.toBeNull();
      const validRaw = await redis.get(leaseKey);
      expect(validRaw).not.toBeNull();
      const validLease = JSON.parse(validRaw!) as Record<string, unknown>;
      for (const field of ["fence", "acquiredAtMs", "renewedAtMs", "expiresAtMs"] as const) {
        const invalidRaw = JSON.stringify({ ...validLease, [field]: String(validLease[field]) });
        await redis.set(leaseKey, invalidRaw);
        await expect(
          store.leases.renew(sessionId, lease!.holder, lease!.fence, 60_000, lease!.generationId),
        ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
        expect(await redis.get(leaseKey)).toBe(invalidRaw);
      }
    } finally {
      await redis.del([leaseKey, `${prefix}leases`, `${prefix}lease_recovery_candidates`]);
      await redis.quit();
    }
  });
});

describe.skipIf(!postgresIntegrationEnabled)(
  "real PostgreSQL active-session idempotency fencing",
  () => {
    it("rejects generation-less inserts and completes a claim for the current lease", async () => {
      const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
      const sqlPool = adaptPool(pg);
      const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
      const sessionId = `legacy_complete_${randomUUID()}` as SessionId;
      const key = `legacy_claim_${randomUUID()}`;
      const requestHash = `hash_${randomUUID()}`;
      const owner = `owner_${randomUUID()}`;
      try {
        await runPostgresMigrations(sqlPool);
        await store.sessions.put({
          session: {
            id: sessionId,
            agentId: `agent_${randomUUID()}` as AgentId,
            status: "active",
            channel: "simulated",
            memoryRefs: [],
            createdAt: new Date().toISOString() as Timestamp,
            startedAt: new Date().toISOString() as Timestamp,
            state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
          },
          runtime: { monotonicStartedAtMs: 0 },
        });
        const lease = await store.leases.acquire(sessionId, owner, 60_000);
        expect(lease).not.toBeNull();
        await expect(
          pg.query(
            `INSERT INTO tvic_tool_idempotency
             (key, session_id, tool_id, tool_version, request_hash, status, owner,
              claimed_fence, expires_at_ms, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7,
               floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000, NOW())`,
            [key, sessionId, "legacy-tool", "1.0.0", requestHash, owner, lease!.fence],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          store.toolIdempotencyStore.claim({
            key,
            sessionId,
            lease: lease!,
            toolId: "legacy-tool" as ToolId,
            toolVersion: "1.0.0",
            requestHash,
            owner,
            ttlMs: 60_000,
          }),
        ).resolves.toMatchObject({ status: "claimed" });

        await expect(
          pg.query("UPDATE tvic_tool_idempotency SET session_id = NULL WHERE key = $1", [key]),
        ).rejects.toMatchObject({ code: "23514" });

        await expect(
          pg.query(
            `UPDATE tvic_tool_idempotency
             SET status = 'succeeded'
             WHERE key = $1 AND request_hash = $2 AND owner = $3 AND status = 'claimed'`,
            [key, requestHash, owner],
          ),
        ).rejects.toMatchObject({ code: "23514" });

        await store.toolIdempotencyStore.complete(key, requestHash, {
          status: "succeeded",
          owner,
          ttlMs: 60_000,
          lease: lease!,
          output: { recovered: true },
        });

        await expect(
          store.toolIdempotencyStore.lookup(key, requestHash, sessionId, lease!),
        ).resolves.toMatchObject({
          status: "found",
          record: {
            status: "succeeded",
            claimedFence: lease!.fence,
            claimedGenerationId: lease!.generationId,
            output: { recovered: true },
          },
        });
      } finally {
        await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]).catch(() => {});
        await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
        await pg.end();
      }
    });
  },
);

describe.skipIf(!postgresIntegrationEnabled)("real PostgreSQL session-scoped idempotency", () => {
  it("rejects unfenced calls after session ID reuse and validates the current lease", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `idempotency_lifetime_${randomUUID()}` as SessionId;
    const replacementSessionId = `idempotency_lifetime_replacement_${randomUUID()}` as SessionId;
    const key = `idempotency_lifetime_key_${randomUUID()}`;
    const requestHash = `idempotency_lifetime_hash_${randomUUID()}`;
    const owner = `idempotency_lifetime_owner_${randomUUID()}`;
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          requestHash,
          owner,
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      expect(
        (await pg.query("SELECT key FROM tvic_tool_idempotency WHERE key = $1", [key])).rows,
      ).toHaveLength(1);

      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `idempotency_lifetime_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      expect(
        (await pg.query("SELECT key FROM tvic_tool_idempotency WHERE key = $1", [key])).rows,
      ).toHaveLength(0);

      await expect(
        store.toolIdempotencyStore.claim({ key, sessionId, requestHash, owner, ttlMs: 60_000 }),
      ).resolves.toEqual({ status: "conflict" });
      await expect(store.toolIdempotencyStore.lookup(key, requestHash, sessionId)).resolves.toEqual(
        {
          status: "conflict",
        },
      );
      await expect(
        store.toolIdempotencyStore.complete(key, requestHash, {
          sessionId,
          owner,
          status: "succeeded",
          ttlMs: 60_000,
          output: { stale: true },
        }),
      ).rejects.toMatchObject({ code: "RECORD_CONFLICT" });

      await expect(
        pg.query(
          `INSERT INTO tvic_tool_idempotency
           (key, session_id, request_hash, status, owner, expires_at_ms, updated_at)
           VALUES ($1, $2, $3, 'claimed', $4,
             floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000, NOW())`,
          [`raw_unfenced_${key}`, sessionId, requestHash, owner],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const lease = await store.leases.acquire(sessionId, owner, 60_000);
      expect(lease).not.toBeNull();
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: lease!,
          requestHash,
          owner,
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await expect(store.toolIdempotencyStore.lookup(key, requestHash, sessionId)).resolves.toEqual(
        {
          status: "conflict",
        },
      );
      await expect(
        store.toolIdempotencyStore.lookup(key, requestHash, sessionId, lease!),
      ).resolves.toMatchObject({ status: "found", record: { status: "claimed" } });

      await updateIdempotencyWithLeaseContext(
        pg,
        lease!,
        "UPDATE tvic_tool_idempotency SET expires_at_ms = 0 WHERE key = $1",
        [key],
      );
      await store.sessions.put({
        session: {
          id: replacementSessionId,
          agentId: `idempotency_replacement_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const replacementLease = await store.leases.acquire(
        replacementSessionId,
        `${owner}_replacement`,
        60_000,
      );
      expect(replacementLease).not.toBeNull();
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId: replacementSessionId,
          lease: replacementLease!,
          requestHash,
          owner: `${owner}_replacement`,
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed", record: { sessionId: replacementSessionId } });
      await expect(
        pg.query("SELECT session_id FROM tvic_tool_idempotency WHERE key = $1", [key]),
      ).resolves.toMatchObject({ rows: [{ session_id: replacementSessionId }] });
    } finally {
      await pg
        .query("DELETE FROM tvic_tool_idempotency WHERE session_id = $1", [sessionId])
        .catch(() => {});
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]).catch(() => {});
      await pg
        .query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [`raw_unfenced_${key}`])
        .catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await pg
        .query("DELETE FROM tvic_sessions WHERE id = $1", [replacementSessionId])
        .catch(() => {});
      await store.close();
      await pg.end();
    }
  });
});

describe.skipIf(!postgresIntegrationEnabled)(
  "real PostgreSQL retention session incarnation",
  () => {
    it("rejects negative or unsafe retention durations", async () => {
      const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
      const sqlPool = adaptPool(pg);
      const common = { pool: sqlPool, hasLegalHold: async () => false };
      try {
        for (const terminalRetentionMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
          expect(() => new PostgresRetentionJob({ ...common, terminalRetentionMs })).toThrow(
            RangeError,
          );
        }
        for (const outboxRetentionMs of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
          expect(
            () =>
              new PostgresRetentionJob({
                ...common,
                terminalRetentionMs: 0,
                outboxRetentionMs,
              }),
          ).toThrow(RangeError);
        }
      } finally {
        await pg.end();
      }
    });

    it("pages session child records with a stable keyset cursor", async () => {
      const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
      const store = createPostgresDurableRuntimeStore({ pool: adaptPool(pg) });
      const sessionId = `session_child_pages_${randomUUID()}` as SessionId;
      const timestamp = new Date().toISOString() as Timestamp;
      try {
        await runPostgresMigrations(adaptPool(pg));
        await store.sessions.put({
          session: {
            id: sessionId,
            agentId: `session_child_pages_agent_${randomUUID()}` as AgentId,
            status: "active",
            channel: "simulated",
            memoryRefs: [],
            createdAt: timestamp,
            startedAt: timestamp,
            state: { variables: {}, pendingToolCallIds: [], turnSequence: 3 },
          },
          runtime: { monotonicStartedAtMs: 0 },
          version: 1,
        });
        for (const [index, id] of ["page_turn_a", "page_turn_b", "page_turn_c"].entries()) {
          const turnId = `${id}_${randomUUID()}` as TurnId;
          const toolCallId = `${id}_${randomUUID()}` as ToolCallId;
          await store.turns.put({
            turn: {
              id: turnId,
              sessionId,
              sequence: index + 1,
              status: "completed",
              input: { transcript: id, mediaEventIds: [] },
              output: { text: id, mediaEventIds: [] },
              toolCallIds: [toolCallId],
              startedAt: timestamp,
              endedAt: timestamp,
              latency: {},
            },
            runtime: { monotonicStartedAtMs: 0 },
            version: 1,
          });
          await store.toolCalls.put({
            toolCall: {
              status: "succeeded",
              toolCallId,
              toolId: `session_child_pages_tool_${index}` as ToolId,
              toolName: "session_child_pages_tool" as ToolName,
              sessionId,
              turnId,
              input: { index },
              attempts: 1,
              queuedAt: timestamp,
              startedAt: timestamp,
              endedAt: timestamp,
              output: { ok: true },
            },
            runtime: { monotonicQueuedAtMs: 0 },
            version: 1,
          });
        }

        const turnsPageOne = await store.turns.listBySessionPage(sessionId, undefined, 2);
        expect(turnsPageOne.records).toHaveLength(2);
        expect(turnsPageOne.nextCursor).toBe(turnsPageOne.records[1]?.turn.id);
        const turnsPageTwo = await store.turns.listBySessionPage(
          sessionId,
          turnsPageOne.nextCursor,
          2,
        );
        expect(turnsPageTwo.records).toHaveLength(1);
        expect(turnsPageTwo.nextCursor).toBeUndefined();

        const toolsPageOne = await store.toolCalls.listBySessionPage(sessionId, undefined, 2);
        expect(toolsPageOne.records).toHaveLength(2);
        expect(toolsPageOne.nextCursor).toBe(toolsPageOne.records[1]?.toolCall.toolCallId);
        const toolsPageTwo = await store.toolCalls.listBySessionPage(
          sessionId,
          toolsPageOne.nextCursor,
          2,
        );
        expect(toolsPageTwo.records).toHaveLength(1);
        expect(toolsPageTwo.nextCursor).toBeUndefined();
      } finally {
        await pg
          .query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId])
          .catch(() => {});
        await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
        await pg.end();
      }
    });

    it("does not delete a replacement session selected by a concurrent retention worker", async () => {
      const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
      const sqlPool = adaptPool(pg);
      const sessionId = `retention_reuse_${randomUUID()}`;
      let allowFirstDelete!: () => void;
      let firstCandidateSelect!: () => void;
      let firstWorker: Promise<unknown> | undefined;
      const firstCanContinue = new Promise<void>((resolve) => {
        allowFirstDelete = resolve;
      });
      const candidateSelected = new Promise<void>((resolve) => {
        firstCandidateSelect = resolve;
      });
      try {
        await runPostgresMigrations(sqlPool);
        await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]);
        await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
        await pg.query(
          `INSERT INTO tvic_sessions
          (id, agent_id, status, created_at, ended_at, payload, runtime, last_activity_at)
         VALUES ($1, 'retention-test-agent', 'completed', '2000-01-01', '2000-01-01',
           '{}'::jsonb, '{}'::jsonb, NOW())`,
          [sessionId],
        );
        const oldRow = await pg.query<{ incarnation: string }>(
          "SELECT incarnation FROM tvic_sessions WHERE id = $1",
          [sessionId],
        );
        const oldIncarnation = oldRow.rows[0]?.incarnation;
        expect(oldIncarnation).toBeDefined();

        let paused = false;
        const delayedPool: SqlPool = {
          query: (text, values) => sqlPool.query(text, values),
          connect: async () => {
            const connection = await sqlPool.connect();
            return {
              query: async <Row extends Record<string, unknown>>(
                text: string,
                values?: readonly unknown[],
              ) => {
                if (!paused && text.includes("FOR UPDATE")) {
                  paused = true;
                  firstCandidateSelect();
                  await firstCanContinue;
                }
                return connection.query<Row>(text, values);
              },
              release: () => connection.release(),
            };
          },
        };
        firstWorker = new PostgresRetentionJob({
          pool: delayedPool,
          terminalRetentionMs: 0,
          hasLegalHold: async () => false,
        }).runOnce();
        await candidateSelected;

        await new PostgresRetentionJob({
          pool: sqlPool,
          terminalRetentionMs: 0,
          hasLegalHold: async () => false,
        }).runOnce();
        expect(
          (await pg.query("SELECT id FROM tvic_sessions WHERE id = $1", [sessionId])).rowCount,
        ).toBe(0);

        await pg.query(
          `INSERT INTO tvic_sessions
          (id, agent_id, status, created_at, ended_at, payload, runtime, last_activity_at)
         VALUES ($1, 'retention-test-agent', 'completed', '2000-01-01', '2000-01-01',
           '{}'::jsonb, '{}'::jsonb, NOW())`,
          [sessionId],
        );
        const replacement = await pg.query<{ incarnation: string }>(
          "SELECT incarnation FROM tvic_sessions WHERE id = $1",
          [sessionId],
        );
        expect(Number(replacement.rows[0]?.incarnation)).toBeGreaterThan(Number(oldIncarnation));

        allowFirstDelete();
        await firstWorker;
        const retained = await pg.query<{ incarnation: string }>(
          "SELECT incarnation FROM tvic_sessions WHERE id = $1",
          [sessionId],
        );
        expect(retained.rows[0]?.incarnation).toBe(replacement.rows[0]?.incarnation);
      } finally {
        allowFirstDelete?.();
        await firstWorker?.catch(() => undefined);
        await pg
          .query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId])
          .catch(() => {});
        await pg
          .query("DELETE FROM tvic_tool_idempotency WHERE session_id = $1", [sessionId])
          .catch(() => {});
        await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
        await pg.end();
      }
    });

    it("pages PostgreSQL retention in bounded batches without starving later sessions", async () => {
      const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
      const sqlPool = adaptPool(pg);
      const prefix = `retention_batch_${randomUUID()}_`;
      const sessionPrefix = `${prefix}session_`;
      const idempotencyPrefix = `${prefix}idem_`;
      const outboxPrefix = `${prefix}outbox_`;
      const retention = new PostgresRetentionJob({
        pool: sqlPool,
        terminalRetentionMs: 0,
        outboxRetentionMs: 0,
        hasLegalHold: async () => false,
      });
      try {
        await runPostgresMigrations(sqlPool);
        await pg.query(
          `INSERT INTO tvic_sessions
             (id, agent_id, status, created_at, ended_at, payload, runtime, last_activity_at)
           SELECT $1 || n::text, 'retention-batch-agent', 'completed', '2000-01-01',
                  '2000-01-01', '{}'::jsonb, '{}'::jsonb, NOW()
           FROM generate_series(1, 105) AS rows_to_insert(n)`,
          [sessionPrefix],
        );
        await pg.query(
          `INSERT INTO tvic_sessions
             (id, agent_id, status, created_at, payload, runtime, last_activity_at)
           VALUES ($1, 'retention-batch-agent', 'active', '2000-01-01', '{}'::jsonb,
                   '{}'::jsonb, NOW())`,
          [`${prefix}outbox_parent`],
        );
        await pg.query(
          `INSERT INTO tvic_tool_idempotency
             (key, request_hash, status, owner, expires_at_ms, updated_at)
           SELECT $1 || n::text, 'retention-batch-hash', 'failed', 'retention-batch-owner', 0, NOW()
           FROM generate_series(1, 105) AS rows_to_insert(n)`,
          [idempotencyPrefix],
        );
        await pg.query(
          `INSERT INTO tvic_outbox
             (id, aggregate_type, aggregate_id, session_id, version, fence, envelope,
              created_at, delivered_at)
           SELECT $1 || n::text, 'session', $2, $2,
                  1, 0, '{}'::jsonb, '2000-01-01', '2000-01-01'
           FROM generate_series(1, 105) AS rows_to_insert(n)`,
          [outboxPrefix, `${prefix}outbox_parent`],
        );

        let remaining = 1;
        let runs = 0;
        while (remaining > 0 && runs < 20) {
          const result = await retention.runOnce();
          expect(result.sessionsDeleted).toBeLessThanOrEqual(100);
          expect(result.outboxDeleted).toBeLessThanOrEqual(100);
          expect(result.idempotencyDeleted).toBeLessThanOrEqual(100);
          runs += 1;
          const pending = await pg.query<{ remaining: number }>(
            `SELECT
               (SELECT count(*)::int FROM tvic_sessions WHERE id LIKE $1) +
               (SELECT count(*)::int FROM tvic_tool_idempotency WHERE key LIKE $2) +
               (SELECT count(*)::int FROM tvic_outbox WHERE id LIKE $3) AS remaining`,
            [`${sessionPrefix}%`, `${idempotencyPrefix}%`, `${outboxPrefix}%`],
          );
          remaining = pending.rows[0]?.remaining ?? 0;
        }
        expect(runs).toBeGreaterThan(1);
        expect(remaining).toBe(0);
      } finally {
        await pg
          .query("DELETE FROM tvic_outbox WHERE id LIKE $1", [`${outboxPrefix}%`])
          .catch(() => {});
        await pg
          .query("DELETE FROM tvic_tool_idempotency WHERE key LIKE $1", [`${idempotencyPrefix}%`])
          .catch(() => {});
        await pg
          .query("DELETE FROM tvic_sessions WHERE id LIKE $1", [`${sessionPrefix}%`])
          .catch(() => {});
        await pg
          .query("DELETE FROM tvic_sessions WHERE id = $1", [`${prefix}outbox_parent`])
          .catch(() => {});
        await pg.end();
      }
    });

    it("waits for retained delivered outbox rows before purging and deleting a session", async () => {
      const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
      const sqlPool = adaptPool(pg);
      const sessionId = `retention_delivered_outbox_${randomUUID()}`;
      const outboxId = `retention_delivered_outbox_event_${randomUUID()}`;
      const purgedSessions: string[] = [];
      try {
        await runPostgresMigrations(sqlPool);
        await pg.query(
          `INSERT INTO tvic_sessions
           (id, agent_id, status, created_at, ended_at, payload, runtime, last_activity_at)
           VALUES ($1, 'retention-test-agent', 'completed', '2000-01-01', '2000-01-01',
             '{}'::jsonb, '{}'::jsonb, NOW())`,
          [sessionId],
        );
        await pg.query(
          `INSERT INTO tvic_outbox
           (id, aggregate_type, aggregate_id, session_id, version, fence, envelope,
            created_at, delivered_at)
           VALUES ($1, 'session', $2, $2, 1, 0, '{}'::jsonb, NOW(), NOW())`,
          [outboxId, sessionId],
        );

        const retention = () =>
          new PostgresRetentionJob({
            pool: sqlPool,
            terminalRetentionMs: 0,
            hasLegalHold: async () => false,
            beforeSessionDelete: async (candidate) => {
              purgedSessions.push(candidate.sessionId);
            },
          });
        const firstRun = await retention().runOnce();
        expect(firstRun.sessionsDeleted).toBe(0);
        expect(firstRun.outboxDeleted).toBe(0);
        expect(purgedSessions).toEqual([]);
        expect(
          (await pg.query("SELECT id FROM tvic_sessions WHERE id = $1", [sessionId])).rowCount,
        ).toBe(1);

        await pg.query("UPDATE tvic_outbox SET delivered_at = '2000-01-01' WHERE id = $1", [
          outboxId,
        ]);
        const secondRun = await retention().runOnce();
        expect(secondRun.outboxDeleted).toBe(1);
        expect(secondRun.sessionsDeleted).toBe(1);
        expect(purgedSessions).toEqual([sessionId]);
      } finally {
        await pg.query("DELETE FROM tvic_outbox WHERE id = $1", [outboxId]).catch(() => {});
        await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
        await pg.end();
      }
    });
  },
);

describe.skipIf(!postgresIntegrationEnabled)("real PostgreSQL lease recovery disposition", () => {
  it("does not persist an overflowing renewal or advance an exhausted fence", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `lease_numeric_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `lease_numeric_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const lease = await store.leases.acquire(sessionId, "numeric_holder", 60_000);
      expect(lease).not.toBeNull();

      const beforeRenewal = await pg.query(
        "SELECT fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      await expect(
        store.leases.renew(
          sessionId,
          lease!.holder,
          lease!.fence,
          Number.MAX_SAFE_INTEGER,
          lease!.generationId,
        ),
      ).resolves.toBeNull();
      const afterRenewal = await pg.query(
        "SELECT fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      expect(afterRenewal.rows).toEqual(beforeRenewal.rows);

      await pg.query(
        "UPDATE tvic_session_leases SET fence = 0, acquired_at_ms = 0, renewed_at_ms = 0, expires_at_ms = 0 WHERE session_id = $1",
        [sessionId],
      );
      const beforeZeroFenceAcquire = await pg.query(
        "SELECT fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      await expect(
        store.leases.acquire(sessionId, "zero_fence_holder", 1_000),
      ).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
      const afterZeroFenceAcquire = await pg.query(
        "SELECT fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      expect(afterZeroFenceAcquire.rows).toEqual(beforeZeroFenceAcquire.rows);

      await pg.query(
        "UPDATE tvic_session_leases SET fence = $2, acquired_at_ms = 0, renewed_at_ms = 0, expires_at_ms = 0 WHERE session_id = $1",
        [sessionId, Number.MAX_SAFE_INTEGER],
      );
      const beforeAcquire = await pg.query(
        "SELECT fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      await expect(
        store.leases.acquire(sessionId, "next_numeric_holder", 1_000),
      ).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      const afterAcquire = await pg.query(
        "SELECT fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      expect(afterAcquire.rows).toEqual(beforeAcquire.rows);
    } finally {
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });

  it("rejects idempotency claims when the persisted lease timestamp is unsafe", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `idempotency_lease_range_${randomUUID()}` as SessionId;
    const key = `idempotency_lease_range_${randomUUID()}`;
    const requestHash = `request_${randomUUID()}`;
    const owner = `owner_${randomUUID()}`;
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `idempotency_lease_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const lease = await store.leases.acquire(sessionId, owner, 60_000);
      expect(lease).not.toBeNull();
      await pg.query("UPDATE tvic_session_leases SET expires_at_ms = $2 WHERE session_id = $1", [
        sessionId,
        "9007199254740992",
      ]);

      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: lease!,
          requestHash,
          owner,
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
      const persisted = await pg.query("SELECT 1 FROM tvic_tool_idempotency WHERE key = $1", [key]);
      expect(persisted.rows).toHaveLength(0);
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]).catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });

  it("fails closed on malformed persisted idempotency fences before stale takeover", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `idempotency_claim_fence_${randomUUID()}` as SessionId;
    const key = `idempotency_claim_fence_${randomUUID()}`;
    const requestHash = `request_${randomUUID()}`;
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `idempotency_claim_fence_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const firstLease = await store.leases.acquire(sessionId, "claim_fence_owner_one", 60_000);
      expect(firstLease).not.toBeNull();
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: firstLease!,
          requestHash,
          owner: "tool_owner_one",
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.leases.release(
        sessionId,
        firstLease!.holder,
        firstLease!.fence,
        firstLease!.generationId,
      );
      const secondLease = await store.leases.acquire(sessionId, "claim_fence_owner_two", 60_000);
      expect(secondLease?.fence).toBe(firstLease!.fence + 1);

      const fenceStateBefore = await pg.query(
        "SELECT status, claimed_fence, claimed_generation_id, expires_at_ms FROM tvic_tool_idempotency WHERE key = $1",
        [key],
      );
      await expect(
        updateIdempotencyWithLeaseContext(
          pg,
          secondLease!,
          "UPDATE tvic_tool_idempotency SET claimed_fence = 0, claimed_generation_id = NULL WHERE key = $1",
          [key],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(
        (
          await pg.query(
            "SELECT status, claimed_fence, claimed_generation_id, expires_at_ms FROM tvic_tool_idempotency WHERE key = $1",
            [key],
          )
        ).rows,
      ).toEqual(fenceStateBefore.rows);
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: secondLease!,
          requestHash,
          owner: "tool_owner_two",
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ status: "claimed" });

      await updateIdempotencyWithLeaseContext(
        pg,
        secondLease!,
        "UPDATE tvic_tool_idempotency SET claimed_fence = $2, expires_at_ms = $3 WHERE key = $1",
        [key, secondLease!.fence, "9007199254740992"],
      );
      const invalidExpiryBefore = await pg.query(
        "SELECT status, claimed_fence, claimed_generation_id, expires_at_ms FROM tvic_tool_idempotency WHERE key = $1",
        [key],
      );
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: secondLease!,
          requestHash,
          owner: "tool_owner_two",
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
      expect(
        (
          await pg.query(
            "SELECT status, claimed_fence, claimed_generation_id, expires_at_ms FROM tvic_tool_idempotency WHERE key = $1",
            [key],
          )
        ).rows,
      ).toEqual(invalidExpiryBefore.rows);

      await updateIdempotencyWithLeaseContext(
        pg,
        secondLease!,
        "UPDATE tvic_tool_idempotency SET expires_at_ms = -1 WHERE key = $1",
        [key],
      );
      const negativeExpiryBefore = await pg.query(
        "SELECT status, claimed_fence, claimed_generation_id, expires_at_ms FROM tvic_tool_idempotency WHERE key = $1",
        [key],
      );
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          lease: secondLease!,
          requestHash,
          owner: "tool_owner_two",
          ttlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
      expect(
        (
          await pg.query(
            "SELECT status, claimed_fence, claimed_generation_id, expires_at_ms FROM tvic_tool_idempotency WHERE key = $1",
            [key],
          )
        ).rows,
      ).toEqual(negativeExpiryBefore.rows);
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]).catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });

  it("rejects idempotency expiry overflow before PostgreSQL claim or completion writes", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const requestHash = `request_${randomUUID()}`;
    const overflowClaimKey = `overflow_claim_${randomUUID()}`;
    const completionKey = `overflow_complete_${randomUUID()}`;
    try {
      await runPostgresMigrations(sqlPool);
      await expect(
        store.toolIdempotencyStore.claim({
          key: overflowClaimKey,
          requestHash,
          owner: "overflow_owner",
          ttlMs: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(
        (await pg.query("SELECT 1 FROM tvic_tool_idempotency WHERE key = $1", [overflowClaimKey]))
          .rows,
      ).toHaveLength(0);

      await store.toolIdempotencyStore.claim({
        key: completionKey,
        requestHash,
        owner: "overflow_owner",
        ttlMs: 60_000,
      });
      const before = await pg.query(
        "SELECT status, owner, expires_at_ms, error FROM tvic_tool_idempotency WHERE key = $1",
        [completionKey],
      );
      await expect(
        store.toolIdempotencyStore.complete(completionKey, requestHash, {
          owner: "overflow_owner",
          status: "failed",
          ttlMs: Number.MAX_SAFE_INTEGER,
          error: providerError("vendor.operation_failed", "provider failed"),
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(
        (
          await pg.query(
            "SELECT status, owner, expires_at_ms, error FROM tvic_tool_idempotency WHERE key = $1",
            [completionKey],
          )
        ).rows,
      ).toEqual(before.rows);
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = ANY($1::text[])", [
        [overflowClaimKey, completionKey],
      ]);
      await store.close();
      await pg.end();
    }
  });

  it("preserves a corrupt negative expiry during quarantine", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `quarantine_bad_expiry_${randomUUID()}` as SessionId;
    const key = `quarantine_bad_expiry_${randomUUID()}`;
    const requestHash = `request_${randomUUID()}`;
    const toolId = `quarantine_bad_expiry_tool_${randomUUID()}` as ToolId;
    const toolVersion = "1.0.0";
    const owner = `quarantine_bad_expiry_owner_${randomUUID()}`;
    const ttlMs = 60_000;
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `quarantine_bad_expiry_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const firstLease = await store.leases.acquire(
        sessionId,
        "quarantine_expiry_owner_one",
        ttlMs,
      );
      expect(firstLease).not.toBeNull();
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          sessionId,
          toolId,
          toolVersion,
          requestHash,
          owner,
          ttlMs,
          lease: firstLease!,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await updateIdempotencyWithLeaseContext(
        pg,
        firstLease!,
        "UPDATE tvic_tool_idempotency SET expires_at_ms = -1 WHERE key = $1",
        [key],
      );
      const before = await pg.query(
        "SELECT status, owner, claimed_fence, claimed_generation_id, expires_at_ms, error FROM tvic_tool_idempotency WHERE key = $1",
        [key],
      );
      await store.leases.release(
        sessionId,
        firstLease!.holder,
        firstLease!.fence,
        firstLease!.generationId,
      );
      const secondLease = await store.leases.acquire(
        sessionId,
        "quarantine_expiry_owner_two",
        ttlMs,
      );
      expect(secondLease?.fence).toBe(firstLease!.fence + 1);

      await expect(
        store.toolIdempotencyStore.quarantine({
          key,
          sessionId,
          toolId,
          toolVersion,
          requestHash,
          owner,
          ttlMs,
          lease: secondLease!,
          error: providerError("tool.runtime_restarted", "interrupted call recovered"),
        }),
      ).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
      expect(
        (
          await pg.query(
            "SELECT status, owner, claimed_fence, claimed_generation_id, expires_at_ms, error FROM tvic_tool_idempotency WHERE key = $1",
            [key],
          )
        ).rows,
      ).toEqual(before.rows);
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]).catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });

  it("serializes cyclic errors on PostgreSQL update paths", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `error_update_${randomUUID()}` as SessionId;
    const turnId = `error_update_turn_${randomUUID()}` as TurnId;
    const toolCallId = `error_update_tool_${randomUUID()}` as ToolCallId;
    const timestamp = new Date().toISOString() as Timestamp;
    const cause: Record<string, unknown> = { source: "postgres-update" };
    cause.self = cause;
    const error = toolError("tool.execution_failed", "tool failed", { cause });
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `error_update_agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 1 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      await store.turns.put({
        turn: {
          id: turnId,
          sessionId,
          sequence: 1,
          status: "started",
          input: { transcript: "update error", mediaEventIds: [] },
          output: { text: "", mediaEventIds: [] },
          toolCallIds: [toolCallId],
          startedAt: timestamp,
          latency: {},
        },
        runtime: { monotonicStartedAtMs: 0 },
        version: 1,
      });
      await store.toolCalls.put({
        toolCall: {
          status: "running",
          toolCallId,
          toolId: `error_update_tool_id_${randomUUID()}` as ToolId,
          toolName: "error_update_tool" as ToolName,
          sessionId,
          turnId,
          input: {},
          attempts: 1,
          queuedAt: timestamp,
          startedAt: timestamp,
        },
        runtime: { monotonicQueuedAtMs: 0 },
        version: 1,
      });

      await store.turns.update(sessionId, turnId, (current) => ({
        ...current,
        turn: { ...current.turn, status: "failed", endedAt: timestamp, error },
      }));
      await store.toolCalls.update(sessionId, toolCallId, (current) => {
        if (current.toolCall.status !== "running") {
          throw new Error("Expected the stored tool call to be running");
        }
        return {
          ...current,
          toolCall: { ...current.toolCall, status: "failed", endedAt: timestamp, error },
        };
      });
      await store.sessions.update(sessionId, (current) => ({
        ...current,
        session: { ...current.session, metadata: { lastError: error } },
      }));

      await expect(store.turns.get(sessionId, turnId)).resolves.toMatchObject({
        turn: {
          status: "failed",
          error: { code: "tool.execution_failed", cause: { self: "[Circular]" } },
        },
      });
      await expect(store.toolCalls.get(sessionId, toolCallId)).resolves.toMatchObject({
        toolCall: {
          status: "failed",
          error: { code: "tool.execution_failed", cause: { self: "[Circular]" } },
        },
      });
      await expect(store.sessions.get(sessionId)).resolves.toMatchObject({
        session: { metadata: { lastError: { cause: { self: "[Circular]" } } } },
      });
    } finally {
      await sqlPool.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });

  it("atomically quarantines only a claim from an older lease and preserves live or terminal claims", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `quarantine_${randomUUID()}` as SessionId;
    const toolId = `quarantine_tool_${randomUUID()}` as ToolId;
    const timestamp = new Date().toISOString() as Timestamp;
    const ttlMs = 10_000;
    const requestHash = `hash_${randomUUID()}`;
    const owner = `tool_call_${randomUUID()}`;
    const error = toolError("tool.runtime_restarted", "The interrupted call will not be replayed");
    const keys = [
      `quarantine_claim_${randomUUID()}`,
      `quarantine_active_${randomUUID()}`,
      `quarantine_succeeded_${randomUUID()}`,
      `quarantine_legacy_${randomUUID()}`,
      `quarantine_same_fence_claim_${randomUUID()}`,
      `quarantine_same_fence_terminal_${randomUUID()}`,
      `quarantine_missing_claim_${randomUUID()}`,
    ];
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      const firstLease = await store.leases.acquire(sessionId, "quarantine_owner_one", ttlMs);
      expect(firstLease).not.toBeNull();
      const firstClaim = {
        key: keys[0]!,
        sessionId,
        toolId,
        toolVersion: "1.0.0",
        requestHash,
        owner,
        ttlMs,
        lease: firstLease!,
      };
      await store.toolIdempotencyStore.claim(firstClaim);
      await expect(
        store.toolIdempotencyStore.quarantine({ ...firstClaim, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { status: "claimed", owner } });
      await store.toolIdempotencyStore.claim({
        ...firstClaim,
        key: keys[4]!,
      });
      await store.toolIdempotencyStore.claim({
        ...firstClaim,
        key: keys[5]!,
      });

      await store.leases.release(
        sessionId,
        firstLease!.holder,
        firstLease!.fence,
        firstLease!.generationId,
      );
      const secondLease = await store.leases.acquire(sessionId, "quarantine_owner_two", ttlMs);
      expect(secondLease?.fence).toBe(firstLease!.fence + 1);
      const recoveryInput = { ...firstClaim, lease: secondLease! };
      await expect(
        store.toolIdempotencyStore.quarantine({ ...recoveryInput, error }),
      ).resolves.toMatchObject({ status: "quarantined", record: { status: "failed", owner } });
      await expect(
        store.toolIdempotencyStore.quarantine({
          ...recoveryInput,
          key: keys[6]!,
          owner: `recovered_${owner}`,
          error,
        }),
      ).resolves.toMatchObject({
        status: "quarantined",
        record: { status: "failed", owner: `recovered_${owner}` },
      });
      await expect(
        store.toolIdempotencyStore.lookup(firstClaim.key, requestHash, sessionId, secondLease!),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "failed", error: { code: "tool.runtime_restarted" } },
      });

      await expect(
        store.toolIdempotencyStore.claim({
          ...recoveryInput,
          key: keys[4]!,
          owner: `recovered_${owner}`,
        }),
      ).resolves.toMatchObject({
        status: "claimed",
        record: {
          claimedFence: secondLease!.fence,
          claimedGenerationId: secondLease!.generationId,
        },
      });

      await expect(
        store.toolIdempotencyStore.quarantine({
          ...recoveryInput,
          key: keys[5]!,
          error,
        }),
      ).resolves.toMatchObject({
        status: "quarantined",
        record: {
          status: "failed",
          claimedFence: secondLease!.fence,
          claimedGenerationId: secondLease!.generationId,
        },
      });

      const activeClaim = {
        ...recoveryInput,
        key: keys[1]!,
        owner: `tool_call_${randomUUID()}`,
      };
      await store.toolIdempotencyStore.claim(activeClaim);
      await expect(
        store.toolIdempotencyStore.quarantine({ ...activeClaim, owner, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { owner: activeClaim.owner } });
      await expect(
        store.toolIdempotencyStore.lookup(activeClaim.key, requestHash, sessionId, secondLease!),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "claimed", owner: activeClaim.owner },
      });

      const succeededClaim = {
        ...recoveryInput,
        key: keys[2]!,
        owner: `tool_call_${randomUUID()}`,
      };
      await store.toolIdempotencyStore.claim(succeededClaim);
      await store.toolIdempotencyStore.complete(succeededClaim.key, requestHash, {
        status: "succeeded",
        owner: succeededClaim.owner,
        ttlMs,
        lease: secondLease!,
        output: { reservation: "held" },
      });
      await expect(
        store.toolIdempotencyStore.quarantine({ ...succeededClaim, error }),
      ).resolves.toMatchObject({
        status: "succeeded",
        record: { output: { reservation: "held" } },
      });

      const legacyKey = keys[3]!;
      await store.toolIdempotencyStore.claim({
        ...recoveryInput,
        key: legacyKey,
      });
      await expect(
        store.toolIdempotencyStore.quarantine({ ...recoveryInput, key: legacyKey, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { status: "claimed", owner } });

      await store.leases.release(
        sessionId,
        secondLease!.holder,
        secondLease!.fence,
        secondLease!.generationId,
      );
      const thirdLease = await store.leases.acquire(sessionId, "quarantine_owner_three", ttlMs);
      expect(thirdLease?.fence).toBe(secondLease!.fence + 1);
      await expect(
        store.toolIdempotencyStore.quarantine({
          ...recoveryInput,
          lease: thirdLease!,
          key: legacyKey,
          error,
        }),
      ).resolves.toMatchObject({ status: "quarantined", record: { status: "failed", owner } });
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = ANY($1::text[])", [keys]);
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
      await pg.end();
    }
  }, 15_000);

  it("does not expose a cached idempotency result across lease sessions", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionA = `idem_scope_a_${randomUUID()}` as SessionId;
    const sessionB = `idem_scope_b_${randomUUID()}` as SessionId;
    const key = `idem_scope_${randomUUID()}`;
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      for (const sessionId of [sessionA, sessionB]) {
        await store.sessions.put({
          session: {
            id: sessionId,
            agentId: `agent_${randomUUID()}` as AgentId,
            status: "active",
            channel: "simulated",
            memoryRefs: [],
            createdAt: timestamp,
            startedAt: timestamp,
            state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
          },
          runtime: { monotonicStartedAtMs: 0 },
        });
      }
      const leaseA = await store.leases.acquire(sessionA, "idem_scope_owner_a", 10_000);
      const leaseB = await store.leases.acquire(sessionB, "idem_scope_owner_b", 10_000);
      expect(leaseA).not.toBeNull();
      expect(leaseB).not.toBeNull();
      const claimed = await store.toolIdempotencyStore.claim({
        key,
        requestHash: "same-request",
        owner: "tool_a",
        ttlMs: 10_000,
        lease: leaseA!,
      });
      expect(claimed.status).toBe("claimed");
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          requestHash: "same-request",
          owner: "tool_a",
          ttlMs: 10_000,
          lease: leaseA!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await store.toolIdempotencyStore.complete(key, "same-request", {
        status: "succeeded",
        owner: "tool_a",
        ttlMs: 10_000,
        lease: leaseA!,
        output: { tenant: "A" },
      });
      await expect(
        store.toolIdempotencyStore.complete(key, "same-request", {
          status: "succeeded",
          owner: "tool_a",
          ttlMs: 10_000,
          lease: leaseB!,
          output: { tenant: "B" },
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);

      const crossSession = await store.toolIdempotencyStore.claim({
        key,
        requestHash: "same-request",
        owner: "tool_b",
        ttlMs: 10_000,
        lease: leaseB!,
      });
      expect(crossSession.status).toBe("conflict");
      await expect(
        store.toolIdempotencyStore.claim({
          key,
          requestHash: "same-request",
          owner: "unfenced_caller",
          ttlMs: 10_000,
        }),
      ).resolves.toEqual({ status: "conflict" });
      await expect(
        store.toolIdempotencyStore.lookup(key, "different-request", sessionA),
      ).resolves.toEqual({ status: "conflict" });
      await expect(
        store.toolIdempotencyStore.lookup(key, "same-request", sessionB),
      ).resolves.toEqual({ status: "conflict" });
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]);
      await pg.query("DELETE FROM tvic_sessions WHERE id = ANY($1::text[])", [
        [sessionA, sessionB],
      ]);
      await pg.end();
    }
  }, 15_000);

  it("recovers a running idempotent tool with a one-connection PostgreSQL pool", async () => {
    const pg = new Pool({
      connectionString: process.env.DATABASE_URL ?? "",
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `idem_recovery_${randomUUID()}` as SessionId;
    const agentId = `agent_${randomUUID()}` as AgentId;
    const toolCallId = `tool_call_${randomUUID()}` as ToolCallId;
    const turnId = `turn_${randomUUID()}` as TurnId;
    const timestamp = new Date().toISOString() as Timestamp;
    const tool = defineTool({
      id: `recovery_tool_${randomUUID()}`,
      name: "recovery_tool",
      description: "A tool whose completed side effect can be replayed after a crash.",
      inputSchema: { type: "object", properties: { reservation: { type: "string" } } },
      idempotency: { enabled: true, keyTemplate: "{input}", ttlMs: 10_000 },
      async execute() {
        throw new Error("recovery must replay the stored result without executing the tool");
      },
    });
    const capabilities = {
      streaming: { input: true, output: true, native: true },
      cancellation: { request: true, output: true, buffer: true, truncation: true },
      transports: ["websocket"],
      audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
      tools: { functionCalling: true, parallelCalls: true },
      playout: { clearBuffer: true, acknowledgement: true, position: true },
    } satisfies ProviderCapabilities;
    const providers = {
      telephony: {
        name: "recovery-test-telephony",
        kind: "telephony",
        version: "0.1.0",
        capabilities,
        async dial() {
          throw new Error("unused in recovery integration test");
        },
        async accept() {
          throw new Error("unused in recovery integration test");
        },
        async hangup() {},
      },
      stt: {
        name: "recovery-test-stt",
        kind: "stt",
        version: "0.1.0",
        capabilities,
        async open() {
          throw new Error("unused in recovery integration test");
        },
      },
      llm: {
        name: "recovery-test-llm",
        kind: "llm",
        version: "0.1.0",
        capabilities,
        async complete() {
          throw new Error("unused in recovery integration test");
        },
      },
    } satisfies AgentProviders;
    const agent: Agent = defineAgent({
      id: agentId,
      name: "Recovery integration agent",
      instructions: "This test exercises durable recovery without starting a voice loop.",
      tools: [tool],
      providers,
      audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
      memoryPolicy: { enabled: false, scopes: [] },
    });
    const input = { reservation: "r1" };
    const runningToolCall = {
      status: "running",
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId,
      turnId,
      input,
      attempts: 1,
      queuedAt: timestamp,
      startedAt: timestamp,
    } as const;
    const storedToolCall: StoredToolCallRecord = {
      toolCall: runningToolCall,
      runtime: { monotonicQueuedAtMs: 0 },
      version: 1,
    };
    const idempotencyInput = { tool, input, sessionId, turnId, toolCallId };
    const key = idempotencyKeyFor(idempotencyInput);
    if (!key) throw new Error("expected the recovery tool to have an idempotency key");
    const requestHash = idempotencyRequestHashFor(idempotencyInput);
    const runtime = createRuntime({ durableStore: store, durableStoreOwnership: "caller" });
    let attached: Awaited<ReturnType<typeof runtime.attachSession>> | undefined;
    try {
      await runPostgresMigrations(sqlPool);
      const storedSession: StoredSessionRecord = {
        session: {
          id: sessionId,
          agentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [toolCallId], turnSequence: 1 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      };
      const storedTurn: StoredTurnRecord = {
        turn: {
          id: turnId,
          sessionId,
          sequence: 1,
          status: "completed",
          input: { transcript: "recovery", mediaEventIds: [] },
          output: { text: "", mediaEventIds: [] },
          toolCallIds: [toolCallId],
          startedAt: timestamp,
          endedAt: timestamp,
          latency: {},
        },
        runtime: { monotonicStartedAtMs: 0 },
        version: 1,
      };
      await store.sessions.put(storedSession);
      await store.turns.put(storedTurn);
      await store.toolCalls.put(storedToolCall);
      const preRecoveryLease = await store.leases.acquire(
        sessionId,
        `pre_recovery_${randomUUID()}`,
        10_000,
      );
      expect(preRecoveryLease).not.toBeNull();
      const claimed = await store.toolIdempotencyStore.claim({
        key,
        sessionId,
        lease: preRecoveryLease!,
        toolId: tool.id,
        toolVersion: tool.version,
        requestHash,
        owner: toolCallId,
        ttlMs: 10_000,
      });
      expect(claimed.status).toBe("claimed");
      await store.toolIdempotencyStore.complete(key, requestHash, {
        status: "succeeded",
        sessionId,
        owner: toolCallId,
        ttlMs: 10_000,
        lease: preRecoveryLease!,
        output: { confirmed: true },
      });
      await store.leases.release(
        sessionId,
        preRecoveryLease!.holder,
        preRecoveryLease!.fence,
        preRecoveryLease!.generationId,
      );

      await runtime.start();
      attached = await runtime.attachSession(agent, sessionId, {
        holderId: `recovery_${randomUUID()}`,
      });
      expect(
        attached.snapshot.toolCalls.find((call) => call.toolCallId === toolCallId),
      ).toMatchObject({
        status: "succeeded",
        output: { confirmed: true },
        metadata: { recovery: "idempotent_replay", idempotentHit: true },
      });
    } finally {
      await attached?.detach().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
      try {
        await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]);
        await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]);
        await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
      } finally {
        await pg.end();
      }
    }
  }, 15_000);

  it("checks idempotency expiry after row-lock waits", async () => {
    const applicationName = `tvic_idem_expiry_${randomUUID().replaceAll("-", "")}`;
    const pg = new Pool({
      connectionString: process.env.DATABASE_URL ?? "",
      application_name: applicationName,
      max: 8,
    });
    const store = createPostgresDurableRuntimeStore({ pool: adaptPool(pg) });
    const claimKey = `idem_expiry_claim_${randomUUID()}`;
    const completeKey = `idem_expiry_complete_${randomUUID()}`;
    const blocker = await pg.connect();
    let blockerTransactionOpen = false;
    let takeover: Promise<ToolIdempotencyClaimResult> | undefined;
    let completion: Promise<void> | undefined;

    try {
      await runPostgresMigrations(adaptPool(pg));
      const originalClaim = await store.toolIdempotencyStore.claim({
        key: claimKey,
        requestHash: "request-hash",
        owner: "original-owner",
        ttlMs: 1_500,
      });
      expect(originalClaim.status).toBe("claimed");
      if (originalClaim.status !== "claimed") {
        throw new Error("initial idempotency claim was not acquired");
      }

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query("SELECT key FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE", [
        claimKey,
      ]);
      takeover = store.toolIdempotencyStore.claim({
        key: claimKey,
        requestHash: "request-hash",
        owner: "replacement-owner",
        ttlMs: 10_000,
      });
      await waitForIdempotencyRowLockWait(pg, applicationName);
      await waitUntilDatabaseTime(blocker, originalClaim.record.expiresAtMs);
      await blocker.query("COMMIT");
      blockerTransactionOpen = false;
      await expect(takeover).resolves.toMatchObject({
        status: "claimed",
        record: { owner: "replacement-owner" },
      });
      takeover = undefined;

      const initialCompletionClaim = await store.toolIdempotencyStore.claim({
        key: completeKey,
        requestHash: "complete-hash",
        owner: "completion-owner",
        ttlMs: 1_500,
      });
      expect(initialCompletionClaim.status).toBe("claimed");
      if (initialCompletionClaim.status !== "claimed") {
        throw new Error("initial completion claim was not acquired");
      }

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query("SELECT key FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE", [
        completeKey,
      ]);
      completion = store.toolIdempotencyStore.complete(completeKey, "complete-hash", {
        status: "succeeded",
        owner: "completion-owner",
        ttlMs: 10_000,
        output: { ok: true },
      });
      await waitForIdempotencyRowLockWait(pg, applicationName);
      await waitUntilDatabaseTime(blocker, initialCompletionClaim.record.expiresAtMs);
      await blocker.query("COMMIT");
      blockerTransactionOpen = false;
      await expect(completion).rejects.toBeInstanceOf(RecordConflictError);
      completion = undefined;
    } finally {
      if (blockerTransactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.all([takeover?.catch(() => undefined), completion?.catch(() => undefined)]);
      blocker.release();
      try {
        await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = ANY($1::text[])", [
          [claimKey, completeKey],
        ]);
      } finally {
        await pg.end();
      }
    }
  }, 15_000);

  it("checks lease expiry after row-lock waits before renew, claims, or fenced work", async () => {
    const applicationName = `tvic_lease_expiry_${randomUUID().replaceAll("-", "")}`;
    const pg = new Pool({
      connectionString: process.env.DATABASE_URL ?? "",
      application_name: applicationName,
      max: 8,
    });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `lease_expiry_lock_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    const blocker = await pg.connect();
    let sessionCreated = false;
    let renewal: Promise<SessionLease | null> | undefined;
    let read: Promise<SessionLease | null> | undefined;
    let transaction: Promise<void> | undefined;
    let claim: Promise<ToolIdempotencyClaimResult> | undefined;
    let completion: Promise<void> | undefined;
    let pendingOperations: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let callbackRan = false;
    let blockerTransactionOpen = false;

    try {
      await runPostgresMigrations(sqlPool);
      const indexes = await pg.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname IN (
             'tvic_session_leases_recovery_expiry_idx',
             'tvic_session_leases_expiry_idx'
           )`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        "tvic_session_leases_recovery_expiry_idx",
      );
      expect(indexes.rows.map((row) => row.indexname)).not.toContain(
        "tvic_session_leases_expiry_idx",
      );
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      sessionCreated = true;
      const lease = await store.leases.acquire(sessionId, "lock_wait_owner", 2_000);
      expect(lease).not.toBeNull();
      const completionKey = `lease_expiry_complete_${randomUUID()}`;
      const completionHash = `completion_${randomUUID()}`;
      await expect(
        store.toolIdempotencyStore.claim({
          key: completionKey,
          requestHash: completionHash,
          owner: "lock_wait_owner",
          ttlMs: 10_000,
          lease: lease!,
        }),
      ).resolves.toMatchObject({ status: "claimed" });

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        "SELECT session_id FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
        [sessionId],
      );
      renewal = store.leases.renew(
        sessionId,
        lease!.holder,
        lease!.fence,
        10_000,
        lease!.generationId,
      );
      read = store.leases.get(sessionId);
      transaction = store.runSessionTransaction(sessionId, lease!, async () => {
        callbackRan = true;
      });
      const claimKey = `lease_expiry_claim_${randomUUID()}`;
      const claimHash = `claim_${randomUUID()}`;
      claim = store.toolIdempotencyStore.claim({
        key: claimKey,
        requestHash: claimHash,
        owner: "lock_wait_owner",
        ttlMs: 10_000,
        lease: lease!,
      });
      completion = store.toolIdempotencyStore.complete(completionKey, completionHash, {
        status: "succeeded",
        owner: "lock_wait_owner",
        ttlMs: 10_000,
        lease: lease!,
        output: { ok: true },
      });
      pendingOperations = Promise.allSettled([renewal, read, transaction, claim, completion]);

      await waitForLeaseRowLockWait(pg, applicationName, 5);
      const clock = await blocker.query<{ now_ms: number | string }>(
        "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms",
      );
      expect(lease!.expiresAtMs).toBeGreaterThan(Number(clock.rows[0]?.now_ms));
      const waitMs = Math.max(0, lease!.expiresAtMs - Number(clock.rows[0]?.now_ms) + 25);
      await blocker.query("SELECT pg_sleep($1::double precision)", [waitMs / 1_000]);
      await blocker.query("COMMIT");
      blockerTransactionOpen = false;

      const [renewalResult, readResult, transactionResult, claimResult, completionResult] =
        await pendingOperations;
      expect(renewalResult).toMatchObject({ status: "fulfilled", value: null });
      expect(readResult).toMatchObject({ status: "fulfilled", value: null });
      expect(transactionResult).toMatchObject({
        status: "rejected",
        reason: expect.any(LeaseLostError),
      });
      expect(claimResult).toMatchObject({
        status: "rejected",
        reason: expect.any(LeaseLostError),
      });
      expect(completionResult).toMatchObject({
        status: "rejected",
        reason: expect.any(LeaseLostError),
      });
      expect(callbackRan).toBe(false);
      await expect(store.toolIdempotencyStore.lookup(claimKey, claimHash)).resolves.toEqual({
        status: "missing",
      });
      await expect(
        pg.query<{ status: string }>("SELECT status FROM tvic_tool_idempotency WHERE key = $1", [
          completionKey,
        ]),
      ).resolves.toMatchObject({ rows: [{ status: "claimed" }] });
    } finally {
      if (blockerTransactionOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      if (pendingOperations) await pendingOperations;
      blocker.release();
      try {
        if (sessionCreated) await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
      } finally {
        await pg.end();
      }
    }
  }, 10_000);

  it("rotates generations when an older writer advances a lease fence", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `legacy_writer_generation_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    let sessionCreated = false;
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put({
        session: {
          id: sessionId,
          agentId: `agent_${randomUUID()}` as AgentId,
          status: "active",
          channel: "simulated",
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0 },
      });
      sessionCreated = true;
      const initial = await store.leases.acquire(sessionId, "old_writer", 60_000);
      expect(initial).not.toBeNull();

      await pg.query(
        `UPDATE tvic_session_leases
         SET recovery_acknowledged_fence = $2,
             recovery_acknowledged_generation_id = $3
         WHERE session_id = $1`,
        [sessionId, initial!.fence, initial!.generationId],
      );

      await pg.query(
        `UPDATE tvic_session_leases
         SET fence = fence + 1,
             holder = $2,
             expires_at_ms = $3,
             recovery_acknowledged_fence = NULL
         WHERE session_id = $1`,
        [sessionId, "old_writer_next_generation", Date.now() + 60_000],
      );
      const upgraded = await store.leases.get(sessionId);
      expect(upgraded?.fence).toBe(initial!.fence + 1);
      expect(upgraded?.generationId).not.toBe(initial!.generationId);

      await store.leases.release(
        sessionId,
        "old_writer_next_generation",
        upgraded!.fence,
        upgraded!.generationId,
      );
      const candidate = await findRecoveryCandidate(store, sessionId);
      expect(candidate).toMatchObject({
        sessionId,
        fence: upgraded!.fence,
        generationId: upgraded!.generationId,
      });
    } finally {
      try {
        if (sessionCreated) await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
      } finally {
        await pg.end();
      }
    }
  });

  it("pages equal-expiry candidates with an opaque expiry-and-ID cursor", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const suffix = randomUUID();
    const sessionIds = ["a", "b", "c", "d", "e"].map(
      (letter) => `recovery_page_${suffix}_${letter}` as SessionId,
    );
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      for (const sessionId of sessionIds) {
        await store.sessions.put({
          session: {
            id: sessionId,
            agentId: `agent_${randomUUID()}` as AgentId,
            status: "active",
            channel: "simulated",
            memoryRefs: [],
            createdAt: timestamp,
            startedAt: timestamp,
            state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
          },
          runtime: { monotonicStartedAtMs: 0 },
        });
        expect(await store.leases.acquire(sessionId, "page_holder", 60_000)).not.toBeNull();
      }
      await pg.query(
        "UPDATE tvic_session_leases SET expires_at_ms = 1 WHERE session_id = ANY($1::text[])",
        [sessionIds],
      );

      const candidates: SessionRecoveryCandidate[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.leases.listRecoveryCandidates({
          nowMs: Date.now(),
          limit: 2,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        candidates.push(...page.candidates);
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      const fixtureCandidates = candidates.filter((candidate) =>
        sessionIds.includes(candidate.sessionId),
      );
      expect(fixtureCandidates.map((candidate) => candidate.sessionId)).toEqual(sessionIds);
      expect(fixtureCandidates.every((candidate) => candidate.generationId.length > 0)).toBe(true);
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 2, cursor: "bad-cursor" }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    } finally {
      await pg.query("DELETE FROM tvic_sessions WHERE id = ANY($1::text[])", [sessionIds]);
      await pg.end();
    }
  });

  it("advances past an empty session ID and reports it as corrupt", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const validSessionId = `after_empty_recovery_cursor_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    let insertedEmptySession = false;
    const sessionPayload = (id: string) => ({
      id,
      agentId: `agent_${randomUUID()}` as AgentId,
      status: "active",
      channel: "simulated",
      memoryRefs: [],
      createdAt: timestamp,
      startedAt: timestamp,
      state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
    });
    try {
      await runPostgresMigrations(sqlPool);
      for (const id of ["", validSessionId]) {
        const inserted = await pg.query(
          `INSERT INTO tvic_sessions
             (id, agent_id, status, created_at, payload, runtime, last_activity_at)
           VALUES ($1, $2, 'active', NOW(), $3::jsonb, '{}'::jsonb, NOW())
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [id, `agent_${randomUUID()}`, JSON.stringify(sessionPayload(id))],
        );
        expect(inserted.rowCount).toBe(1);
        if (id === "") insertedEmptySession = true;
      }
      await pg.query(
        `INSERT INTO tvic_session_leases
           (session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms)
         VALUES ('', 'corrupt_empty_id', 1, gen_random_uuid(), 0, 0, -9223372036854775808),
                ($1, 'valid_after_empty_id', 1, gen_random_uuid(), 0, 0, 1)`,
        [validSessionId],
      );

      const firstPage = await store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 1 });
      expect(firstPage.corruptLeaseSessionIds).toContain("");
      expect(firstPage.nextCursor).toBeDefined();

      let cursor = firstPage.nextCursor;
      const candidates = [...firstPage.candidates];
      while (
        cursor !== undefined &&
        !candidates.some(({ sessionId }) => sessionId === validSessionId)
      ) {
        const page = await store.leases.listRecoveryCandidates({
          nowMs: Date.now(),
          limit: 1,
          cursor,
        });
        candidates.push(...page.candidates);
        cursor = page.nextCursor;
      }
      expect(candidates).toContainEqual(
        expect.objectContaining({ sessionId: validSessionId, fence: 1 }),
      );
    } finally {
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [validSessionId]);
      if (insertedEmptySession) await pg.query("DELETE FROM tvic_sessions WHERE id = ''");
      await pg.end();
    }
  });

  it("persists acknowledgments per expired generation and ignores stale acknowledgments", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const sessionId = `recovery_disposition_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
    };
    let sessionCreated = false;
    try {
      await runPostgresMigrations(sqlPool);
      await store.sessions.put(record);
      sessionCreated = true;

      const firstLease = await store.leases.acquire(sessionId, "first_holder", 60_000);
      expect(firstLease).not.toBeNull();
      await store.leases.release(
        sessionId,
        "first_holder",
        firstLease!.fence,
        firstLease!.generationId,
      );
      const firstCandidate = await findRecoveryCandidate(store, sessionId);
      expect(firstCandidate).toMatchObject({ sessionId, fence: firstLease!.fence });
      expect(firstCandidate?.generationId).toBe(firstLease!.generationId);

      await store.leases.acknowledgeRecoveryCandidate(firstCandidate!);
      await store.leases.release(
        sessionId,
        "first_holder",
        firstLease!.fence,
        firstLease!.generationId,
      );
      await expect(findRecoveryCandidate(store, sessionId)).resolves.toBeUndefined();

      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
      sessionCreated = false;
      await store.sessions.put(record);
      sessionCreated = true;

      const replacementLease = await store.leases.acquire(sessionId, "first_holder", 60_000);
      expect(replacementLease?.fence).toBe(firstLease!.fence);
      expect(replacementLease?.generationId).not.toBe(firstLease!.generationId);
      await expect(
        store.leases.renew(
          sessionId,
          "first_holder",
          firstLease!.fence,
          60_000,
          firstLease!.generationId,
        ),
      ).resolves.toBeNull();
      await store.leases.release(
        sessionId,
        "first_holder",
        firstLease!.fence,
        firstLease!.generationId,
      );
      await expect(store.leases.get(sessionId)).resolves.toMatchObject({
        generationId: replacementLease!.generationId,
      });
      await expect(
        store.runSessionTransaction(sessionId, firstLease!, async () => undefined),
      ).rejects.toBeInstanceOf(LeaseLostError);
      await store.leases.release(
        sessionId,
        "first_holder",
        replacementLease!.fence,
        replacementLease!.generationId,
      );
      const replacementCandidate = await findRecoveryCandidate(store, sessionId);
      expect(replacementCandidate).toMatchObject({
        sessionId,
        fence: replacementLease!.fence,
      });
      expect(replacementCandidate?.generationId).toBe(replacementLease!.generationId);
      expect(replacementLease!.generationId).not.toBe(firstLease!.generationId);

      await store.leases.acknowledgeRecoveryCandidate(firstCandidate!);
      await expect(findRecoveryCandidate(store, sessionId)).resolves.toMatchObject({
        sessionId,
        fence: replacementLease!.fence,
        generationId: replacementLease!.generationId,
      });

      await store.leases.acknowledgeRecoveryCandidate(replacementCandidate!);
      await expect(findRecoveryCandidate(store, sessionId)).resolves.toBeUndefined();

      const secondLease = await store.leases.acquire(sessionId, "second_holder", 60_000);
      expect(secondLease?.fence).toBe(replacementLease!.fence + 1);
      await store.leases.release(
        sessionId,
        "second_holder",
        secondLease!.fence,
        secondLease!.generationId,
      );
      const secondCandidate = await findRecoveryCandidate(store, sessionId);
      expect(secondCandidate).toMatchObject({ sessionId, fence: secondLease!.fence });
      expect(secondCandidate?.generationId).toBe(secondLease!.generationId);

      await store.leases.acknowledgeRecoveryCandidate(replacementCandidate!);
      await expect(findRecoveryCandidate(store, sessionId)).resolves.toMatchObject({
        sessionId,
        fence: secondLease!.fence,
        generationId: secondLease!.generationId,
      });
    } finally {
      try {
        if (sessionCreated) await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);
      } finally {
        await pg.end();
      }
    }
  });

  it("reports corrupt expired recovery rows and advances the cursor past them", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const ids = [0, 1, 2, 3].map(
      (index) => `recovery_timestamp_${index}_${randomUUID()}` as SessionId,
    );
    const timestamp = new Date().toISOString() as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      for (const sessionId of ids) {
        await store.sessions.put({
          session: {
            id: sessionId,
            agentId: `recovery_timestamp_agent_${randomUUID()}` as AgentId,
            status: "active",
            channel: "simulated",
            memoryRefs: [],
            createdAt: timestamp,
            startedAt: timestamp,
            state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
          },
          runtime: { monotonicStartedAtMs: 0 },
        });
        await store.leases.acquire(sessionId, `recovery_timestamp_holder_${sessionId}`, 60_000);
      }
      const expiredAtMs = Date.now() - 10_000;
      await pg.query(
        `UPDATE tvic_session_leases
         SET acquired_at_ms = $2, renewed_at_ms = $3, expires_at_ms = $4
         WHERE session_id = $1`,
        [ids[0], "9007199254740992", expiredAtMs - 1, "-1"],
      );
      await pg.query(
        `UPDATE tvic_session_leases
         SET acquired_at_ms = $2, renewed_at_ms = $3, expires_at_ms = $4
         WHERE session_id = $1`,
        [ids[1], expiredAtMs - 5, "9007199254740992", expiredAtMs - 3],
      );
      await pg.query(
        `UPDATE tvic_session_leases
         SET acquired_at_ms = $2, renewed_at_ms = $2, expires_at_ms = $3
         WHERE session_id = $1`,
        [ids[2], expiredAtMs - 6, expiredAtMs - 2],
      );
      await pg.query(
        `UPDATE tvic_session_leases SET fence = $2, expires_at_ms = $3 WHERE session_id = $1`,
        [ids[3], "9007199254740992", expiredAtMs - 1],
      );

      const corruptIds = new Set<SessionId>();
      const candidateIds = new Set<SessionId>();
      let cursor: string | undefined;
      let firstCorruptCursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await store.leases.listRecoveryCandidates({
          nowMs: Date.now(),
          limit: 1,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const sessionId of page.corruptLeaseSessionIds ?? []) corruptIds.add(sessionId);
        for (const candidate of page.candidates) candidateIds.add(candidate.sessionId);
        if (corruptIds.has(ids[0]!)) firstCorruptCursor = page.nextCursor;
        if (corruptIds.has(ids[3]!) || page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }

      expect(firstCorruptCursor).toBeDefined();
      expect(corruptIds).toEqual(new Set([ids[0], ids[1], ids[3]]));
      expect(candidateIds).toContain(ids[2]);
    } finally {
      await pg.query("DELETE FROM tvic_sessions WHERE id = ANY($1::text[])", [ids]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });

  it("allows an identical retry after persisting a custom provider error", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 4 });
    const sqlPool = adaptPool(pg);
    const store = createPostgresDurableRuntimeStore({ pool: sqlPool });
    const key = `custom_error_${randomUUID()}`;
    const requestHash = "custom-provider-error";
    const outcome = {
      owner: "custom_error_owner",
      status: "failed" as const,
      ttlMs: 60_000,
      error: providerError("vendor.operation_failed", "Provider failed", {
        retriable: true,
        metadata: {
          api_key: "secret-value",
          details: `upstream returned Bearer pg-error-token-${key}; Incorrect API key provided: pg-openai-key-${key}`,
        },
        cause: `Authorization: Bearer pg-message-token-${key}`,
      }),
    };
    try {
      await runPostgresMigrations(sqlPool);
      await expect(
        store.toolIdempotencyStore.claim({ key, requestHash, owner: outcome.owner, ttlMs: 60_000 }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.toolIdempotencyStore.complete(key, requestHash, outcome);
      await expect(store.toolIdempotencyStore.complete(key, requestHash, outcome)).resolves.toBe(
        undefined,
      );
      const persisted = await pg.query<{ error: Record<string, unknown> }>(
        "SELECT error FROM tvic_tool_idempotency WHERE key = $1",
        [key],
      );
      expect(persisted.rows[0]?.error.retriable).toBe(true);
      expect(JSON.stringify(persisted.rows[0]?.error)).not.toContain("secret-value");
      expect(JSON.stringify(persisted.rows[0]?.error)).not.toContain(`pg-error-token-${key}`);
      expect(JSON.stringify(persisted.rows[0]?.error)).not.toContain(`pg-openai-key-${key}`);
      expect(JSON.stringify(persisted.rows[0]?.error)).not.toContain(`pg-message-token-${key}`);
      await expect(store.toolIdempotencyStore.lookup(key, requestHash)).resolves.toMatchObject({
        status: "found",
        record: { error: { retriable: false } },
      });
    } finally {
      await pg.query("DELETE FROM tvic_tool_idempotency WHERE key = $1", [key]).catch(() => {});
      await store.close();
      await pg.end();
    }
  });
});

async function findRecoveryCandidate(
  store: {
    readonly leases: {
      listRecoveryCandidates(options: {
        readonly nowMs: number;
        readonly limit: number;
        readonly cursor?: string;
      }): Promise<{
        readonly candidates: readonly SessionRecoveryCandidate[];
        readonly nextCursor?: string;
      }>;
    };
  },
  sessionId: SessionId,
): Promise<SessionRecoveryCandidate | undefined> {
  const nowMs = Date.now();
  let cursor: string | undefined;
  do {
    const page = await store.leases.listRecoveryCandidates({
      nowMs,
      limit: 1_000,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const candidate = page.candidates.find((entry) => entry.sessionId === sessionId);
    if (candidate) return candidate;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

async function waitForLeaseRowLockWait(
  pg: Pool,
  applicationName: string,
  expectedWaiters: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastActivity: readonly Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    const result = await pg.query<Record<string, unknown>>(
      `SELECT pid, application_name, state, wait_event_type, wait_event, query
       FROM pg_stat_activity
       WHERE application_name = $1`,
      [applicationName],
    );
    lastActivity = result.rows;
    const waiters = result.rows.filter(
      (row) =>
        row.state === "active" &&
        row.wait_event_type === "Lock" &&
        (String(row.query).includes("tvic_session_leases") ||
          String(row.query).includes("tvic_sessions")),
    );
    if (waiters.length >= expectedWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${expectedWaiters} PostgreSQL lease row locks: ${JSON.stringify(lastActivity)}`,
  );
}

async function waitForIdempotencyRowLockWait(pg: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastActivity: readonly Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    const result = await pg.query<Record<string, unknown>>(
      `SELECT pid, application_name, state, wait_event_type, wait_event, query
       FROM pg_stat_activity
       WHERE application_name = $1`,
      [applicationName],
    );
    lastActivity = result.rows;
    const waiting = result.rows.some(
      (row) =>
        row.state === "active" &&
        row.wait_event_type === "Lock" &&
        String(row.query).includes("tvic_tool_idempotency"),
    );
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for PostgreSQL idempotency row lock: ${JSON.stringify(lastActivity)}`,
  );
}

async function waitUntilDatabaseTime(client: PoolClient, expiresAtMs: number): Promise<void> {
  const result = await client.query<{ now_ms: number | string }>(
    "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  const remainingMs = Math.max(0, expiresAtMs - Number(result.rows[0]?.now_ms) + 25);
  if (remainingMs > 0) {
    await client.query("SELECT pg_sleep($1::double precision)", [remainingMs / 1_000]);
  }
}

async function waitForDeliveredOutboxEvent(pool: Pool, eventId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ delivered_at: Date | string | null }>(
      "SELECT delivered_at FROM tvic_outbox WHERE id = $1",
      [eventId],
    );
    if (result.rows[0]?.delivered_at != null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Outbox event was not delivered: ${eventId}`);
}

describe.skipIf(!integrationEnabled)("real PostgreSQL + Redis durability", () => {
  it("rebuilds a tombstoned session projection before delivering its outbox event", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const sqlPool = adaptPool(pg);
    const prefix = `tvic:test:tombstone-outbox-retry:${randomUUID()}:`;
    const store = createPostgresRedisDurableRuntimeStore({
      pool: sqlPool,
      redis: adaptRedis(redis),
      redisOptions: { prefix },
    });
    const sessionId = `tombstone_retry_${randomUUID()}` as SessionId;
    const turnId = `tombstone_retry_turn_${randomUUID()}` as TurnId;
    const toolCallId = `tombstone_retry_tool_${randomUUID()}` as ToolCallId;
    const eventId = `tombstone_retry_event:${randomUUID()}`;
    const timestamp = new Date().toISOString() as Timestamp;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `tombstone_retry_agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
      version: 1,
    };
    const sessionKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const turnKey = `${prefix}turn:${encodeURIComponent(sessionId)}:${encodeURIComponent(turnId)}`;
    const toolKey = `${prefix}tool_call:${encodeURIComponent(sessionId)}:${encodeURIComponent(toolCallId)}`;
    let outboxEvent: DurableOutboxEvent | undefined;
    try {
      await runPostgresMigrations(sqlPool);
      const lease = await store.createSessionWithLease(
        record,
        "tombstone_retry_owner",
        60_000,
        (owned) => {
          const event: DurableOutboxEvent = {
            id: eventId,
            aggregateType: "session",
            aggregateId: sessionId,
            sessionId,
            version: 1,
            fence: owned.fence,
            envelope: {
              kind: "session",
              schemaVersion: 1,
              payload: record.session,
              runtime: record.runtime,
              version: 1,
            },
          };
          outboxEvent = event;
          return event;
        },
      );
      expect(lease).not.toBeNull();
      expect(outboxEvent).toBeDefined();
      const createdEvent = outboxEvent!;
      const turnRecord: StoredTurnRecord = {
        turn: {
          id: turnId,
          sessionId,
          sequence: 1,
          status: "completed",
          input: { transcript: "retry input", mediaEventIds: [] },
          output: { text: "retry output", mediaEventIds: [] },
          toolCallIds: [toolCallId],
          startedAt: timestamp,
          endedAt: timestamp,
          latency: {},
        },
        runtime: { monotonicStartedAtMs: 0 },
        version: 1,
      };
      const toolCallRecord: StoredToolCallRecord = {
        toolCall: {
          status: "running",
          toolCallId,
          toolId: `tombstone_retry_tool_id_${randomUUID()}` as ToolId,
          toolName: "tombstone_retry_tool" as ToolName,
          sessionId,
          turnId,
          input: { payload: "retry" },
          attempts: 1,
          queuedAt: timestamp,
          startedAt: timestamp,
        },
        runtime: { monotonicQueuedAtMs: 0 },
        version: 1,
      };
      await store.primary.turns.put(turnRecord);
      await store.primary.toolCalls.put(toolCallRecord);
      const identityResult = await pg.query<{
        incarnation: number | string;
        version: number | string;
        last_fence: number | string;
      }>("SELECT incarnation, version, last_fence FROM tvic_sessions WHERE id = $1", [sessionId]);
      const identity = {
        sessionId,
        incarnation: Number(identityResult.rows[0]?.incarnation),
        version: Number(identityResult.rows[0]?.version),
        fence: Number(identityResult.rows[0]?.last_fence),
      };
      const purgeToken = `retry:${randomUUID()}`;
      await store.cacheProjector.purgeSession(identity, purgeToken);
      await expect(
        store.cacheProjector.apply({ ...createdEvent, sessionIncarnation: identity.incarnation }),
      ).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });

      store.startOutboxWorker({ workerId: `tombstone_retry_worker_${randomUUID()}` });
      await waitForDeliveredOutboxEvent(pg, createdEvent.id);
      expect(JSON.parse((await redis.get(sessionKey))!).payload).toMatchObject({ id: sessionId });
      await expect(
        new RedisTurnStore(adaptRedis(redis), { prefix }).listBySession(sessionId),
      ).resolves.toMatchObject([{ turn: { id: turnId } }]);
      await expect(
        new RedisToolCallStore(adaptRedis(redis), { prefix }).listBySession(sessionId),
      ).resolves.toMatchObject([{ toolCall: { toolCallId } }]);
    } finally {
      await store.stopOutboxWorker();
      await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]).catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await redis
        .del([
          sessionKey,
          `${sessionKey}:cache_meta`,
          turnKey,
          `${turnKey}:cache_meta`,
          toolKey,
          `${toolKey}:cache_meta`,
          `${prefix}sessions`,
          `${prefix}session:${encodeURIComponent(sessionId)}:turns`,
          `${prefix}session:${encodeURIComponent(sessionId)}:tools`,
        ])
        .catch(() => 0);
      await store.close();
      await redis.quit();
      await pg.end();
    }
  }, 15_000);

  it("restores the session and child cache projections when retention rolls back", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const sqlPool = adaptPool(pg);
    const prefix = `tvic:test:retention-rollback:${randomUUID()}:`;
    const store = createPostgresRedisDurableRuntimeStore({
      pool: sqlPool,
      redis: adaptRedis(redis),
      redisOptions: { prefix },
    });
    const suffix = randomUUID().replaceAll("-", "");
    const triggerName = `tvic_test_retention_${suffix}`;
    const functionName = `tvic_test_retention_fn_${suffix}`;
    const sessionId = `retention_rollback_${randomUUID()}` as SessionId;
    const turnId = `retention_turn_${randomUUID()}` as TurnId;
    const toolCallId = `retention_tool_${randomUUID()}` as ToolCallId;
    const timestamp = "2000-01-01T00:00:00.000Z" as Timestamp;
    const sessionRecord: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `retention_rollback_agent_${randomUUID()}` as AgentId,
        status: "completed",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        endedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [toolCallId], turnSequence: 1 },
      },
      runtime: { monotonicStartedAtMs: 0 },
      version: 1,
    };
    const turnRecord: StoredTurnRecord = {
      turn: {
        id: turnId,
        sessionId,
        sequence: 1,
        status: "completed",
        input: { transcript: "retention input", mediaEventIds: [] },
        output: { text: "retention output", mediaEventIds: [] },
        toolCallIds: [toolCallId],
        startedAt: timestamp,
        endedAt: timestamp,
        latency: {},
      },
      runtime: { monotonicStartedAtMs: 0 },
      version: 1,
    };
    const toolCallRecord: StoredToolCallRecord = {
      toolCall: {
        status: "running",
        toolCallId,
        toolId: `retention_tool_${randomUUID()}` as ToolId,
        toolName: "retention_tool" as ToolName,
        sessionId,
        turnId,
        input: { payload: "retention" },
        attempts: 1,
        queuedAt: timestamp,
        startedAt: timestamp,
      },
      runtime: { monotonicQueuedAtMs: 0 },
      version: 1,
    };
    const sessionKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const turnKey = `${prefix}turn:${encodeURIComponent(sessionId)}:${encodeURIComponent(turnId)}`;
    const toolKey = `${prefix}tool_call:${encodeURIComponent(sessionId)}:${encodeURIComponent(toolCallId)}`;
    try {
      await runPostgresMigrations(sqlPool);
      await store.primary.sessions.put(sessionRecord);
      await store.primary.turns.put(turnRecord);
      await store.primary.toolCalls.put(toolCallRecord);
      const identity = await pg.query<{ incarnation: string; last_fence: string }>(
        "SELECT incarnation, last_fence FROM tvic_sessions WHERE id = $1",
        [sessionId],
      );
      const incarnation = Number(identity.rows[0]?.incarnation);
      const event = (
        aggregateType: DurableOutboxEvent["aggregateType"],
        aggregateId: string,
        envelope: Readonly<Record<string, unknown>>,
      ): DurableOutboxEvent => ({
        id: `retention:${aggregateType}:${aggregateId}`,
        aggregateType,
        aggregateId,
        sessionId,
        sessionIncarnation: incarnation,
        version: 1,
        fence: 0,
        envelope,
      });
      await store.cacheProjector.apply(
        event("session", sessionId, {
          kind: "session",
          schemaVersion: 1,
          payload: sessionRecord.session,
          runtime: sessionRecord.runtime,
          version: 1,
        }),
      );
      await store.cacheProjector.apply(
        event("turn", turnId, {
          kind: "turn",
          schemaVersion: 1,
          payload: turnRecord.turn,
          runtime: turnRecord.runtime,
          version: 1,
        }),
      );
      await store.cacheProjector.apply(
        event("tool_call", toolCallId, {
          kind: "tool_call",
          schemaVersion: 1,
          payload: toolCallRecord.toolCall,
          runtime: toolCallRecord.runtime,
          version: 1,
        }),
      );
      expect(await redis.get(sessionKey)).not.toBeNull();
      expect(await redis.get(turnKey)).not.toBeNull();
      expect(await redis.get(toolKey)).not.toBeNull();

      await pg.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $body$
         BEGIN
           IF OLD.id = '${sessionId}' THEN
             RAISE EXCEPTION 'forced retention rollback';
           END IF;
           RETURN OLD;
         END;
         $body$`,
      );
      await pg.query(
        `CREATE TRIGGER ${triggerName} BEFORE DELETE ON tvic_sessions
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );

      await expect(
        store
          .createRetentionJob({ terminalRetentionMs: 0, hasLegalHold: async () => false })
          .runOnce(),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(sessionKey)).not.toBeNull();
      expect(await redis.get(turnKey)).not.toBeNull();
      expect(await redis.get(toolKey)).not.toBeNull();
      await expect(
        new RedisTurnStore(adaptRedis(redis), { prefix }).listBySession(sessionId),
      ).resolves.toHaveLength(1);
      await expect(
        new RedisToolCallStore(adaptRedis(redis), { prefix }).listBySession(sessionId),
      ).resolves.toHaveLength(1);
      expect(JSON.parse((await redis.get(`${sessionKey}:cache_meta`))!).retired).toBe(false);
    } finally {
      await pg.query(`DROP TRIGGER IF EXISTS ${triggerName} ON tvic_sessions`).catch(() => {});
      await pg.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
      await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]).catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await redis
        .del([
          sessionKey,
          `${sessionKey}:cache_meta`,
          turnKey,
          `${turnKey}:cache_meta`,
          toolKey,
          `${toolKey}:cache_meta`,
          `${prefix}sessions`,
          `${prefix}session:${encodeURIComponent(sessionId)}:turns`,
          `${prefix}session:${encodeURIComponent(sessionId)}:tools`,
        ])
        .catch(() => 0);
      await store.close();
      await redis.quit();
      await pg.end();
    }
  });

  it("orders cache events across reused session IDs", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const sqlPool = adaptPool(pg);
    const prefix = `tvic:test:session-incarnation:${randomUUID()}:`;
    const store = createPostgresRedisDurableRuntimeStore({
      pool: sqlPool,
      redis: adaptRedis(redis),
      redisOptions: { prefix },
    });
    const sessionId = `session_reuse_${randomUUID()}` as SessionId;
    const firstCreatedAt = new Date().toISOString() as Timestamp;
    const makeRecord = (turnSequence: number, createdAt: Timestamp): StoredSessionRecord => ({
      session: {
        id: sessionId,
        agentId: `agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt,
        startedAt: createdAt,
        state: { variables: {}, pendingToolCallIds: [], turnSequence },
      },
      runtime: { monotonicStartedAtMs: turnSequence },
      version: 1,
    });
    const makeInitialEvent = (
      record: StoredSessionRecord,
      lease: SessionLease,
    ): DurableOutboxEvent => ({
      id: `session:${sessionId}:1:${lease.fence}`,
      aggregateType: "session",
      aggregateId: sessionId,
      sessionId,
      version: 1,
      fence: lease.fence,
      envelope: {
        kind: "session",
        schemaVersion: 1,
        payload: record.session,
        runtime: record.runtime,
        version: 1,
      },
    });
    const cacheKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const cacheMetaKey = `${cacheKey}:cache_meta`;
    let firstLease: SessionLease | null = null;
    let secondLease: SessionLease | null = null;
    try {
      await runPostgresMigrations(sqlPool);
      const firstRecord = makeRecord(0, firstCreatedAt);
      let firstEvent!: DurableOutboxEvent;
      firstLease = await store.createSessionWithLease(
        firstRecord,
        "session_reuse_first_owner",
        60_000,
        (lease) => (firstEvent = makeInitialEvent(firstRecord, lease)),
      );
      expect(firstLease).not.toBeNull();
      const firstOutbox = await pg.query<{ session_incarnation: string }>(
        "SELECT session_incarnation FROM tvic_outbox WHERE id = $1",
        [firstEvent.id],
      );
      const firstIncarnation = Number(firstOutbox.rows[0]?.session_incarnation);
      expect(Number.isSafeInteger(firstIncarnation)).toBe(true);
      const firstProjection = { ...firstEvent, sessionIncarnation: firstIncarnation };
      const reusedIdempotencyKey = `session-reuse:${randomUUID()}`;
      const reusedRequestHash = `request:${randomUUID()}`;
      const reusedToolId = `reuse_tool_${randomUUID()}` as ToolId;
      const firstIdempotencyLease = {
        sessionId,
        holder: firstLease!.holder,
        fence: firstLease!.fence,
        generationId: firstLease!.generationId,
      };
      const firstIdempotencyClaim = await store.primary.toolIdempotencyStore.claim({
        key: reusedIdempotencyKey,
        sessionId,
        toolId: reusedToolId,
        toolVersion: "1",
        requestHash: reusedRequestHash,
        owner: "first-session-lifetime",
        ttlMs: 60_000,
        lease: firstIdempotencyLease,
      });
      expect(firstIdempotencyClaim.status).toBe("claimed");
      await store.primary.toolIdempotencyStore.complete(reusedIdempotencyKey, reusedRequestHash, {
        status: "succeeded",
        sessionId,
        owner: "first-session-lifetime",
        ttlMs: 60_000,
        lease: firstIdempotencyLease,
        output: { lifetime: 1 },
      });
      await store.cacheProjector.apply(firstProjection);
      await store.leases.release(
        sessionId,
        firstLease!.holder,
        firstLease!.fence,
        firstLease!.generationId,
      );
      await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]);
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]);

      const secondCreatedAt = new Date(Date.now() + 1_000).toISOString() as Timestamp;
      const secondRecord = makeRecord(7, secondCreatedAt);
      await pg.query(
        `INSERT INTO tvic_sessions
          (id, agent_id, status, created_at, started_at, ended_at, payload, runtime,
           version, last_fence, last_activity_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 0, NOW(), NOW())`,
        [
          sessionId,
          secondRecord.session.agentId,
          secondRecord.session.status,
          secondRecord.session.createdAt,
          "startedAt" in secondRecord.session ? secondRecord.session.startedAt : null,
          "endedAt" in secondRecord.session ? secondRecord.session.endedAt : null,
          JSON.stringify(secondRecord.session),
          JSON.stringify(secondRecord.runtime),
          secondRecord.version ?? 1,
        ],
      );
      let secondEvent!: DurableOutboxEvent;
      secondLease = await store.createSessionWithLease(
        secondRecord,
        "session_reuse_second_owner",
        60_000,
        (lease) => (secondEvent = makeInitialEvent(secondRecord, lease)),
      );
      expect(secondLease).not.toBeNull();
      const secondIdempotencyClaim = await store.primary.toolIdempotencyStore.claim({
        key: reusedIdempotencyKey,
        sessionId,
        toolId: reusedToolId,
        toolVersion: "1",
        requestHash: reusedRequestHash,
        owner: "second-session-lifetime",
        ttlMs: 60_000,
        lease: {
          sessionId,
          holder: secondLease!.holder,
          fence: secondLease!.fence,
          generationId: secondLease!.generationId,
        },
      });
      expect(secondIdempotencyClaim.status).toBe("claimed");
      const secondOutbox = await pg.query<{ session_incarnation: string }>(
        "SELECT session_incarnation FROM tvic_outbox WHERE id = $1",
        [secondEvent.id],
      );
      const secondIncarnation = Number(secondOutbox.rows[0]?.session_incarnation);
      expect(secondIncarnation).toBeGreaterThan(firstIncarnation);

      const legacyInsert = await pg.query<{ session_incarnation: string }>(
        `INSERT INTO tvic_outbox
          (id, aggregate_type, aggregate_id, session_id, version, fence, envelope)
         VALUES ($1, 'session', $2, $2, 1, $3, $4::jsonb)
         RETURNING session_incarnation`,
        [
          `legacy_writer:${sessionId}:${randomUUID()}`,
          sessionId,
          secondLease!.fence,
          JSON.stringify(secondEvent.envelope),
        ],
      );
      expect(Number(legacyInsert.rows[0]?.session_incarnation)).toBe(secondIncarnation);

      const secondProjection = { ...secondEvent, sessionIncarnation: secondIncarnation };
      await store.cacheProjector.apply(secondProjection);
      await store.cacheProjector.apply(firstProjection);

      const cached = JSON.parse((await redis.get(cacheKey))!) as {
        payload: { state: { turnSequence: number } };
      };
      const metadata = JSON.parse((await redis.get(cacheMetaKey))!) as {
        sessionIncarnation: number;
      };
      expect(cached.payload.state.turnSequence).toBe(7);
      expect(metadata.sessionIncarnation).toBe(secondIncarnation);

      const retainedTurnId = `retained_turn_${randomUUID()}` as TurnId;
      const retainedToolCallId = `retained_tool_${randomUUID()}` as ToolCallId;
      const retainedTurn = {
        id: retainedTurnId,
        sessionId,
        sequence: 8,
        status: "completed" as const,
        input: { transcript: "retained transcript", mediaEventIds: [] },
        output: { text: "retained response", mediaEventIds: [] },
        toolCallIds: [retainedToolCallId],
        startedAt: secondCreatedAt,
        endedAt: secondCreatedAt,
        latency: {},
      };
      const retainedToolCall = {
        status: "running" as const,
        toolCallId: retainedToolCallId,
        toolId: `retained_tool_${randomUUID()}` as ToolId,
        toolName: "retained_tool" as ToolName,
        sessionId,
        turnId: retainedTurnId,
        input: { customerData: "retained" },
        attempts: 1,
        queuedAt: secondCreatedAt,
        startedAt: secondCreatedAt,
      };
      const retainedTurnProjection = {
        id: `retained_turn:${retainedTurnId}`,
        aggregateType: "turn",
        aggregateId: retainedTurnId,
        sessionId,
        sessionIncarnation: secondIncarnation,
        version: 1,
        fence: secondLease!.fence,
        envelope: {
          kind: "turn",
          schemaVersion: 1,
          payload: retainedTurn,
          runtime: { monotonicStartedAtMs: 0 },
          version: 1,
        },
      } satisfies DurableOutboxEvent;
      await store.cacheProjector.apply(retainedTurnProjection);
      const retainedToolProjection = {
        id: `retained_tool_call:${retainedToolCallId}`,
        aggregateType: "tool_call",
        aggregateId: retainedToolCallId,
        sessionId,
        sessionIncarnation: secondIncarnation,
        version: 1,
        fence: secondLease!.fence,
        envelope: {
          kind: "tool_call",
          schemaVersion: 1,
          payload: retainedToolCall,
          runtime: { monotonicQueuedAtMs: 0 },
          version: 1,
        },
      } satisfies DurableOutboxEvent;
      await store.cacheProjector.apply(retainedToolProjection);
      const projectedTurns = new RedisTurnStore(adaptRedis(redis), { prefix });
      const projectedToolCalls = new RedisToolCallStore(adaptRedis(redis), { prefix });
      await expect(projectedTurns.listBySession(sessionId)).resolves.toHaveLength(1);
      await expect(projectedToolCalls.listBySession(sessionId)).resolves.toHaveLength(1);

      await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]);
      await pg.query(
        "UPDATE tvic_sessions SET status = 'completed', ended_at = '2000-01-01' WHERE id = $1",
        [sessionId],
      );
      await store
        .createRetentionJob({ terminalRetentionMs: 0, hasLegalHold: async () => false })
        .runOnce();
      expect(await redis.get(cacheKey)).toBeNull();
      expect(JSON.parse((await redis.get(cacheMetaKey))!).retired).toBe(true);
      await expect(redis.zRange(`${prefix}sessions`, 0, -1)).resolves.not.toContain(cacheKey);
      await expect(
        redis.zRange(`${prefix}session:${encodeURIComponent(sessionId)}:turns`, 0, -1),
      ).resolves.toEqual([]);
      await expect(
        redis.zRange(`${prefix}session:${encodeURIComponent(sessionId)}:tools`, 0, -1),
      ).resolves.toEqual([]);
      await expect(projectedTurns.listBySession(sessionId)).resolves.toEqual([]);
      await expect(projectedToolCalls.listBySession(sessionId)).resolves.toEqual([]);

      await store.cacheProjector.apply(firstProjection);
      await expect(store.cacheProjector.apply(secondProjection)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      await expect(store.cacheProjector.apply(retainedTurnProjection)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      await expect(store.cacheProjector.apply(retainedToolProjection)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      expect(await redis.get(cacheKey)).toBeNull();
      await expect(projectedTurns.listBySession(sessionId)).resolves.toEqual([]);
      await expect(projectedToolCalls.listBySession(sessionId)).resolves.toEqual([]);
    } finally {
      await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]).catch(() => {});
      await pg
        .query("DELETE FROM tvic_tool_idempotency WHERE session_id = $1", [sessionId])
        .catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await redis.del([
        cacheKey,
        cacheMetaKey,
        `${prefix}sessions`,
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
      await pg.end();
    }
  });

  it("projects an unfenced terminal update after an older fenced cache event", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const sqlPool = adaptPool(pg);
    const prefix = `tvic:test:unfenced-cache-order:${randomUUID()}:`;
    const store = createPostgresRedisDurableRuntimeStore({
      pool: sqlPool,
      redis: adaptRedis(redis),
      redisOptions: { prefix },
    });
    const sessionId = `unfenced_terminal_${randomUUID()}` as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: `agent_${randomUUID()}` as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
      version: 1,
    };
    let lease: SessionLease | null = null;
    let initialEvent!: DurableOutboxEvent;
    let terminalEvent!: DurableOutboxEvent;
    const cacheKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    try {
      await runPostgresMigrations(sqlPool);
      lease = await store.createSessionWithLease(
        record,
        "terminal_cache_owner",
        60_000,
        (owned) => {
          initialEvent = {
            id: `session:${sessionId}:1:${owned.fence}`,
            aggregateType: "session",
            aggregateId: sessionId,
            sessionId,
            version: 1,
            fence: owned.fence,
            envelope: {
              kind: "session",
              schemaVersion: 1,
              payload: record.session,
              runtime: record.runtime,
              version: 1,
            },
          };
          return initialEvent;
        },
      );
      expect(lease).not.toBeNull();
      const initialRow = await pg.query<{ session_incarnation: string }>(
        "SELECT session_incarnation FROM tvic_outbox WHERE id = $1",
        [initialEvent.id],
      );
      const sessionIncarnation = Number(initialRow.rows[0]?.session_incarnation);
      await store.cacheProjector.apply({ ...initialEvent, sessionIncarnation });
      await store.leases.release(sessionId, lease!.holder, lease!.fence, lease!.generationId);

      await store.runUnfencedSessionTransaction(sessionId, async (tx) => {
        const updated = await tx.updateSession(sessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            status: "completed",
            startedAt: "startedAt" in current.session ? current.session.startedAt : timestamp,
            endedAt: timestamp,
          },
          runtime: current.runtime,
        }));
        terminalEvent = {
          id: `session:${sessionId}:${updated.version ?? 2}:0`,
          aggregateType: "session",
          aggregateId: sessionId,
          sessionId,
          version: updated.version ?? 2,
          fence: 0,
          envelope: {
            kind: "session",
            schemaVersion: 1,
            payload: updated.session,
            runtime: updated.runtime,
            version: updated.version ?? 2,
          },
        };
        await tx.appendOutbox(terminalEvent);
      });

      const terminalRow = await pg.query<{
        session_incarnation: string;
        fence: number;
        version: number;
      }>("SELECT session_incarnation, fence, version FROM tvic_outbox WHERE id = $1", [
        terminalEvent.id,
      ]);
      expect(Number(terminalRow.rows[0]?.fence)).toBe(0);
      expect(Number(terminalRow.rows[0]?.version)).toBe(2);
      expect(Number(terminalRow.rows[0]?.session_incarnation)).toBe(sessionIncarnation);
      await store.cacheProjector.apply({ ...terminalEvent, sessionIncarnation });
      await store.cacheProjector.apply({ ...initialEvent, sessionIncarnation });

      const cached = JSON.parse((await redis.get(cacheKey))!) as {
        version: number;
        payload: { status: string };
      };
      expect(cached.version).toBe(2);
      expect(cached.payload.status).toBe("completed");
      expect(await redis.zScore(`${prefix}sessions`, cacheKey)).toBe(Date.parse(timestamp));
    } finally {
      await pg.query("DELETE FROM tvic_outbox WHERE session_id = $1", [sessionId]).catch(() => {});
      await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [sessionId]).catch(() => {});
      await redis.del([
        cacheKey,
        `${cacheKey}:cache_meta`,
        `${prefix}sessions`,
        `${prefix}lease:${encodeURIComponent(sessionId)}`,
        `${prefix}leases`,
        `${prefix}lease_recovery_candidates`,
      ]);
      await redis.quit();
      await pg.end();
    }
  });

  it("runs migrations, fences a transaction, and projects a committed event", async () => {
    const schemaName = `tvic_test_${randomUUID().replaceAll("-", "")}`;
    const pg = await createIsolatedPostgresPool(process.env.DATABASE_URL ?? "", schemaName);
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    const sqlPool = adaptPool(pg);
    const store = createPostgresRedisDurableRuntimeStore({
      pool: sqlPool,
      redis: adaptRedis(redis),
      redisOptions: { prefix: integrationRedisPrefix },
    });
    const sessionId = integrationTestId("integration_session") as SessionId;
    const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
    try {
      await redis.connect();
      await runPostgresMigrations(sqlPool);

      const record = {
        session: {
          id: sessionId,
          agentId: "integration_agent" as AgentId,
          status: "active" as const,
          channel: "simulated" as const,
          memoryRefs: [],
          createdAt: timestamp,
          startedAt: timestamp,
          state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
        },
        runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
      };
      const initialRaceSessionId = integrationTestId("integration_initial_race") as SessionId;
      await store.sessions.put({
        ...record,
        session: { ...record.session, id: initialRaceSessionId },
      });
      const [initialRaceA, initialRaceB] = await Promise.all([
        store.leases.acquire(initialRaceSessionId, "initial_race_a", 5000),
        store.leases.acquire(initialRaceSessionId, "initial_race_b", 5000),
      ]);
      expect([initialRaceA, initialRaceB].filter((candidate) => candidate !== null)).toHaveLength(
        1,
      );
      expect([initialRaceA, initialRaceB].find((candidate) => candidate !== null)?.fence).toBe(1);
      const lease = await store.createSessionWithLease(record, "integration_owner", 5000);
      expect(lease?.fence).toBe(1);
      await store.runSessionTransaction(sessionId, lease!, async (tx) => {
        const session = await tx.updateSession(sessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            state: { ...current.session.state, turnSequence: 1 },
          },
        }));
        await tx.appendOutbox({
          id: integrationTestId("integration_event"),
          aggregateType: "session",
          aggregateId: sessionId,
          sessionId,
          version: session.version ?? 1,
          fence: lease!.fence,
          envelope: {
            kind: "session",
            schemaVersion: 1,
            payload: session.session,
            runtime: session.runtime,
            version: session.version ?? 1,
          },
        });
      });
      expect((await store.sessions.get(sessionId))?.session.state.turnSequence).toBe(1);
      await expect(
        store.runUnfencedSessionTransaction(sessionId, async (tx) => {
          await tx.updateSession(sessionId, (current) => ({
            ...current,
            session: {
              ...current.session,
              state: { ...current.session.state, turnSequence: 99 },
            },
          }));
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect((await store.sessions.get(sessionId))?.session.state.turnSequence).toBe(1);

      const unfencedCreationRaceId = integrationTestId(
        "integration_unfenced_creation_race",
      ) as SessionId;
      const unfencedCreationRaceRecord = {
        ...record,
        session: {
          ...record.session,
          id: unfencedCreationRaceId,
          state: { ...record.session.state, turnSequence: 0 },
        },
      };
      let signalCallbackEntered: () => void = () => {};
      let releaseCallback: () => void = () => {};
      const callbackEntered = new Promise<void>((resolve) => {
        signalCallbackEntered = resolve;
      });
      const callbackGate = new Promise<void>((resolve) => {
        releaseCallback = resolve;
      });
      const unfencedCreationRace = store.runUnfencedSessionTransaction(
        unfencedCreationRaceId,
        async (tx) => {
          signalCallbackEntered();
          await callbackGate;
          await tx.putSession(unfencedCreationRaceRecord);
          await tx.updateSession(unfencedCreationRaceId, (current) => ({
            ...current,
            session: {
              ...current.session,
              state: { ...current.session.state, turnSequence: 99 },
            },
          }));
        },
      );
      await callbackEntered;
      const racingLease = await store.createSessionWithLease(
        unfencedCreationRaceRecord,
        "integration_creation_race_owner",
        5000,
      );
      expect(racingLease).not.toBeNull();
      releaseCallback();
      await expect(unfencedCreationRace).rejects.toBeInstanceOf(LeaseLostError);
      expect((await store.sessions.get(unfencedCreationRaceId))?.session.state.turnSequence).toBe(
        0,
      );
      await store.leases.release(
        unfencedCreationRaceId,
        racingLease!.holder,
        racingLease!.fence,
        racingLease!.generationId,
      );

      const idempotencyClaim = {
        key: integrationTestId("integration_idempotency"),
        toolId: "integration_tool" as ToolId,
        toolVersion: "1",
        requestHash: integrationTestId("integration_request"),
        ttlMs: 5_000,
      };
      const [claimA, claimB] = await Promise.all([
        store.toolIdempotencyStore.claim({ ...idempotencyClaim, owner: "tool_owner_a" }),
        store.toolIdempotencyStore.claim({ ...idempotencyClaim, owner: "tool_owner_b" }),
      ]);
      expect([claimA.status, claimB.status].sort()).toEqual(["claimed", "in_progress"]);
      const winningOwner = claimA.status === "claimed" ? "tool_owner_a" : "tool_owner_b";
      await store.toolIdempotencyStore.complete(
        idempotencyClaim.key,
        idempotencyClaim.requestHash,
        {
          owner: winningOwner,
          status: "succeeded",
          ttlMs: 5_000,
          output: { ok: true },
        },
      );
      await expect(
        store.toolIdempotencyStore.claim({ ...idempotencyClaim, owner: "tool_owner_c" }),
      ).resolves.toMatchObject({ status: "succeeded", record: { output: { ok: true } } });
      expect(
        (
          await sqlPool.query(
            "SELECT count(*)::int AS count FROM tvic_outbox WHERE session_id = $1",
            [sessionId],
          )
        ).rows[0],
      ).toMatchObject({
        count: 1,
      });
      const fencedIdempotencySessionId = integrationTestId(
        "integration_fenced_idempotency",
      ) as SessionId;
      await store.sessions.put({
        ...record,
        session: { ...record.session, id: fencedIdempotencySessionId },
      });
      const fencedIdempotencyLease = await store.leases.acquire(
        fencedIdempotencySessionId,
        "fenced_owner_one",
        10_000,
      );
      const fencedIdempotencyKey = integrationTestId("integration_pg_fenced_idempotency");
      const fencedIdempotencyHash = integrationTestId("integration_pg_request");
      await expect(
        store.toolIdempotencyStore.claim({
          key: fencedIdempotencyKey,
          requestHash: fencedIdempotencyHash,
          owner: "pg_tool_one",
          ttlMs: 10_000,
          lease: fencedIdempotencyLease!,
        }),
      ).resolves.toMatchObject({ status: "claimed", record: { claimedFence: 1 } });
      const legacyIdempotencyKey = integrationTestId(
        "integration_pg_legacy_same_fence_idempotency",
      );
      await store.toolIdempotencyStore.claim({
        key: legacyIdempotencyKey,
        sessionId: fencedIdempotencySessionId,
        requestHash: integrationTestId("integration_pg_legacy_request"),
        owner: "legacy_pg_tool_owner",
        ttlMs: 10_000,
        lease: fencedIdempotencyLease!,
      });
      await expect(
        store.toolIdempotencyStore.claim({
          key: legacyIdempotencyKey,
          requestHash: integrationTestId("integration_pg_legacy_request"),
          owner: "pg_tool_same_fence_retry",
          ttlMs: 10_000,
          lease: fencedIdempotencyLease!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await expect(
        store.toolIdempotencyStore.claim({
          key: legacyIdempotencyKey,
          requestHash: integrationTestId("integration_pg_legacy_request"),
          owner: "legacy_pg_tool_owner",
          ttlMs: 10_000,
          lease: fencedIdempotencyLease!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await store.leases.release(
        fencedIdempotencySessionId,
        "fenced_owner_one",
        fencedIdempotencyLease!.fence,
        fencedIdempotencyLease!.generationId,
      );
      const fencedIdempotencyLeaseTwo = await store.leases.acquire(
        fencedIdempotencySessionId,
        "fenced_owner_two",
        10_000,
      );
      expect(fencedIdempotencyLeaseTwo?.fence).toBe(2);
      await expect(
        store.toolIdempotencyStore.claim({
          key: fencedIdempotencyKey,
          requestHash: fencedIdempotencyHash,
          owner: "pg_tool_two",
          ttlMs: 10_000,
          lease: fencedIdempotencyLeaseTwo!,
        }),
      ).resolves.toMatchObject({ status: "claimed", record: { claimedFence: 2 } });
      await store.toolIdempotencyStore.complete(fencedIdempotencyKey, fencedIdempotencyHash, {
        status: "succeeded",
        owner: "pg_tool_two",
        ttlMs: 10_000,
        lease: fencedIdempotencyLeaseTwo!,
        output: { ok: true },
      });
      await expect(
        store.toolIdempotencyStore.lookup(
          fencedIdempotencyKey,
          fencedIdempotencyHash,
          fencedIdempotencySessionId,
          fencedIdempotencyLeaseTwo!,
        ),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "succeeded", output: { ok: true } },
      });
      const pgTerminalKey = integrationTestId("integration_pg_terminal_failure");
      await expect(
        store.toolIdempotencyStore.claim({
          key: pgTerminalKey,
          requestHash: integrationTestId("integration_pg_terminal_request"),
          owner: "pg_terminal_owner",
          ttlMs: 10_000,
          lease: fencedIdempotencyLeaseTwo!,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.toolIdempotencyStore.complete(
        pgTerminalKey,
        integrationTestId("integration_pg_terminal_request"),
        {
          status: "failed",
          owner: "pg_terminal_owner",
          ttlMs: 10_000,
          lease: fencedIdempotencyLeaseTwo!,
          error: toolError("tool.execution_failed", "Tool execution failed", { retriable: false }),
        },
      );
      await expect(
        store.toolIdempotencyStore.claim({
          key: pgTerminalKey,
          requestHash: integrationTestId("integration_pg_terminal_request"),
          owner: "pg_terminal_retry",
          ttlMs: 10_000,
          lease: fencedIdempotencyLeaseTwo!,
        }),
      ).resolves.toMatchObject({ status: "terminal", record: { status: "failed" } });
      const worker = new PostgresOutboxWorker({
        pool: sqlPool,
        workerId: "integration_worker",
        deliver: (event) => store.cacheProjector.apply(event),
      });
      await expect(worker.runOnce()).resolves.toMatchObject({ claimed: 1, delivered: 1 });
      expect(
        await redis.get(`${integrationRedisPrefix}session:${encodeURIComponent(sessionId)}`),
      ).toContain('"version":2');
      await expect(
        store.runSessionTransaction(sessionId, lease!, async (tx) => {
          await tx.updateSession(sessionId, (current) => ({
            ...current,
            session: { ...current.session, state: { ...current.session.state, turnSequence: 99 } },
          }));
          throw new Error("rollback integration");
        }),
      ).rejects.toThrow("rollback integration");
      expect((await store.sessions.get(sessionId))?.session.state.turnSequence).toBe(1);
      await expect(store.leases.acquire(sessionId, "other_owner", 5000)).resolves.toBeNull();
      await store.leases.release(sessionId, "integration_owner", lease!.fence, lease!.generationId);
      const secondLease = await store.leases.acquire(sessionId, "other_owner", 5000);
      expect(secondLease).toMatchObject({
        fence: 2,
      });
      const [racedA, racedB] = await Promise.all([
        store.leases.acquire(sessionId, "race_a", 5000),
        store.leases.acquire(sessionId, "race_b", 5000),
      ]);
      expect([racedA, racedB].filter((candidate) => candidate !== null)).toHaveLength(0);
      await store.leases.release(
        sessionId,
        "other_owner",
        secondLease!.fence,
        secondLease!.generationId,
      );
      const [winnerA, winnerB] = await Promise.all([
        store.leases.acquire(sessionId, "race_a", 5000),
        store.leases.acquire(sessionId, "race_b", 5000),
      ]);
      expect([winnerA, winnerB].filter((candidate) => candidate !== null)).toHaveLength(1);

      const redisStore = createRedisDurableRuntimeStore(adaptRedis(redis), {
        prefix: integrationRedisPrefix,
      });
      const redisSessionId = integrationTestId("integration_redis_transaction") as SessionId;
      const redisRecord = {
        ...record,
        session: { ...record.session, id: redisSessionId },
      };
      const redisLease = await redisStore.createSessionWithLease(
        redisRecord,
        "redis_owner",
        5000,
        (owned) => ({
          id: integrationTestId("integration_redis_initial"),
          aggregateType: "session",
          aggregateId: redisSessionId,
          sessionId: redisSessionId,
          version: 1,
          fence: owned.fence,
          envelope: {
            kind: "session",
            schemaVersion: 1,
            payload: redisRecord.session,
            runtime: redisRecord.runtime,
            version: 1,
          },
        }),
      );
      expect(redisLease?.fence).toBe(1);
      expect(
        await redis.get(
          `${integrationRedisPrefix}outbox:${encodeURIComponent(integrationTestId("integration_redis_initial"))}`,
        ),
      ).toContain('"version":1');
      await expect(
        redisStore.createSessionWithLease(redisRecord, "redis_owner", 5000, () => {
          throw new Error("redis initial event failed");
        }),
      ).rejects.toThrow("redis initial event failed");
      await expect(redisStore.leases.get(redisSessionId)).resolves.toMatchObject({
        holder: "redis_owner",
        fence: redisLease?.fence,
        generationId: redisLease?.generationId,
      });
      await expect(
        redisStore.leases.acquire(redisSessionId, "redis_other_owner", 5000),
      ).resolves.toBeNull();

      const redisSessionKey = `${integrationRedisPrefix}session:${encodeURIComponent(redisSessionId)}`;
      expect((await redisStore.sessions.list()).map((entry) => entry.session.id)).toContain(
        redisSessionId,
      );
      await redis.zRem(`${integrationRedisPrefix}sessions`, redisSessionKey);
      await redisStore.sessions.put(redisRecord);
      const repairedSessionIndex = await redis.zRange(`${integrationRedisPrefix}sessions`, 0, -1);
      expect(repairedSessionIndex).toContain(redisSessionKey);
      await redisStore.runSessionTransaction(redisSessionId, redisLease!, async (tx) => {
        await tx.updateSession(redisSessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            state: { ...current.session.state, turnSequence: 1 },
          },
        }));
        const updated = await tx.updateSession(redisSessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            state: { ...current.session.state, turnSequence: 2 },
          },
        }));
        await tx.appendOutbox({
          id: integrationTestId("integration_redis_transaction_event"),
          aggregateType: "session",
          aggregateId: redisSessionId,
          sessionId: redisSessionId,
          version: updated.version ?? 1,
          fence: redisLease!.fence,
          envelope: {
            kind: "session",
            schemaVersion: 1,
            payload: updated.session,
            runtime: updated.runtime,
            version: updated.version ?? 1,
          },
        });
        expect((await tx.getSession(redisSessionId))?.session.state.turnSequence).toBe(2);
      });
      expect((await redisStore.sessions.get(redisSessionId))?.session.state.turnSequence).toBe(2);
      expect(
        await redis.get(
          `${integrationRedisPrefix}outbox:${encodeURIComponent(integrationTestId("integration_redis_transaction_event"))}`,
        ),
      ).toContain('"version":3');
      await expect(
        redisStore.runUnfencedSessionTransaction(redisSessionId, async (tx) => {
          await tx.updateSession(redisSessionId, (current) => ({
            ...current,
            session: {
              ...current.session,
              state: { ...current.session.state, turnSequence: 99 },
            },
          }));
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect((await redisStore.sessions.get(redisSessionId))?.session.state.turnSequence).toBe(2);
      const redisIdempotencyKey = integrationTestId("integration_redis_fenced_idempotency");
      const redisRequestHash = integrationTestId("integration_redis_request");
      const redisClaim = await redisStore.toolIdempotencyStore.claim({
        key: redisIdempotencyKey,
        requestHash: redisRequestHash,
        owner: "redis_tool_one",
        ttlMs: 10_000,
        lease: redisLease!,
      });
      expect(redisClaim.status).toBe("claimed");
      const redisTerminalKey = integrationTestId("integration_redis_terminal_failure");
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: redisTerminalKey,
          requestHash: integrationTestId("integration_redis_terminal_request"),
          owner: "redis_terminal_owner",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      const redisTerminalRedisKey = `${integrationRedisPrefix}idempotency:${encodeURIComponent(redisTerminalKey)}`;
      expect(await redis.pTTL(redisTerminalRedisKey)).toBeGreaterThan(0);
      await redisStore.toolIdempotencyStore.complete(
        redisTerminalKey,
        integrationTestId("integration_redis_terminal_request"),
        {
          status: "timed_out",
          owner: "redis_terminal_owner",
          ttlMs: 10_000,
          lease: redisLease!,
          error: toolError("tool.timeout", "Tool timed out", { retriable: false }),
        },
      );
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: redisTerminalKey,
          requestHash: integrationTestId("integration_redis_terminal_request"),
          owner: "redis_terminal_retry",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "terminal", record: { status: "timed_out" } });
      const legacyRedisIdempotencyKey = integrationTestId(
        "integration_redis_legacy_same_fence_idempotency",
      );
      await redis.set(
        `${integrationRedisPrefix}idempotency:${encodeURIComponent(legacyRedisIdempotencyKey)}`,
        JSON.stringify({
          key: legacyRedisIdempotencyKey,
          sessionId: redisSessionId,
          requestHash: integrationTestId("integration_redis_legacy_request"),
          status: "claimed",
          owner: "legacy_redis_tool_owner",
          claimedFence: redisLease!.fence,
          expiresAtMs: Date.now() + 10_000,
        }),
      );
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: legacyRedisIdempotencyKey,
          requestHash: integrationTestId("integration_redis_legacy_request"),
          owner: "redis_tool_same_fence_retry",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: legacyRedisIdempotencyKey,
          requestHash: integrationTestId("integration_redis_legacy_request"),
          owner: "legacy_redis_tool_owner",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await redisStore.leases.release(
        redisSessionId,
        "redis_owner",
        redisLease!.fence,
        redisLease!.generationId,
      );
      const redisSecondLease = await redisStore.leases.acquire(
        redisSessionId,
        "redis_owner_two",
        10_000,
      );
      expect(redisSecondLease?.fence).toBe(2);
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: redisIdempotencyKey,
          requestHash: redisRequestHash,
          owner: "redis_tool_two",
          ttlMs: 10_000,
          lease: redisSecondLease!,
        }),
      ).resolves.toMatchObject({ status: "claimed", record: { claimedFence: 2 } });
      await expect(
        redisStore.toolIdempotencyStore.complete(redisIdempotencyKey, redisRequestHash, {
          status: "succeeded",
          owner: "redis_tool_two",
          ttlMs: 10_000,
          lease: redisSecondLease!,
          output: { ok: true },
        }),
      ).resolves.toBeUndefined();
      await expect(
        redisStore.toolIdempotencyStore.lookup(
          redisIdempotencyKey,
          redisRequestHash,
          redisSessionId,
          redisSecondLease!,
        ),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "succeeded", output: { ok: true } },
      });
    } finally {
      try {
        await store.stopOutboxWorker();
      } finally {
        try {
          await deleteRedisPrefix(redis, integrationRedisPrefix);
        } finally {
          await redis.quit().catch(() => undefined);
          try {
            await pg.end();
          } finally {
            await dropIsolatedPostgresSchema(process.env.DATABASE_URL ?? "", schemaName);
          }
        }
      }
    }
  }, 30_000);
});

async function createIsolatedPostgresPool(databaseUrl: string, schemaName: string): Promise<Pool> {
  const setupPool = new Pool({ connectionString: databaseUrl });
  try {
    await setupPool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
    await setupPool.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await setupPool.end();
  }
  return new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName},public`,
  });
}

async function dropIsolatedPostgresSchema(databaseUrl: string, schemaName: string): Promise<void> {
  const cleanupPool = new Pool({ connectionString: databaseUrl });
  try {
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  } finally {
    await cleanupPool.end();
  }
}

async function deleteRedisPrefix(redis: ReturnType<typeof createClient>, prefix: string) {
  let cursor = 0;
  const keys = new Set<string>();
  do {
    const page = await redis.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
    for (const key of page.keys) keys.add(key);
    cursor = page.cursor;
  } while (cursor !== 0);
  const scopedKeys = [...keys];
  for (let index = 0; index < scopedKeys.length; index += 500) {
    await redis.del(scopedKeys.slice(index, index + 500));
  }
}

function adaptPool(pool: Pool): SqlPool {
  return {
    query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      adaptQuery<Row>(pool, text, values),
    connect: async () => adaptConnection(await pool.connect()),
  };
}

function adaptConnection(connection: PoolClient): SqlClient & { readonly release: () => void } {
  return {
    query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      adaptQuery<Row>(connection, text, values),
    release: () => connection.release(),
  };
}

async function adaptQuery<Row extends Record<string, unknown>>(
  client: Pool | PoolClient,
  text: string,
  values?: readonly unknown[],
): Promise<SqlResult<Row>> {
  const result = await client.query(text, values ? [...values] : undefined);
  return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
}

function adaptRedis(client: any): import("@tvic/dal-redis").RedisClient {
  return {
    get: (key) => client.get(key),
    set: async (key, value, options) =>
      (await client.set(
        key,
        value,
        options
          ? { ...(options.NX ? { NX: true } : {}), ...(options.PX ? { PX: options.PX } : {}) }
          : undefined,
      )) as "OK" | null,
    del: (...keys) => client.del([...keys]),
    eval: (script, keys, args) => client.eval(script, { keys: [...keys], arguments: [...args] }),
    scan: async (cursor, options) => {
      const result = await client.scan(
        Number(cursor),
        options?.MATCH ? { MATCH: options.MATCH, COUNT: options.COUNT } : undefined,
      );
      return [String(result.cursor), result.keys];
    },
    zrange: (key, start, stop) => client.zRange(key, start, stop),
    zrangebyscore: (key, min, max) => client.zRangeByScore(key, min, max),
    time: async () => {
      const result = (await client.sendCommand(["TIME"])) as string[];
      return [result[0] ?? "0", result[1] ?? "0"];
    },
    watch: (...keys) => client.watch([...keys]).then(() => undefined),
    unwatch: () => client.unwatch().then(() => undefined),
    multi: () => {
      const multi = client.multi();
      const wrapped = {
        set: (key: string, value: string, options?: { readonly PX?: number }) => {
          multi.set(key, value, options);
          return wrapped;
        },
        del: (...keys: readonly string[]) => {
          multi.del([...keys]);
          return wrapped;
        },
        exec: async () => ((await multi.exec()) ?? []) as readonly unknown[],
      };
      return wrapped;
    },
  };
}
