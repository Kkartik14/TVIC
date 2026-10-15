import { randomUUID } from "node:crypto";
import type { SqlPool } from "./index.js";
import { withBackendBoundary, withTransaction } from "./postgres-helpers.js";

const RETENTION_BATCH_SIZE = 100;

export interface PostgresRetentionSessionIdentity {
  readonly sessionId: string;
  readonly incarnation: number | string;
  readonly version: number | string;
  readonly fence: number | string;
}

export interface PostgresRetentionJobOptions {
  readonly pool: SqlPool;
  readonly terminalRetentionMs: number;
  readonly outboxRetentionMs?: number;
  readonly hasLegalHold: (sessionId: string) => Promise<boolean>;
  readonly archive?: (sessionId: string) => Promise<void>;
  readonly beforeSessionDelete?: (
    candidate: PostgresRetentionSessionIdentity,
    purgeToken: string,
  ) => Promise<void>;
  readonly afterSessionDeleteFailure?: (
    candidate: PostgresRetentionSessionIdentity,
    purgeToken: string,
  ) => Promise<void>;
}

interface RetentionSessionCandidate extends PostgresRetentionSessionIdentity {
  readonly endedAt: string;
}

export interface RetentionRunResult {
  readonly sessionsDeleted: number;
  readonly outboxDeleted: number;
  readonly idempotencyDeleted: number;
}

export class PostgresRetentionJob {
  readonly #options: PostgresRetentionJobOptions;
  #sessionCursor: { readonly endedAt: string; readonly sessionId: string } | undefined;

  constructor(options: PostgresRetentionJobOptions) {
    assertRetentionDuration(options.terminalRetentionMs, "terminalRetentionMs");
    if (options.outboxRetentionMs !== undefined) {
      assertRetentionDuration(options.outboxRetentionMs, "outboxRetentionMs");
    }
    this.#options = options;
  }

  async runOnce(): Promise<RetentionRunResult> {
    return withBackendBoundary(() => this.#runOnce());
  }

  async #runOnce(): Promise<RetentionRunResult> {
    const outbox = await this.#options.pool.query(
      `WITH candidates AS (
         SELECT id FROM tvic_outbox
         WHERE delivered_at IS NOT NULL
           AND delivered_at <= NOW() - ($1::text || ' milliseconds')::interval
         ORDER BY delivered_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM tvic_outbox o USING candidates c WHERE o.id = c.id`,
      [this.#options.outboxRetentionMs ?? 7 * 24 * 60 * 60 * 1_000, RETENTION_BATCH_SIZE],
    );
    const candidates = await this.#options.pool.query<
      RetentionSessionCandidate & Record<string, unknown>
    >(
      `SELECT id AS "sessionId", incarnation, version, last_fence AS fence,
              ended_at::text AS "endedAt"
       FROM tvic_sessions
       WHERE status IN ('completed', 'failed', 'cancelled')
         AND ended_at <= NOW() - ($1::text || ' milliseconds')::interval
         AND ($2::timestamptz IS NULL OR (ended_at, id) > ($2::timestamptz, $3::text))
         AND NOT EXISTS (
           SELECT 1 FROM tvic_outbox o
           WHERE o.session_id = tvic_sessions.id
         )
       ORDER BY ended_at, id
       LIMIT $4`,
      [
        this.#options.terminalRetentionMs,
        this.#sessionCursor?.endedAt ?? null,
        this.#sessionCursor?.sessionId ?? null,
        RETENTION_BATCH_SIZE,
      ],
    );
    let sessionsDeleted = 0;
    for (const row of candidates.rows.slice(0, RETENTION_BATCH_SIZE)) {
      let deletedCount: number;
      let beforeDeleteAttempted = false;
      const purgeToken = randomUUID();
      try {
        deletedCount = await withTransaction(this.#options.pool, async (tx) => {
          const current = await tx.query<
            PostgresRetentionSessionIdentity & Record<string, unknown>
          >(
            `SELECT id AS "sessionId", incarnation, version, last_fence AS fence
             FROM tvic_sessions
             WHERE id = $1 AND incarnation = $2
               AND status IN ('completed', 'failed', 'cancelled')
               AND ended_at <= NOW() - ($3::text || ' milliseconds')::interval
               AND NOT EXISTS (
                 SELECT 1 FROM tvic_outbox o
                 WHERE o.session_id = tvic_sessions.id
               )
             FOR UPDATE`,
            [row.sessionId, row.incarnation, this.#options.terminalRetentionMs],
          );
          const candidate = current.rows[0];
          if (!candidate || (await this.#options.hasLegalHold(candidate.sessionId))) return 0;

          await this.#options.archive?.(candidate.sessionId);
          beforeDeleteAttempted = true;
          await this.#options.beforeSessionDelete?.(candidate, purgeToken);
          const deleted = await tx.query(
            `DELETE FROM tvic_sessions
             WHERE id = $1 AND incarnation = $2
               AND status IN ('completed', 'failed', 'cancelled')
               AND ended_at <= NOW() - ($3::text || ' milliseconds')::interval
               AND NOT EXISTS (
                 SELECT 1 FROM tvic_outbox o
                 WHERE o.session_id = tvic_sessions.id
               )`,
            [candidate.sessionId, candidate.incarnation, this.#options.terminalRetentionMs],
          );
          return deleted.rowCount ?? 0;
        });
      } catch (error) {
        if (beforeDeleteAttempted) {
          await this.#options.afterSessionDeleteFailure?.(row, purgeToken);
        }
        throw error;
      }
      sessionsDeleted += deletedCount;
      if (beforeDeleteAttempted && deletedCount === 0) {
        await this.#options.afterSessionDeleteFailure?.(row, purgeToken);
      }
      this.#sessionCursor = { endedAt: row.endedAt, sessionId: row.sessionId };
    }
    if (candidates.rows.length === 0) this.#sessionCursor = undefined;
    const idempotency = await this.#options.pool.query(
      `WITH candidates AS (
         SELECT key FROM tvic_tool_idempotency
         WHERE (status = 'claimed'
              AND expires_at_ms <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
          OR (status <> 'claimed'
              AND expires_at_ms <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint - $1)
         ORDER BY expires_at_ms, key
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM tvic_tool_idempotency i USING candidates c WHERE i.key = c.key`,
      [this.#options.terminalRetentionMs, RETENTION_BATCH_SIZE],
    );
    return {
      sessionsDeleted,
      outboxDeleted: outbox.rowCount ?? 0,
      idempotencyDeleted: idempotency.rowCount ?? 0,
    };
  }
}

function assertRetentionDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
