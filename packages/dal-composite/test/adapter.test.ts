import { describe, expect, it, vi } from "vitest";

import {
  createPostgresRedisDurableRuntimeStore,
  type PostgresRedisDurableStoreOptions,
} from "../src/index.js";
import type { RedisClient, RedisMulti } from "@tvic/dal-redis";
import type { SqlClient, SqlPool } from "@tvic/dal-postgres";

function fakePool(queries: string[] = []): SqlPool {
  const query = async (text: string) => {
    queries.push(text);
    return { rows: [], rowCount: 0 };
  };
  const connection: SqlClient & { readonly release: () => void } = {
    query,
    release: () => undefined,
  };
  return {
    query,
    connect: async () => connection,
  };
}

function fakeRedis(): RedisClient {
  const evalMock = vi.fn(async () => 1);
  const multi: RedisMulti = {
    set: () => multi,
    del: () => multi,
    exec: async () => [],
  };
  return {
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
    eval: evalMock,
    scan: async () => ["0", []],
    zrange: async () => [],
    zrangebyscore: async () => [],
    time: async () => ["0", "0"],
    watch: async () => undefined,
    unwatch: async () => undefined,
    multi: () => multi,
  };
}

describe("PostgreSQL + Redis composition", () => {
  it("exposes PostgreSQL stores and a separate cache projector", () => {
    const options: PostgresRedisDurableStoreOptions = {
      pool: fakePool(),
      redis: fakeRedis(),
    };
    const store = createPostgresRedisDurableRuntimeStore(options);
    expect(store.sessions).toBe(store.primary.sessions);
    expect(store.leases).toBe(store.primary.leases);
    expect(store.cacheProjector).toBeDefined();
  });

  it("stops its outbox worker before the durable store is closed", async () => {
    vi.useFakeTimers();
    try {
      const queries: string[] = [];
      const store = createPostgresRedisDurableRuntimeStore({
        pool: fakePool(queries),
        redis: fakeRedis(),
      });
      store.startOutboxWorker({ workerId: "shutdown-test" });
      await store.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(queries).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the PostgreSQL pool once and then the owned Redis client", async () => {
    const end = vi.fn(async () => undefined);
    const quit = vi.fn(async () => undefined);
    const pool = { ...fakePool(), end };
    const redis = { ...fakeRedis(), quit };
    const store = createPostgresRedisDurableRuntimeStore({
      pool,
      redis,
      redisOptions: { closeClient: true },
    });

    await Promise.all([store.close(), store.close()]);

    expect(end).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
