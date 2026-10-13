import {
  assertLeaseTtlMs,
  LeaseLostError,
  RecordConflictError,
  safeLeaseExpiryAt,
  type SessionId,
  type ToolId,
  type ToolIdempotencyClaim,
  type ToolIdempotencyClaimResult,
  type ToolIdempotencyLookupResult,
  type ToolIdempotencyOutcome,
  type ToolIdempotencyQuarantine,
  type ToolIdempotencyQuarantineResult,
  type ToolIdempotencyRecord,
  type ToolIdempotencyStore,
} from "@tvic/core";
import {
  CorruptRecordError,
  normalizePersistedErrorForComparison,
  readPersistedError,
  rewritePersistedErrorIfAlias,
  sanitizeNormalizedErrorForStorage,
  stableStringify,
  type PersistedErrorCompatibilityDiagnostic,
} from "@tvic/dal-codec";
import type { SqlClient } from "./index.js";
import { databaseNowMs, withBackendBoundary, withTransaction } from "./postgres-helpers.js";
import { safePersistedIntegerValue } from "./postgres-records.js";
import { assertLease } from "./session-leases.js";

type ToolIdempotencyLease = NonNullable<ToolIdempotencyClaim["lease"]>;

async function assertToolIdempotencyLease(
  tx: SqlClient,
  lease: ToolIdempotencyLease,
): Promise<void> {
  await assertLease(tx, lease.sessionId, lease);
  await tx.query("SELECT set_config('tvic.tool_idempotency_lease', $1, true)", [
    JSON.stringify({
      sessionId: lease.sessionId,
      fence: lease.fence,
      generationId: lease.generationId,
    }),
  ]);
}

const MAX_FAILED_ALIAS_REWRITES = 1_024;
const MAX_ALIAS_REWRITE_KEY_LENGTH = 256;

interface IdempotencyRow extends Record<string, unknown> {
  readonly key: string;
  readonly session_id?: string | null;
  readonly tool_id?: string | null;
  readonly tool_version?: string | null;
  readonly request_hash: string;
  readonly status: ToolIdempotencyRecord["status"];
  readonly owner?: string | null;
  readonly claimed_fence?: number | string | null;
  readonly claimed_generation_id?: string | null;
  readonly expires_at_ms: number | string;
  readonly output?: unknown;
  readonly error?: unknown;
}

function aliasRewriteKey(key: string, legacyCode: unknown): string {
  // This key only suppresses repeated best-effort rewrites. Truncation keeps
  // caller-controlled idempotency keys from becoming retained memory; a
  // collision can delay a rewrite but never changes the returned record.
  return `${key.slice(0, MAX_ALIAS_REWRITE_KEY_LENGTH)}:${String(legacyCode)}`;
}

function rememberFailedAliasRewrite(failures: Set<string>, key: string): void {
  if (failures.has(key)) return;
  if (failures.size >= MAX_FAILED_ALIAS_REWRITES) {
    const oldest = failures.values().next().value;
    if (typeof oldest === "string") failures.delete(oldest);
  }
  failures.add(key);
}

