import type {
  DurableOutboxEvent,
  DurableRuntimeStore,
  DurableSessionTransaction,
  SessionId,
  SessionLease,
  SessionStore,
  StoredSessionRecord,
  ToolCallStore,
  ToolIdempotencyStore,
  TurnStore,
} from "@tvic/core";
import {
  createPostgresDurableRuntimeStore,
  PostgresOutboxWorker,
  type PostgresOutboxWorkerOptions,
  type SqlPool,
} from "@tvic/dal-postgres";
import {
  RedisOutboxCacheProjector,
  type RedisClient,
  type RedisStoreOptions,
} from "@tvic/dal-redis";

export interface PostgresRedisDurableStoreOptions {
  readonly pool: SqlPool;
  readonly redis: RedisClient;
  readonly redisOptions?: RedisStoreOptions;
}

/**
 * The production composition: PostgreSQL owns all mutations, leases,
 * idempotency, and reads; the outbox asynchronously projects committed
 * envelopes into Redis. A Redis outage therefore cannot turn a committed
 * runtime mutation into a failed domain operation.
 */
export class PostgresRedisDurableRuntimeStore implements DurableRuntimeStore {
  readonly primary;
  readonly cacheProjector: RedisOutboxCacheProjector;
  readonly sessions: SessionStore;
  readonly turns: TurnStore;
  readonly toolCalls: ToolCallStore;
  readonly leases;
  readonly toolIdempotencyStore: ToolIdempotencyStore;
  readonly #redis: RedisClient;
  readonly #redisOptions: RedisStoreOptions | undefined;
  #worker: PostgresOutboxWorker | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: PostgresRedisDurableStoreOptions) {
    this.primary = createPostgresDurableRuntimeStore({ pool: options.pool });
    this.cacheProjector = new RedisOutboxCacheProjector(options.redis, options.redisOptions);
    this.#redis = options.redis;
    this.#redisOptions = options.redisOptions;
    this.sessions = this.primary.sessions;
    this.turns = this.primary.turns;
    this.toolCalls = this.primary.toolCalls;
    this.leases = this.primary.leases;
    this.toolIdempotencyStore = this.primary.toolIdempotencyStore;
  }

  createSessionWithLease(
    record: StoredSessionRecord,
    holder: string,
    ttlMs: number,
    initialEvent?: (lease: SessionLease) => DurableOutboxEvent,
  ): Promise<SessionLease | null> {
    return this.primary.createSessionWithLease(record, holder, ttlMs, initialEvent);
  }

  runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.primary.runSessionTransaction(sessionId, lease, operation);
  }

  runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return this.primary.runUnfencedSessionTransaction(sessionId, operation);
  }

  startOutboxWorker(options: Omit<PostgresOutboxWorkerOptions, "pool" | "deliver">): void {
    void this.#worker?.stop();
    this.#worker = new PostgresOutboxWorker({
      ...options,
      pool: this.primary.pool,
      deliver: (event: DurableOutboxEvent) => this.cacheProjector.apply(event),
    });
    this.#worker.start();
  }

  async stopOutboxWorker(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    await worker?.stop();
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = (async () => {
        await this.stopOutboxWorker();
        await this.primary.close?.();
        if (this.#redisOptions?.closeClient) await this.#redis.quit?.();
      })();
    }
    await this.#closePromise;
  }
}

export function createPostgresRedisDurableRuntimeStore(
  options: PostgresRedisDurableStoreOptions,
): PostgresRedisDurableRuntimeStore {
  return new PostgresRedisDurableRuntimeStore(options);
}
