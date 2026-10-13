import { randomUUID } from "node:crypto";
import {
  assertLeaseFence,
  assertLeaseTtlMs,
  assertRecoveryPageSize,
  BackendUnavailableError,
  CorruptRecordError,
  InvalidArgumentError,
  LeaseLostError,
  RecordNotFoundError,
  safeLeaseExpiryAt,
} from "@tvic/core";
import type {
  SessionId,
  SessionLease,
  SessionLeaseStore,
  SessionRecoveryCandidate,
} from "@tvic/core";
import type { SqlClient, SqlPool } from "./index.js";
import { databaseNowMs, withBackendBoundary, withTransaction } from "./postgres-helpers.js";
import {
  leaseFromRow,
  safePersistedIntegerValue,
  validateLeaseRowNumericFields,
  type LeaseRow,
} from "./postgres-records.js";

export class PostgresSessionLeaseStore implements SessionLeaseStore {
  constructor(readonly client: SqlPool) {}

  async acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null> {
    assertLeaseTtlMs(ttlMs);
    return withTransaction(this.client, (tx) => acquireLease(tx, sessionId, holder, ttlMs));
  }

  async renew(
    sessionId: SessionId,
    holder: string,
    fence: number,
    ttlMs: number,
    generationId: string,
  ): Promise<SessionLease | null> {
    assertLeaseTtlMs(ttlMs);
    assertLeaseFence(fence);
    return withBackendBoundary(async () => {
      const result = await this.client.query<LeaseRow>(
        `WITH current_lease AS MATERIALIZED (
           SELECT session_id, holder, fence, generation_id,
                  acquired_at_ms, renewed_at_ms, expires_at_ms
           FROM tvic_session_leases
           WHERE session_id = $1 AND holder = $2 AND fence = $3 AND generation_id = $5
           FOR UPDATE
         ), clock AS MATERIALIZED (
           SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms
           FROM current_lease
         ), renewed AS (
           UPDATE tvic_session_leases AS lease
           SET renewed_at_ms = clock.now_ms, expires_at_ms = clock.now_ms + $4::bigint,
               updated_at = NOW()
           FROM current_lease, clock
           WHERE lease.session_id = current_lease.session_id
             AND lease.holder = current_lease.holder
             AND lease.fence = current_lease.fence
             AND lease.generation_id = current_lease.generation_id
             AND current_lease.expires_at_ms > clock.now_ms
             AND lease.expires_at_ms > clock.now_ms
             AND $4::bigint > 0
             AND clock.now_ms BETWEEN 0 AND 9007199254740991
             AND clock.now_ms <= 9007199254740991 - $4::bigint
             AND current_lease.fence BETWEEN 1 AND 9007199254740991
             AND current_lease.acquired_at_ms BETWEEN 0 AND 9007199254740991
             AND current_lease.renewed_at_ms BETWEEN 0 AND 9007199254740991
             AND current_lease.expires_at_ms BETWEEN 0 AND 9007199254740991
           RETURNING lease.session_id, lease.holder, lease.fence, lease.generation_id,
                     lease.acquired_at_ms, lease.renewed_at_ms, lease.expires_at_ms
         )
         SELECT session_id, holder, fence, generation_id,
                acquired_at_ms, renewed_at_ms, expires_at_ms
         FROM renewed`,
        [sessionId, holder, fence, ttlMs, generationId],
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
    assertLeaseFence(fence);
    await withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new BackendUnavailableError("PostgreSQL returned an unsafe lease timestamp");
      }
      await this.client.query(
        `UPDATE tvic_session_leases
         SET expires_at_ms = $4, renewed_at_ms = $4, updated_at = NOW()
         WHERE session_id = $1 AND holder = $2 AND fence = $3 AND generation_id = $5
           AND acquired_at_ms BETWEEN 0 AND 9007199254740991
           AND renewed_at_ms BETWEEN 0 AND 9007199254740991
           AND expires_at_ms BETWEEN 0 AND 9007199254740991`,
        [sessionId, holder, fence, now, generationId],
      );
    });
  }

