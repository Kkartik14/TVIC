import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireLocalDurableIntegrationTargets } from "./local-durable-integration-targets.mjs";

const require = createRequire(new URL("../packages/dal-composite/package.json", import.meta.url));
const { Pool } = require("pg");
const { createClient } = require("redis");

const { databaseUrl, memoryDatabaseUrl, redisUrl } = requireLocalDurableIntegrationTargets();

const {
  createPostgresMemory,
  createPostgresRedisDurableRuntimeStore,
  createRedisDurableRuntimeStore,
  runPostgresMemoryMigrations,
  runPostgresMigrations,
} = await import("../packages/voice-runtime/dist/index.js");
const commonJsApi = require(
  fileURLToPath(new URL("../packages/voice-runtime/dist/index.cjs", import.meta.url)),
);

const pg = new Pool({ connectionString: databaseUrl });
const memoryPg = new Pool({ connectionString: memoryDatabaseUrl });
const redis = createClient({ url: redisUrl });
const redisClient = adaptRedis(redis);
const runId = randomUUID();
const redisPrefix = `tvic:test:public-durable:${runId}:`;
const memoryUserId = `public_integration_user_${runId}`;
const compositeSessionId = `public_composite_session_${runId}`;
const redisSessionId = `public_redis_session_${runId}`;
const postgresTerminalKey = `public_integration_terminal_failure_${runId}`;
const redisTerminalKey = `public_redis_terminal_failure_${runId}`;
const expiredLegacyKey = `public_integration_expired_legacy_${runId}`;
let memory;
let composite;
let redisStore;

try {
  await redis.connect();
  await runPostgresMigrations(pg);
  await runPostgresMemoryMigrations(memoryPg);
  assert(
    (await commonJsApi.runPostgresMigrations(pg)).length === 0,
    "public CommonJS migration idempotency failed",
  );
  assert(
    (await commonJsApi.runPostgresMemoryMigrations(memoryPg)).length === 0,
    "public CommonJS memory migration idempotency failed",
  );
  memory = createPostgresMemory({ pool: memoryPg });
  const memoryRef = { scope: "user", userId: memoryUserId };
  await memory.put(memoryRef, "timezone", "fact", "Asia/Kolkata");
  const memoryEntry = await memory.get(memoryRef, "timezone", "fact");
  assert(memoryEntry?.value === "Asia/Kolkata", "public Postgres memory put/get failed");
  assert(
    await memory.delete(memoryRef, "timezone", "fact"),
    "public Postgres memory delete failed",
  );
  assert(
    (await memory.get(memoryRef, "timezone", "fact")) === null,
    "memory delete was not durable",
  );

  const record = sessionRecord(compositeSessionId);
  composite = createPostgresRedisDurableRuntimeStore({
    pool: pg,
    redis: redisClient,
    redisOptions: { prefix: redisPrefix },
  });
  const lease = await composite.createSessionWithLease(record, "public_composite_owner", 10_000);
  assert(lease?.fence === 1, "public composite lease acquisition failed");
  await composite.runSessionTransaction(record.session.id, lease, async (tx) => {
    await tx.updateSession(record.session.id, (current) => ({
      ...current,
      session: {
        ...current.session,
        state: { ...current.session.state, turnSequence: 1 },
      },
    }));
  });
  const durableRecord = await composite.sessions.get(record.session.id);
  assert(
    durableRecord?.session.state.turnSequence === 1,
    "public PostgreSQL composite transaction failed",
  );

  const postgresTerminalHash = `public_integration_terminal_request_${runId}`;
  const postgresTerminalClaim = await composite.toolIdempotencyStore.claim({
    key: postgresTerminalKey,
    sessionId: record.session.id,
    lease,
    requestHash: postgresTerminalHash,
    owner: "public_integration_terminal_owner",
    ttlMs: 10_000,
  });
  assert(postgresTerminalClaim.status === "claimed", "PostgreSQL idempotency claim failed");
  await composite.toolIdempotencyStore.complete(postgresTerminalKey, postgresTerminalHash, {
    status: "failed",
    sessionId: record.session.id,
    lease,
    owner: "public_integration_terminal_owner",
    ttlMs: 10_000,
    error: {
      name: "ToolError",
      code: "tool.execution_failed",
      category: "tool",
      message: "Tool execution failed",
      retriable: false,
    },
  });
  const postgresTerminalRetry = await composite.toolIdempotencyStore.claim({
    key: postgresTerminalKey,
    sessionId: record.session.id,
    lease,
    requestHash: postgresTerminalHash,
    owner: "public_integration_terminal_retry",
    ttlMs: 10_000,
  });
  assert(
    postgresTerminalRetry.status === "terminal" && postgresTerminalRetry.record.status === "failed",
    "PostgreSQL retried a terminal idempotency failure",
  );

  redisStore = createRedisDurableRuntimeStore(redisClient, { prefix: redisPrefix });
  const redisRecord = sessionRecord(redisSessionId);
  const redisLease = await redisStore.createSessionWithLease(
    redisRecord,
    "public_redis_owner",
    10_000,
  );
  assert(redisLease?.fence === 1, "public Redis lease acquisition failed");
  const redisStored = await redisStore.sessions.get(redisRecord.session.id);
  assert(redisStored?.session.id === redisRecord.session.id, "public Redis session read failed");
  const redisTerminalHash = `public_redis_terminal_request_${runId}`;
  const redisTerminalClaim = await redisStore.toolIdempotencyStore.claim({
    key: redisTerminalKey,
    sessionId: redisRecord.session.id,
    lease: redisLease,
    requestHash: redisTerminalHash,
    owner: "public_redis_terminal_owner",
    ttlMs: 10_000,
  });
  assert(redisTerminalClaim.status === "claimed", "Redis idempotency claim failed");
  const redisTerminalPhysicalKey = `${redisPrefix}idempotency:${encodeURIComponent(redisTerminalKey)}`;
  assert((await redis.pTTL(redisTerminalPhysicalKey)) > 0, "Redis idempotency TTL was not set");
  await redisStore.toolIdempotencyStore.complete(redisTerminalKey, redisTerminalHash, {
    status: "timed_out",
    sessionId: redisRecord.session.id,
    lease: redisLease,
    owner: "public_redis_terminal_owner",
    ttlMs: 10_000,
    error: {
      name: "TimeoutError",
      code: "tool.timeout",
      category: "timeout",
      message: "Tool execution exceeded its timeout",
      retriable: false,
    },
  });
  const redisTerminalRetry = await redisStore.toolIdempotencyStore.claim({
    key: redisTerminalKey,
    sessionId: redisRecord.session.id,
    lease: redisLease,
    requestHash: redisTerminalHash,
    owner: "public_redis_terminal_retry",
    ttlMs: 10_000,
  });
  assert(
    redisTerminalRetry.status === "terminal" && redisTerminalRetry.record.status === "timed_out",
    "Redis retried a terminal idempotency failure",
  );
  const expiredLegacyPhysicalKey = `${redisPrefix}idempotency:${encodeURIComponent(expiredLegacyKey)}`;
  await redis.set(
    expiredLegacyPhysicalKey,
    JSON.stringify({
      key: expiredLegacyKey,
      requestHash: "expired_legacy_request",
      status: "succeeded",
      expiresAtMs: 1,
      output: { ok: true },
    }),
  );
  const pruned = await redisStore.toolIdempotencyStore.pruneExpiredIdempotencyPage("0", 100);
  assert(pruned.deleted === 1, "expired Redis legacy idempotency row was not pruned");
  assert((await redis.get(expiredLegacyPhysicalKey)) === null, "expired Redis row remains stored");

  console.log("check-public-durable-integrations: public ESM artifact passed PostgreSQL and Redis");
} finally {
  await closeQuietly(() => composite?.stopOutboxWorker());
  await closeQuietly(() => redisStore?.close());
  await closeQuietly(() =>
    memory?.delete({ scope: "user", userId: memoryUserId }, "timezone", "fact"),
  );
  await closeQuietly(() =>
    pg.query("DELETE FROM tvic_tool_idempotency WHERE key = ANY($1::text[])", [
      [postgresTerminalKey],
    ]),
  );
  await closeQuietly(() =>
    pg.query("DELETE FROM tvic_sessions WHERE id = $1", [compositeSessionId]),
  );
  await closeQuietly(() =>
    redis.del([
      `${redisPrefix}session:${encodeURIComponent(redisSessionId)}`,
      `${redisPrefix}sessions`,
      `${redisPrefix}lease:${encodeURIComponent(redisSessionId)}`,
      `${redisPrefix}leases`,
      `${redisPrefix}lease_recovery_candidates`,
      `${redisPrefix}idempotency:${encodeURIComponent(redisTerminalKey)}`,
      `${redisPrefix}idempotency:${encodeURIComponent(expiredLegacyKey)}`,
    ]),
  );
  await closeQuietly(() => redis.quit());
  await closeQuietly(() => memoryPg.end());
  await closeQuietly(() => pg.end());
}

