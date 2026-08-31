import { Pool, type PoolClient } from "pg";
import { createClient } from "redis";
import { describe, expect, it } from "vitest";

import type { AgentId, SessionId, Timestamp, ToolId } from "@tvic/core";
import {
  PostgresOutboxWorker,
  runPostgresMigrations,
  type SqlResult,
  type SqlClient,
  type SqlPool,
} from "@tvic/dal-postgres";
import { createRedisDurableRuntimeStore } from "@tvic/dal-redis";
import { createPostgresRedisDurableRuntimeStore } from "../src/index.js";

const integrationEnabled =
  process.env.TVIC_RUN_INTEGRATION === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.REDIS_URL);

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
      await store.leases.release(
        fencedIdempotencySessionId,
        "fenced_owner_one",
        fencedIdempotencyLease!.fence,
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
        store.toolIdempotencyStore.lookup(fencedIdempotencyKey, fencedIdempotencyHash),
      ).resolves.toMatchObject({ status: "succeeded", output: { ok: true } });
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
      await store.leases.release(sessionId, "integration_owner", lease!.fence);
      const secondLease = await store.leases.acquire(sessionId, "other_owner", 5000);
      expect(secondLease).toMatchObject({
        fence: 2,
      });
      const [racedA, racedB] = await Promise.all([
        store.leases.acquire(sessionId, "race_a", 5000),
        store.leases.acquire(sessionId, "race_b", 5000),
      ]);
      expect([racedA, racedB].filter((candidate) => candidate !== null)).toHaveLength(0);
      await store.leases.release(sessionId, "other_owner", secondLease!.fence);
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
      await redisStore.leases.release(redisSessionId, "redis_owner", redisLease!.fence);
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
        redisStore.toolIdempotencyStore.lookup(redisIdempotencyKey, redisRequestHash),
      ).resolves.toMatchObject({ status: "succeeded", output: { ok: true } });
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
      (await client.set(key, value, options?.NX ? { NX: true } : undefined)) as "OK" | null,
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
        set: (key: string, value: string) => {
          multi.set(key, value);
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
