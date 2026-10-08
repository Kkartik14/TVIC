import {
  CorruptRecordError,
  readPersistedError,
  rewritePersistedErrorIfAlias,
  stableStringify,
} from "@tvic/dal-codec";
import {
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
  type ToolIdempotencyStore,
} from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";
import { idempotencyKey, leaseKey, prefix } from "./keys.js";
import { maxRetries, parseObject, redisNowMs, withRedisBoundary } from "./redis-helpers.js";

const MAX_FAILED_ALIAS_REWRITES = 1_024;
const MAX_ALIAS_REWRITE_KEY_LENGTH = 256;
const MAX_PRUNE_PAGE_SIZE = 1_000;

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

/**
 * A fenced claim must validate the lease and mutate the idempotency record in
 * one Redis operation. WATCH/MULTI alone leaves a small expiry race between
 * reading the lease and committing the claim.
 */
const FENCED_CLAIM_SCRIPT = `
local leaseRaw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not leaseRaw then return {-1, ''} end
local lease = cjson.decode(leaseRaw)
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(lease.fence)) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or generationId ~= ARGV[10] or tonumber(lease.expiresAtMs) <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw then
  local current = cjson.decode(currentRaw)
  if tonumber(current.expiresAtMs) > now then
    if (ARGV[5] ~= '' and current.toolId ~= nil and current.toolId ~= ARGV[5]) or
       (ARGV[6] ~= '' and current.toolVersion ~= nil and current.toolVersion ~= ARGV[6]) or
       current.requestHash ~= ARGV[7] or
       (ARGV[4] ~= '' and (current.sessionId == nil or current.sessionId ~= ARGV[4])) then
      return {-2, currentRaw}
    end
    if current.status == 'succeeded' then return {2, currentRaw} end
    if current.status == 'claimed' then
      local stale = false
      if ARGV[4] ~= '' and current.sessionId ~= nil and current.sessionId == ARGV[4] then
        if current.claimedGenerationId ~= nil then
          stale = current.claimedGenerationId ~= ARGV[10] or
            (current.claimedFence ~= nil and tonumber(current.claimedFence) < tonumber(ARGV[2]))
        else
          stale = current.claimedFence ~= nil and tonumber(current.claimedFence) < tonumber(ARGV[2])
        end
      end
      if not stale then return {0, currentRaw} end
    else
      return {3, currentRaw}
    end
  end
end
local next = {
  key = ARGV[3],
  requestHash = ARGV[7],
  status = 'claimed',
  owner = ARGV[8],
  expiresAtMs = now + tonumber(ARGV[9])
}
if ARGV[4] ~= '' then
  next.sessionId = ARGV[4]
  next.claimedFence = tonumber(ARGV[2])
  next.claimedGenerationId = ARGV[10]
end
if ARGV[5] ~= '' then next.toolId = ARGV[5] end
if ARGV[6] ~= '' then next.toolVersion = ARGV[6] end
local encoded = cjson.encode(next)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[9])
return {1, encoded}
`;

const FENCED_COMPLETE_SCRIPT = `
local leaseRaw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not leaseRaw then return {-1, ''} end
local lease = cjson.decode(leaseRaw)
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(lease.fence)) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or generationId ~= ARGV[10] or tonumber(lease.expiresAtMs) <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if not currentRaw then return {-2, ''} end
local current = cjson.decode(currentRaw)
if tonumber(current.expiresAtMs) <= now or current.requestHash ~= ARGV[3] or current.owner ~= ARGV[4] or
   (ARGV[9] ~= '' and (current.sessionId == nil or current.sessionId ~= ARGV[9])) or
   (current.claimedFence ~= nil and tonumber(current.claimedFence) ~= tonumber(ARGV[2])) or
   (current.claimedGenerationId ~= ARGV[10]) then
  return {-2, currentRaw}
end
if current.status ~= 'claimed' then return {2, currentRaw} end
current.status = ARGV[5]
current.expiresAtMs = now + tonumber(ARGV[6])
current.claimedFence = current.claimedFence or tonumber(ARGV[2])
if ARGV[7] == '' then current.output = nil else current.output = cjson.decode(ARGV[7]) end
if ARGV[8] == '' then current.error = nil else current.error = cjson.decode(ARGV[8]) end
local encoded = cjson.encode(current)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[6])
return {1, encoded}
`;

