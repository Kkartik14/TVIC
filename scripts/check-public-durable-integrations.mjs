import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../packages/dal-composite/package.json", import.meta.url));
const { Pool } = require("pg");
const { createClient } = require("redis");

const databaseUrl = process.env.DATABASE_URL;
const memoryDatabaseUrl = process.env.MEMORY_INTEGRATION_URL ?? databaseUrl;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !memoryDatabaseUrl || !redisUrl) {
  throw new Error(
    "DATABASE_URL, MEMORY_INTEGRATION_URL (or DATABASE_URL), and REDIS_URL are required",
  );
}

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
  await pg.query("TRUNCATE tvic_sessions, tvic_tool_idempotency CASCADE");
  await memoryPg.query("TRUNCATE tvic_memory_entries");
  await redis.flushDb();

  const memory = createPostgresMemory({ pool: memoryPg });
  const memoryRef = { scope: "user", userId: "public_integration_user" };
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

  const record = sessionRecord("public_composite_session");
  composite = createPostgresRedisDurableRuntimeStore({ pool: pg, redis: redisClient });
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

  redisStore = createRedisDurableRuntimeStore(redisClient);
  const redisRecord = sessionRecord("public_redis_session");
  const redisLease = await redisStore.createSessionWithLease(
    redisRecord,
    "public_redis_owner",
    10_000,
  );
  assert(redisLease?.fence === 1, "public Redis lease acquisition failed");
  const redisStored = await redisStore.sessions.get(redisRecord.session.id);
  assert(redisStored?.session.id === redisRecord.session.id, "public Redis session read failed");

  console.log("check-public-durable-integrations: public ESM artifact passed PostgreSQL and Redis");
} finally {
  await closeQuietly(() => composite?.stopOutboxWorker());
  await closeQuietly(() => redisStore?.close());
  await closeQuietly(() => redis.quit());
  await closeQuietly(() => memoryPg.end());
  await closeQuietly(() => pg.end());
}

async function closeQuietly(close) {
  try {
    await close();
  } catch {
    // Cleanup should not hide the original integration failure.
  }
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
      (await client.set(key, value, options?.NX ? { NX: true } : undefined)) ?? null,
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
        set: (key, value) => {
          multi.set(key, value);
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
