import {
  CorruptRecordError,
  normalizePersistedErrorForComparison,
  readPersistedError,
  rewritePersistedErrorIfAlias,
  sanitizeNormalizedErrorForStorage,
  stableStringify,
} from "@tvic/dal-codec";
import {
  assertLeaseTtlMs,
  assertLeaseFence,
  BackendUnavailableError,
  InvalidArgumentError,
  LeaseLostError,
  RecordConflictError,
  type ToolId,
  type SessionId,
  type ToolIdempotencyClaim,
  type ToolIdempotencyClaimResult,
  type ToolIdempotencyLookupResult,
  type ToolIdempotencyOutcome,
  type ToolIdempotencyQuarantine,
  type ToolIdempotencyQuarantineResult,
  type ToolIdempotencyRecord,
  type ToolIdempotencyRelease,
  type ToolIdempotencyStore,
} from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";
import { decodeKeyPart, idempotencyKey, leaseKey, prefix, sessionKey } from "./keys.js";
import { parseObject, redisNowMs, withRedisBoundary } from "./redis-helpers.js";
import {
  FENCED_CLAIM_SCRIPT,
  UNFENCED_CLAIM_SCRIPT,
  FENCED_COMPLETE_SCRIPT,
  UNFENCED_COMPLETE_SCRIPT,
  QUARANTINE_RECOVERED_IDEMPOTENCY_SCRIPT,
  FENCED_RELEASE_CLAIM_SCRIPT,
  UNFENCED_RELEASE_CLAIM_SCRIPT,
  REWRITE_ALIAS_ERROR_SCRIPT,
  DELETE_EXPIRED_IDEMPOTENCY_SCRIPT,
  UNFENCED_LOOKUP_SCRIPT,
  FENCED_LOOKUP_SCRIPT,
} from "./redis-idempotency-scripts.js";

const MAX_FAILED_ALIAS_REWRITES = 1_024;
const MAX_ALIAS_REWRITE_KEY_LENGTH = 256;
const MAX_PRUNE_PAGE_SIZE = 1_000;

async function withIdempotencyBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await withRedisBoundary(operation);
  } catch (error) {
    if (
      error instanceof BackendUnavailableError &&
      error.message.includes("TVIC_LEASE_EXPIRY_RANGE")
    ) {
      throw new InvalidArgumentError("Lease expiry must be a non-negative safe integer timestamp");
    }
    throw error;
  }
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

