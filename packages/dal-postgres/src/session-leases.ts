import { randomUUID } from "node:crypto";
import {
  assertRecoveryPageSize,
  InvalidArgumentError,
  LeaseLostError,
  RecordNotFoundError,
} from "@tvic/core";
import type {
  SessionId,
  SessionLease,
  SessionLeaseStore,
  SessionRecoveryCandidate,
} from "@tvic/core";
import type { SqlClient, SqlPool } from "./index.js";
import { databaseNowMs, withBackendBoundary, withTransaction } from "./postgres-helpers.js";
import { leaseFromRow, type LeaseRow } from "./postgres-records.js";

export class PostgresSessionLeaseStore implements SessionLeaseStore {
  constructor(readonly client: SqlPool) {}

  async acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null> {
    return withTransaction(this.client, (tx) => acquireLease(tx, sessionId, holder, ttlMs));
  }

  async renew(
    sessionId: SessionId,
    holder: string,
    fence: number,
    ttlMs: number,
    generationId: string,
  ): Promise<SessionLease | null> {
    return withTransaction(this.client, async (tx) => {
      const current = await tx.query<LeaseRow>(
        `SELECT session_id, holder, fence, generation_id,
                acquired_at_ms, renewed_at_ms, expires_at_ms
         FROM tvic_session_leases
         WHERE session_id = $1
         FOR UPDATE`,
        [sessionId],
      );
      const row = current.rows[0];
      if (
        !row ||
        row.holder !== holder ||
        Number(row.fence) !== fence ||
        row.generation_id !== generationId
      ) {
        return null;
      }

      const now = await databaseNowMs(tx);
      if (Number(row.expires_at_ms) <= now) return null;

      const result = await tx.query<LeaseRow>(
        `UPDATE tvic_session_leases
         SET renewed_at_ms = $4, expires_at_ms = $5,
             generation_id = COALESCE(generation_id, gen_random_uuid()), updated_at = NOW()
         WHERE session_id = $1 AND holder = $2 AND fence = $3 AND expires_at_ms > $4
           AND generation_id = $6
         RETURNING session_id, holder, fence, generation_id,
                   acquired_at_ms, renewed_at_ms, expires_at_ms`,
        [sessionId, holder, fence, now, now + ttlMs, generationId],
      );
      return result.rows[0] ? leaseFromRow(result.rows[0]) : null;
    });
  }

  async release(
    sessionId: SessionId,
    holder: string,
    fence: number,
    generationId: string,
  ): Promise<void> {
    await withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      await this.client.query(
        "UPDATE tvic_session_leases SET expires_at_ms = $4, renewed_at_ms = $4, updated_at = NOW() WHERE session_id = $1 AND holder = $2 AND fence = $3 AND generation_id = $5",
        [sessionId, holder, fence, now, generationId],
      );
    });
  }

  async get(sessionId: SessionId): Promise<SessionLease | null> {
    return withTransaction(this.client, async (tx) => {
      await tx.query(
        "UPDATE tvic_session_leases SET generation_id = gen_random_uuid() WHERE session_id = $1 AND generation_id IS NULL",
        [sessionId],
      );
      const result = await tx.query<LeaseRow>(
        `SELECT session_id, holder, fence, generation_id,
                acquired_at_ms, renewed_at_ms, expires_at_ms
         FROM tvic_session_leases
         WHERE session_id = $1
         FOR UPDATE`,
        [sessionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const now = await databaseNowMs(tx);
      return row && Number(row.expires_at_ms) > now ? leaseFromRow(row) : null;
    });
  }

  async listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly candidates: readonly SessionRecoveryCandidate[];
    readonly nextCursor?: string;
  }> {
    assertRecoveryPageSize(options.limit);
    return withBackendBoundary(async () => {
      const nowMs = await databaseNowMs(this.client);
      const cursor = decodeRecoveryCursor(options.cursor);
      if (cursor) {
        await this.client.query(
          `WITH needs_generation AS (
             SELECT session_id FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND generation_id IS NULL
               AND (expires_at_ms, session_id) > ($2::bigint, $3::text)
             ORDER BY expires_at_ms, session_id
             LIMIT $4 FOR UPDATE SKIP LOCKED
           )
           UPDATE tvic_session_leases AS lease
           SET generation_id = gen_random_uuid()
           FROM needs_generation
           WHERE lease.session_id = needs_generation.session_id`,
          [nowMs, cursor.expiresAtMs, cursor.sessionId, options.limit],
        );
      } else {
        await this.client.query(
          `WITH needs_generation AS (
             SELECT session_id FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND generation_id IS NULL
             ORDER BY expires_at_ms, session_id
             LIMIT $2 FOR UPDATE SKIP LOCKED
           )
           UPDATE tvic_session_leases AS lease
           SET generation_id = gen_random_uuid()
           FROM needs_generation
           WHERE lease.session_id = needs_generation.session_id`,
          [nowMs, options.limit],
        );
      }
      const query = cursor
        ? await this.client.query<RecoveryCandidateRow>(
            `SELECT session_id, fence, generation_id, expires_at_ms FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND generation_id IS NOT NULL
               AND recovery_acknowledged_generation_id IS DISTINCT FROM generation_id
               AND (expires_at_ms, session_id) > ($2::bigint, $3::text)
             ORDER BY expires_at_ms, session_id LIMIT $4`,
            [nowMs, cursor.expiresAtMs, cursor.sessionId, options.limit],
          )
        : await this.client.query<RecoveryCandidateRow>(
            `SELECT session_id, fence, generation_id, expires_at_ms FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND generation_id IS NOT NULL
               AND recovery_acknowledged_generation_id IS DISTINCT FROM generation_id
             ORDER BY expires_at_ms, session_id LIMIT $2`,
            [nowMs, options.limit],
          );
      const candidates = query.rows.map((row) => ({
        sessionId: row.session_id as SessionId,
        fence: Number(row.fence),
        generationId: row.generation_id,
      }));
      return {
        candidates,
        ...(query.rows.length === options.limit
          ? { nextCursor: encodeRecoveryCursor(query.rows.at(-1)!) }
          : {}),
      };
    });
  }

  async acknowledgeRecoveryCandidate(candidate: SessionRecoveryCandidate): Promise<void> {
    await withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      await this.client.query(
        `UPDATE tvic_session_leases
         SET recovery_acknowledged_generation_id = $3,
             recovery_acknowledged_fence = fence, updated_at = NOW()
         WHERE session_id = $1 AND fence = $2 AND generation_id = $3 AND expires_at_ms <= $4`,
        [candidate.sessionId, candidate.fence, candidate.generationId, now],
      );
    });
  }

  async close(): Promise<void> {
    await this.client.end?.();
  }
}
interface RecoveryCandidateRow extends Record<string, unknown> {
  readonly session_id: string;
  readonly fence: number | string;
  readonly generation_id: string;
  readonly expires_at_ms: number | string;
}

