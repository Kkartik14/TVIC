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
  PostgresRetentionJob,
  PostgresSessionStore,
  PostgresToolCallStore,
  PostgresTurnStore,
  type PostgresOutboxWorkerOptions,
  type PostgresRetentionJobOptions,
  type SqlPool,
} from "@tvic/dal-postgres";
import {
  RedisOutboxCacheProjector,
  SessionCacheRetentionPendingError,
  type RedisClient,
  type RedisStoreOptions,
} from "@tvic/dal-redis";

const SESSION_CACHE_RESTORE_PAGE_SIZE = 100;

type SessionProjectionRecovery = "restored" | "stale" | "not-pending";

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
    lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
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
      deliver: (event: DurableOutboxEvent) => this.#deliverOutboxEvent(event),
    });
    this.#worker.start();
  }

  createRetentionJob(options: Omit<PostgresRetentionJobOptions, "pool">): PostgresRetentionJob {
    const beforeSessionDelete = options.beforeSessionDelete;
    const afterSessionDeleteFailure = options.afterSessionDeleteFailure;
    return new PostgresRetentionJob({
      ...options,
      pool: this.primary.pool,
      beforeSessionDelete: async (candidate, purgeToken) => {
        await beforeSessionDelete?.(candidate, purgeToken);
        await this.cacheProjector.purgeSession(
          {
            sessionId: candidate.sessionId as SessionId,
            incarnation: candidate.incarnation,
            version: candidate.version,
            fence: candidate.fence,
          },
          purgeToken,
        );
      },
      afterSessionDeleteFailure: async (candidate, purgeToken) => {
        await this.#restoreCurrentSessionProjection(
          candidate.sessionId as SessionId,
          candidate.incarnation,
          purgeToken,
        );
        await afterSessionDeleteFailure?.(candidate, purgeToken);
      },
    });
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

  async #deliverOutboxEvent(event: DurableOutboxEvent): Promise<void> {
    try {
      await this.cacheProjector.apply(event);
    } catch (error) {
      if (!(error instanceof SessionCacheRetentionPendingError)) throw error;
      const recovery = await this.#restoreCurrentSessionProjection(
        event.sessionId,
        event.sessionIncarnation ?? 0,
      );
      if (recovery === "stale") return;
      await this.cacheProjector.apply(event);
    }
  }

  async #restoreCurrentSessionProjection(
    sessionId: SessionId,
    expectedIncarnation?: number | string,
    expectedPurgeToken?: string,
  ): Promise<SessionProjectionRecovery> {
    // Keep session writes serialized until the cached snapshot is complete.
    const connection = await this.primary.pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await connection.query<
        { incarnation: number | string; version: number | string; fence: number | string } & Record<
          string,
          unknown
        >
      >(
        `SELECT incarnation, version, last_fence AS fence
         FROM tvic_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const row = result.rows[0];
      if (!row) {
        await connection.query("COMMIT");
        return "stale";
      }
      const incarnation = Number(row.incarnation);
      const version = Number(row.version);
      const fence = Number(row.fence);
      if (
        !Number.isSafeInteger(incarnation) ||
        incarnation < 0 ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !Number.isSafeInteger(fence) ||
        fence < 0
      ) {
        throw new Error("PostgreSQL session retention identity is invalid");
      }
      if (expectedIncarnation !== undefined && Number(expectedIncarnation) !== incarnation) {
        await connection.query("COMMIT");
        return "stale";
      }
      const identity = { sessionId, incarnation, version, fence };
      const purgeToken =
        expectedPurgeToken ??
        (await this.cacheProjector.getSessionPurgeToken({ sessionId, incarnation }));
      if (!purgeToken) {
        await connection.query("COMMIT");
        return "not-pending";
      }
      if (!(await this.cacheProjector.resumeSessionPurge(identity, purgeToken))) {
        await connection.query("COMMIT");
        return "not-pending";
      }
      const session = await new PostgresSessionStore(connection).get(sessionId);
      if (!session) {
        await connection.query("COMMIT");
        return "stale";
      }
      const turns = this.#turnPages(new PostgresTurnStore(connection), sessionId);
      const toolCalls = this.#toolCallPages(new PostgresToolCallStore(connection), sessionId);
      await this.cacheProjector.restoreSessionProjection(identity, purgeToken, {
        session,
        turns,
        toolCalls,
      });
      await connection.query("COMMIT");
      return "restored";
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async *#turnPages(store: PostgresTurnStore, sessionId: SessionId) {
    let cursor: string | undefined;
    while (true) {
      const page = await store.listBySessionPage(
        sessionId,
        cursor,
        SESSION_CACHE_RESTORE_PAGE_SIZE,
      );
      yield* page.records;
      if (page.nextCursor === undefined) return;
      cursor = page.nextCursor;
    }
  }

  async *#toolCallPages(store: PostgresToolCallStore, sessionId: SessionId) {
    let cursor: string | undefined;
    while (true) {
      const page = await store.listBySessionPage(
        sessionId,
        cursor,
        SESSION_CACHE_RESTORE_PAGE_SIZE,
      );
      yield* page.records;
      if (page.nextCursor === undefined) return;
      cursor = page.nextCursor;
    }
  }
}

export function createPostgresRedisDurableRuntimeStore(
  options: PostgresRedisDurableStoreOptions,
): PostgresRedisDurableRuntimeStore {
  return new PostgresRedisDurableRuntimeStore(options);
}