async function closeQuietly(close) {
  try {
    await close();
  } catch {}
}

function sessionRecord(id) {
  const timestamp = "2026-09-07T00:00:00.000Z";
  return {
    session: {
      id,
      agentId: "public_integration_agent",
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function adaptRedis(client) {
  return {
    get: (key) => client.get(key),
    set: async (key, value, options) =>
      (await client.set(
        key,
        value,
        options
          ? { ...(options.NX ? { NX: true } : {}), ...(options.PX ? { PX: options.PX } : {}) }
          : undefined,
      )) ?? null,
    del: (...keys) => client.del([...keys]),
    eval: (script, keys, args) => client.eval(script, { keys: [...keys], arguments: [...args] }),
    scan: async (cursor, options) => {
      const result = await client.scan(Number(cursor), options?.MATCH ? options : undefined);
      return [String(result.cursor), result.keys];
    },
    zrange: (key, start, stop) => client.zRange(key, start, stop),
    zrangebyscore: (key, min, max) => client.zRangeByScore(key, min, max),
    time: async () => {
      const result = await client.sendCommand(["TIME"]);
      return [result[0] ?? "0", result[1] ?? "0"];
    },
    watch: (...keys) => client.watch([...keys]).then(() => undefined),
    unwatch: () => client.unwatch().then(() => undefined),
    multi: () => {
      const multi = client.multi();
      const wrapped = {
        set: (key, value, options) => {
          multi.set(key, value, options);
          return wrapped;
        },
        del: (...keys) => {
          multi.del([...keys]);
          return wrapped;
        },
        exec: async () => (await multi.exec()) ?? [],
      };
      return wrapped;
    },
  };
}
