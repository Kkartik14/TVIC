import {
  LeaseLostError,
  RecordConflictError,
  type SessionId,
  type ToolId,
  type ToolIdempotencyClaim,
  type ToolIdempotencyClaimResult,
  type ToolIdempotencyOutcome,
  type ToolIdempotencyRecord,
  type ToolIdempotencyStore,
} from "@tvic/core";
import { CorruptRecordError, normalizePersistedError, stableStringify } from "@tvic/dal-codec";
import type { SqlClient } from "./index.js";
import { databaseNowMs, withBackendBoundary, withTransaction } from "./postgres-helpers.js";

interface IdempotencyRow extends Record<string, unknown> {
  readonly key: string;
  readonly session_id?: string | null;
  readonly tool_id?: string | null;
  readonly tool_version?: string | null;
  readonly request_hash: string;
  readonly status: ToolIdempotencyRecord["status"];
  readonly owner?: string | null;
  readonly claimed_fence?: number | string | null;
  readonly expires_at_ms: number | string;
  readonly output?: unknown;
  readonly error?: unknown;
}

export class PostgresToolIdempotencyStore implements ToolIdempotencyStore {
  constructor(readonly client: SqlClient) {}

  async lookup(key: string, requestHash: string): Promise<ToolIdempotencyRecord | null> {
    return withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      const result = await this.client.query<IdempotencyRow>(
        "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1",
        [key],
      );
      const row = result.rows[0];
      if (!row || Number(row.expires_at_ms) <= now) return null;
      return idempotencyFromRow(row, requestHash);
    });
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    return withTransaction(this.client, async (tx) => {
      if (input.lease) await assertIdempotencyLease(tx, input.lease);
      const now = await databaseNowMs(tx);
      const result = await tx.query<IdempotencyRow>(
        "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
        [input.key],
      );
      let existing = result.rows[0];
      if (!existing) {
        // A missing row is not lockable. Insert a provisional claim without
        // overwriting a concurrent claimant, then lock and re-read it before
        // deciding whether this caller owns the key.
        await tx.query(
          `INSERT INTO tvic_tool_idempotency
            (key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, expires_at_ms, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, NOW())
           ON CONFLICT (key) DO NOTHING`,
          [
            input.key,
            input.lease?.sessionId ?? null,
            input.toolId ?? null,
            input.toolVersion ?? null,
            input.requestHash,
            input.owner,
            input.lease?.fence ?? null,
            now + input.ttlMs,
          ],
        );
        const afterInsert = await tx.query<IdempotencyRow>(
          "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
          [input.key],
        );
        existing = afterInsert.rows[0];
      }
      if (existing && Number(existing.expires_at_ms) > now) {
        const record = idempotencyFromRow(existing, input.requestHash);
        if (
          (input.toolId && record.toolId && input.toolId !== record.toolId) ||
          (input.toolVersion && record.toolVersion && input.toolVersion !== record.toolVersion)
        ) {
          return { status: "conflict", record };
        }
        if (record.requestHash !== input.requestHash) return { status: "conflict", record };
        if (record.status === "succeeded") return { status: "succeeded", record };
        if (record.status === "claimed") {
          const staleClaim =
            input.lease !== undefined &&
            record.sessionId === input.lease.sessionId &&
            record.claimedFence !== undefined &&
            record.claimedFence < input.lease.fence;
          if (record.owner !== input.owner && !staleClaim) return { status: "in_progress", record };
          if (staleClaim) {
            // A claim from an older fenced owner is recoverable by the current
            // owner; it must not block execution until its TTL expires.
          } else {
            return { status: "claimed", record };
          }
        }
      }
      await tx.query(
        `INSERT INTO tvic_tool_idempotency
          (key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, expires_at_ms, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, NOW())
         ON CONFLICT (key) DO UPDATE SET tool_id = EXCLUDED.tool_id,
           session_id = EXCLUDED.session_id, tool_version = EXCLUDED.tool_version,
           request_hash = EXCLUDED.request_hash,
           status = EXCLUDED.status, owner = EXCLUDED.owner,
           claimed_fence = EXCLUDED.claimed_fence,
           expires_at_ms = EXCLUDED.expires_at_ms, output = NULL, error = NULL,
           updated_at = NOW()`,
        [
          input.key,
          input.lease?.sessionId ?? null,
          input.toolId ?? null,
          input.toolVersion ?? null,
          input.requestHash,
          input.owner,
          input.lease?.fence ?? null,
          now + input.ttlMs,
        ],
      );
      return {
        status: "claimed",
        record: {
          key: input.key,
          ...(input.lease
            ? { sessionId: input.lease.sessionId, claimedFence: input.lease.fence }
            : {}),
          ...(input.toolId ? { toolId: input.toolId } : {}),
          ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
          requestHash: input.requestHash,
          status: "claimed",
          owner: input.owner,
          expiresAtMs: now + input.ttlMs,
        },
      };
    });
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    await withTransaction(this.client, async (tx) => {
      if (outcome.lease) await assertIdempotencyLease(tx, outcome.lease);
      const now = await databaseNowMs(tx);
      const currentResult = await tx.query<IdempotencyRow>(
        "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
        [key],
      );
      const current = currentResult.rows[0];
      if (!current || Number(current.expires_at_ms) <= now) {
        throw new RecordConflictError(`idempotency:${key}`);
      }
      const currentRecord = idempotencyFromRow(current, requestHash);
      if (
        (currentRecord.sessionId !== undefined &&
          (!outcome.lease || currentRecord.sessionId !== outcome.lease.sessionId)) ||
        (currentRecord.claimedFence !== undefined &&
          (!outcome.lease || currentRecord.claimedFence !== outcome.lease.fence))
      ) {
        throw new LeaseLostError(currentRecord.sessionId ?? outcome.lease?.sessionId ?? "unknown");
      }
      if (
        currentRecord.requestHash !== requestHash ||
        currentRecord.owner !== outcome.owner ||
        (outcome.lease &&
          currentRecord.sessionId &&
          currentRecord.sessionId !== outcome.lease.sessionId)
      ) {
        throw new RecordConflictError(`idempotency:${key}`);
      }
      if (currentRecord.status !== "claimed") {
        if (sameOutcome(currentRecord, outcome)) return;
        throw new RecordConflictError(`idempotency:${key}`);
      }
      const updated = await tx.query(
        `UPDATE tvic_tool_idempotency SET status = $3, output = $4::jsonb, error = $5::jsonb,
           expires_at_ms = $6, claimed_fence = COALESCE(claimed_fence, $9), updated_at = NOW()
         WHERE key = $1 AND request_hash = $2 AND owner = $7 AND status = 'claimed'
           AND expires_at_ms > $8`,
        [
          key,
          requestHash,
          outcome.status,
          outcome.output === undefined ? null : stableStringify(outcome.output),
          outcome.error === undefined ? null : stableStringify(outcome.error),
          now + outcome.ttlMs,
          outcome.owner,
          now,
          outcome.lease?.fence ?? null,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new RecordConflictError(`idempotency:${key}`);
      }
    });
  }
}

