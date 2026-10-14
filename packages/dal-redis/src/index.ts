import { randomUUID } from "node:crypto";
import {
  CorruptRecordError,
  decodeOutboxEnvelope,
  encodeStoredSession,
  normalizeStoredSession,
  stableStringify,
} from "@tvic/dal-codec";
import type { PersistedErrorCompatibilityDiagnostic } from "@tvic/dal-codec";
import {
  assertLeaseFence,
  assertLeaseTtlMs,
  InvalidArgumentError,
  LeaseLostError,
  RecordConflictError,
  assertRecoveryPageSize,
  type DurableOutboxEvent,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type SessionId,
  type SessionLease,
  type SessionLeaseStore,
  type SessionRecoveryCandidate,
  type StoredSessionRecord,
} from "@tvic/core";
import {
  encodeKeyPart,
  leaseIndexKey,
  leaseKey,
  leaseRecoveryCandidatesKey,
  outboxKey,
  prefix,
  sessionIndexKey,
  sessionKey,
} from "./keys.js";
import { parseLease, readLease, redisNowMs, withRedisBoundary } from "./redis-helpers.js";
import {
  ACK_RECOVERY_CANDIDATE_SCRIPT,
  ACQUIRE_LEASE_SCRIPT,
  decodeRecoveryCursor,
  encodeRecoveryCursor,
  FINALIZE_SESSION_CREATION_SCRIPT,
  INITIAL_RECOVERY_CURSOR,
  LIST_RECOVERY_CANDIDATES_SCRIPT,
  PREPARE_SESSION_LEASE_SCRIPT,
  RELEASE_LEASE_SCRIPT,
  RENEW_LEASE_SCRIPT,
} from "./redis-lease-scripts.js";
import { RedisToolIdempotencyStore } from "./redis-idempotency.js";
import { RedisSessionStore, RedisToolCallStore, RedisTurnStore } from "./record-stores.js";
import { RedisSessionTransaction } from "./redis-transaction.js";
import { LEASE_NUMERIC_GUARD, SORTED_SET_TYPE_GUARD } from "./redis-script-helpers.js";

export { RedisToolIdempotencyStore } from "./redis-idempotency.js";
export { RedisSessionStore, RedisToolCallStore, RedisTurnStore } from "./record-stores.js";

export type RedisSetResult = "OK" | "ok" | boolean | null;

export interface RedisScanOptions {
  readonly MATCH?: string;
  readonly COUNT?: number;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { readonly NX?: boolean; readonly PX?: number },
  ): Promise<RedisSetResult>;
  del(...keys: readonly string[]): Promise<number>;
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
  scan(cursor: string, options?: RedisScanOptions): Promise<readonly [string, readonly string[]]>;
  zrange(key: string, start: number, stop: number): Promise<readonly string[]>;
  zrangebyscore(key: string, min: number, max: number): Promise<readonly string[]>;
  time(): Promise<readonly [string, string]>;
  watch(...keys: readonly string[]): Promise<void>;
  unwatch(): Promise<void>;
  multi(): RedisMulti;
  quit?(): Promise<void>;
}

export interface RedisMulti {
  set(key: string, value: string, options?: { readonly PX?: number }): RedisMulti;
  del(...keys: readonly string[]): RedisMulti;
  exec(): Promise<readonly unknown[] | null>;
}

export interface RedisStoreOptions {
  readonly prefix?: string;
  readonly nowMs?: () => number;
  readonly maxTransactionRetries?: number;
  readonly closeClient?: boolean;
  readonly onCompatibilityDiagnostic?: (diagnostic: PersistedErrorCompatibilityDiagnostic) => void;
}

const MAX_REDIS_TRANSACTION_WRITES = 1_000;

