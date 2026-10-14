import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requireLocalDurableIntegrationTargets } from "./local-durable-integration-targets.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tarballIndex = process.argv.indexOf("--tarball");
const tarballArgument = tarballIndex >= 0 ? process.argv[tarballIndex + 1] : undefined;
if (!tarballArgument)
  throw new Error("Usage: node scripts/check-public-durable-artifact.mjs --tarball path.tgz");
const tarball = path.resolve(tarballArgument);
await readFile(tarball);

const { databaseUrl, memoryDatabaseUrl, redisUrl } = requireLocalDurableIntegrationTargets();

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
import { randomUUID } from "node:crypto";
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
const runId = randomUUID();
const redisPrefix = "tvic:test:packed-durable:" + runId + ":";
const memoryUserId = "packed_artifact_user_" + runId;
const compositeSessionId = "packed_artifact_session_" + runId;
const redisSessionId = "packed_artifact_redis_session_" + runId;
let composite;
let redisStore;
try {
  await redis.connect();
  await runPostgresMigrations(pg);
  await runPostgresMemoryMigrations(memoryPg);

  const memory = createPostgresMemory({ pool: memoryPg });
  const ref = { scope: "user", userId: memoryUserId };
  await memory.put(ref, "timezone", "fact", "Asia/Kolkata");
  if ((await memory.get(ref, "timezone", "fact"))?.value !== "Asia/Kolkata") {
    throw new Error("packed artifact Postgres memory read failed");
  }

  const redisAdapter = {
    get: (key) => redis.get(key),
    set: async (key, value, options) => (await redis.set(
      key,
      value,
      options ? { ...(options.NX ? { NX: true } : {}), ...(options.PX ? { PX: options.PX } : {}) } : undefined,
    )) ?? null,
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
        set: (key, value, options) => { multi.set(key, value, options); return wrapped; },
        del: (...keys) => { multi.del([...keys]); return wrapped; },
        exec: async () => (await multi.exec()) ?? [],
      };
      return wrapped;
    },
  };
  composite = createPostgresRedisDurableRuntimeStore({
    pool: pg,
    redis: redisAdapter,
    redisOptions: { prefix: redisPrefix },
  });
  const timestamp = "2026-09-15T00:00:00.000Z";
  const compositeHolder = "packed_artifact_owner";
  const record = {
    session: {
      id: compositeSessionId, agentId: "packed_artifact_agent", status: "active",
      channel: "simulated", memoryRefs: [], createdAt: timestamp, startedAt: timestamp,
      state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
    },
    runtime: { monotonicStartedAtMs: 0, lastActivityWallAtMs: 0 },
  };
  const lease = await composite.createSessionWithLease(record, compositeHolder, 10_000);
  if (lease?.fence !== 1) throw new Error("packed artifact composite lease failed");
  await composite.leases.release(compositeSessionId, compositeHolder, lease.fence, lease.generationId);
  const compositeCandidate = await findRecoveryCandidate(composite.leases, compositeSessionId);
  if (
    compositeCandidate?.fence !== lease.fence ||
    compositeCandidate?.generationId !== lease.generationId
  ) {
    throw new Error("packed artifact PostgreSQL recovery candidate failed");
  }
  await composite.leases.acknowledgeRecoveryCandidate(compositeCandidate);
  if (await findRecoveryCandidate(composite.leases, compositeSessionId)) {
    throw new Error("packed artifact PostgreSQL recovery acknowledgment failed");
  }

  redisStore = createRedisDurableRuntimeStore(redisAdapter, { prefix: redisPrefix });
  const redisHolder = "packed_artifact_redis_owner";
  const redisLease = await redisStore.createSessionWithLease(
    { ...record, session: { ...record.session, id: redisSessionId } },
    redisHolder,
    10_000,
  );
  if (redisLease?.fence !== 1) throw new Error("packed artifact Redis lease failed");
  await redisStore.leases.release(redisSessionId, redisHolder, redisLease.fence, redisLease.generationId);
  const redisCandidate = await findRecoveryCandidate(redisStore.leases, redisSessionId);
  if (
    redisCandidate?.fence !== redisLease.fence ||
    redisCandidate?.generationId !== redisLease.generationId
  ) {
    throw new Error("packed artifact Redis recovery candidate failed");
  }
  await redisStore.leases.acknowledgeRecoveryCandidate(redisCandidate);
  if (await findRecoveryCandidate(redisStore.leases, redisSessionId)) {
    throw new Error("packed artifact Redis recovery acknowledgment failed");
  }
  console.log("check-public-durable-artifact: exact packed artifact passed PostgreSQL and Redis");
} finally {
  if (composite) await composite.stopOutboxWorker().catch(() => undefined);
  if (redisStore) await redisStore.close().catch(() => undefined);
  await pg.query("DELETE FROM tvic_sessions WHERE id = $1", [compositeSessionId]).catch(() => undefined);
  await memoryPg
    .query(
      "DELETE FROM tvic_memory_entries WHERE scope_kind = 'user' AND scope_id = $1 AND kind = 'fact' AND key = 'timezone'",
      [memoryUserId],
    )
    .catch(() => undefined);
  await redis
    .del([
      redisPrefix + "session:" + encodeURIComponent(redisSessionId),
      redisPrefix + "sessions",
      redisPrefix + "lease:" + encodeURIComponent(redisSessionId),
      redisPrefix + "leases",
      redisPrefix + "lease_recovery_candidates",
    ])
    .catch(() => undefined);
  await redis.quit().catch(() => undefined);
  await memoryPg.end().catch(() => undefined);
  await pg.end().catch(() => undefined);
}

async function findRecoveryCandidate(leases, sessionId) {
  let cursor;
  do {
    const page = await leases.listRecoveryCandidates({
      nowMs: Date.now(),
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const candidate = page.candidates.find((entry) => entry.sessionId === sessionId);
    if (candidate) return candidate;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return null;
}
`;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", check], {
    cwd: projectDirectory,
    env: { ...process.env, MEMORY_INTEGRATION_URL: memoryDatabaseUrl },
  });
  process.stdout.write(result.stdout);
} finally {
  await rm(projectDirectory, { recursive: true, force: true });
}
