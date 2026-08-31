import {
  decodeStoredSession,
  decodeStoredToolCall,
  decodeStoredTurn,
  decodeOutboxEnvelope,
  encodeStoredSession,
  encodeStoredToolCall,
  encodeStoredTurn,
  normalizeStoredSession,
  normalizeStoredToolCall,
  normalizeStoredTurn,
  stableStringify,
} from "@tvic/dal-codec";
import {
  LeaseLostError,
  RecordConflictError,
  type DurableOutboxEvent,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type SessionId,
  type SessionLease,
  type SessionLeaseStore,
  type SessionStore,
  type StoredSessionRecord,
  type StoredToolCallRecord,
  type StoredTurnRecord,
  type ToolCallId,
  type ToolCallStore,
  type TurnId,
  type TurnStore,
} from "@tvic/core";
import {
  decodeKeyPart,
  encodeKeyPart,
  leaseIndexKey,
  leaseKey,
  outboxKey,
  sessionIndexKey,
  sessionKey,
  toolCallKey,
  toolIndexKey,
  turnIndexKey,
  turnKey,
} from "./keys.js";
import { parseLease, readLease, redisNowMs, withRedisBoundary } from "./redis-helpers.js";
import { RedisToolIdempotencyStore } from "./redis-idempotency.js";
import { atomicUpdate, putIfAbsent, RedisSessionTransaction } from "./redis-transaction.js";

export { RedisToolIdempotencyStore } from "./redis-idempotency.js";

export type RedisSetResult = "OK" | "ok" | boolean | null;

export interface RedisScanOptions {
  readonly MATCH?: string;
  readonly COUNT?: number;
}

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { readonly NX?: boolean }): Promise<RedisSetResult>;
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
  set(key: string, value: string): RedisMulti;
  del(...keys: readonly string[]): RedisMulti;
  exec(): Promise<readonly unknown[] | null>;
}

export interface RedisStoreOptions {
  readonly prefix?: string;
  readonly nowMs?: () => number;
  readonly maxTransactionRetries?: number;
  readonly closeClient?: boolean;
}

const FENCED_TRANSACTION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
local now = tonumber(redis.call('TIME')[1]) * 1000 + math.floor(tonumber(redis.call('TIME')[2]) / 1000)
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or tonumber(lease.expiresAtMs) <= now then return 0 end
local arg = 3
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
arg = 3
for index = 2, #KEYS do
  local value = ARGV[arg]
  redis.call('SET', KEYS[index], value)
  local orderKey = ARGV[arg + 1]
  if orderKey ~= '' then redis.call('ZADD', orderKey, ARGV[arg + 2], KEYS[index]) end
  arg = arg + 4
end
return 1
`;

const UNFENCED_TRANSACTION_SCRIPT = `
local arg = 1
for index = 1, #KEYS do
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
arg = 1
for index = 1, #KEYS do
  local value = ARGV[arg]
  redis.call('SET', KEYS[index], value)
  local orderKey = ARGV[arg + 1]
  if orderKey ~= '' then redis.call('ZADD', orderKey, ARGV[arg + 2], KEYS[index]) end
  arg = arg + 4
end
return 1
`;

const ACQUIRE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if raw then
  local current = cjson.decode(raw)
  if tonumber(current.expiresAtMs) > now then
    if current.holder == ARGV[1] then return raw else return '' end
  end
  local next = {sessionId = ARGV[2], holder = ARGV[1], fence = tonumber(current.fence) + 1, acquiredAtMs = now, renewedAtMs = now, expiresAtMs = now + tonumber(ARGV[3])}
  local encoded = cjson.encode(next)
  redis.call('SET', KEYS[1], encoded)
  redis.call('ZADD', KEYS[2], next.expiresAtMs, ARGV[4])
  return encoded
end
local next = {sessionId = ARGV[2], holder = ARGV[1], fence = 1, acquiredAtMs = now, renewedAtMs = now, expiresAtMs = now + tonumber(ARGV[3])}
local encoded = cjson.encode(next)
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], next.expiresAtMs, ARGV[4])
return encoded
`;

