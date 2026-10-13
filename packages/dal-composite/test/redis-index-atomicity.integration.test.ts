import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";

import type { AgentId, SessionId, StoredSessionRecord, Timestamp } from "@tvic/core";
import {
  createRedisDurableRuntimeStore,
  RedisOutboxCacheProjector,
  type RedisClient,
} from "@tvic/dal-redis";

const redisIntegrationEnabled = Boolean(process.env.REDIS_URL);

describe.skipIf(!redisIntegrationEnabled)("real Redis record index atomicity", () => {
  it("rejects wrong-type indexes before changing records or outbox events", async () => {
    const redis = createClient({ url: process.env.REDIS_URL ?? "" });
    await redis.connect();
    const prefix = `tvic:test:record-index-atomicity:${randomUUID()}:`;
    const cachePrefix = `${prefix}cache:`;
    const client = adaptRedis(redis);
    const store = createRedisDurableRuntimeStore(client, { prefix });
    const timestamp = new Date().toISOString() as Timestamp;
    const sessionId = `existing_${randomUUID()}` as SessionId;
    const session = createSessionRecord(sessionId, timestamp);
    const sessionKey = `${prefix}session:${encodeURIComponent(sessionId)}`;
    const sessionIndexKey = `${prefix}sessions`;
    const leaseIndexKey = `${prefix}leases`;
    const recoveryIndexKey = `${prefix}lease_recovery_candidates`;
    const leaseKey = `${prefix}lease:${encodeURIComponent(sessionId)}`;
    const standaloneId = `standalone_${randomUUID()}` as SessionId;
    const standaloneKey = `${prefix}session:${encodeURIComponent(standaloneId)}`;
    const createdId = `created_${randomUUID()}` as SessionId;
    const createdKey = `${prefix}session:${encodeURIComponent(createdId)}`;
    const createdLeaseKey = `${prefix}lease:${encodeURIComponent(createdId)}`;
    const fencedEventId = `fenced_${randomUUID()}`;
    const unfencedEventId = `unfenced_${randomUUID()}`;
    const fencedEventKey = `${prefix}outbox:${encodeURIComponent(fencedEventId)}`;
    const unfencedEventKey = `${prefix}outbox:${encodeURIComponent(unfencedEventId)}`;
    const cacheSessionKey = `${cachePrefix}session:${encodeURIComponent(sessionId)}`;
    const cacheIndexKey = `${cachePrefix}sessions`;
    const cacheMetaKey = `${cacheSessionKey}:cache_meta`;
    const lease = await store.leases.acquire(sessionId, "index_test_holder", 60_000);
    let originalSessionRaw: string | null = null;

    try {
      await store.sessions.put(session);
      originalSessionRaw = await redis.get(sessionKey);
      expect(originalSessionRaw).not.toBeNull();
      expect(lease).not.toBeNull();
      await redis.set(sessionIndexKey, "wrong-type");

      await expect(
        store.runSessionTransaction(sessionId, lease!, async (tx) => {
          const updated = await tx.updateSession(sessionId, (current) => ({
            ...current,
            runtime: { ...current.runtime, lastActivityWallAtMs: 1 },
          }));
          await tx.appendOutbox(makeSessionEvent(fencedEventId, updated, lease!.fence));
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(sessionKey)).toBe(originalSessionRaw);
      expect(await redis.get(fencedEventKey)).toBeNull();

      await store.leases.release(sessionId, lease!.holder, lease!.fence, lease!.generationId);
      await expect(
        store.runUnfencedSessionTransaction(sessionId, async (tx) => {
          const updated = await tx.updateSession(sessionId, (current) => ({
            ...current,
            runtime: { ...current.runtime, lastActivityWallAtMs: 2 },
          }));
          await tx.appendOutbox(makeSessionEvent(unfencedEventId, updated, lease!.fence));
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(sessionKey)).toBe(originalSessionRaw);
      expect(await redis.get(unfencedEventKey)).toBeNull();

      await expect(
        store.sessions.put(createSessionRecord(standaloneId, timestamp)),
      ).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      expect(await redis.get(standaloneKey)).toBeNull();

      await expect(
        store.createSessionWithLease(
          createSessionRecord(createdId, timestamp),
          "creation_index_test_holder",
          60_000,
        ),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(await redis.get(createdKey)).toBeNull();

      await redis.set(cacheIndexKey, "wrong-type");
      const projector = new RedisOutboxCacheProjector(client, { prefix: cachePrefix });
      const cacheEvent = makeSessionEvent(`cache_${randomUUID()}`, session, lease!.fence);
      await expect(projector.apply(cacheEvent)).rejects.toMatchObject({
        code: "BACKEND_UNAVAILABLE",
      });
      expect(await redis.get(cacheSessionKey)).toBeNull();
      expect(await redis.get(cacheMetaKey)).toBeNull();
    } finally {
      await redis.del([
        sessionIndexKey,
        leaseIndexKey,
        recoveryIndexKey,
        sessionKey,
        leaseKey,
        standaloneKey,
        createdKey,
        createdLeaseKey,
        fencedEventKey,
        unfencedEventKey,
        cacheIndexKey,
        cacheSessionKey,
        cacheMetaKey,
      ]);
      await redis.quit();
    }
  });
});

function createSessionRecord(id: SessionId, timestamp: Timestamp): StoredSessionRecord {
  return {
    session: {
      id,
      agentId: "atomicity_test_agent" as AgentId,
      status: "active",
      channel: "simulated",
      memoryRefs: [],
      createdAt: timestamp,
      startedAt: timestamp,
      state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
    },
    runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
  };
}

function makeSessionEvent(id: string, record: StoredSessionRecord, fence: number) {
  return {
    id,
    aggregateType: "session" as const,
    aggregateId: record.session.id,
    sessionId: record.session.id,
    version: record.version ?? 1,
    fence,
    envelope: {
      kind: "session",
      schemaVersion: 1,
      payload: record.session,
      runtime: record.runtime,
      version: record.version ?? 1,
    },
  };
}

function adaptRedis(client: any): RedisClient {
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