interface RecoveryCursor {
  readonly expiresAtMs: string;
  readonly sessionId: string;
}

const RECOVERY_CURSOR_PREFIX = "tvic_pg_recovery_v1:";

function encodeRecoveryCursor(row: RecoveryCandidateRow): string {
  const payload = JSON.stringify([String(row.expires_at_ms), row.session_id]);
  return `${RECOVERY_CURSOR_PREFIX}${Buffer.from(payload).toString("base64url")}`;
}

function decodeRecoveryCursor(cursor: string | undefined): RecoveryCursor | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.startsWith(RECOVERY_CURSOR_PREFIX)) {
    throw new InvalidArgumentError("Invalid PostgreSQL recovery cursor");
  }

  const encoded = cursor.slice(RECOVERY_CURSOR_PREFIX.length);
  try {
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(payload, "utf8").toString("base64url") !== encoded) {
      throw new Error("non-canonical cursor encoding");
    }
    const decoded: unknown = JSON.parse(payload);
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      !/^(0|[1-9]\d*)$/.test(decoded[0]) ||
      typeof decoded[1] !== "string" ||
      decoded[1].length === 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return { expiresAtMs: decoded[0], sessionId: decoded[1] };
  } catch {
    throw new InvalidArgumentError("Invalid PostgreSQL recovery cursor");
  }
}
export async function assertLease(
  client: SqlClient,
  sessionId: SessionId,
  lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
): Promise<void> {
  // Match acquireLease's session-then-lease lock order. Keeping that order
  // prevents an acquire from deadlocking with a transaction that writes the
  // session after its lease has been checked.
  const session = await client.query<{ id: string } & Record<string, unknown>>(
    "SELECT id FROM tvic_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  if (!session.rows[0]) throw new LeaseLostError(sessionId);

  await client.query(
    "UPDATE tvic_session_leases SET generation_id = gen_random_uuid() WHERE session_id = $1 AND generation_id IS NULL",
    [sessionId],
  );
  const result = await client.query<LeaseRow>(
    "SELECT session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const now = await databaseNowMs(client);
  const row = result.rows[0];
  if (
    !row ||
    row.holder !== lease.holder ||
    Number(row.fence) !== lease.fence ||
    row.generation_id !== lease.generationId ||
    Number(row.expires_at_ms) <= now
  ) {
    throw new LeaseLostError(sessionId);
  }
}

export async function acquireLease(
  client: SqlClient,
  sessionId: SessionId,
  holder: string,
  ttlMs: number,
): Promise<SessionLease | null> {
  const session = await client.query<{ id: string } & Record<string, unknown>>(
    "SELECT id FROM tvic_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  if (!session.rows[0]) throw new RecordNotFoundError(`session:${sessionId}`);
  await client.query(
    "UPDATE tvic_session_leases SET generation_id = gen_random_uuid() WHERE session_id = $1 AND generation_id IS NULL",
    [sessionId],
  );
  const result = await client.query<LeaseRow>(
    "SELECT session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const current = result.rows[0];
  const now = await databaseNowMs(client);
  if (current && Number(current.expires_at_ms) > now) {
    return current.holder === holder ? leaseFromRow(current) : null;
  }
  const fence = Number(current?.fence ?? 0) + 1;
  const generationId = randomUUID();
  await client.query(
    `INSERT INTO tvic_session_leases
      (session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms,
       recovery_acknowledged_generation_id, recovery_acknowledged_fence, updated_at)
     VALUES ($1, $2, $3, $6, $4, $4, $5, NULL, NULL, NOW())
     ON CONFLICT (session_id) DO UPDATE SET holder = EXCLUDED.holder,
       fence = EXCLUDED.fence, acquired_at_ms = EXCLUDED.acquired_at_ms,
       renewed_at_ms = EXCLUDED.renewed_at_ms, expires_at_ms = EXCLUDED.expires_at_ms,
       generation_id = EXCLUDED.generation_id,
       recovery_acknowledged_generation_id = NULL,
       recovery_acknowledged_fence = NULL,
       updated_at = NOW()`,
    [sessionId, holder, fence, now, now + ttlMs, generationId],
  );
  return {
    sessionId,
    holder,
    fence,
    generationId,
    acquiredAtMs: now,
    renewedAtMs: now,
    expiresAtMs: now + ttlMs,
  };
}