export class PostgresToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #options: {
    readonly onCompatibilityDiagnostic?: (
      diagnostic: PersistedErrorCompatibilityDiagnostic,
    ) => void;
  };
  readonly #failedAliasRewrites = new Set<string>();
  readonly #aliasRewritesInFlight = new Set<string>();

  constructor(
    readonly client: SqlClient,
    options: {
      readonly onCompatibilityDiagnostic?: (
        diagnostic: PersistedErrorCompatibilityDiagnostic,
      ) => void;
    } = {},
  ) {
    this.#options = options;
  }

  async lookup(
    key: string,
    requestHash: string,
    sessionId?: SessionId,
    lease?: NonNullable<ToolIdempotencyClaim["lease"]>,
  ): Promise<ToolIdempotencyLookupResult> {
    const lookupSessionId = lease?.sessionId ?? sessionId;
    if (!lookupSessionId && !lease) {
      return withBackendBoundary(async () => {
        const result = await this.client.query<IdempotencyRow>(
          `SELECT key, session_id, tool_id, tool_version, request_hash, status, owner,
                  claimed_fence, claimed_generation_id, expires_at_ms, output, error
           FROM tvic_tool_idempotency
           WHERE key = $1
             AND expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint`,
          [key],
        );
        return this.#lookupResult(result.rows[0], requestHash, sessionId, this.client);
      });
    }
    return withBackendBoundary(() =>
      withTransaction(this.client, async (tx) => {
        if (lease) {
          if (sessionId && sessionId !== lease.sessionId) return { status: "conflict" };
          await assertToolIdempotencyLease(tx, lease);
        } else if (sessionId) {
          if (await lockSessionIdempotencyLifetime(tx, sessionId)) return { status: "conflict" };
        }
        const result = await tx.query<IdempotencyRow>(
          `SELECT key, session_id, tool_id, tool_version, request_hash, status, owner,
                claimed_fence, claimed_generation_id, expires_at_ms, output, error
         FROM tvic_tool_idempotency
         WHERE key = $1
           AND expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint`,
          [key],
        );
        return this.#lookupResult(result.rows[0], requestHash, lookupSessionId, tx);
      }),
    );
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    assertLeaseTtlMs(input.ttlMs);
    return withTransaction(this.client, async (tx) => {
      if (input.lease && input.sessionId && input.sessionId !== input.lease.sessionId) {
        return { status: "conflict" };
      }
      const sessionId = input.lease?.sessionId ?? input.sessionId;
      if (input.lease) await assertToolIdempotencyLease(tx, input.lease);
      else if (sessionId && (await lockSessionIdempotencyLifetime(tx, sessionId))) {
        return { status: "conflict" };
      }
      const result = await tx.query<IdempotencyRow>(
        "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, claimed_generation_id, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
        [input.key],
      );
      let existing = result.rows[0];
      let insertedByCurrentClaim = false;
      if (!existing) {
        const provisionalExpiryAtMs = safeLeaseExpiryAt(await databaseNowMs(tx), input.ttlMs);
        // A missing row is not lockable. Insert a provisional claim without
        // overwriting a concurrent claimant, then lock and re-read it before
        // deciding whether this caller owns the key.
        const inserted = await tx.query(
          `INSERT INTO tvic_tool_idempotency
            (key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, claimed_generation_id, expires_at_ms, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8,
             $9, NOW())
           ON CONFLICT (key) DO NOTHING`,
          [
            input.key,
            sessionId ?? null,
            input.toolId ?? null,
            input.toolVersion ?? null,
            input.requestHash,
            input.owner,
            input.lease?.fence ?? null,
            input.lease?.generationId ?? null,
            provisionalExpiryAtMs,
          ],
        );
        insertedByCurrentClaim = inserted.rowCount === 1;
        const afterInsert = await tx.query<IdempotencyRow>(
          "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, claimed_generation_id, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
          [input.key],
        );
        existing = afterInsert.rows[0];
      }
      const now = await databaseNowMs(tx);
      const claimExpiresAtMs = safeLeaseExpiryAt(now, input.ttlMs);
      const existingFields = existing ? persistedIdempotencyNumericFields(existing) : undefined;
      if (existing && existingFields!.expiresAtMs > now) {
        const record = await idempotencyFromRow(
          existing,
          input.requestHash,
          this.#rewriteOptions(tx),
        );
        if (record.sessionId !== sessionId) {
          return { status: "conflict" };
        }
        if (
          (input.toolId && record.toolId && input.toolId !== record.toolId) ||
          (input.toolVersion && record.toolVersion && input.toolVersion !== record.toolVersion)
        ) {
          return { status: "conflict" };
        }
        if (record.requestHash !== input.requestHash) {
          return { status: "conflict" };
        }
        if (record.status === "succeeded") return { status: "succeeded", record };
        if (record.status !== "claimed") return { status: "terminal", record };
        if (record.status === "claimed") {
          if (insertedByCurrentClaim) return { status: "claimed", record };
          const staleClaim =
            input.lease !== undefined &&
            record.sessionId === input.lease.sessionId &&
            (record.claimedGenerationId !== undefined
              ? record.claimedGenerationId !== input.lease.generationId
              : record.claimedFence !== undefined && record.claimedFence < input.lease.fence);
          if (!staleClaim) {
            return { status: "in_progress", record };
          }
          // A claim from an older fenced owner is recoverable by the current
          // owner; it must not block execution until its TTL expires.
        }
      }
      await tx.query(
        `INSERT INTO tvic_tool_idempotency
          (key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, claimed_generation_id, expires_at_ms, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, $9, NOW())
         ON CONFLICT (key) DO UPDATE SET tool_id = EXCLUDED.tool_id,
           session_id = EXCLUDED.session_id, tool_version = EXCLUDED.tool_version,
           request_hash = EXCLUDED.request_hash,
           status = EXCLUDED.status, owner = EXCLUDED.owner,
           claimed_fence = EXCLUDED.claimed_fence,
           claimed_generation_id = EXCLUDED.claimed_generation_id,
           expires_at_ms = EXCLUDED.expires_at_ms, output = NULL, error = NULL,
           updated_at = NOW()`,
        [
          input.key,
          sessionId ?? null,
          input.toolId ?? null,
          input.toolVersion ?? null,
          input.requestHash,
          input.owner,
          input.lease?.fence ?? null,
          input.lease?.generationId ?? null,
          claimExpiresAtMs,
        ],
      );
      return {
        status: "claimed",
        record: {
          key: input.key,
          ...(sessionId ? { sessionId } : {}),
          ...(input.lease
            ? {
                claimedFence: input.lease.fence,
                claimedGenerationId: input.lease.generationId,
              }
            : {}),
          ...(input.toolId ? { toolId: input.toolId } : {}),
          ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
          requestHash: input.requestHash,
          status: "claimed",
          owner: input.owner,
          expiresAtMs: claimExpiresAtMs,
        },
      };
    });
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    assertLeaseTtlMs(outcome.ttlMs);
    await withTransaction(this.client, async (tx) => {
      if (outcome.lease && outcome.sessionId && outcome.sessionId !== outcome.lease.sessionId) {
        throw new RecordConflictError("tool_idempotency");
      }
      const sessionId = outcome.lease?.sessionId ?? outcome.sessionId;
      if (outcome.lease) await assertToolIdempotencyLease(tx, outcome.lease);
      else if (sessionId && (await lockSessionIdempotencyLifetime(tx, sessionId))) {
        throw new RecordConflictError("tool_idempotency");
      }
      const currentResult = await tx.query<IdempotencyRow>(
        "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, claimed_generation_id, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
        [key],
      );
      const now = await databaseNowMs(tx);
      const current = currentResult.rows[0];
      const currentFields = current ? persistedIdempotencyNumericFields(current) : undefined;
      if (!current || !currentFields || currentFields.expiresAtMs <= now) {
        throw new RecordConflictError("tool_idempotency");
      }
      const currentRecord = await idempotencyFromRow(
        current,
        requestHash,
        this.#rewriteOptions(tx),
      );
      if (
        currentRecord.sessionId !== (outcome.lease?.sessionId ?? outcome.sessionId) ||
        ((currentRecord.claimedFence !== undefined ||
          currentRecord.claimedGenerationId !== undefined) &&
          (!outcome.lease ||
            (currentRecord.claimedGenerationId !== undefined
              ? currentRecord.claimedGenerationId !== outcome.lease.generationId ||
                (currentRecord.claimedFence !== undefined &&
                  currentRecord.claimedFence !== outcome.lease.fence)
              : currentRecord.claimedFence !== outcome.lease.fence)))
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
        throw new RecordConflictError("tool_idempotency");
      }
      if (currentRecord.status !== "claimed") {
        if (sameOutcome(currentRecord, outcome)) return;
        throw new RecordConflictError("tool_idempotency");
      }
      const completionExpiresAtMs = safeLeaseExpiryAt(now, outcome.ttlMs);
      const updated = await tx.query(
        `UPDATE tvic_tool_idempotency SET status = $3, output = $4::jsonb, error = $5::jsonb,
           expires_at_ms = $6, claimed_fence = COALESCE(claimed_fence, $9),
           claimed_generation_id = COALESCE(claimed_generation_id, $10), updated_at = NOW()
         WHERE key = $1 AND request_hash = $2 AND owner = $7 AND status = 'claimed'
           AND expires_at_ms > $8
           AND ($10::text IS NULL OR claimed_generation_id = $10 OR
             (claimed_generation_id IS NULL AND claimed_fence = $9))`,
        [
          key,
          requestHash,
          outcome.status,
          outcome.output === undefined ? null : stableStringify(outcome.output),
          outcome.error === undefined
            ? null
            : stableStringify(sanitizeNormalizedErrorForStorage(outcome.error)),
          completionExpiresAtMs,
          outcome.owner,
          now,
          outcome.lease?.fence ?? null,
          outcome.lease?.generationId ?? null,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new RecordConflictError("tool_idempotency");
      }
    });
  }

  async quarantine(input: ToolIdempotencyQuarantine): Promise<ToolIdempotencyQuarantineResult> {
    assertLeaseTtlMs(input.ttlMs);
    return withTransaction(this.client, async (tx) => {
      if (input.sessionId !== input.lease.sessionId) return { status: "conflict" };
      await assertToolIdempotencyLease(tx, input.lease);
      const select = () =>
        tx.query<IdempotencyRow>(
          "SELECT key, session_id, tool_id, tool_version, request_hash, status, owner, claimed_fence, claimed_generation_id, expires_at_ms, output, error FROM tvic_tool_idempotency WHERE key = $1 FOR UPDATE",
          [input.key],
        );
      let existing = (await select()).rows[0];
      if (!existing) {
        const provisionalExpiryAtMs = safeLeaseExpiryAt(await databaseNowMs(tx), input.ttlMs);
        // Insert a terminal row without overwriting a claim that wins the race.
        // The transaction holds the inserted row lock until the lease check
        // and final outcome are committed together.
        await tx.query(
          `INSERT INTO tvic_tool_idempotency
            (key, session_id, tool_id, tool_version, request_hash, status, owner,
             claimed_fence, claimed_generation_id, expires_at_ms, error, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7, $8,
             $9,
             $10::jsonb, NOW())
           ON CONFLICT (key) DO NOTHING`,
          [
            input.key,
            input.sessionId,
            input.toolId,
            input.toolVersion,
            input.requestHash,
            input.owner,
            input.lease.fence,
            input.lease.generationId,
            provisionalExpiryAtMs,
            stableStringify(sanitizeNormalizedErrorForStorage(input.error)),
          ],
        );
        existing = (await select()).rows[0];
      }
      if (!existing) throw new RecordConflictError("tool_idempotency");
      const now = await databaseNowMs(tx);
      const existingFields = persistedIdempotencyNumericFields(existing);
      if (existingFields.expiresAtMs > now) {
        const record = await idempotencyFromRow(
          existing,
          input.requestHash,
          this.#rewriteOptions(tx),
        );
        if (
          record.sessionId !== input.sessionId ||
          record.toolId !== input.toolId ||
          record.toolVersion !== input.toolVersion ||
          record.requestHash !== input.requestHash
        ) {
          return { status: "conflict" };
        }
        if (record.status === "succeeded") return { status: "succeeded", record };
        if (record.status !== "claimed") return { status: "terminal", record };
        if (record.owner !== input.owner) return { status: "in_progress", record };
        const priorLease =
          record.claimedGenerationId !== undefined
            ? record.claimedGenerationId !== input.lease.generationId
            : record.claimedFence !== undefined && record.claimedFence < input.lease.fence;
        if (!priorLease) {
          return { status: "in_progress", record };
        }
      }

      const expiresAtMs = safeLeaseExpiryAt(now, input.ttlMs);
      const encodedError = stableStringify(sanitizeNormalizedErrorForStorage(input.error));
      await tx.query(
        `INSERT INTO tvic_tool_idempotency
          (key, session_id, tool_id, tool_version, request_hash, status, owner,
           claimed_fence, claimed_generation_id, expires_at_ms, output, error, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7, $8, $9, NULL, $10::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET session_id = EXCLUDED.session_id,
           tool_id = EXCLUDED.tool_id, tool_version = EXCLUDED.tool_version,
           request_hash = EXCLUDED.request_hash, status = 'failed', owner = EXCLUDED.owner,
           claimed_fence = EXCLUDED.claimed_fence,
           claimed_generation_id = EXCLUDED.claimed_generation_id,
           expires_at_ms = EXCLUDED.expires_at_ms, output = NULL,
           error = EXCLUDED.error, updated_at = NOW()`,
        [
          input.key,
          input.sessionId,
          input.toolId,
          input.toolVersion,
          input.requestHash,
          input.owner,
          input.lease.fence,
          input.lease.generationId,
          expiresAtMs,
          encodedError,
        ],
      );
      return {
        status: "quarantined",
        record: {
          key: input.key,
          sessionId: input.sessionId,
          toolId: input.toolId,
          toolVersion: input.toolVersion,
          requestHash: input.requestHash,
          status: "failed",
          owner: input.owner,
          claimedFence: input.lease.fence,
          claimedGenerationId: input.lease.generationId,
          expiresAtMs,
          error: normalizePersistedErrorForComparison(input.error),
        },
      };
    });
  }

  #rewriteOptions(client: SqlClient): IdempotencyErrorRewriteOptions {
    return {
      client,
      failedAliasRewrites: this.#failedAliasRewrites,
      aliasRewritesInFlight: this.#aliasRewritesInFlight,
      ...(this.#options.onCompatibilityDiagnostic
        ? { onCompatibilityDiagnostic: this.#options.onCompatibilityDiagnostic }
        : {}),
    };
  }

  async #lookupResult(
    row: IdempotencyRow | undefined,
    requestHash: string,
    sessionId: SessionId | undefined,
    client: SqlClient,
  ): Promise<ToolIdempotencyLookupResult> {
    if (!row) return { status: "missing" };
    if (row.request_hash !== requestHash || (row.session_id ?? undefined) !== sessionId) {
      return { status: "conflict" };
    }
    return {
      status: "found",
      record: await idempotencyFromRow(row, requestHash, this.#rewriteOptions(client)),
    };
  }
}

