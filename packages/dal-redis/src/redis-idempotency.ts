import { stableStringify, CorruptRecordError } from "@tvic/dal-codec";
import {
  isNormalizedError,
  LeaseLostError,
  RecordConflictError,
  type ToolId,
  type SessionId,
  type ToolIdempotencyClaim,
  type ToolIdempotencyClaimResult,
  type ToolIdempotencyOutcome,
  type ToolIdempotencyRecord,
  type ToolIdempotencyStore,
} from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";
import { idempotencyKey, leaseKey } from "./keys.js";
import { maxRetries, parseObject, redisNowMs, withRedisBoundary } from "./redis-helpers.js";

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
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or tonumber(lease.expiresAtMs) <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if currentRaw then
  local current = cjson.decode(currentRaw)
  if tonumber(current.expiresAtMs) > now then
    if (ARGV[5] ~= '' and current.toolId ~= nil and current.toolId ~= ARGV[5]) or
       (ARGV[6] ~= '' and current.toolVersion ~= nil and current.toolVersion ~= ARGV[6]) or
       current.requestHash ~= ARGV[7] then
      return {-2, currentRaw}
    end
    if current.status == 'succeeded' then return {2, currentRaw} end
    if current.status == 'claimed' then
      local stale = ARGV[4] ~= '' and current.sessionId ~= nil and current.sessionId == ARGV[4] and
        current.claimedFence ~= nil and tonumber(current.claimedFence) < tonumber(ARGV[2])
      if current.owner ~= ARGV[8] and not stale then return {0, currentRaw} end
      if not stale then return {1, currentRaw} end
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
end
if ARGV[5] ~= '' then next.toolId = ARGV[5] end
if ARGV[6] ~= '' then next.toolVersion = ARGV[6] end
local encoded = cjson.encode(next)
redis.call('SET', KEYS[2], encoded)
return {1, encoded}
`;

const FENCED_COMPLETE_SCRIPT = `
local leaseRaw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not leaseRaw then return {-1, ''} end
local lease = cjson.decode(leaseRaw)
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or tonumber(lease.expiresAtMs) <= now then
  return {-1, ''}
end
local currentRaw = redis.call('GET', KEYS[2])
if not currentRaw then return {-2, ''} end
local current = cjson.decode(currentRaw)
if tonumber(current.expiresAtMs) <= now or current.requestHash ~= ARGV[3] or current.owner ~= ARGV[4] or
   (current.sessionId ~= nil and current.sessionId ~= ARGV[9]) or
   (current.claimedFence ~= nil and tonumber(current.claimedFence) ~= tonumber(ARGV[2])) then
  return {-2, currentRaw}