export class RedisToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #options: RedisStoreOptions;
  readonly #failedAliasRewrites = new Set<string>();
  readonly #aliasRewritesInFlight = new Set<string>();

  constructor(
    readonly client: RedisClient,
    options: RedisStoreOptions = {},
  ) {
    this.#options = options;
  }

  async lookup(
    key: string,
    requestHash: string,
    sessionId?: SessionId,
    lease?: ToolIdempotencyClaim["lease"],
  ): Promise<ToolIdempotencyLookupResult> {
    return withRedisBoundary(async () => {
      const redisKey = idempotencyKey(this.#options.prefix, key);
      if (lease) assertLeaseFence(lease.fence);
      if (lease && sessionId && sessionId !== lease.sessionId) return { status: "conflict" };
      const result = lease
        ? await this.client.eval(
            FENCED_LOOKUP_SCRIPT,
            [leaseKey(this.#options.prefix, lease.sessionId), redisKey],
            [
              lease.sessionId,
              lease.holder,
              String(lease.fence),
              lease.generationId,
              key,
              requestHash,
            ],
          )
        : await this.client.eval(
            UNFENCED_LOOKUP_SCRIPT,
            [
              sessionKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
              leaseKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
              redisKey,
            ],
            [key, requestHash, sessionId ?? ""],
          );
      const script = parseScriptResult(result, `redis:tool_idempotency:${key}`);
      if (script.code === -1) throw new LeaseLostError(lease?.sessionId ?? sessionId ?? "unknown");
      if (script.code === -2) return { status: "conflict" };
      if (script.code === 0) return { status: "missing" };
      if (script.code === 2) {
        await this.client.eval(DELETE_EXPIRED_IDEMPOTENCY_SCRIPT, [redisKey], [key]);
        return { status: "missing" };
      }
      if (script.code !== 1 || !script.raw) {
        throw new CorruptRecordError(`redis:tool_idempotency:${key}`, "invalid lookup result");
      }
      const record = await this.#parseIdempotency(script.raw, redisKey, key);
      return { status: "found", record };
    });
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    return withIdempotencyBoundary(async () => {
      assertLeaseTtlMs(input.ttlMs);
      if (input.lease) assertLeaseFence(input.lease.fence);
      if (input.lease && input.sessionId && input.sessionId !== input.lease.sessionId) {
        return { status: "conflict" };
      }
      const key = idempotencyKey(this.#options.prefix, input.key);
      if (input.lease) return this.#fencedClaim(key, input, input.lease);
      const sessionId = input.sessionId;
      const result = await this.client.eval(
        UNFENCED_CLAIM_SCRIPT,
        [
          sessionKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
          leaseKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
          key,
        ],
        [
          input.key,
          sessionId ?? "",
          input.toolId ? String(input.toolId) : "",
          input.toolVersion ?? "",
          input.requestHash,
          input.owner,
          String(input.ttlMs),
        ],
      );
      const script = parseScriptResult(result, "redis:tool_idempotency");
      if (script.code === -2) return { status: "conflict" };
      if (!script.raw) {
        throw new CorruptRecordError("redis:tool_idempotency", "missing idempotency claim result");
      }
      const record = await this.#parseIdempotency(script.raw, key, input.key);
      if (script.code === 0) return { status: "in_progress", record };
      if (script.code === 2) return { status: "succeeded", record };
      if (script.code === 3) return { status: "terminal", record };
      if (script.code === 1) return { status: "claimed", record };
      throw new CorruptRecordError(
        "redis:tool_idempotency",
        `unknown idempotency claim result: ${script.code}`,
      );
    });
  }

  async releaseClaim(input: ToolIdempotencyRelease): Promise<boolean> {
    return withRedisBoundary(async () => {
      if (input.lease) assertLeaseFence(input.lease.fence);
      if (input.lease && input.sessionId && input.sessionId !== input.lease.sessionId) {
        return false;
      }
      const sessionId = input.lease?.sessionId ?? input.sessionId;
      const redisKey = idempotencyKey(this.#options.prefix, input.key);
      const result = input.lease
        ? await this.client.eval(
            FENCED_RELEASE_CLAIM_SCRIPT,
            [leaseKey(this.#options.prefix, input.lease.sessionId), redisKey],
            [
              input.lease.holder,
              String(input.lease.fence),
              input.lease.generationId,
              input.lease.sessionId,
              input.key,
              input.requestHash,
              input.owner,
            ],
          )
        : await this.client.eval(
            UNFENCED_RELEASE_CLAIM_SCRIPT,
            [
              sessionKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
              leaseKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
              redisKey,
            ],
            [input.key, input.requestHash, input.owner, sessionId ?? ""],
          );
      const code = Number(result);
      if (code === -1) throw new LeaseLostError(sessionId ?? "unknown");
      return code === 1;
    });
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    await withIdempotencyBoundary(async () => {
      assertLeaseTtlMs(outcome.ttlMs);
      if (outcome.lease) assertLeaseFence(outcome.lease.fence);
      if (outcome.lease && outcome.sessionId && outcome.sessionId !== outcome.lease.sessionId) {
        throw new RecordConflictError("tool_idempotency");
      }
      const redisKey = idempotencyKey(this.#options.prefix, key);
      if (outcome.lease) {
        const result = await this.client.eval(
          FENCED_COMPLETE_SCRIPT,
          [leaseKey(this.#options.prefix, outcome.lease.sessionId), redisKey],
          [
            outcome.lease.holder,
            String(outcome.lease.fence),
            requestHash,
            outcome.owner,
            outcome.status,
            String(outcome.ttlMs),
            outcome.output === undefined ? "" : stableStringify(outcome.output),
            outcome.error === undefined
              ? ""
              : stableStringify(sanitizeNormalizedErrorForStorage(outcome.error)),
            outcome.lease.sessionId,
            outcome.lease.generationId,
            key,
          ],
        );
        const script = parseScriptResult(result, "redis:tool_idempotency");
        if (script.code === -1) throw new LeaseLostError(outcome.lease.sessionId);
        if (script.code === -2) throw new RecordConflictError("tool_idempotency");
        if (script.code === 2) {
          const current = script.raw
            ? await this.#parseIdempotency(script.raw, redisKey, key)
            : null;
          if (current && sameOutcome(current, outcome)) return;
          throw new RecordConflictError("tool_idempotency");
        }
        if (script.code !== 1) throw new RecordConflictError("tool_idempotency");
        return;
      }
      const sessionId = outcome.sessionId;
      const result = await this.client.eval(
        UNFENCED_COMPLETE_SCRIPT,
        [
          sessionKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
          leaseKey(this.#options.prefix, sessionId ?? ("" as SessionId)),
          redisKey,
        ],
        [
          key,
          sessionId ?? "",
          requestHash,
          outcome.owner,
          outcome.status,
          String(outcome.ttlMs),
          outcome.output === undefined ? "" : stableStringify(outcome.output),
          outcome.error === undefined
            ? ""
            : stableStringify(sanitizeNormalizedErrorForStorage(outcome.error)),
        ],
      );
      const script = parseScriptResult(result, "redis:tool_idempotency");
      if (script.code === -1) throw new LeaseLostError(sessionId ?? "unknown");
      if (script.code === -2) throw new RecordConflictError("tool_idempotency");
      if (script.code === 2) {
        const current = script.raw ? await this.#parseIdempotency(script.raw, redisKey, key) : null;
        if (current && sameOutcome(current, outcome)) return;
        throw new RecordConflictError("tool_idempotency");
      }
      if (script.code !== 1) throw new RecordConflictError("tool_idempotency");
    });
  }

  async quarantine(input: ToolIdempotencyQuarantine): Promise<ToolIdempotencyQuarantineResult> {
    return withIdempotencyBoundary(async () => {
      assertLeaseTtlMs(input.ttlMs);
      assertLeaseFence(input.lease.fence);
      if (input.sessionId !== input.lease.sessionId) return { status: "conflict" };
      const redisKey = idempotencyKey(this.#options.prefix, input.key);
      const result = await this.client.eval(
        QUARANTINE_RECOVERED_IDEMPOTENCY_SCRIPT,
        [leaseKey(this.#options.prefix, input.lease.sessionId), redisKey],
        [
          input.lease.holder,
          String(input.lease.fence),
          input.lease.generationId,
          input.key,
          input.sessionId,
          String(input.toolId),
          input.toolVersion,
          input.requestHash,
          input.owner,
          String(input.ttlMs),
          stableStringify(sanitizeNormalizedErrorForStorage(input.error)),
        ],
      );
      const script = parseScriptResult(result, "redis:tool_idempotency");
      if (script.code === -1) throw new LeaseLostError(input.sessionId);
      if (script.code === -2) return { status: "conflict" };
      if (!script.raw) {
        throw new CorruptRecordError("redis:tool_idempotency", "missing quarantine script result");
      }
      const record = await this.#parseIdempotency(script.raw, redisKey, input.key);
      if (script.code === 0) return { status: "in_progress", record };
      if (script.code === 1) return { status: "quarantined", record };
      if (script.code === 2) return { status: "succeeded", record };
      if (script.code === 3) return { status: "terminal", record };
      throw new CorruptRecordError(
        "redis:tool_idempotency",
        `unknown quarantine script result: ${script.code}`,
      );
    });
  }

  async #fencedClaim(
    key: string,
    input: ToolIdempotencyClaim,
    lease: NonNullable<ToolIdempotencyClaim["lease"]>,
  ): Promise<ToolIdempotencyClaimResult> {
    const result = await this.client.eval(
      FENCED_CLAIM_SCRIPT,
      [leaseKey(this.#options.prefix, lease.sessionId), key],
      [
        lease.holder,
        String(lease.fence),
        input.key,
        lease.sessionId,
        input.toolId ? String(input.toolId) : "",
        input.toolVersion ?? "",
        input.requestHash,
        input.owner,
        String(input.ttlMs),
        lease.generationId,
      ],
    );
    const script = parseScriptResult(result, "redis:tool_idempotency");
    if (script.code === -1) throw new LeaseLostError(lease.sessionId);
    if (script.code === -2) return { status: "conflict" };
    if (!script.raw) {
      throw new CorruptRecordError("redis:tool_idempotency", "missing idempotency script result");
    }
    const record = await this.#parseIdempotency(script.raw, "redis:tool_idempotency", input.key);
    if (script.code === 0) return { status: "in_progress", record };
    if (script.code === 2) return { status: "succeeded", record };
    if (script.code === 3) return { status: "terminal", record };
    if (script.code === 1) {
      return { status: record.status === "succeeded" ? "succeeded" : "claimed", record };
    }
    throw new CorruptRecordError(
      "redis:tool_idempotency",
      `unknown idempotency script result: ${script.code}`,
    );
  }

  async #parseIdempotency(
    raw: string,
    redisKey: string,
    logicalKey: string,
    rewrite = true,
  ): Promise<ToolIdempotencyRecord> {
    const value = parseObject(raw, "redis:tool_idempotency");
    const statuses = new Set(["claimed", "succeeded", "failed", "timed_out", "cancelled"]);
    let output = value.output;
    if (value.outputJson !== undefined) {
      if (typeof value.outputJson !== "string" || value.output !== undefined) {
        throw new CorruptRecordError("redis:tool_idempotency", "invalid idempotency output");
      }
      try {
        output = JSON.parse(value.outputJson) as unknown;
      } catch {
        throw new CorruptRecordError("redis:tool_idempotency", "invalid idempotency output JSON");
      }
    }
    let rawError = value.error;
    if (value.errorJson !== undefined) {
      if (typeof value.errorJson !== "string" || value.error !== undefined) {
        throw new CorruptRecordError("redis:tool_idempotency", "invalid idempotency error");
      }
      try {
        rawError = JSON.parse(value.errorJson) as unknown;
      } catch {
        throw new CorruptRecordError("redis:tool_idempotency", "invalid idempotency error JSON");
      }
    }
    const read = readPersistedError(rawError);
    if (
      typeof value.key !== "string" ||
      value.key !== logicalKey ||
      typeof value.requestHash !== "string" ||
      typeof value.status !== "string" ||
      !statuses.has(value.status) ||
      typeof value.expiresAtMs !== "number" ||
      !Number.isSafeInteger(value.expiresAtMs) ||
      value.expiresAtMs < 0 ||
      (value.toolId !== undefined && typeof value.toolId !== "string") ||
      (value.toolVersion !== undefined && typeof value.toolVersion !== "string") ||
      (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
      (value.claimedFence !== undefined &&
        (typeof value.claimedFence !== "number" ||
          !Number.isSafeInteger(value.claimedFence) ||
          value.claimedFence < 1)) ||
      (value.claimedGenerationId !== undefined &&
        (typeof value.claimedGenerationId !== "string" ||
          value.claimedGenerationId.length === 0)) ||
      (value.owner !== undefined && typeof value.owner !== "string") ||
      ((value.error !== undefined || value.errorJson !== undefined) && read === null)
    ) {
      throw new CorruptRecordError("redis:tool_idempotency", "invalid idempotency payload");
    }
    if (read !== null && rewrite) {
      if (read.migratedAlias) {
        const legacyCode = read.error.metadata?.legacyCode;
        const rewriteKey = aliasRewriteKey(logicalKey, legacyCode);
        if (
          typeof legacyCode === "string" &&
          !this.#failedAliasRewrites.has(rewriteKey) &&
          !this.#aliasRewritesInFlight.has(rewriteKey)
        ) {
          this.#aliasRewritesInFlight.add(rewriteKey);
          const rewritten = await rewritePersistedErrorIfAlias({
            adapter: "redis",
            key: logicalKey,
            read,
            ...(this.#options.onCompatibilityDiagnostic
              ? { onCompatibilityDiagnostic: this.#options.onCompatibilityDiagnostic }
              : {}),
            rewrite: async (canonical) => {
              const result = await this.client.eval(
                REWRITE_ALIAS_ERROR_SCRIPT,
                [redisKey],
                [raw, stableStringify({ ...value, error: canonical })],
              );
              if (Number(result) !== 1) {
                throw new Error("idempotency alias rewrite lost its compare-and-set race");
              }
            },
          });
          this.#aliasRewritesInFlight.delete(rewriteKey);
          if (!rewritten) rememberFailedAliasRewrite(this.#failedAliasRewrites, rewriteKey);
        }
      }
    }
    return {
      key: value.key,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId as SessionId } : {}),
      ...(typeof value.toolId === "string" ? { toolId: value.toolId as ToolId } : {}),
      ...(typeof value.toolVersion === "string" ? { toolVersion: value.toolVersion } : {}),
      requestHash: value.requestHash,
      status: value.status as ToolIdempotencyRecord["status"],
      expiresAtMs: value.expiresAtMs,
      ...(typeof value.owner === "string" ? { owner: value.owner } : {}),
      ...(typeof value.claimedFence === "number" ? { claimedFence: value.claimedFence } : {}),
      ...(typeof value.claimedGenerationId === "string"
        ? { claimedGenerationId: value.claimedGenerationId }
        : {}),
      ...(output !== undefined ? { output } : {}),
      ...(read !== null
        ? {
            error: read.knownCode ? read.error : { ...read.error, retriable: false },
          }
        : {}),
    };
  }

  /**
   * Removes expired records written before Redis TTLs were applied. Run this
   * with the returned cursor until it returns "0" to clean a legacy prefix.
   */
  async pruneExpiredIdempotencyPage(
    cursor = "0",
    limit = 100,
  ): Promise<{ readonly cursor: string; readonly scanned: number; readonly deleted: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PRUNE_PAGE_SIZE) {
      throw new RangeError(`Idempotency prune limit must be between 1 and ${MAX_PRUNE_PAGE_SIZE}`);
    }
    return withRedisBoundary(async () => {
      const [nextCursor, keys] = await this.client.scan(cursor, {
        MATCH: `${prefix(this.#options.prefix)}idempotency:*`,
        COUNT: limit,
      });
      const now = await redisNowMs(this.client);
      let deleted = 0;
      for (const key of keys) {
        const raw = await this.client.get(key);
        if (raw === null) continue;
        let expiresAtMs: unknown;
        try {
          const value: unknown = JSON.parse(raw);
          expiresAtMs =
            typeof value === "object" && value !== null
              ? (value as { readonly expiresAtMs?: unknown }).expiresAtMs
              : undefined;
        } catch {
          continue;
        }
        if (typeof expiresAtMs !== "number" || expiresAtMs > now) continue;
        const logicalKey = decodeKeyPart(
          key.slice(`${prefix(this.#options.prefix)}idempotency:`.length),
        );
        if (
          Number(await this.client.eval(DELETE_EXPIRED_IDEMPOTENCY_SCRIPT, [key], [logicalKey])) ===
          1
        ) {
          deleted += 1;
        }
      }
      return { cursor: nextCursor, scanned: keys.length, deleted };
    });
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

function parseScriptResult(
  result: unknown,
  key: string,
): { readonly code: number; readonly raw?: string } {
  if (!Array.isArray(result) || result.length < 1) {
    throw new CorruptRecordError(key, "invalid idempotency script result");
  }
  const code = Number(result[0]);
  if (!Number.isInteger(code)) {
    throw new CorruptRecordError(key, "invalid idempotency script result code");
  }
  const raw = result[1];
  return {
    code,
    ...(typeof raw === "string" && raw.length > 0 ? { raw } : {}),
  };
}
