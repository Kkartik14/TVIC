import {
  InvalidArgumentError,
  MemorySessionQuotaExceededError,
  RecordConflictError,
  type Memory,
  type MemoryCapabilities,
  type MemoryEntry,
  type MemoryKind,
  type MemoryPutOptions,
  type MemoryQuery,
  type MemoryRef,
  type UserId,
} from "@tvic/core";
import { stableStringify } from "@tvic/dal-codec";
import {
  POSTGRES_MEMORY_CAPABILITIES,
  enforceSize,
  escapeLikePrefix,
  memoryEntryExists,
  parseMemoryCursor,
  refKeyToWhereClause,
  rowToEntry,
  serializeMemoryMetadata,
  serializeMemoryTags,
  serializeMemoryValue,
  scopeKindOf,
  validateMemoryQuery,
  valuesEqual,
} from "./memory-records.js";
import type { MemoryRow } from "./memory-records.js";
import type { SqlClient, SqlPool } from "./postgres-helpers.js";
import { databaseNowMs, withBackendBoundary, withTransaction } from "./postgres-helpers.js";

export interface PostgresMemoryOptions {
  readonly pool: SqlPool;
  /** UTF-8 serialized memory-value cap; throws MemoryEntryTooLargeError. */
  readonly maxEntryBytes?: number;
}

export class PostgresMemory implements Memory {
  readonly name = "postgres";
  readonly version = "0.1.0";
  readonly capabilities: MemoryCapabilities;

  constructor(
    readonly pool: SqlPool,
    options: Omit<PostgresMemoryOptions, "pool"> = {},
  ) {
    if (
      options.maxEntryBytes !== undefined &&
      (!Number.isSafeInteger(options.maxEntryBytes) || options.maxEntryBytes <= 0)
    ) {
      throw new InvalidArgumentError(
        `maxEntryBytes must be a positive safe integer: ${options.maxEntryBytes}`,
      );
    }
    this.capabilities = {
      ...POSTGRES_MEMORY_CAPABILITIES,
      ...(options.maxEntryBytes !== undefined ? { maxEntryBytes: options.maxEntryBytes } : {}),
    };
  }