const RENEW_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local current = cjson.decode(raw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if current.holder ~= ARGV[1] or tonumber(current.fence) ~= tonumber(ARGV[2]) or tonumber(current.expiresAtMs) <= now then return '' end
current.renewedAtMs = now
current.expiresAtMs = now + tonumber(ARGV[3])
local encoded = cjson.encode(current)
redis.call('SET', KEYS[1], encoded)
redis.call('ZADD', KEYS[2], current.expiresAtMs, ARGV[4])
return encoded
`;

const RELEASE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.holder ~= ARGV[1] or tonumber(current.fence) ~= tonumber(ARGV[2]) then return 0 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
current.renewedAtMs = now
current.expiresAtMs = now
redis.call('SET', KEYS[1], cjson.encode(current))
redis.call('ZADD', KEYS[2], now, ARGV[3])
return 1
`;

const PREPARE_SESSION_LEASE_SCRIPT = `
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw and existingRaw ~= ARGV[1] then return -1 end
local leaseRaw = redis.call('GET', KEYS[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local current = leaseRaw and cjson.decode(leaseRaw) or nil
if current and tonumber(current.expiresAtMs) > now then
  if current.holder ~= ARGV[2] then return 0 end
  return leaseRaw
end
local lease = {
  sessionId = ARGV[3],
  holder = ARGV[2],
  fence = current and tonumber(current.fence) + 1 or 1,
  acquiredAtMs = now,
  renewedAtMs = now,
  expiresAtMs = now + tonumber(ARGV[4])
}
local encoded = cjson.encode(lease)
redis.call('SET', KEYS[3], encoded)
redis.call('ZADD', KEYS[4], lease.expiresAtMs, ARGV[5])
return encoded
`;

const FINALIZE_SESSION_CREATION_SCRIPT = `
local leaseRaw = redis.call('GET', KEYS[3])
if not leaseRaw then return 0 end
local lease = cjson.decode(leaseRaw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if lease.holder ~= ARGV[2] or tonumber(lease.fence) ~= tonumber(ARGV[4]) or tonumber(lease.expiresAtMs) <= now then return 0 end
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw and existingRaw ~= ARGV[1] then return -1 end
if not existingRaw then
  redis.call('SET', KEYS[1], ARGV[1])
end
-- Repair the derived session index on retries as well as on first creation.
-- A process can crash after SET session but before the index write; finalization
-- is the next safe point at which the exact same session is known to be valid.
-- The index member is the encoded session id, matching every other lease path.
redis.call('ZADD', KEYS[2], ARGV[7], ARGV[8])
if ARGV[5] ~= '' then
  redis.call('SET', ARGV[6], ARGV[5])
end
return 1
`;

export { RedisOutboxCacheProjector } from "./cache-projector.js";

export class RedisSessionStore implements SessionStore {
  constructor(
    readonly client: RedisClient,
    readonly options: RedisStoreOptions = {},
  ) {}

  async get(id: SessionId): Promise<StoredSessionRecord | null> {
    return withRedisBoundary(async () => {
      const raw = await this.client.get(sessionKey(this.options.prefix, id));
      return raw === null ? null : decodeStoredSession(raw, `redis:session:${id}`);
    });
  }

  async list(): Promise<readonly StoredSessionRecord[]> {
    return withRedisBoundary(async () => {
      const keys = await this.client.zrange(sessionIndexKey(this.options.prefix), 0, -1);
      const records = await Promise.all(
        keys.map(async (key) => {
          const raw = await this.client.get(key);
          return raw === null ? null : decodeStoredSession(raw, `redis:${key}`);
        }),
      );
      return records
        .filter((record): record is StoredSessionRecord => record !== null)
        .sort((a, b) => {
          const created = a.session.createdAt.localeCompare(b.session.createdAt);
          return created === 0 ? a.session.id.localeCompare(b.session.id) : created;
        });
    });
  }

  async put(record: StoredSessionRecord): Promise<void> {
    const normalized = normalizeStoredSession(
      { ...record, version: record.version ?? 1 },
      `redis:session:${record.session.id}`,
    );
    await withRedisBoundary(() =>
      putIfAbsent(
        this.client,
        sessionKey(this.options.prefix, record.session.id),
        sessionIndexKey(this.options.prefix),
        Date.parse(record.session.createdAt),
        encodeStoredSession(normalized),
        () => this.get(record.session.id),
        record,
        "Session",
      ),
    );
  }

  update(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    return withRedisBoundary(() =>
      atomicUpdate(
        this.client,
        sessionKey(this.options.prefix, id),
        `redis:session:${id}`,
        decodeStoredSession,
        encodeStoredSession,
        normalizeStoredSession,
        updater,
        this.options.maxTransactionRetries,
      ),
    );
  }

  async close(): Promise<void> {
    return;
  }
}

export class RedisTurnStore implements TurnStore {
  constructor(
    readonly client: RedisClient,
    readonly options: RedisStoreOptions = {},
  ) {}

  async get(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null> {
    return withRedisBoundary(async () => {
      const raw = await this.client.get(turnKey(this.options.prefix, sessionId, id));
      return raw === null ? null : decodeStoredTurn(raw, `redis:turn:${sessionId}:${id}`);
    });
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    return withRedisBoundary(async () => {
      const keys = await this.client.zrange(turnIndexKey(this.options.prefix, sessionId), 0, -1);
      const records = await Promise.all(
        keys.map(async (key) => {
          const raw = await this.client.get(key);
          return raw === null ? null : decodeStoredTurn(raw, `redis:${key}`);
        }),
      );
      return records
        .filter((record): record is StoredTurnRecord => record !== null)
        .sort((a, b) => a.turn.sequence - b.turn.sequence || a.turn.id.localeCompare(b.turn.id));
    });
  }

  async put(record: StoredTurnRecord): Promise<void> {
    const normalized = normalizeStoredTurn(
      { ...record, version: record.version ?? 1 },
      `redis:turn:${record.turn.sessionId}:${record.turn.id}`,
    );
    await withRedisBoundary(() =>
      putIfAbsent(
        this.client,
        turnKey(this.options.prefix, record.turn.sessionId, record.turn.id),
        turnIndexKey(this.options.prefix, record.turn.sessionId),
        record.turn.sequence,
        encodeStoredTurn(normalized),
        () => this.get(record.turn.sessionId, record.turn.id),
        record,
        "Turn",
      ),
    );
  }

  update(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    return withRedisBoundary(() =>
      atomicUpdate(
        this.client,
        turnKey(this.options.prefix, sessionId, id),
        `redis:turn:${sessionId}:${id}`,
        decodeStoredTurn,
        encodeStoredTurn,
        normalizeStoredTurn,
        updater,
        this.options.maxTransactionRetries,
      ),
    );
  }

  async close(): Promise<void> {
    return;
  }
}

export class RedisToolCallStore implements ToolCallStore {
  constructor(
    readonly client: RedisClient,
    readonly options: RedisStoreOptions = {},
  ) {}

  async get(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null> {
    return withRedisBoundary(async () => {
      const raw = await this.client.get(toolCallKey(this.options.prefix, sessionId, id));
      return raw === null ? null : decodeStoredToolCall(raw, `redis:tool_call:${sessionId}:${id}`);
    });
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    return withRedisBoundary(async () => {
      const keys = await this.client.zrange(toolIndexKey(this.options.prefix, sessionId), 0, -1);
      const records = await Promise.all(
        keys.map(async (key) => {
          const raw = await this.client.get(key);
          return raw === null ? null : decodeStoredToolCall(raw, `redis:${key}`);
        }),
      );
      return records
        .filter((record): record is StoredToolCallRecord => record !== null)
        .sort(
          (a, b) =>
            a.toolCall.queuedAt.localeCompare(b.toolCall.queuedAt) ||
            a.toolCall.toolCallId.localeCompare(b.toolCall.toolCallId),
        );
    });
  }

  async put(record: StoredToolCallRecord): Promise<void> {
    const normalized = normalizeStoredToolCall(
      { ...record, version: record.version ?? 1 },
      `redis:tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
    );
    await withRedisBoundary(() =>
      putIfAbsent(
        this.client,
        toolCallKey(this.options.prefix, record.toolCall.sessionId, record.toolCall.toolCallId),
        toolIndexKey(this.options.prefix, record.toolCall.sessionId),
        Date.parse(record.toolCall.queuedAt),
        encodeStoredToolCall(normalized),
        () => this.get(record.toolCall.sessionId, record.toolCall.toolCallId),
        record,
        "Tool call",
      ),
    );
  }

  update(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    return withRedisBoundary(() =>
      atomicUpdate(
        this.client,
        toolCallKey(this.options.prefix, sessionId, id),
        `redis:tool_call:${sessionId}:${id}`,
        decodeStoredToolCall,
        encodeStoredToolCall,
        normalizeStoredToolCall,
        updater,
        this.options.maxTransactionRetries,
      ),
    );
  }

  async close(): Promise<void> {
    return;
  }
}

export class RedisSessionLeaseStore implements SessionLeaseStore {
  readonly #options: RedisStoreOptions;

  constructor(
    readonly client: RedisClient,
    options: RedisStoreOptions = {},
  ) {
    this.#options = options;
  }

  async acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null> {
    return withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      const raw = await this.client.eval(
        ACQUIRE_LEASE_SCRIPT,
        [key, leaseIndexKey(this.#options.prefix)],
        [holder, String(sessionId), String(ttlMs), encodeKeyPart(String(sessionId))],
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
  ): Promise<SessionLease | null> {
    return withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      const raw = await this.client.eval(
        RENEW_LEASE_SCRIPT,
        [key, leaseIndexKey(this.#options.prefix)],
        [holder, String(fence), String(ttlMs), encodeKeyPart(String(sessionId))],
      );
      if (typeof raw !== "string" || raw.length === 0) return null;
      return parseLease(raw, key);
    });
  }

  async release(sessionId: SessionId, holder: string, fence: number): Promise<void> {
    await withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      await this.client.eval(
        RELEASE_LEASE_SCRIPT,
        [key, leaseIndexKey(this.#options.prefix)],
        [holder, String(fence), encodeKeyPart(String(sessionId))],
      );
    });
  }

  async get(sessionId: SessionId): Promise<SessionLease | null> {
    return withRedisBoundary(async () => {
      const current = await readLease(this.client, leaseKey(this.#options.prefix, sessionId));
      return current && current.expiresAtMs > (await redisNowMs(this.client)) ? current : null;
    });
  }

  async listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly sessionIds: readonly SessionId[]; readonly nextCursor?: string }> {
    return withRedisBoundary(async () => {
      const nowMs = await redisNowMs(this.client);
      const ids = (await this.client.zrangebyscore(leaseIndexKey(this.#options.prefix), 0, nowMs))
        .map((id) => decodeKeyPart(id) as SessionId)
        .sort();
      const cursorIndex = options.cursor ? ids.findIndex((id) => id === options.cursor) : -1;
      const safeStart = options.cursor ? (cursorIndex >= 0 ? cursorIndex + 1 : 0) : 0;
      const page = ids.slice(safeStart, safeStart + options.limit);
      const last = page.at(-1);
      return {
        sessionIds: page,
        ...(last && safeStart + page.length < ids.length ? { nextCursor: last } : {}),
      };
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
      ];
      let result: unknown;
      try {
        result = await this.#client.eval(PREPARE_SESSION_LEASE_SCRIPT, keys, [
          encodedSession,
          holder,
          String(record.session.id),
          String(ttlMs),
          encodeKeyPart(String(record.session.id)),
        ]);
      } catch (error) {
        await this.#releasePreparedLease(record.session.id, holder).catch(() => undefined);
        throw error;
      }
      if (Number(result) === 0 || Number(result) === -1 || typeof result !== "string") return null;
      const lease = parseLease(result, leaseKey(this.#options.prefix, record.session.id));

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
        ]);
        if (Number(finalized) !== 1) {
          await this.#releasePreparedLease(record.session.id, holder, lease.fence).catch(
            () => undefined,
          );
          return null;
        }
        return lease;
      } catch (error) {
        await this.#releasePreparedLease(record.session.id, holder, lease.fence).catch(
          () => undefined,
        );
        throw error;
      }
    });
  }

  async #releasePreparedLease(sessionId: SessionId, holder: string, fence?: number): Promise<void> {
    const lease = await this.leases.get(sessionId);
    if (lease?.holder !== holder || (fence !== undefined && lease.fence !== fence)) return;
    await this.leases.release(sessionId, holder, lease.fence);
  }

  async runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withRedisBoundary(async () => {
      const tx = new RedisSessionTransaction(
        this.sessions,
        this.turns,
        this.toolCalls,
        this.#options.prefix,
        sessionId,
      );
      const result = await operation(tx);
      const writes = tx.writes();
      const keys = [leaseKey(this.#options.prefix, sessionId), ...writes.map((write) => write.key)];
      const args = [lease.holder, String(lease.fence)];
      for (const write of writes) {
        args.push(
          write.value,
          write.indexKey,
          String(write.orderScore),
          write.expectedValue ?? "*",
        );
      }
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
        this.sessions,
        this.turns,
        this.toolCalls,
        this.#options.prefix,
        sessionId,
      );
      const result = await operation(tx);
      const writes = tx.writes();
      if (writes.length === 0) return result;
      const args: string[] = [];
      for (const write of writes) {
        args.push(
          write.value,
          write.indexKey,
          String(write.orderScore),
          write.expectedValue ?? "*",
        );
      }
      const committed = await this.#client.eval(
        UNFENCED_TRANSACTION_SCRIPT,
        writes.map((write) => write.key),
        args,
      );
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
