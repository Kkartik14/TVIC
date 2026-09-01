import type { SqlPool } from "./index.js";
import { withBackendBoundary } from "./postgres-helpers.js";

export interface PostgresRetentionJobOptions {
  readonly pool: SqlPool;
  readonly terminalRetentionMs: number;
  readonly outboxRetentionMs?: number;
  readonly hasLegalHold: (sessionId: string) => Promise<boolean>;
  readonly archive?: (sessionId: string) => Promise<void>;
}

export interface RetentionRunResult {
  readonly sessionsDeleted: number;
  readonly outboxDeleted: number;
  readonly idempotencyDeleted: number;
}

export class PostgresRetentionJob {
  readonly #options: PostgresRetentionJobOptions;

  constructor(options: PostgresRetentionJobOptions) {
    this.#options = options;
  }

  async runOnce(): Promise<RetentionRunResult> {
    return withBackendBoundary(() => this.#runOnce());
  }

  async #runOnce(): Promise<RetentionRunResult> {
    // Outbox rows are retained independently, but delivered rows must be
    // removed before their parent sessions because the schema deliberately
    // uses RESTRICT on the session foreign key. Pending rows are never
    // deleted here; they also prevent session deletion below.
    const outbox = await this.#options.pool.query(
      `DELETE FROM tvic_outbox
       WHERE delivered_at IS NOT NULL
         AND delivered_at <= NOW() - ($1::text || ' milliseconds')::interval`,
      [this.#options.outboxRetentionMs ?? 7 * 24 * 60 * 60 * 1_000],
    );
    const candidates = await this.#options.pool.query<{ id: string } & Record<string, unknown>>(
      `SELECT id FROM tvic_sessions
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND ended_at <= NOW() - ($1::text || ' milliseconds')::interval
         AND NOT EXISTS (
           SELECT 1 FROM tvic_outbox o
           WHERE o.session_id = tvic_sessions.id AND o.delivered_at IS NULL
         )
       ORDER BY ended_at, id`,
      [this.#options.terminalRetentionMs],
    );
    let sessionsDeleted = 0;
    for (const row of candidates.rows) {
      if (await this.#options.hasLegalHold(row.id)) continue;
      await this.#options.archive?.(row.id);
      const deleted = await this.#options.pool.query(
        `DELETE FROM tvic_sessions
         WHERE id = $1 AND status IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM tvic_outbox o
             WHERE o.session_id = tvic_sessions.id AND o.delivered_at IS NULL
           )`,
        [row.id],
      );
      sessionsDeleted += deleted.rowCount ?? 0;
    }
    const idempotency = await this.#options.pool.query(
      `DELETE FROM tvic_tool_idempotency
       WHERE status <> 'claimed'
         AND expires_at_ms <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint - $1`,
      [this.#options.terminalRetentionMs],
    );
    return {
      sessionsDeleted,
      outboxDeleted: outbox.rowCount ?? 0,
      idempotencyDeleted: idempotency.rowCount ?? 0,
    };
  }
}