  async get<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind = "raw",
  ): Promise<MemoryEntry<T> | null> {
    return withBackendBoundary(async () => {
      const now = await databaseNowMs(this.pool);
      const row = await memoryEntryExists(this.pool, ref, key, kind, now);
      return row ? (rowToEntry(row) as MemoryEntry<T>) : null;
    });
  }

  async put<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind,
    value: T,
    options: MemoryPutOptions = {},
  ): Promise<MemoryEntry<T>> {
    if (
      options.sessionUserId !== undefined &&
      (ref.scope !== "session" ||
        typeof options.sessionUserId !== "string" ||
        options.sessionUserId.trim().length === 0)
    ) {
      throw new InvalidArgumentError(
        "sessionUserId is only valid as a non-empty attribution for session-scope writes",
      );
    }
    validateSessionQuota(ref, options.maxSessionBytes);
    const serializedValue = serializeMemoryValue(value, key);
    const serializedTags =
      options.tags !== undefined ? serializeMemoryTags(options.tags, `${key}:tags`) : undefined;
    const serializedMetadata =
      options.metadata !== undefined
        ? serializeMemoryMetadata(options.metadata, `${key}:metadata`)
        : undefined;
    enforceSize(serializedValue, this.capabilities.maxEntryBytes, key);
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)) {
      throw new InvalidArgumentError(
        `ttlMs must be a non-negative finite number: ${options.ttlMs}`,
      );
    }
    return withTransaction(this.pool, async (tx) => {
      const { kind: scopeKind, id: scopeId } = scopeKindOf(ref);
      let now: number;
      let existing: MemoryRow | null;
      if (ref.scope === "session") {
        await lockSession(tx, scopeId);
        now = await databaseNowMs(tx);
        existing = await memoryEntryExists(tx, ref, key, kind, now);

        // The owner is part of the deletion lock domain even when the caller
        // omits sessionUserId on an update. Lock every known owner in a stable
        // order, then re-read after the locks: deleteForUser can remove a row
        // without taking the session lock, so the first read is only a hint.
        const userIds = new Set<string>();
        if (options.sessionUserId !== undefined) userIds.add(options.sessionUserId);
        if (existing?.memory_user_id !== null && existing?.memory_user_id !== undefined) {
          userIds.add(existing.memory_user_id);
        }
        for (const userId of [...userIds].sort()) await lockUser(tx, userId);
        if (userIds.size > 0) {
          now = await databaseNowMs(tx);
          existing = await memoryEntryExists(tx, ref, key, kind, now);
        }
      } else {
        if (ref.scope === "user") await lockUser(tx, scopeId);
        now = await databaseNowMs(tx);
        existing = await memoryEntryExists(tx, ref, key, kind, now);
      }
      if (existing && options.ifNotExists) {
        return rowToEntry(existing) as MemoryEntry<T>;
      }
      if (existing && !valuesEqual(existing.value, value)) {
        throw new RecordConflictError(`memory:${scopeKind}:${scopeId}:${kind}:${key}`);
      }
      if (ref.scope === "session" && options.maxSessionBytes !== undefined) {
        const usage = await tx.query<{ used_bytes: number | string } & Record<string, unknown>>(
          `SELECT COALESCE(SUM(value_bytes), 0)::numeric AS used_bytes
             FROM tvic_memory_entries
            WHERE scope_kind = 'session' AND scope_id = $1
              AND (expires_at_ms IS NULL OR expires_at_ms > $2)`,
          [scopeId, now],
        );
        const usedBytes = sqlInteger(usage.rows[0]?.used_bytes ?? 0, "used_bytes");
        const existingBytes = existing ? sqlInteger(existing.value_bytes, "value_bytes") : 0n;
        const valueBytes = await canonicalValueBytes(tx, serializedValue);
        const projectedBytes = usedBytes - existingBytes + valueBytes;
        if (projectedBytes > BigInt(options.maxSessionBytes)) {
          const baseBytes = usedBytes - existingBytes;
          const requestedBytes = valueBytes > existingBytes ? valueBytes - existingBytes : 0n;
          throw new MemorySessionQuotaExceededError(
            scopeId,
            safeQuotaNumber(baseBytes),
            safeQuotaNumber(requestedBytes),
            options.maxSessionBytes,
          );
        }
      }
      if (existing) {
        const existingEntry = rowToEntry(existing);
        const tags =
          serializedTags !== undefined
            ? serializedTags
            : existingEntry.tags !== undefined
              ? JSON.stringify(existingEntry.tags)
              : null;
        const metadata =
          serializedMetadata !== undefined
            ? serializedMetadata
            : existingEntry.metadata !== undefined
              ? JSON.stringify(existingEntry.metadata)
              : null;
        const expiresAtMs =
          options.ttlMs !== undefined ? now + options.ttlMs : existingEntry.expiresAtMs;
        const memoryUserId =
          ref.scope === "session"
            ? typeof options.sessionUserId === "string"
              ? options.sessionUserId
              : (existing.memory_user_id ?? null)
            : null;
        // Identical value: idempotent touch.
        const result = await tx.query<MemoryRow>(
          `UPDATE tvic_memory_entries
              SET value = $5::jsonb,
                  value_bytes = octet_length(convert_to($5::jsonb::text, 'UTF8')),
                  version = version + 1, updated_at_ms = $6,
                  expires_at_ms = $7, memory_user_id = $8,
                  tags = $9::jsonb, metadata = $10::jsonb
            WHERE scope_kind = $1 AND scope_id = $2 AND kind = $3 AND key = $4
              AND (expires_at_ms IS NULL OR expires_at_ms > $6)
          RETURNING scope_kind, scope_id, kind, key, value, version,
                    created_at_ms, updated_at_ms, expires_at_ms,
                    memory_user_id, entry_id, tags, metadata, value_bytes`,
          [
            scopeKind,
            scopeId,
            kind,
            key,
            serializedValue,
            now,
            expiresAtMs ?? null,
            memoryUserId,
            tags,
            metadata,
          ],
        );
        if (result.rowCount === 0) {
          throw new RecordConflictError(`memory:${scopeKind}:${scopeId}:${kind}:${key}`);
        }
        return rowToEntry(result.rows[0]!) as MemoryEntry<T>;
      }
      await tx.query(
        `DELETE FROM tvic_memory_entries
          WHERE scope_kind = $1 AND scope_id = $2 AND kind = $3 AND key = $4
            AND expires_at_ms IS NOT NULL AND expires_at_ms <= $5`,
        [scopeKind, scopeId, kind, key, now],
      );
      const expiresAtMs = options.ttlMs !== undefined ? now + options.ttlMs : null;
      const tags = serializedTags ?? null;
      const metadata = serializedMetadata ?? null;
      // The runtime passes `sessionUserId` as a reserved attribution
      // for session-scope writes. We pull it back out so the cascade
      // (`Memory.deleteForUser(userId)`) can target
      // session-scope entries written by the user without a separate
      // schema column or a side-channel key.
      const memoryUserId =
        ref.scope === "session" && typeof options.sessionUserId === "string"
          ? options.sessionUserId
          : null;
      const result = await tx.query<MemoryRow>(
        `INSERT INTO tvic_memory_entries
            (scope_kind, scope_id, kind, key, value, value_bytes, version, created_at_ms, updated_at_ms, expires_at_ms, memory_user_id, entry_id, tags, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb,
                 octet_length(convert_to($5::jsonb::text, 'UTF8')),
                 1, $6, $6, $7, $8, gen_random_uuid(), $9::jsonb, $10::jsonb)
         ON CONFLICT (scope_kind, scope_id, kind, key) DO NOTHING
         RETURNING scope_kind, scope_id, kind, key, value, version,
                   created_at_ms, updated_at_ms, expires_at_ms,
                   memory_user_id, entry_id, tags, metadata, value_bytes`,
        [
          scopeKind,
          scopeId,
          kind,
          key,
          serializedValue,
          now,
          expiresAtMs,
          memoryUserId,
          tags,
          metadata,
        ],
      );
      if (result.rowCount === 0) {
        // The unique constraint serialized a concurrent insert after the
        // earlier existence check. Honor the same idempotency contract as the
        // non-racing path instead of turning `ifNotExists` into a conflict.
        const raced = await memoryEntryExists(tx, ref, key, kind, now);
        if (raced) {
          if (options.ifNotExists) {
            return rowToEntry(raced) as MemoryEntry<T>;
          }
          const racedEntry = rowToEntry(raced);
          if (valuesEqual(racedEntry.value, value)) {
            return racedEntry as MemoryEntry<T>;
          }
        }
        throw new RecordConflictError(`memory:${scopeKind}:${scopeId}:${kind}:${key}`);
      }
      return rowToEntry(result.rows[0]!) as MemoryEntry<T>;
    });
  }

  async list<T = unknown>(
    ref: MemoryRef,
    query: MemoryQuery = {},
  ): Promise<readonly MemoryEntry<T>[]> {
    return withBackendBoundary(async () => {
      const now = await databaseNowMs(this.pool);
      const { sql: where, params } = refKeyToWhereClause(ref, query.kind);
      const limit = validateMemoryQuery(query);
      const offset = parseMemoryCursor(query.cursor);
      const conditions: string[] = [
        where,
        `(expires_at_ms IS NULL OR expires_at_ms > $${params.length + 1})`,
      ];
      const fullParams: unknown[] = [...params, now];
      if (query.key !== undefined) {
        conditions.push(`key = $${fullParams.length + 1}`);
        fullParams.push(query.key);
      }
      if (query.prefix !== undefined) {
        conditions.push(`key LIKE $${fullParams.length + 1} ESCAPE E'\\\\'`);
        fullParams.push(`${escapeLikePrefix(query.prefix)}%`);
      }
      if (query.tags && query.tags.length > 0) {
        conditions.push(`tags @> $${fullParams.length + 1}::jsonb`);
        fullParams.push(JSON.stringify(query.tags));
      }
      const result = await this.pool.query<MemoryRow>(
        `SELECT scope_kind, scope_id, kind, key, value, version,
                created_at_ms, updated_at_ms, expires_at_ms,
                memory_user_id, entry_id, tags, metadata
           FROM tvic_memory_entries
          WHERE ${conditions.join(" AND ")}
          ORDER BY updated_at_ms DESC, key ASC, kind ASC
          LIMIT $${fullParams.length + 1}
          OFFSET $${fullParams.length + 2}`,
        [...fullParams, limit, offset],
      );
      return result.rows.map((row) => rowToEntry(row) as MemoryEntry<T>);
    });
  }

  async delete(ref: MemoryRef, key: string, kind: MemoryKind = "raw"): Promise<boolean> {
    if (ref.scope === "session") {
      return withTransaction(this.pool, async (tx) => {
        const { id: scopeId } = scopeKindOf(ref);
        await lockSession(tx, scopeId);
        const result = await tx.query(
          `DELETE FROM tvic_memory_entries
            WHERE scope_kind = 'session' AND scope_id = $1 AND kind = $2 AND key = $3`,
          [scopeId, kind, key],
        );
        return result.rowCount > 0;
      });
    }
    return withTransaction(this.pool, async (tx) => {
      const { kind: scopeKind, id: scopeId } = scopeKindOf(ref);
      if (ref.scope === "user") await lockUser(tx, scopeId);
      const result = await tx.query(
        `DELETE FROM tvic_memory_entries
          WHERE scope_kind = $1 AND scope_id = $2 AND kind = $3 AND key = $4`,
        [scopeKind, scopeId, kind, key],
      );
      return result.rowCount > 0;
    });
  }

  async deleteAll(ref: MemoryRef): Promise<number> {
    if (ref.scope === "session") {
      return withTransaction(this.pool, async (tx) => {
        const { id: scopeId } = scopeKindOf(ref);
        await lockSession(tx, scopeId);
        const result = await tx.query(
          `DELETE FROM tvic_memory_entries WHERE scope_kind = 'session' AND scope_id = $1`,
          [scopeId],
        );
        return result.rowCount;
      });
    }
    return withTransaction(this.pool, async (tx) => {
      const { kind: scopeKind, id: scopeId } = scopeKindOf(ref);
      if (ref.scope === "user") await lockUser(tx, scopeId);
      const result = await tx.query(
        `DELETE FROM tvic_memory_entries WHERE scope_kind = $1 AND scope_id = $2`,
        [scopeKind, scopeId],
      );
      return result.rowCount;
    });
  }

  async deleteForUser(userIdValue: UserId): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      await lockUser(tx, userIdValue);
      // A user deletion only targets user-owned data. Organization/workflow
      // scopes are shared and must be deleted explicitly after an
      // application-owned authorization decision.
      const userResult = await tx.query(
        `DELETE FROM tvic_memory_entries
          WHERE scope_kind = 'user' AND scope_id = $1`,
        [String(userIdValue)],
      );
      let deleted = userResult.rowCount;
      // Session-scope cascade. The runtime populates `memory_user_id` as a
      // reserved attribution on session writes; caller metadata is never
      // interpreted as ownership. The partial index keeps this deletion
      // selective without touching shared organization/workflow scopes.
      const sessionResult = await tx.query(
        `DELETE FROM tvic_memory_entries
          WHERE scope_kind = 'session' AND memory_user_id = $1`,
        [String(userIdValue)],
      );
      deleted += sessionResult.rowCount;
      return deleted;
    });
  }
}

