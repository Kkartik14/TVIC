import { Pool, type PoolClient } from "pg";
import { createClient } from "redis";

import type { Memory, Runtime } from "@tvic/core";
import { createPostgresRedisDurableRuntimeStore } from "@tvic/dal-composite";
import {
  runPostgresMigrations,
  type SqlClient,
  type SqlPool,
  type SqlResult,
} from "@tvic/dal-postgres";
import { type RedisClient, type RedisMulti } from "@tvic/dal-redis";
import { createRuntime } from "@tvic/runtime";

export interface ConfiguredRuntime {
  readonly runtime: Runtime;
}

export async function createConfiguredRuntime(memory: Memory): Promise<ConfiguredRuntime> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl && !redisUrl) {
    if (isProductionEnv()) {
      throw new Error("DATABASE_URL and REDIS_URL are required in production");
    }
    console.warn(
      "[durability] DATABASE_URL/REDIS_URL unset; using in-memory runtime for local development.",
    );
    return { runtime: createRuntime({ memory }) };
  }
  if (!databaseUrl || !redisUrl) {
    throw new Error("DATABASE_URL and REDIS_URL must be provided together");
  }

  const pg = new Pool({ connectionString: databaseUrl });
  const redis = createClient({ url: redisUrl });
  try {
    await redis.connect();
    const pool = adaptPool(pg);
    await runPostgresMigrations(pool);
    const durableStore = createPostgresRedisDurableRuntimeStore({
      pool,
      redis: adaptRedis(redis),
      redisOptions: { closeClient: true },
    });
    durableStore.startOutboxWorker({ workerId: `voice-mode-${process.pid}` });
    return {
      runtime: createRuntime({ durableStore, memory }),
    };
  } catch (error) {
    await redis.quit().catch(() => undefined);
    await pg.end().catch(() => undefined);
    throw error;
  }
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production";
}

export function adaptPool(pool: Pool): SqlPool {
  return {
    query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      adaptQuery<Row>(pool, text, values),
    connect: async () => adaptConnection(await pool.connect()),
    end: () => pool.end(),
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

function adaptRedis(client: ReturnType<typeof createClient>): RedisClient {
  return {
    get: (key) => client.get(key),
    set: async (key, value, options) =>
      (await client.set(key, value, options?.NX ? { NX: true } : undefined)) as "OK" | null,
    del: (...keys) => client.del([...keys]),
    eval: (script, keys, args) => client.eval(script, { keys: [...keys], arguments: [...args] }),
    scan: async (cursor, options) => {
      const result = await client.scan(Number(cursor), {
        ...(options?.MATCH ? { MATCH: options.MATCH } : {}),
        ...(options?.COUNT ? { COUNT: options.COUNT } : {}),
      });
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
      const wrapped: RedisMulti = {
        set: (key, value) => {
          multi.set(key, value);
          return wrapped;
        },
        del: (...keys) => {
          multi.del([...keys]);
          return wrapped;
        },
        exec: async () => ((await multi.exec()) ?? []) as readonly unknown[],
      };
      return wrapped;
    },
  };
}
