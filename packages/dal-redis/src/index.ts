import { randomUUID } from "node:crypto";
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
import type { PersistedErrorCompatibilityDiagnostic } from "@tvic/dal-codec";
import {
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
  encodeKeyPart,
  leaseIndexKey,
  leaseKey,
  leaseRecoveryCandidatesKey,
  outboxKey,
  prefix,
  sessionIndexKey,
  sessionKey,
  toolCallKey,
  toolIndexKey,
  turnIndexKey,
  turnKey,
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
import { atomicUpdate, putIfAbsent, RedisSessionTransaction } from "./redis-transaction.js";

export { RedisToolIdempotencyStore } from "./redis-idempotency.js";

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

const FENCED_TRANSACTION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local generationId = lease.generationId
if generationId == nil then
  generationId = 'legacy:' .. tostring(tonumber(lease.fence)) .. ':' .. tostring(tonumber(lease.acquiredAtMs))
end
if lease.holder ~= ARGV[1] or tonumber(lease.fence) ~= tonumber(ARGV[2]) or generationId ~= ARGV[3] or tonumber(lease.expiresAtMs) <= now then return 0 end
local arg = 4
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
arg = 4
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
    return withRedisBoundary(async () => {
      const key = leaseKey(this.#options.prefix, sessionId);
      const raw = await this.client.eval(
        RENEW_LEASE_SCRIPT,
        [
          key,
          leaseIndexKey(this.#options.prefix),
          leaseRecoveryCandidatesKey(this.#options.prefix),
        ],
        [holder, String(fence), String(ttlMs), encodeKeyPart(String(sessionId)), generationId],
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
      const current = await readLease(this.client, leaseKey(this.#options.prefix, sessionId));
      return current && current.expiresAtMs > (await redisNowMs(this.client)) ? current : null;
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
        !Array.isArray(raw[2])
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
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  async acknowledgeRecoveryCandidate(candidate: SessionRecoveryCandidate): Promise<void> {
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
          lease.generationId,
        ]);
        if (Number(finalized) !== 1) {
          await this.#releasePreparedLease(record.session.id, holder, lease.generationId).catch(
            () => undefined,
          );
          return null;
        }
        return lease;
      } catch (error) {
        await this.#releasePreparedLease(record.session.id, holder, lease.generationId).catch(
          () => undefined,
        );
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
      const args = [lease.holder, String(lease.fence), lease.generationId];
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