const QUARANTINE_RECOVERED_IDEMPOTENCY_SCRIPT = `
-- TVIC_QUARANTINE_RECOVERED_IDEMPOTENCY
local leaseRaw = redis.call('GET', KEYS[1])
if not leaseRaw then return {-1, ''} end
local lease = cjson.decode(leaseRaw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(lease.fence)) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or
   generationId ~= ARGV[3] or tonumber(lease.expiresAtMs) <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw then
  local current = cjson.decode(currentRaw)
  if tonumber(current.expiresAtMs) > now then
    if current.sessionId ~= ARGV[5] or current.toolId ~= ARGV[6] or
       current.toolVersion ~= ARGV[7] or current.requestHash ~= ARGV[8] then
      return {-2, currentRaw}
    end
    if current.status == 'succeeded' then return {2, currentRaw} end
    if current.status ~= 'claimed' then return {3, currentRaw} end
    if current.owner ~= ARGV[9] then return {0, currentRaw} end
    local priorLease = false
    if current.claimedGenerationId ~= nil then
      priorLease = current.claimedGenerationId ~= ARGV[3] and
        (current.claimedFence == nil or tonumber(current.claimedFence) < tonumber(ARGV[2]))
    elseif current.claimedFence ~= nil then
      priorLease = tonumber(current.claimedFence) < tonumber(ARGV[2])
    end
    if not priorLease then return {0, currentRaw} end
  end
end
local next = {
  key = ARGV[4],
  sessionId = ARGV[5],
  toolId = ARGV[6],
  toolVersion = ARGV[7],
  requestHash = ARGV[8],
  status = 'failed',
  owner = ARGV[9],
  claimedFence = tonumber(ARGV[2]),
  claimedGenerationId = ARGV[3],
  expiresAtMs = now + tonumber(ARGV[10]),
  error = cjson.decode(ARGV[11])
}
local encoded = cjson.encode(next)
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[10])
return {1, encoded}
`;

/**
 * Canonicalize a legacy error only while the exact value that was read is
 * still present. The compare-and-set is atomic inside Redis, so a lookup can
 * never overwrite a newer claim or completion that raced with its rewrite.
 */
const REWRITE_ALIAS_ERROR_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