function sameOutcome(record: ToolIdempotencyRecord, outcome: ToolIdempotencyOutcome): boolean {
  return (
    record.status === outcome.status &&
    stableStringify(record.output) === stableStringify(outcome.output) &&
    stableStringify(record.error) ===
      stableStringify(
        outcome.error === undefined
          ? undefined
          : normalizePersistedErrorForComparison(outcome.error),
      )
  );
}

interface IdempotencyErrorRewriteOptions {
  readonly client: SqlClient;
  readonly failedAliasRewrites: Set<string>;
  readonly aliasRewritesInFlight: Set<string>;
  readonly onCompatibilityDiagnostic?: (diagnostic: PersistedErrorCompatibilityDiagnostic) => void;
}

async function idempotencyFromRow(
  row: IdempotencyRow,
  requestHash: string,
  rewriteOptions: IdempotencyErrorRewriteOptions,
): Promise<ToolIdempotencyRecord> {
  const { expiresAtMs, claimedFence } = persistedIdempotencyNumericFields(row);
  if (
    row.claimed_generation_id !== null &&
    row.claimed_generation_id !== undefined &&
    (typeof row.claimed_generation_id !== "string" || row.claimed_generation_id.length === 0)
  ) {
    throw new CorruptRecordError(
      "postgres:tool_idempotency",
      "claimed_generation_id must be a non-empty string",
    );
  }
  const record: ToolIdempotencyRecord = {
    key: row.key,
    ...(row.session_id ? { sessionId: row.session_id as SessionId } : {}),
    ...(row.tool_id ? { toolId: row.tool_id as ToolId } : {}),
    ...(row.tool_version ? { toolVersion: row.tool_version } : {}),
    requestHash: row.request_hash,
    status: row.status,
    expiresAtMs,
    ...(row.owner ? { owner: row.owner } : {}),
    ...(claimedFence !== undefined ? { claimedFence } : {}),
    ...(row.claimed_generation_id ? { claimedGenerationId: row.claimed_generation_id } : {}),
  };
  if (row.request_hash !== requestHash) return record;

  const read = readPersistedError(row.error);
  if (row.error !== null && row.error !== undefined && read === null) {
    throw new CorruptRecordError("postgres:tool_idempotency", "invalid idempotency error");
  }
  if (read !== null) {
    if (read.migratedAlias) {
      const legacyCode = read.error.metadata?.legacyCode;
      const rewriteKey = aliasRewriteKey(row.key, legacyCode);
      if (
        typeof legacyCode === "string" &&
        !rewriteOptions.failedAliasRewrites.has(rewriteKey) &&
        !rewriteOptions.aliasRewritesInFlight.has(rewriteKey)
      ) {
        rewriteOptions.aliasRewritesInFlight.add(rewriteKey);
        const rewritten = await rewritePersistedErrorIfAlias({
          adapter: "postgres",
          key: row.key,
          read,
          ...(rewriteOptions.onCompatibilityDiagnostic
            ? { onCompatibilityDiagnostic: rewriteOptions.onCompatibilityDiagnostic }
            : {}),
          rewrite: async (canonical) => {
            const result = await rewriteOptions.client.query(
              "UPDATE tvic_tool_idempotency SET error = $2::jsonb, updated_at = NOW() WHERE key = $1 AND error = $3::jsonb",
              [row.key, stableStringify(canonical), stableStringify(row.error)],
            );
            if ((result.rowCount ?? 0) !== 1) {
              throw new Error("idempotency alias rewrite lost its compare-and-set race");
            }
          },
        });
        rewriteOptions.aliasRewritesInFlight.delete(rewriteKey);
        if (!rewritten) rememberFailedAliasRewrite(rewriteOptions.failedAliasRewrites, rewriteKey);
      }
    }
  }
  const persistedError =
    read === null ? undefined : read.knownCode ? read.error : { ...read.error, retriable: false };
  return {
    ...record,
    ...(row.output !== null && row.output !== undefined ? { output: row.output } : {}),
    ...(persistedError !== undefined ? { error: persistedError } : {}),
  };
}

