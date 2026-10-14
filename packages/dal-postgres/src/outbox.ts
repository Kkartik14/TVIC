import { decodeOutboxEnvelope } from "@tvic/dal-codec";
import { CorruptRecordError } from "@tvic/core";
import type { DurableOutboxEvent } from "@tvic/core";
import type { SqlClient, SqlPool } from "./index.js";
import { withBackendBoundary } from "./postgres-helpers.js";
import { safePersistedIntegerValue } from "./postgres-records.js";

interface OutboxRow extends Record<string, unknown> {
  readonly id: string;
  readonly aggregate_type: DurableOutboxEvent["aggregateType"];
  readonly aggregate_id: string;
  readonly session_id: string;
  readonly session_incarnation: number | string;
  readonly version: number | string;
  readonly fence: number | string;
  readonly envelope: unknown;
}

export interface PostgresOutboxWorkerOptions {
  readonly pool: SqlPool;
  readonly workerId: string;
  readonly deliver: (event: DurableOutboxEvent) => Promise<void>;
  readonly batchSize?: number;
  readonly claimTtlMs?: number;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number }) => void;
}

export interface OutboxRunResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

export class PostgresOutboxWorker {
  readonly #options: PostgresOutboxWorkerOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<OutboxRunResult> | undefined;

  constructor(options: PostgresOutboxWorkerOptions) {
    this.#options = options;
  }

  start(intervalMs = 250): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#inFlight) return;
      void this.runOnce().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#inFlight) await Promise.allSettled([this.#inFlight]);
  }

  runOnce(): Promise<OutboxRunResult> {
    if (this.#inFlight) return this.#inFlight;
    const operation = this.#runOnce();
    void operation.then(
      () => {
        if (this.#inFlight === operation) this.#inFlight = undefined;
      },
      () => {
        if (this.#inFlight === operation) this.#inFlight = undefined;
      },
    );
    this.#inFlight = operation;
    return operation;
  }

  async #runOnce(): Promise<OutboxRunResult> {
    const rows = await withTransaction(this.#options.pool, async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH candidates AS (
           SELECT id FROM tvic_outbox
           WHERE delivered_at IS NULL
             AND (claim_expires_at IS NULL OR claim_expires_at <= NOW())
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE tvic_outbox AS event
         SET claimed_by = $2,
             claim_expires_at = NOW() + ($3::text || ' milliseconds')::interval,
             attempts = event.attempts + 1
         FROM candidates
         WHERE event.id = candidates.id
         RETURNING event.id, event.aggregate_type, event.aggregate_id,
           event.session_id, event.session_incarnation, event.version,
           event.fence, event.envelope`,
        [this.#options.batchSize ?? 100, this.#options.workerId, this.#options.claimTtlMs ?? 5_000],
      );
      return result.rows;
    });

    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      let event: DurableOutboxEvent;
      try {
        event = rowToEvent(row);
      } catch (error) {
        await this.#recordFailure(row.id, error);
        failed += 1;
        this.#emitMetric("outbox.failed", 1);
        continue;
      }
      try {
        await this.#options.deliver(event);
        await withBackendBoundary(() =>
          this.#options.pool.query(
            `UPDATE tvic_outbox
           SET delivered_at = NOW(), claimed_by = NULL, claim_expires_at = NULL
           WHERE id = $1 AND claimed_by = $2`,
            [event.id, this.#options.workerId],
          ),
        );
        delivered += 1;
        this.#emitMetric("outbox.delivered", 1);
      } catch (error) {
        await withBackendBoundary(() =>
          this.#options.pool.query(
            `UPDATE tvic_outbox
           SET last_error = $3::jsonb, claimed_by = NULL, claim_expires_at = NULL
           WHERE id = $1 AND claimed_by = $2`,
            [
              event.id,
              this.#options.workerId,
              JSON.stringify({
                message: error instanceof Error ? error.message : String(error),
              }),
            ],
          ),
        );
        failed += 1;
        this.#emitMetric("outbox.failed", 1);
      }
    }
    this.#emitMetric("outbox.claimed", rows.length);
    return { claimed: rows.length, delivered, failed };
  }

  async #recordFailure(id: string, error: unknown): Promise<void> {
    await withBackendBoundary(() =>
      this.#options.pool.query(
        `UPDATE tvic_outbox
         SET last_error = $2::jsonb, claimed_by = NULL, claim_expires_at = NULL
         WHERE id = $1 AND claimed_by = $3`,
        [
          id,
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
          }),
          this.#options.workerId,
        ],
      ),
    );
  }

  #emitMetric(name: string, value: number): void {
    try {
      this.#options.onMetric?.({ name, value });
    } catch {}
  }
}

function rowToEvent(row: OutboxRow): DurableOutboxEvent {
  const sessionIncarnation = safePersistedIntegerValue(row.session_incarnation);
  if (sessionIncarnation === null) {
    throw new CorruptRecordError(
      `outbox:${row.id}`,
      "session incarnation must be a safe non-negative integer",
    );
  }
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    sessionId: row.session_id as DurableOutboxEvent["sessionId"],
    sessionIncarnation,
    version: Number(row.version),
    fence: Number(row.fence),
    envelope: decodeOutboxEnvelope(
      row.aggregate_type,
      row.envelope,
      `outbox:${row.id}`,
      Number(row.version),
    ),
  };
}

async function withTransaction<T>(
  pool: SqlPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  return withBackendBoundary(async () => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await operation(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  });
}