function sameOutcome(record: ToolIdempotencyRecord, outcome: ToolIdempotencyOutcome): boolean {
  return (
    record.status === outcome.status &&
    stableStringify(record.output) === stableStringify(outcome.output) &&
    stableStringify(record.error) === stableStringify(outcome.error)
  );
}

function idempotencyFromRow(row: IdempotencyRow, requestHash: string): ToolIdempotencyRecord {
  const error =
    row.error === null || row.error === undefined ? undefined : normalizePersistedError(row.error);
  if (row.error !== null && row.error !== undefined && error === null) {
    throw new CorruptRecordError(`postgres:idempotency:${row.key}`, "invalid idempotency error");
  }
  const record: ToolIdempotencyRecord = {
    key: row.key,
    ...(row.session_id ? { sessionId: row.session_id as SessionId } : {}),
    ...(row.tool_id ? { toolId: row.tool_id as ToolId } : {}),
    ...(row.tool_version ? { toolVersion: row.tool_version } : {}),
    requestHash: row.request_hash,
    status: row.status,
    expiresAtMs: Number(row.expires_at_ms),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.claimed_fence !== null && row.claimed_fence !== undefined
      ? { claimedFence: Number(row.claimed_fence) }
      : {}),
  };
  if (row.request_hash !== requestHash) {
    return record;
  }
  return {
    ...record,
    ...(row.output !== null && row.output !== undefined ? { output: row.output } : {}),
    ...(error !== undefined && error !== null ? { error } : {}),
  };
}

async function assertIdempotencyLease(
  client: SqlClient,
  lease: NonNullable<ToolIdempotencyClaim["lease"]> | NonNullable<ToolIdempotencyOutcome["lease"]>,
): Promise<void> {
  const now = await databaseNowMs(client);
  const result = await client.query<
    {
      readonly holder: string;
      readonly fence: number | string;
      readonly expires_at_ms: number | string;
    } & Record<string, unknown>
  >(
    "SELECT holder, fence, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [lease.sessionId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.holder !== lease.holder ||
    Number(row.fence) !== lease.fence ||
    Number(row.expires_at_ms) <= now
  ) {
    throw new LeaseLostError(lease.sessionId);
  }
}