interface IdempotencyNumericFields {
  readonly expiresAtMs: number;
  readonly claimedFence?: number;
}

function persistedIdempotencyNumericFields(row: IdempotencyRow): IdempotencyNumericFields {
  const expiresAtMs = safePersistedIntegerValue(row.expires_at_ms);
  const claimedFence =
    row.claimed_fence === null || row.claimed_fence === undefined
      ? undefined
      : safePersistedIntegerValue(row.claimed_fence, 1);
  if (expiresAtMs === null) {
    throw new CorruptRecordError(
      "postgres:tool_idempotency",
      "expires_at_ms must be a non-negative safe integer",
    );
  }
  if (claimedFence === null) {
    throw new CorruptRecordError(
      "postgres:tool_idempotency",
      "claimed_fence must be a positive safe integer",
    );
  }
  return {
    expiresAtMs,
    ...(claimedFence !== undefined ? { claimedFence } : {}),
  };
}

async function lockSessionIdempotencyLifetime(
  client: SqlClient,
  sessionId: SessionId,
): Promise<boolean> {
  // Session creation takes this same transaction lock before clearing prior
  // lifetime results, so an unfenced operation cannot race ID reuse.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sessionId]);
  const result = await client.query("SELECT 1 FROM tvic_sessions WHERE id = $1", [sessionId]);
  return result.rows.length > 0;
}