const DELETE_EXPIRED_IDEMPOTENCY_SCRIPT = `
-- TVIC_DELETE_EXPIRED_IDEMPOTENCY
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if tonumber(record.expiresAtMs) <= now then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

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
  ): Promise<ToolIdempotencyLookupResult> {
    return withRedisBoundary(async () => {
      const redisKey = idempotencyKey(this.#options.prefix, key);
      const record = await this.#readIdempotency(redisKey, key);
      if (!record) {
        return { status: "missing" };
      }
      if (record.expiresAtMs <= (await redisNowMs(this.client))) {
        await this.client.eval(DELETE_EXPIRED_IDEMPOTENCY_SCRIPT, [redisKey], []);
        return { status: "missing" };
      }
      if (record.requestHash !== requestHash || record.sessionId !== sessionId) {
        return { status: "conflict" };
      }
      return { status: "found", record };
    });
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    return withRedisBoundary(async () => {
      if (input.lease && input.sessionId && input.sessionId !== input.lease.sessionId) {
        return { status: "conflict" };
      }
      const key = idempotencyKey(this.#options.prefix, input.key);
      if (input.lease) return this.#fencedClaim(key, input, input.lease);
      for (let attempt = 0; attempt < maxRetries(this.#options); attempt += 1) {
        await this.client.watch(key);
        try {
          // Do not issue a write while this optimistic transaction is being
          // watched. A legacy rewrite is optional and can safely wait for a
          // later lookup outside the transaction.
          const current = await this.#readIdempotency(key, input.key, false);
          const now = await redisNowMs(this.client);
          if (current && current.expiresAtMs > now) {
            if (
              current.sessionId !== input.sessionId ||
              (input.toolId && current.toolId && input.toolId !== current.toolId) ||
              (input.toolVersion &&
                current.toolVersion &&
                input.toolVersion !== current.toolVersion)
            ) {
              return { status: "conflict" };
            }
            if (current.requestHash !== input.requestHash) return { status: "conflict" };
            if (current.status === "succeeded") return { status: "succeeded", record: current };
            if (current.status !== "claimed") return { status: "terminal", record: current };
            if (current.status === "claimed") {
              return { status: "in_progress", record: current };
            }
          }
          const record: ToolIdempotencyRecord = {
            key: input.key,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.toolId ? { toolId: input.toolId } : {}),
            ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
            requestHash: input.requestHash,
            status: "claimed",
            owner: input.owner,
            expiresAtMs: now + input.ttlMs,
          };
          const committed = await this.client
            .multi()
            .set(key, stableStringify(record), { PX: input.ttlMs })
            .exec();
          if (committed !== null) return { status: "claimed", record };
        } finally {
          await this.client.unwatch().catch(() => undefined);
        }
      }
      throw new Error("Redis idempotency contention");
    });
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    await withRedisBoundary(async () => {
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
            outcome.error === undefined ? "" : stableStringify(outcome.error),
            outcome.lease.sessionId,
            outcome.lease.generationId,
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
      for (let attempt = 0; attempt < maxRetries(this.#options); attempt += 1) {
        await this.client.watch(redisKey);
        try {
          // Do not issue a write while this optimistic transaction is being
          // watched. A legacy rewrite is optional and can safely wait for a
          // later lookup outside the transaction.
          const current = await this.#readIdempotency(redisKey, key, false);
          const now = await redisNowMs(this.client);
          if (
            !current ||
            current.expiresAtMs <= now ||
            current.requestHash !== requestHash ||
            current.owner !== outcome.owner
          ) {
            throw new RecordConflictError("tool_idempotency");
          }
          if (
            current.sessionId !== outcome.sessionId ||
            current.claimedFence !== undefined ||
            current.claimedGenerationId !== undefined
          ) {
            throw new LeaseLostError(current.sessionId ?? "unknown");
          }
          if (current.status !== "claimed") {
            if (sameOutcome(current, outcome)) return;
            throw new RecordConflictError("tool_idempotency");
          }
          const next: ToolIdempotencyRecord = {
            ...current,
            ...(outcome.owner ? { owner: outcome.owner } : {}),
            status: outcome.status,
            expiresAtMs: now + outcome.ttlMs,
            ...(outcome.output !== undefined ? { output: outcome.output } : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          };
          const committed = await this.client
            .multi()
            .set(redisKey, stableStringify(next), { PX: outcome.ttlMs })
            .exec();
          if (committed !== null) return;
        } finally {
          await this.client.unwatch().catch(() => undefined);
        }
      }
      throw new RecordConflictError("tool_idempotency");
    });
  }

  async quarantine(input: ToolIdempotencyQuarantine): Promise<ToolIdempotencyQuarantineResult> {
    return withRedisBoundary(async () => {
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
          stableStringify(input.error),
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

  async #readIdempotency(
    redisKey: string,
    logicalKey: string,
    rewrite = true,
  ): Promise<ToolIdempotencyRecord | null> {
    const raw = await this.client.get(redisKey);
    if (raw === null) return null;
    return this.#parseIdempotency(raw, redisKey, logicalKey, rewrite);
  }

  async #parseIdempotency(
    raw: string,
    redisKey: string,
    logicalKey: string,
    rewrite = true,
  ): Promise<ToolIdempotencyRecord> {
    const value = parseObject(raw, "redis:tool_idempotency");
    const statuses = new Set(["claimed", "succeeded", "failed", "timed_out", "cancelled"]);
    const read = readPersistedError(value.error);
    if (
      typeof value.key !== "string" ||
      typeof value.requestHash !== "string" ||
      typeof value.status !== "string" ||
      !statuses.has(value.status) ||
      typeof value.expiresAtMs !== "number" ||
      (value.toolId !== undefined && typeof value.toolId !== "string") ||
      (value.toolVersion !== undefined && typeof value.toolVersion !== "string") ||
      (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
      (value.claimedFence !== undefined &&
        (typeof value.claimedFence !== "number" || !Number.isInteger(value.claimedFence))) ||
      (value.claimedGenerationId !== undefined &&
        (typeof value.claimedGenerationId !== "string" ||
          value.claimedGenerationId.length === 0)) ||
      (value.owner !== undefined && typeof value.owner !== "string") ||
      (value.error !== undefined && read === null)
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
      ...(value.output !== undefined ? { output: value.output } : {}),
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
        if (Number(await this.client.eval(DELETE_EXPIRED_IDEMPOTENCY_SCRIPT, [key], [])) === 1) {
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
    stableStringify(record.error) === stableStringify(outcome.error)
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