  async get(sessionId: SessionId): Promise<SessionLease | null> {
    return withTransaction(this.client, async (tx) => {
      await tx.query(
        `UPDATE tvic_session_leases SET generation_id = gen_random_uuid()
         WHERE session_id = $1 AND generation_id IS NULL
           AND fence BETWEEN 1 AND 9007199254740991
           AND acquired_at_ms BETWEEN 0 AND 9007199254740991
           AND renewed_at_ms BETWEEN 0 AND 9007199254740991
           AND expires_at_ms BETWEEN 0 AND 9007199254740991`,
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
      const lease = leaseFromRow(row);
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new BackendUnavailableError("PostgreSQL returned an unsafe lease timestamp");
      }
      return lease.expiresAtMs > now ? lease : null;
    });
  }

  async listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly candidates: readonly SessionRecoveryCandidate[];
    readonly corruptLeaseSessionIds?: readonly SessionId[];
    readonly nextCursor?: string;
  }> {
    assertRecoveryPageSize(options.limit);
    const cursor = decodeRecoveryCursor(options.cursor);
    return withBackendBoundary(async () => {
      const nowMs = await databaseNowMs(this.client);
      if (cursor) {
        await this.client.query(
          `WITH needs_generation AS (
             SELECT session_id FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND expires_at_ms BETWEEN 0 AND 9007199254740991
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND generation_id IS NULL
               AND fence BETWEEN 1 AND 9007199254740991
               AND acquired_at_ms BETWEEN 0 AND 9007199254740991
               AND renewed_at_ms BETWEEN 0 AND 9007199254740991
               AND (expires_at_ms, session_id) > ($2::bigint, $3::text)
             ORDER BY tvic_session_leases.expires_at_ms, tvic_session_leases.session_id
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
               AND expires_at_ms BETWEEN 0 AND 9007199254740991
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND generation_id IS NULL
               AND fence BETWEEN 1 AND 9007199254740991
               AND acquired_at_ms BETWEEN 0 AND 9007199254740991
               AND renewed_at_ms BETWEEN 0 AND 9007199254740991
             ORDER BY tvic_session_leases.expires_at_ms, tvic_session_leases.session_id
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
            `SELECT session_id, fence, generation_id, acquired_at_ms, renewed_at_ms,
                    expires_at_ms::text AS expires_at_ms
             FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND (
                 recovery_acknowledged_generation_id IS DISTINCT FROM generation_id
                 OR expires_at_ms NOT BETWEEN 0 AND 9007199254740991
                 OR fence NOT BETWEEN 1 AND 9007199254740991
                 OR acquired_at_ms NOT BETWEEN 0 AND 9007199254740991
                 OR renewed_at_ms NOT BETWEEN 0 AND 9007199254740991
                 OR generation_id IS NULL
               )
               AND (expires_at_ms, session_id) > ($2::bigint, $3::text)
             ORDER BY tvic_session_leases.expires_at_ms, tvic_session_leases.session_id LIMIT $4`,
            [nowMs, cursor.expiresAtMs, cursor.sessionId, options.limit],
          )
        : await this.client.query<RecoveryCandidateRow>(
            `SELECT session_id, fence, generation_id, acquired_at_ms, renewed_at_ms,
                    expires_at_ms::text AS expires_at_ms
             FROM tvic_session_leases
             WHERE expires_at_ms <= $1
               AND recovery_acknowledged_fence IS DISTINCT FROM fence
               AND (
                 recovery_acknowledged_generation_id IS DISTINCT FROM generation_id
                 OR expires_at_ms NOT BETWEEN 0 AND 9007199254740991
                 OR fence NOT BETWEEN 1 AND 9007199254740991
                 OR acquired_at_ms NOT BETWEEN 0 AND 9007199254740991
                 OR renewed_at_ms NOT BETWEEN 0 AND 9007199254740991
                 OR generation_id IS NULL
               )
             ORDER BY tvic_session_leases.expires_at_ms, tvic_session_leases.session_id LIMIT $2`,
            [nowMs, options.limit],
          );
      const candidates: SessionRecoveryCandidate[] = [];
      const corruptLeaseSessionIds: SessionId[] = [];
      for (const row of query.rows) {
        const sessionId = row.session_id as SessionId;
        const fence = safePersistedIntegerValue(row.fence, 1);
        const acquiredAtMs = safePersistedIntegerValue(row.acquired_at_ms);
        const renewedAtMs = safePersistedIntegerValue(row.renewed_at_ms);
        const expiresAtMs = safePersistedIntegerValue(row.expires_at_ms);
        if (
          fence === null ||
          acquiredAtMs === null ||
          renewedAtMs === null ||
          expiresAtMs === null ||
          sessionId.length === 0 ||
          typeof row.generation_id !== "string" ||
          row.generation_id.length === 0
        ) {
          corruptLeaseSessionIds.push(sessionId);
          continue;
        }
        candidates.push({ sessionId, fence, generationId: row.generation_id });
      }
      return {
        candidates,
        ...(corruptLeaseSessionIds.length > 0 ? { corruptLeaseSessionIds } : {}),
        ...(query.rows.length === options.limit
          ? { nextCursor: encodeRecoveryCursor(query.rows.at(-1)!) }
          : {}),
      };
    });
  }

  async acknowledgeRecoveryCandidate(candidate: SessionRecoveryCandidate): Promise<void> {
    assertLeaseFence(candidate.fence);
    if (candidate.generationId.length === 0) {
      throw new InvalidArgumentError("Recovery candidate generation ID must be non-empty");
    }
    await withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      await this.client.query(
        `UPDATE tvic_session_leases
         SET recovery_acknowledged_generation_id = $3,
             recovery_acknowledged_fence = fence, updated_at = NOW()
         WHERE session_id = $1 AND fence = $2 AND generation_id = $3 AND expires_at_ms <= $4
           AND acquired_at_ms BETWEEN 0 AND 9007199254740991
           AND renewed_at_ms BETWEEN 0 AND 9007199254740991
           AND expires_at_ms BETWEEN 0 AND 9007199254740991`,
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
  readonly generation_id: string | null;
  readonly acquired_at_ms: number | string;
  readonly renewed_at_ms: number | string;
  readonly expires_at_ms: number | string;
}

interface RecoveryCursor {
  readonly expiresAtMs: string;
  readonly sessionId: string;
}

const RECOVERY_CURSOR_PREFIX = "tvic_pg_recovery_v1:";
const MAX_RECOVERY_CURSOR_LENGTH = 4_096;
const MAX_RECOVERY_CURSOR_EXPIRY_LENGTH = 20;

function encodeRecoveryCursor(row: RecoveryCandidateRow): string {
  const payload = JSON.stringify([String(row.expires_at_ms), row.session_id]);
  return `${RECOVERY_CURSOR_PREFIX}${Buffer.from(payload).toString("base64url")}`;
}

function decodeRecoveryCursor(cursor: string | undefined): RecoveryCursor | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length > MAX_RECOVERY_CURSOR_LENGTH ||
    !cursor.startsWith(RECOVERY_CURSOR_PREFIX)
  ) {
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
      decoded[0].length > MAX_RECOVERY_CURSOR_EXPIRY_LENGTH ||
      !/^(0|[1-9]\d*|-[1-9]\d*)$/.test(decoded[0]) ||
      typeof decoded[1] !== "string"
    ) {
      throw new Error("invalid cursor payload");
    }
    const expiresAtMs = decoded[0] as string;
    const expiry = BigInt(expiresAtMs);
    if (expiry < -9_223_372_036_854_775_808n || expiry > 9_223_372_036_854_775_807n) {
      throw new Error("cursor expiry is outside the PostgreSQL bigint range");
    }
    return { expiresAtMs, sessionId: decoded[1] as string };
  } catch {
    throw new InvalidArgumentError("Invalid PostgreSQL recovery cursor");
  }
}
export async function assertLease(
  client: SqlClient,
  sessionId: SessionId,
  lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
): Promise<number> {
  assertLeaseFence(lease.fence);
  // Match acquireLease's session-then-lease lock order. Keeping that order
  // prevents an acquire from deadlocking with a transaction that writes the
  // session after its lease has been checked.
  const session = await client.query<
    { id: string; incarnation: number | string } & Record<string, unknown>
  >("SELECT id, incarnation FROM tvic_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
  const incarnation = session.rows[0]
    ? safePersistedIntegerValue(session.rows[0].incarnation)
    : null;
  if (!session.rows[0]) throw new LeaseLostError(sessionId);
  if (incarnation === null) {
    throw new CorruptRecordError(
      `postgres:session:${sessionId}`,
      "incarnation must be a safe non-negative integer",
    );
  }

  await client.query(
    `UPDATE tvic_session_leases SET generation_id = gen_random_uuid()
     WHERE session_id = $1 AND generation_id IS NULL
       AND fence BETWEEN 1 AND 9007199254740991
       AND acquired_at_ms BETWEEN 0 AND 9007199254740991
       AND renewed_at_ms BETWEEN 0 AND 9007199254740991
       AND expires_at_ms BETWEEN 0 AND 9007199254740991`,
    [sessionId],
  );
  const result = await client.query<LeaseRow>(
    "SELECT session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const now = await databaseNowMs(client);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new BackendUnavailableError("PostgreSQL returned an unsafe lease timestamp");
  }
  const row = result.rows[0];
  const parsedLease = row ? leaseFromRow(row) : null;
  if (
    !row ||
    !parsedLease ||
    row.holder !== lease.holder ||
    parsedLease.fence !== lease.fence ||
    row.generation_id !== lease.generationId ||
    parsedLease.expiresAtMs <= now
  ) {
    throw new LeaseLostError(sessionId);
  }
  return incarnation;
}

export async function assertNoActiveLease(
  client: SqlClient,
  sessionId: SessionId,
): Promise<{ readonly fence: number; readonly sessionIncarnation?: number }> {
  // Keep the same session-then-lease lock order as acquireLease/assertLease.
  // The session row lock prevents a lease from being acquired between this
  // check and the compatibility transaction's commit.
  const sessionResult = await client.query<
    {
      id: string;
      last_fence: number | string;
      incarnation: number | string;
    } & Record<string, unknown>
  >("SELECT id, last_fence, incarnation FROM tvic_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
  const session = sessionResult.rows[0];
  const fence = session ? safePersistedIntegerValue(session.last_fence) : 0;
  const sessionIncarnation = session ? safePersistedIntegerValue(session.incarnation) : null;
  if (fence === null || (session && sessionIncarnation === null)) {
    throw new CorruptRecordError(
      `postgres:session:${sessionId}`,
      "fence and incarnation must be safe non-negative integers",
    );
  }
  const result = await client.query<{ expires_at_ms: number | string } & Record<string, unknown>>(
    "SELECT expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const row = result.rows[0];
  if (row) {
    const expiresAtMs = safePersistedIntegerValue(row.expires_at_ms);
    const now = await databaseNowMs(client);
    if (!Number.isSafeInteger(now) || now < 0 || expiresAtMs === null || expiresAtMs > now) {
      throw new LeaseLostError(sessionId);
    }
  }
  return {
    fence,
    ...(sessionIncarnation !== null ? { sessionIncarnation } : {}),
  };
}

export async function acquireLease(
  client: SqlClient,
  sessionId: SessionId,
  holder: string,
  ttlMs: number,
): Promise<SessionLease | null> {
  assertLeaseTtlMs(ttlMs);
  const session = await client.query<{ id: string } & Record<string, unknown>>(
    "SELECT id FROM tvic_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  if (!session.rows[0]) throw new RecordNotFoundError(`session:${sessionId}`);
  const existing = await client.query<LeaseRow>(
    "SELECT session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  let current = existing.rows[0];
  if (current) {
    validateLeaseRowNumericFields(current);
    if (current.generation_id === null) {
      await client.query(
        "UPDATE tvic_session_leases SET generation_id = gen_random_uuid() WHERE session_id = $1 AND generation_id IS NULL",
        [sessionId],
      );
      const regenerated = await client.query<LeaseRow>(
        "SELECT session_id, holder, fence, generation_id, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
        [sessionId],
      );
      current = regenerated.rows[0];
    }
  }
  const now = await databaseNowMs(client);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new BackendUnavailableError("PostgreSQL returned an unsafe lease timestamp");
  }
  const currentExpiry = current ? safePersistedIntegerValue(current.expires_at_ms) : null;
  if (current && currentExpiry !== null && currentExpiry > now) {
    return current.holder === holder ? leaseFromRow(current) : null;
  }
  const currentFence = current ? safePersistedIntegerValue(current.fence) : 0;
  if (currentFence === null || currentFence >= Number.MAX_SAFE_INTEGER) {
    throw new BackendUnavailableError("PostgreSQL lease fence exhausted the safe integer range");
  }
  const fence = currentFence + 1;
  const expiresAtMs = safeLeaseExpiryAt(now, ttlMs);
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
    [sessionId, holder, fence, now, expiresAtMs, generationId],
  );
  return {
    sessionId,
    holder,
    fence,
    generationId,
    acquiredAtMs: now,
    renewedAtMs: now,
    expiresAtMs,
  };
}
