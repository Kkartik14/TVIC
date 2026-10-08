import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";

import type {
  Agent,
  AgentProviders,
  AgentId,
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
} from "@tvic/core";
import {
  InvalidArgumentError,
  LeaseLostError,
  PCM16_16K_MONO,
  RecordConflictError,
  toolError,
} from "@tvic/core";
import {
  createPostgresDurableRuntimeStore,
  PostgresOutboxWorker,
  runPostgresMigrations,
  type SqlResult,
  type SqlClient,
  type SqlPool,
} from "@tvic/dal-postgres";
import { createRedisDurableRuntimeStore } from "@tvic/dal-redis";
import { createRuntime, defineAgent, defineTool } from "@tvic/runtime";
import { idempotencyKeyFor, idempotencyRequestHashFor } from "@tvic/tools";
import { createPostgresRedisDurableRuntimeStore } from "../src/index.js";

const integrationEnabled =
  process.env.TVIC_RUN_INTEGRATION === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.REDIS_URL);

const redisIntegrationEnabled = Boolean(process.env.REDIS_URL);
const postgresIntegrationEnabled =
  process.env.TVIC_RUN_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

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
        store.toolIdempotencyStore.lookup(key, requestHash, sessionId),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "failed", error: { code: "tool.runtime_restarted" } },
      });

      const activeKey = `quarantine_active_${randomUUID()}`;
      const activeOwner = `tool_call_${randomUUID()}`;
      const activeClaim = { ...recoveryInput, key: activeKey, owner: activeOwner };
      await store.toolIdempotencyStore.claim(activeClaim);
      await expect(
        store.toolIdempotencyStore.quarantine({ ...activeClaim, owner, error }),
      ).resolves.toMatchObject({ status: "in_progress", record: { owner: activeOwner } });
      await expect(
        store.toolIdempotencyStore.lookup(activeKey, requestHash, sessionId),
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
    const validSessionId = "valid_expired";
    const malformedSessionId = "malformed_expired";
    const wrongTypeSessionId = "wrong_type_expired";
    const store = createRedisDurableRuntimeStore(adaptRedis(redis), { prefix });
    try {
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
      await redis.hSet(
        `${prefix}lease:${encodeURIComponent(wrongTypeSessionId)}`,
        "unexpected",
        "value",
      );
      await redis.zAdd(`${prefix}leases`, [
        { score: 1, value: encodeURIComponent(validSessionId) },
        { score: 1, value: encodeURIComponent(malformedSessionId) },
        { score: 1, value: encodeURIComponent(wrongTypeSessionId) },
      ]);

      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toMatchObject({ candidates: [{ sessionId: validSessionId, fence: 1 }] });

      await redis.del(`${prefix}lease:${encodeURIComponent(validSessionId)}`);
      await redis.hSet(
        `${prefix}lease:${encodeURIComponent(validSessionId)}`,
        "unexpected",
        "value",
      );
      await expect(
        store.leases.listRecoveryCandidates({ nowMs: Date.now(), limit: 10 }),
      ).resolves.toEqual({ candidates: [] });
    } finally {
      await redis.del([
        `${prefix}lease:${encodeURIComponent(validSessionId)}`,
        `${prefix}lease:${encodeURIComponent(malformedSessionId)}`,
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

describe.skipIf(!postgresIntegrationEnabled)("real PostgreSQL lease recovery disposition", () => {
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
        store.toolIdempotencyStore.lookup(firstClaim.key, requestHash, sessionId),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "failed", error: { code: "tool.runtime_restarted" } },
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
        store.toolIdempotencyStore.lookup(activeClaim.key, requestHash, sessionId),
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
      await pg.query(
        `INSERT INTO tvic_tool_idempotency
          (key, session_id, tool_id, tool_version, request_hash, status, owner,
           claimed_fence, expires_at_ms, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6,
           $7, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + $8, NOW())`,
        [legacyKey, sessionId, toolId, "1.0.0", requestHash, owner, secondLease!.fence, ttlMs],
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
      const claimed = await store.toolIdempotencyStore.claim({
        key,
        sessionId,
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
        output: { confirmed: true },
      });

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
        store.toolIdempotencyStore.lookup(completionKey, completionHash, sessionId),
      ).resolves.toMatchObject({ status: "found", record: { status: "claimed" } });
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
        String(row.query).includes("tvic_session_leases"),
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

describe.skipIf(!integrationEnabled)("real PostgreSQL + Redis durability", () => {
  it("runs migrations, fences a transaction, and projects a committed event", async () => {
    const pg = new Pool({ connectionString: process.env.DATABASE_URL ?? "" });
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const sqlPool = adaptPool(pg);
    const store = createPostgresRedisDurableRuntimeStore({
      pool: sqlPool,
      redis: adaptRedis(redis),
    });
    const sessionId = "integration_session" as SessionId;
    const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
    try {
      await runPostgresMigrations(sqlPool);
      await sqlPool.query("TRUNCATE tvic_sessions, tvic_tool_idempotency CASCADE");
      await redis.flushDb();

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
      const initialRaceSessionId = "integration_initial_race" as SessionId;
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
          id: "integration_event",
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
      const idempotencyClaim = {
        key: "integration_idempotency",
        toolId: "integration_tool" as ToolId,
        toolVersion: "1",
        requestHash: "integration_request",
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
        (await sqlPool.query("SELECT count(*)::int AS count FROM tvic_outbox")).rows[0],
      ).toMatchObject({
        count: 1,
      });
      const fencedIdempotencySessionId = "integration_fenced_idempotency" as SessionId;
      await store.sessions.put({
        ...record,
        session: { ...record.session, id: fencedIdempotencySessionId },
      });
      const fencedIdempotencyLease = await store.leases.acquire(
        fencedIdempotencySessionId,
        "fenced_owner_one",
        10_000,
      );
      const fencedIdempotencyKey = "integration_pg_fenced_idempotency";
      const fencedIdempotencyHash = "integration_pg_request";
      await expect(
        store.toolIdempotencyStore.claim({
          key: fencedIdempotencyKey,
          requestHash: fencedIdempotencyHash,
          owner: "pg_tool_one",
          ttlMs: 10_000,
          lease: fencedIdempotencyLease!,
        }),
      ).resolves.toMatchObject({ status: "claimed", record: { claimedFence: 1 } });
      const legacyIdempotencyKey = "integration_pg_legacy_same_fence_idempotency";
      await sqlPool.query(
        `INSERT INTO tvic_tool_idempotency
          (key, session_id, request_hash, status, owner, claimed_fence, expires_at_ms, updated_at)
         VALUES ($1, $2, $3, 'claimed', $4, $5, $6, NOW())`,
        [
          legacyIdempotencyKey,
          fencedIdempotencySessionId,
          "integration_pg_legacy_request",
          "legacy_pg_tool_owner",
          fencedIdempotencyLease!.fence,
          Date.now() + 10_000,
        ],
      );
      await expect(
        store.toolIdempotencyStore.claim({
          key: legacyIdempotencyKey,
          requestHash: "integration_pg_legacy_request",
          owner: "pg_tool_same_fence_retry",
          ttlMs: 10_000,
          lease: fencedIdempotencyLease!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await expect(
        store.toolIdempotencyStore.claim({
          key: legacyIdempotencyKey,
          requestHash: "integration_pg_legacy_request",
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
        ),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "succeeded", output: { ok: true } },
      });
      const pgTerminalKey = "integration_pg_terminal_failure";
      await expect(
        store.toolIdempotencyStore.claim({
          key: pgTerminalKey,
          requestHash: "integration_pg_terminal_request",
          owner: "pg_terminal_owner",
          ttlMs: 10_000,
          lease: fencedIdempotencyLeaseTwo!,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      await store.toolIdempotencyStore.complete(pgTerminalKey, "integration_pg_terminal_request", {
        status: "failed",
        owner: "pg_terminal_owner",
        ttlMs: 10_000,
        lease: fencedIdempotencyLeaseTwo!,
        error: toolError("tool.execution_failed", "Tool execution failed", { retriable: false }),
      });
      await expect(
        store.toolIdempotencyStore.claim({
          key: pgTerminalKey,
          requestHash: "integration_pg_terminal_request",
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
      expect(await redis.get("tvic:v1:session:integration_session")).toContain('"version":2');
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

      const redisStore = createRedisDurableRuntimeStore(adaptRedis(redis));
      const redisSessionId = "integration_redis_transaction" as SessionId;
      const redisRecord = {
        ...record,
        session: { ...record.session, id: redisSessionId },
      };
      const redisLease = await redisStore.createSessionWithLease(redisRecord, "redis_owner", 5000);
      expect(redisLease?.fence).toBe(1);
      await redisStore.runSessionTransaction(redisSessionId, redisLease!, async (tx) => {
        await tx.updateSession(redisSessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            state: { ...current.session.state, turnSequence: 1 },
          },
        }));
        await tx.updateSession(redisSessionId, (current) => ({
          ...current,
          session: {
            ...current.session,
            state: { ...current.session.state, turnSequence: 2 },
          },
        }));
        expect((await tx.getSession(redisSessionId))?.session.state.turnSequence).toBe(2);
      });
      expect((await redisStore.sessions.get(redisSessionId))?.session.state.turnSequence).toBe(2);
      const redisIdempotencyKey = "integration_redis_fenced_idempotency";
      const redisRequestHash = "integration_redis_request";
      const redisClaim = await redisStore.toolIdempotencyStore.claim({
        key: redisIdempotencyKey,
        requestHash: redisRequestHash,
        owner: "redis_tool_one",
        ttlMs: 10_000,
        lease: redisLease!,
      });
      expect(redisClaim.status).toBe("claimed");
      const redisTerminalKey = "integration_redis_terminal_failure";
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: redisTerminalKey,
          requestHash: "integration_redis_terminal_request",
          owner: "redis_terminal_owner",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "claimed" });
      const redisTerminalRedisKey = `tvic:v1:idempotency:${encodeURIComponent(redisTerminalKey)}`;
      expect(await redis.pTTL(redisTerminalRedisKey)).toBeGreaterThan(0);
      await redisStore.toolIdempotencyStore.complete(
        redisTerminalKey,
        "integration_redis_terminal_request",
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
          requestHash: "integration_redis_terminal_request",
          owner: "redis_terminal_retry",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "terminal", record: { status: "timed_out" } });
      const legacyRedisIdempotencyKey = "integration_redis_legacy_same_fence_idempotency";
      await redis.set(
        `tvic:v1:idempotency:${encodeURIComponent(legacyRedisIdempotencyKey)}`,
        JSON.stringify({
          key: legacyRedisIdempotencyKey,
          sessionId: redisSessionId,
          requestHash: "integration_redis_legacy_request",
          status: "claimed",
          owner: "legacy_redis_tool_owner",
          claimedFence: redisLease!.fence,
          expiresAtMs: Date.now() + 10_000,
        }),
      );
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: legacyRedisIdempotencyKey,
          requestHash: "integration_redis_legacy_request",
          owner: "redis_tool_same_fence_retry",
          ttlMs: 10_000,
          lease: redisLease!,
        }),
      ).resolves.toMatchObject({ status: "in_progress" });
      await expect(
        redisStore.toolIdempotencyStore.claim({
          key: legacyRedisIdempotencyKey,
          requestHash: "integration_redis_legacy_request",
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
        ),
      ).resolves.toMatchObject({
        status: "found",
        record: { status: "succeeded", output: { ok: true } },
      });
    } finally {
      store.stopOutboxWorker();
      await redis.quit();
      await pg.end();
    }
  }, 30_000);
});

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