async function lockSession(client: SqlClient, sessionId: string): Promise<void> {
  // Every session mutation takes the same transaction-scoped advisory lock.
  // This makes quota admission atomic when several runtime processes share the
  // database, while keeping the quota optional for unbounded adapters.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `tvic:memory:session:${sessionId}`,
  ]);
}

async function lockUser(client: SqlClient, userId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `tvic:memory:user:${String(userId)}`,
  ]);
}

async function canonicalValueBytes(client: SqlClient, serializedValue: string): Promise<bigint> {
  const result = await client.query<{ value_bytes: number | string } & Record<string, unknown>>(
    "SELECT octet_length(convert_to($1::jsonb::text, 'UTF8'))::numeric AS value_bytes",
    [serializedValue],
  );
  return sqlInteger(result.rows[0]?.value_bytes, "value_bytes");
}

function sqlInteger(value: unknown, field: string): bigint {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) {
    throw new InvalidArgumentError(`PostgreSQL returned an invalid memory ${field}: ${text}`);
  }
  try {
    return BigInt(text);
  } catch {
    throw new InvalidArgumentError(`PostgreSQL returned an invalid memory ${field}: ${text}`);
  }
}

function safeQuotaNumber(value: bigint): number {
  if (value <= 0n) return 0;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return value >= max ? Number.MAX_SAFE_INTEGER : Number(value);
}

function validateSessionQuota(ref: MemoryRef, maxSessionBytes: number | undefined): void {
  if (maxSessionBytes === undefined) return;
  if (ref.scope !== "session") {
    throw new InvalidArgumentError("maxSessionBytes is only valid for session-scope writes");
  }
  if (!Number.isSafeInteger(maxSessionBytes) || maxSessionBytes < 0) {
    throw new InvalidArgumentError(
      `maxSessionBytes must be a non-negative safe integer: ${maxSessionBytes}`,
    );
  }
}

export function createPostgresMemory(options: PostgresMemoryOptions): PostgresMemory {
  return new PostgresMemory(options.pool, options);
}

export { runPostgresMemoryMigrations } from "./migrations.js";
export type { PostgresMigration } from "./migrations.js";
export { stableStringify };
export type { SqlClient, SqlPool } from "./postgres-helpers.js";