const COMMIT_RECORDS_SCRIPT = `
local function commitRecords(firstArg)
  if #KEYS - 1 > ${MAX_REDIS_TRANSACTION_WRITES} then return false end
  local values = {}
  local arg = firstArg
  for index = 2, #KEYS do
    local orderKey = ARGV[arg + 1]
    if orderKey ~= '' then redis.call('ZADD', orderKey, ARGV[arg + 2], KEYS[index]) end
    values[#values + 1] = KEYS[index]
    values[#values + 1] = ARGV[arg]
    arg = arg + 4
  end
  -- Indexes are derived: a failed ZADD can leave a harmless member without a record.
  -- MSET is the single commit point for all canonical records and outbox values.
  if #values > 0 then redis.call('MSET', unpack(values)) end
  return true
end
`;

const FENCED_TRANSACTION_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}${COMMIT_RECORDS_SCRIPT}
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease, expiresAtMs, fence = readLease(raw)
local requestedFence = safeInteger(ARGV[2], 1)
if not lease or not requestedFence then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
if lease.sessionId ~= ARGV[#ARGV] then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(fence) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or fence ~= requestedFence or generationId ~= ARGV[3] or expiresAtMs <= now then return 0 end
local arg = 4
for index = 2, #KEYS do
  local orderKey = ARGV[arg + 1]
  if orderKey ~= '' then
    local score = tonumber(ARGV[arg + 2])
    if not score or score ~= score or score == math.huge or score == -math.huge then
      return redis.error_reply('TVIC_RECORD_INDEX_SCORE')
    end
    if not isSortedSetOrMissing(orderKey) then
      return redis.error_reply('TVIC_RECORD_INDEX_TYPE')
    end
  end
  arg = arg + 4
end
arg = 4
for index = 2, #KEYS do
  local value = ARGV[arg]
  local current = redis.call('GET', KEYS[index])
  local expected = ARGV[arg + 3]
  if expected == '*' then
    if current and current ~= value then return -1 end
  elseif expected == '__absent__' then
    if current then return -1 end
  elseif current ~= expected then
    return -1
  end
  arg = arg + 4
end
if not commitRecords(4) then return redis.error_reply('TVIC_TRANSACTION_TOO_LARGE') end
return 1
`;

const UNFENCED_TRANSACTION_SCRIPT = `${SORTED_SET_TYPE_GUARD}${LEASE_NUMERIC_GUARD}${COMMIT_RECORDS_SCRIPT}
-- TVIC_UNFENCED_TRANSACTION
local rawLease = redis.call('GET', KEYS[1])
if rawLease then
  local lease, expiresAtMs = readLease(rawLease)
  if not lease then return redis.error_reply('TVIC_LEASE_RECORD_INVALID') end
  if lease.sessionId ~= ARGV[#ARGV] then return -2 end
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  if not safeTimestamp(now) then return redis.error_reply('TVIC_LEASE_TIMESTAMP_RANGE') end
  if expiresAtMs > now then return -2 end
end
local arg = 1
for index = 2, #KEYS do
  local orderKey = ARGV[arg + 1]
  if orderKey ~= '' then
    local score = tonumber(ARGV[arg + 2])
    if not score or score ~= score or score == math.huge or score == -math.huge then
      return redis.error_reply('TVIC_RECORD_INDEX_SCORE')
    end
    if not isSortedSetOrMissing(orderKey) then
      return redis.error_reply('TVIC_RECORD_INDEX_TYPE')
    end
  end
  arg = arg + 4
end
arg = 1
for index = 2, #KEYS do
  local value = ARGV[arg]
  local current = redis.call('GET', KEYS[index])
  local expected = ARGV[arg + 3]
  if expected == '*' then
    if current and current ~= value then return -1 end
  elseif expected == '__absent__' then
    if current then return -1 end
  elseif current ~= expected then
    return -1
  end
  arg = arg + 4
end
if not commitRecords(1) then return redis.error_reply('TVIC_TRANSACTION_TOO_LARGE') end
return 1
`;

export {
  RedisOutboxCacheProjector,
  SessionCacheRetentionPendingError,
  type ProjectedSessionCacheSnapshot,
  type ProjectedSessionRetentionIdentity,
} from "./cache-projector.js";

export class RedisSessionLeaseStore implements SessionLeaseStore {
  readonly #options: RedisStoreOptions;

  constructor(
    readonly client: RedisClient,
    options: RedisStoreOptions = {},
  ) {
    this.#options = options;
  }

  async acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null> {
    assertLeaseTtlMs(ttlMs);
    return withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      const raw = await this.client.eval(
        ACQUIRE_LEASE_SCRIPT,
        [
          key,
          leaseIndexKey(this.#options.prefix),
          leaseRecoveryCandidatesKey(this.#options.prefix),
        ],
        [holder, String(sessionId), String(ttlMs), encodeKeyPart(String(sessionId)), randomUUID()],
      );
      if (typeof raw !== "string" || raw.length === 0) return null;
      return parseLease(raw, key);
    });
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
    return withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      const raw = await this.client.eval(
        RENEW_LEASE_SCRIPT,
        [
          key,
          leaseIndexKey(this.#options.prefix),
          leaseRecoveryCandidatesKey(this.#options.prefix),
        ],
        [
          holder,
          String(fence),
          String(ttlMs),
          encodeKeyPart(String(sessionId)),
          generationId,
          String(sessionId),
        ],
      );
      if (typeof raw !== "string" || raw.length === 0) return null;
      return parseLease(raw, key);
    });
  }

  async release(
    sessionId: SessionId,
    holder: string,
    fence: number,
    generationId: string,
  ): Promise<void> {
    assertLeaseFence(fence);
    await withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      await this.client.eval(
        RELEASE_LEASE_SCRIPT,
        [
          key,
          leaseIndexKey(this.#options.prefix),
          leaseRecoveryCandidatesKey(this.#options.prefix),
        ],
        [holder, String(fence), encodeKeyPart(String(sessionId)), String(sessionId), generationId],
      );
    });
  }

  async get(sessionId: SessionId): Promise<SessionLease | null> {
    return withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      const current = await readLease(this.client, key);
      if (current && current.sessionId !== sessionId) {
        throw new CorruptRecordError(key, "lease session ID does not match its Redis key");
      }
      return current && current.expiresAtMs > (await redisNowMs(this.client)) ? current : null;
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
    return withRedisBoundary(async () => {
      const cursor = decodeRecoveryCursor(options.cursor);
      const raw = await this.client.eval(
        LIST_RECOVERY_CANDIDATES_SCRIPT,
        [leaseIndexKey(this.#options.prefix), leaseRecoveryCandidatesKey(this.#options.prefix)],
        [
          cursor.provided ? "1" : "0",
          cursor.sessionId,
          String(options.limit),
          `${prefix(this.#options.prefix)}lease:`,
        ],
      );
      if (
        !Array.isArray(raw) ||
        !Array.isArray(raw[0]) ||
        !Array.isArray(raw[1]) ||
        !Array.isArray(raw[2]) ||
        !Array.isArray(raw[7])
      ) {
        throw new Error("Redis returned an invalid recovery page");
      }
      if (raw[0].length !== raw[1].length || raw[0].length !== raw[2].length) {
        throw new Error("Redis returned mismatched recovery candidate identities");
      }
      const candidates = raw[0].map((id, index) => {
        const fence = Number(raw[1][index]);
        const generationId = raw[2][index];
        if (
          !Number.isSafeInteger(fence) ||
          fence < 1 ||
          typeof generationId !== "string" ||
          generationId.length === 0
        ) {
          throw new Error("Redis returned an invalid recovery candidate identity");
        }
        return { sessionId: String(id) as SessionId, fence, generationId };
      });
      const corruptLeaseSessionIds = raw[7].map((id) => String(id) as SessionId);
      const lastExamined = String(raw[3] ?? "");
      const inspected = Number(raw[5] ?? 0);
      const hasMore = Number(raw[4]) === 1;
      const hasMoreDue = Number(raw[6]) === 1;
      let nextCursor: string | undefined;
      if (hasMore || hasMoreDue) {
        if (inspected > 0) nextCursor = encodeRecoveryCursor(lastExamined);
        else if (cursor.provided) nextCursor = encodeRecoveryCursor(cursor.sessionId);
        else nextCursor = INITIAL_RECOVERY_CURSOR;
      }
      return {
        candidates,
        ...(corruptLeaseSessionIds.length > 0 ? { corruptLeaseSessionIds } : {}),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  async acknowledgeRecoveryCandidate(candidate: SessionRecoveryCandidate): Promise<void> {
    assertLeaseFence(candidate.fence);
    if (candidate.generationId.length === 0) {
      throw new InvalidArgumentError("Recovery candidate generation ID must be non-empty");
    }
    await withRedisBoundary(async () => {
      const sessionId = String(candidate.sessionId);
      await this.client.eval(
        ACK_RECOVERY_CANDIDATE_SCRIPT,
        [
          leaseKey(this.#options.prefix, candidate.sessionId),
          leaseIndexKey(this.#options.prefix),
          leaseRecoveryCandidatesKey(this.#options.prefix),
        ],
        [sessionId, String(candidate.fence), candidate.generationId, encodeKeyPart(sessionId)],
      );
    });
  }

  async close(): Promise<void> {
    await withRedisBoundary(async () => {
      if (this.#options.closeClient) await this.client.quit?.();
    });
  }
}

export class RedisDurableRuntimeStore implements DurableRuntimeStore {
  readonly sessions: RedisSessionStore;
  readonly turns: RedisTurnStore;
  readonly toolCalls: RedisToolCallStore;
  readonly leases: RedisSessionLeaseStore;
  readonly toolIdempotencyStore: RedisToolIdempotencyStore;
  #closePromise: Promise<void> | undefined;
  readonly #client: RedisClient;
  readonly #options: RedisStoreOptions;

  constructor(client: RedisClient, options: RedisStoreOptions = {}) {
    this.#client = client;
    this.#options = options;
    this.sessions = new RedisSessionStore(client, options);
    this.turns = new RedisTurnStore(client, options);
    this.toolCalls = new RedisToolCallStore(client, options);
    this.leases = new RedisSessionLeaseStore(client, options);
    this.toolIdempotencyStore = new RedisToolIdempotencyStore(client, options);
  }

  async createSessionWithLease(
    record: StoredSessionRecord,
    holder: string,
    ttlMs: number,
    initialEvent?: (lease: SessionLease) => DurableOutboxEvent,
  ): Promise<SessionLease | null> {
    return withRedisBoundary(async () => {
      assertLeaseTtlMs(ttlMs);
      const sessionKeyValue = sessionKey(this.#options.prefix, record.session.id);
      const normalized = normalizeStoredSession(
        { ...record, version: record.version ?? 1 },
        `redis:session:${record.session.id}`,
      );
      const encodedSession = encodeStoredSession(normalized);
      const keys = [
        sessionKeyValue,
        sessionIndexKey(this.#options.prefix),
        leaseKey(this.#options.prefix, record.session.id),
        leaseIndexKey(this.#options.prefix),
        leaseRecoveryCandidatesKey(this.#options.prefix),
      ];
      const requestedGenerationId = randomUUID();
      let result: unknown;
      try {
        result = await this.#client.eval(PREPARE_SESSION_LEASE_SCRIPT, keys, [
          encodedSession,
          holder,
          String(record.session.id),
          String(ttlMs),
          encodeKeyPart(String(record.session.id)),
          requestedGenerationId,
        ]);
      } catch (error) {
        await this.#releasePreparedLease(record.session.id, holder, requestedGenerationId).catch(
          () => undefined,
        );
        throw error;
      }
      if (Number(result) === 0 || Number(result) === -1) return null;
      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        (result[0] !== "prepared" && result[0] !== "reused") ||
        typeof result[1] !== "string"
      ) {
        return null;
      }
      const [preparation, rawLease] = result;
      const ownsPreparedLease = preparation === "prepared";
      const lease = parseLease(rawLease, leaseKey(this.#options.prefix, record.session.id));

      let eventValue = "";
      let eventKey = "";
      try {
        if (initialEvent) {
          const event = initialEvent(lease);
          const envelope = decodeOutboxEnvelope(
            event.aggregateType,
            event.envelope,
            `outbox:${event.id}`,
            event.version,
          );
          eventValue = stableStringify({ ...event, envelope });
          eventKey = outboxKey(this.#options.prefix, event.id);
        }
        const finalized = await this.#client.eval(FINALIZE_SESSION_CREATION_SCRIPT, keys, [
          encodedSession,
          holder,
          String(record.session.id),
          String(lease.fence),
          eventValue,
          eventKey,
          String(Date.parse(record.session.createdAt)),
          encodeKeyPart(String(record.session.id)),
          lease.generationId,
        ]);
        if (Number(finalized) !== 1) {
          if (ownsPreparedLease) {
            await this.#releasePreparedLease(record.session.id, holder, lease.generationId).catch(
              () => undefined,
            );
          }
          return null;
        }
        return lease;
      } catch (error) {
        if (ownsPreparedLease) {
          await this.#releasePreparedLease(record.session.id, holder, lease.generationId).catch(
            () => undefined,
          );
        }
        throw error;
      }
    });
  }

  async #releasePreparedLease(
    sessionId: SessionId,
    holder: string,
    generationId: string,
  ): Promise<void> {
    const lease = await this.leases.get(sessionId);
    if (lease?.holder !== holder || lease.generationId !== generationId) return;
    await this.leases.release(sessionId, holder, lease.fence, generationId);
  }

  async runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    assertLeaseFence(lease.fence);
    return withRedisBoundary(async () => {
      const tx = new RedisSessionTransaction(
        this.#client,
        this.#options.prefix,
        sessionId,
        this.turns,
        this.toolCalls,
      );
      const result = await operation(tx);
      const writes = tx.writes();
      const keys = [leaseKey(this.#options.prefix, sessionId), ...writes.map((write) => write.key)];
      const args = [lease.holder, String(lease.fence), lease.generationId];
      for (const write of writes) {
        args.push(
          write.value,
          write.indexKey,
          String(write.orderScore),
          write.expectedValue ?? "*",
        );
      }
      args.push(String(sessionId));
      const committed = await this.#client.eval(FENCED_TRANSACTION_SCRIPT, keys, args);
      if (Number(committed) === -1) throw new RecordConflictError(`session:${sessionId}`);
      if (Number(committed) !== 1) throw new LeaseLostError(sessionId);
      return result;
    });
  }

  async runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withRedisBoundary(async () => {
      const tx = new RedisSessionTransaction(
        this.#client,
        this.#options.prefix,
        sessionId,
        this.turns,
        this.toolCalls,
      );
      const result = await operation(tx);
      const writes = tx.writes();
      const args: string[] = [];
      for (const write of writes) {
        args.push(
          write.value,
          write.indexKey,
          String(write.orderScore),
          write.expectedValue ?? "*",
        );
      }
      args.push(String(sessionId));
      const committed = await this.#client.eval(
        UNFENCED_TRANSACTION_SCRIPT,
        [leaseKey(this.#options.prefix, sessionId), ...writes.map((write) => write.key)],
        args,
      );
      if (Number(committed) === -2) throw new LeaseLostError(sessionId);
      if (Number(committed) !== 1) throw new RecordConflictError(`session:${sessionId}`);
      return result;
    });
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.leases.close();
    }
    await this.#closePromise;
  }
}

export function createRedisDurableRuntimeStore(
  client: RedisClient,
  options: RedisStoreOptions = {},
): RedisDurableRuntimeStore {
  return new RedisDurableRuntimeStore(client, options);
}
