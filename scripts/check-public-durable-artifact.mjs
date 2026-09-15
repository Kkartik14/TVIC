import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarballIndex = process.argv.indexOf("--tarball");
const tarballArgument = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : undefined;
if (!tarballArgument)
  throw new Error("Usage: node scripts/check-public-durable-artifact.mjs --tarball path.tgz");
const tarball = path.resolve(tarballArgument);
await readFile(tarball);

const databaseUrl = process.env.DATABASE_URL;
const memoryDatabaseUrl = process.env.MEMORY_INTEGRATION_URL ?? databaseUrl;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !memoryDatabaseUrl || !redisUrl) {
  throw new Error(
    "DATABASE_URL, MEMORY_INTEGRATION_URL (or DATABASE_URL), and REDIS_URL are required",
  );
}

const projectDirectory = await mkdtemp(path.join(tmpdir(), "voice-runtime-durable-artifact-"));
try {
  await execFileAsync("npm", ["init", "-y"], { cwd: projectDirectory });
  await execFileAsync(
    "npm",
    ["install", tarball, "pg@8.13.1", "redis@4.7.0", "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: projectDirectory },
  );

  const check = `
import pgModule from "pg";
import redisModule from "redis";
import {
  createPostgresMemory,
  createPostgresRedisDurableRuntimeStore,
  createRedisDurableRuntimeStore,
  runPostgresMemoryMigrations,
  runPostgresMigrations,
} from "voice-runtime";

const { Pool } = pgModule;
const { createClient } = redisModule;

const databaseUrl = process.env.DATABASE_URL;
const memoryDatabaseUrl = process.env.MEMORY_INTEGRATION_URL;
const redisUrl = process.env.REDIS_URL;
const pg = new Pool({ connectionString: databaseUrl });
const memoryPg = new Pool({ connectionString: memoryDatabaseUrl });
const redis = createClient({ url: redisUrl });
let composite;
let redisStore;
try {
  await redis.connect();
  await runPostgresMigrations(pg);
  await runPostgresMemoryMigrations(memoryPg);
  await pg.query("TRUNCATE tvic_sessions, tvic_tool_idempotency CASCADE");
  await memoryPg.query("TRUNCATE tvic_memory_entries");
  await redis.flushDb();

  const memory = createPostgresMemory({ pool: memoryPg });
  const ref = { scope: "user", userId: "packed_artifact_user" };
  await memory.put(ref, "timezone", "fact", "Asia/Kolkata");
  if ((await memory.get(ref, "timezone", "fact"))?.value !== "Asia/Kolkata") {
    throw new Error("packed artifact Postgres memory read failed");
  }

  const redisAdapter = {
    get: (key) => redis.get(key),
    set: async (key, value, options) => (await redis.set(key, value, options?.NX ? { NX: true } : undefined)) ?? null,
    del: (...keys) => redis.del([...keys]),
    eval: (script, keys, args) => redis.eval(script, { keys: [...keys], arguments: [...args] }),
    scan: async (cursor, options) => {
      const result = await redis.scan(Number(cursor), options?.MATCH ? options : undefined);
      return [String(result.cursor), result.keys];
    },
    zrange: (key, start, stop) => redis.zRange(key, start, stop),
    zrangebyscore: (key, min, max) => redis.zRangeByScore(key, min, max),
    time: async () => {
      const result = await redis.sendCommand(["TIME"]);
      return [result[0] ?? "0", result[1] ?? "0"];
    },
    watch: (...keys) => redis.watch([...keys]).then(() => undefined),
    unwatch: () => redis.unwatch().then(() => undefined),
    multi: () => {
      const multi = redis.multi();
      const wrapped = {
        set: (key, value) => { multi.set(key, value); return wrapped; },
        del: (...keys) => { multi.del([...keys]); return wrapped; },
        exec: async () => (await multi.exec()) ?? [],
      };
      return wrapped;
    },
  };
  composite = createPostgresRedisDurableRuntimeStore({ pool: pg, redis: redisAdapter });
  const timestamp = "2026-09-15T00:00:00.000Z";
  const record = {
    session: {
      id: "packed_artifact_session", agentId: "packed_artifact_agent", status: "active",
      channel: "simulated", memoryRefs: [], createdAt: timestamp, startedAt: timestamp,
      state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
    },
    runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
  };
  const lease = await composite.createSessionWithLease(record, "packed_artifact_owner", 10_000);
  if (lease?.fence !== 1) throw new Error("packed artifact composite lease failed");
  redisStore = createRedisDurableRuntimeStore(redisAdapter);
  const redisLease = await redisStore.createSessionWithLease(
    { ...record, session: { ...record.session, id: "packed_artifact_redis_session" } },
    "packed_artifact_redis_owner",
    10_000,
  );
  if (redisLease?.fence !== 1) throw new Error("packed artifact Redis lease failed");
  console.log("check-public-durable-artifact: exact packed artifact passed PostgreSQL and Redis");
} finally {
  if (composite) await composite.stopOutboxWorker().catch(() => undefined);
  if (redisStore) await redisStore.close().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  await memoryPg.end().catch(() => undefined);
  await pg.end().catch(() => undefined);
}
`;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", check], {
    cwd: projectDirectory,
    env: process.env,
  });
  process.stdout.write(result.stdout);
} finally {
  await rm(projectDirectory, { recursive: true, force: true });
}