end
if current.status ~= 'claimed' then return {2, currentRaw} end
current.status = ARGV[5]
current.expiresAtMs = now + tonumber(ARGV[6])
current.claimedFence = current.claimedFence or tonumber(ARGV[2])
if ARGV[7] == '' then current.output = nil else current.output = cjson.decode(ARGV[7]) end
if ARGV[8] == '' then current.error = nil else current.error = cjson.decode(ARGV[8]) end
local encoded = cjson.encode(current)
redis.call('SET', KEYS[2], encoded)
return {1, encoded}
`;

export class RedisToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #options: RedisStoreOptions;

  constructor(
    readonly client: RedisClient,
    options: RedisStoreOptions = {},
  ) {
    this.#options = options;
  }

  async lookup(key: string, _requestHash: string): Promise<ToolIdempotencyRecord | null> {
    return withRedisBoundary(async () => {
      const record = await readIdempotency(this.client, idempotencyKey(this.#options.prefix, key));
      if (!record || record.expiresAtMs <= (await redisNowMs(this.client))) return null;
      return record;
    });
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    return withRedisBoundary(async () => {
      const key = idempotencyKey(this.#options.prefix, input.key);
      if (input.lease) return this.#fencedClaim(key, input, input.lease);
      for (let attempt = 0; attempt < maxRetries(this.#options); attempt += 1) {
        await this.client.watch(key);
        try {
          const current = await readIdempotency(this.client, key);
          const now = await redisNowMs(this.client);
          if (current && current.expiresAtMs > now) {
            if (
              (input.toolId && current.toolId && input.toolId !== current.toolId) ||
              (input.toolVersion &&
                current.toolVersion &&
                input.toolVersion !== current.toolVersion)
            ) {
              return { status: "conflict", record: current };
            }
            if (current.requestHash !== input.requestHash)
              return { status: "conflict", record: current };
            if (current.status === "succeeded") return { status: "succeeded", record: current };
            if (current.status === "claimed") {
              if (current.owner !== input.owner) return { status: "in_progress", record: current };
              return { status: "claimed", record: current };
            }
          }
          const record: ToolIdempotencyRecord = {
            key: input.key,
            ...(input.toolId ? { toolId: input.toolId } : {}),
            ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
            requestHash: input.requestHash,
            status: "claimed",
            owner: input.owner,
            expiresAtMs: now + input.ttlMs,
          };
          const committed = await this.client.multi().set(key, stableStringify(record)).exec();
          if (committed !== null) return { status: "claimed", record };
        } finally {
          await this.client.unwatch().catch(() => undefined);
        }
      }
      throw new Error(`Redis idempotency contention for key: ${input.key}`);
    });
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    await withRedisBoundary(async () => {
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
          ],
        );
        const script = parseScriptResult(result, redisKey);
        if (script.code === -1) throw new LeaseLostError(outcome.lease.sessionId);
        if (script.code === -2) throw new RecordConflictError(`idempotency:${key}`);
        if (script.code === 2) {
          const current = script.raw ? parseIdempotency(script.raw, redisKey) : null;
          if (current && sameOutcome(current, outcome)) return;
          throw new RecordConflictError(`idempotency:${key}`);
        }
        if (script.code !== 1) throw new RecordConflictError(`idempotency:${key}`);
        return;
      }
      for (let attempt = 0; attempt < maxRetries(this.#options); attempt += 1) {
        await this.client.watch(redisKey);
        try {
          const current = await readIdempotency(this.client, redisKey);
          const now = await redisNowMs(this.client);
          if (
            !current ||
            current.expiresAtMs <= now ||
            current.requestHash !== requestHash ||
            current.owner !== outcome.owner
          ) {
            throw new RecordConflictError(`idempotency:${key}`);
          }
          if (current.sessionId !== undefined || current.claimedFence !== undefined) {
            throw new LeaseLostError(current.sessionId ?? "unknown");
          }
          if (current.status !== "claimed") {
            if (sameOutcome(current, outcome)) return;
            throw new RecordConflictError(`idempotency:${key}`);
          }
          const next: ToolIdempotencyRecord = {
            ...current,
            ...(outcome.owner ? { owner: outcome.owner } : {}),
            status: outcome.status,
            expiresAtMs: now + outcome.ttlMs,
            ...(outcome.output !== undefined ? { output: outcome.output } : {}),
            ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          };
          const committed = await this.client.multi().set(redisKey, stableStringify(next)).exec();
          if (committed !== null) return;
        } finally {
          await this.client.unwatch().catch(() => undefined);
        }
      }
      throw new RecordConflictError(`idempotency:${key}`);
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
      ],
    );
    const script = parseScriptResult(result, key);
    if (script.code === -1) throw new LeaseLostError(lease.sessionId);
    if (!script.raw) throw new CorruptRecordError(key, "missing idempotency script result");
    const record = parseIdempotency(script.raw, key);
    if (script.code === -2) return { status: "conflict", record };
    if (script.code === 0) return { status: "in_progress", record };
    if (script.code === 2) return { status: "succeeded", record };
    if (script.code === 1) {
      return { status: record.status === "succeeded" ? "succeeded" : "claimed", record };
    }
    throw new CorruptRecordError(key, `unknown idempotency script result: ${script.code}`);
  }
}

function sameOutcome(record: ToolIdempotencyRecord, outcome: ToolIdempotencyOutcome): boolean {
  return (
    record.status === outcome.status &&
    stableStringify(record.output) === stableStringify(outcome.output) &&
    stableStringify(record.error) === stableStringify(outcome.error)
  );
}

async function readIdempotency(
  client: RedisClient,
  key: string,
): Promise<ToolIdempotencyRecord | null> {
  const raw = await client.get(key);
  if (raw === null) return null;
  return parseIdempotency(raw, key);
}

function parseIdempotency(raw: string, key: string): ToolIdempotencyRecord {
  const value = parseObject(raw, key);
  const statuses = new Set(["claimed", "succeeded", "failed", "timed_out", "cancelled"]);
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
    (value.owner !== undefined && typeof value.owner !== "string") ||
    (value.error !== undefined && !isNormalizedError(value.error))
  ) {
    throw new CorruptRecordError(key, "invalid idempotency payload");
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
    ...(value.output !== undefined ? { output: value.output } : {}),
    ...(isNormalizedError(value.error) ? { error: value.error } : {}),
  };
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
