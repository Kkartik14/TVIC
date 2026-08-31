import {
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
  InvalidArgumentError,
  RecordConflictError,
  RecordNotFoundError,
  type DurableOutboxEvent,
  type DurableSessionTransaction,
  type SessionId,
  type StoredSessionRecord,
  type StoredToolCallRecord,
  type StoredTurnRecord,
  type ToolCallId,
  type TurnId,
} from "@tvic/core";
import {
  outboxKey,
  sessionIndexKey,
  sessionKey,
  toolCallKey,
  toolIndexKey,
  turnIndexKey,
  turnKey,
} from "./keys.js";
import type {
  RedisClient,
  RedisSessionStore,
  RedisToolCallStore,
  RedisTurnStore,
} from "./index.js";

const PUT_AND_INDEX_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], KEYS[1])
return 1
`;

export class RedisSessionTransaction implements DurableSessionTransaction {
  readonly #sessionCache = new Map<SessionId, StoredSessionRecord | null>();
  readonly #turnCache = new Map<string, StoredTurnRecord | null>();
  readonly #toolCache = new Map<string, StoredToolCallRecord | null>();
  readonly #writes = new Map<string, RedisWrite>();
  readonly #outbox = new Map<string, RedisWrite>();
  readonly #expectedValues = new Map<string, string | undefined>();

  constructor(
    readonly sessions: RedisSessionStore,
    readonly turns: RedisTurnStore,
    readonly toolCalls: RedisToolCallStore,
    readonly prefixValue: string | undefined,
    readonly sessionId: SessionId,
  ) {}

  async getSession(id: SessionId): Promise<StoredSessionRecord | null> {
    this.assertSession(id);
    if (this.#sessionCache.has(id)) return this.#sessionCache.get(id) ?? null;
    const record = await this.sessions.get(id);
    this.#sessionCache.set(id, record);
    return record;
  }

  async putSession(record: StoredSessionRecord): Promise<void> {
    this.assertSession(record.session.id);
    const cacheKnown = this.#sessionCache.has(record.session.id);
    const previous = this.#sessionCache.get(record.session.id);
    const normalized = normalizeStoredSession(
      { ...record, version: record.version ?? previous?.version ?? 1 },
      `redis:session:${record.session.id}`,
    );
    this.#sessionCache.set(record.session.id, normalized);
    const key = sessionKey(this.prefixValue, record.session.id);
    this.rememberExpected(key, cacheKnown, previous, encodeStoredSession);
    const expectedValue = this.#expectedValues.get(key);
    this.#writes.set(key, {
      key,
      value: encodeStoredSession(normalized),
      indexKey: sessionIndexKey(this.prefixValue),
      orderScore: Date.parse(record.session.createdAt),
      ...(expectedValue !== undefined ? { expectedValue } : {}),
    });
  }

  async updateSession(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    const current = await this.getSession(id);
    if (!current) throw new RecordNotFoundError(`session:${id}`);
    const next = withIncrementedVersion(current, updater(current));
    await this.putSession(next);
    return next;
  }

  async getTurn(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null> {
    this.assertSession(sessionId);
    const cacheKey = `${sessionId}:${id}`;
    if (this.#turnCache.has(cacheKey)) return this.#turnCache.get(cacheKey) ?? null;
    const record = await this.turns.get(sessionId, id);
    this.#turnCache.set(cacheKey, record);
    return record;
  }

  async listTurns(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    this.assertSession(sessionId);
    const records = new Map(
      (await this.turns.listBySession(sessionId)).map((record) => [record.turn.id, record]),
    );
    for (const [cacheKey, record] of this.#turnCache) {
      if (!cacheKey.startsWith(`${sessionId}:`)) continue;
      if (record) records.set(record.turn.id, record);
      else records.delete(cacheKey.slice(sessionId.length + 1) as TurnId);
    }
    return [...records.values()].sort(
      (a, b) => a.turn.sequence - b.turn.sequence || a.turn.id.localeCompare(b.turn.id),
    );
  }

  async putTurn(record: StoredTurnRecord): Promise<void> {
    this.assertSession(record.turn.sessionId);
    const cacheKey = `${record.turn.sessionId}:${record.turn.id}`;
    const cacheKnown = this.#turnCache.has(cacheKey);
    const previous = this.#turnCache.get(cacheKey);
    const normalized = normalizeStoredTurn(
      { ...record, version: record.version ?? previous?.version ?? 1 },
      `redis:turn:${record.turn.sessionId}:${record.turn.id}`,
    );
    this.#turnCache.set(cacheKey, normalized);
    const key = turnKey(this.prefixValue, record.turn.sessionId, record.turn.id);
    this.rememberExpected(key, cacheKnown, previous, encodeStoredTurn);
    const expectedValue = this.#expectedValues.get(key);
    this.#writes.set(key, {
      key,
      value: encodeStoredTurn(normalized),
      indexKey: turnIndexKey(this.prefixValue, record.turn.sessionId),
      orderScore: record.turn.sequence,
      ...(expectedValue !== undefined ? { expectedValue } : {}),
    });
  }

  async updateTurn(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    const current = await this.getTurn(sessionId, id);
    if (!current) throw new RecordNotFoundError(`turn:${sessionId}:${id}`);
    const next = withIncrementedVersion(current, updater(current));
    await this.putTurn(next);
    return next;
  }

  async getToolCall(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null> {
    this.assertSession(sessionId);
    const cacheKey = `${sessionId}:${id}`;
    if (this.#toolCache.has(cacheKey)) return this.#toolCache.get(cacheKey) ?? null;
    const record = await this.toolCalls.get(sessionId, id);
    this.#toolCache.set(cacheKey, record);
    return record;
  }

  async listToolCalls(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    this.assertSession(sessionId);
    const records = new Map(
      (await this.toolCalls.listBySession(sessionId)).map((record) => [
        record.toolCall.toolCallId,
        record,
      ]),
    );
    for (const [cacheKey, record] of this.#toolCache) {
      if (!cacheKey.startsWith(`${sessionId}:`)) continue;
      if (record) records.set(record.toolCall.toolCallId, record);
      else records.delete(cacheKey.slice(sessionId.length + 1) as ToolCallId);
    }
    return [...records.values()].sort(
      (a, b) =>
        Date.parse(a.toolCall.queuedAt) - Date.parse(b.toolCall.queuedAt) ||
        a.toolCall.toolCallId.localeCompare(b.toolCall.toolCallId),
    );
  }

  async putToolCall(record: StoredToolCallRecord): Promise<void> {
    this.assertSession(record.toolCall.sessionId);
    const cacheKey = `${record.toolCall.sessionId}:${record.toolCall.toolCallId}`;
    const cacheKnown = this.#toolCache.has(cacheKey);
    const previous = this.#toolCache.get(cacheKey);
    const normalized = normalizeStoredToolCall(
      { ...record, version: record.version ?? previous?.version ?? 1 },
      `redis:tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
    );
    this.#toolCache.set(cacheKey, normalized);
    const key = toolCallKey(
      this.prefixValue,
      record.toolCall.sessionId,
      record.toolCall.toolCallId,
    );
    this.rememberExpected(key, cacheKnown, previous, encodeStoredToolCall);
    const expectedValue = this.#expectedValues.get(key);
    this.#writes.set(key, {
      key,
      value: encodeStoredToolCall(normalized),
      indexKey: toolIndexKey(this.prefixValue, record.toolCall.sessionId),
      orderScore: Date.parse(record.toolCall.queuedAt),
      ...(expectedValue !== undefined ? { expectedValue } : {}),
    });
  }

  async updateToolCall(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    this.assertSession(sessionId);
    const current = await this.getToolCall(sessionId, id);
    if (!current) throw new RecordNotFoundError(`tool_call:${sessionId}:${id}`);
    const next = withIncrementedVersion(current, updater(current));
    await this.putToolCall(next);
    return next;
  }

  async appendOutbox(event: DurableOutboxEvent): Promise<void> {
    this.assertSession(event.sessionId);
    const envelope = decodeOutboxEnvelope(
      event.aggregateType,
      event.envelope,
      `outbox:${event.id}`,
      event.version,
    );
    const key = outboxKey(this.prefixValue, event.id);
    this.#outbox.set(key, {
      key,
      value: stableStringify({ ...event, envelope }),
      indexKey: "",
      orderScore: 0,
    });
  }

  writes(): readonly RedisWrite[] {
    return [...this.#writes.values(), ...this.#outbox.values()];
  }

  private assertSession(candidate: SessionId): void {
    if (candidate !== this.sessionId) {
      throw new InvalidArgumentError(
        `Session transaction ${this.sessionId} cannot access ${candidate}`,
      );
    }
  }

  private rememberExpected<T>(
    key: string,
    cacheKnown: boolean,
    previous: T | null | undefined,
    encode: (value: T) => string,
  ): void {
    if (this.#expectedValues.has(key)) return;
    this.#expectedValues.set(
      key,
      cacheKnown ? (previous ? encode(previous) : "__absent__") : undefined,
    );
  }
}

interface RedisWrite {
  readonly key: string;
  readonly value: string;
  readonly indexKey: string;
  readonly orderScore: number;
  readonly expectedValue?: string;
}

export async function putIfAbsent<T>(
  client: RedisClient,
  key: string,
  indexKey: string,
  orderScore: number,
  encoded: string,
  readExisting: () => Promise<T | null>,
  record: T,
  kind: string,
): Promise<void> {
  const result = await client.eval(
    PUT_AND_INDEX_SCRIPT,
    [key, indexKey],
    [encoded, String(orderScore)],
  );
  if (Number(result) === 1) return;
  const existing = await readExisting();
  if (!existing || !sameStoredRecord(existing, record)) {
    throw new RecordConflictError(`${kind}:${key}`);
  }
}

export async function atomicUpdate<T>(
  client: RedisClient,
  key: string,
  decodeKey: string,
  decode: (raw: string, key: string) => T,
  encode: (record: T) => string,
  normalize: (record: T, key: string) => T,
  updater: (record: T) => T,
  retries = 4,
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    await client.watch(key);
    try {
      const raw = await client.get(key);
      if (raw === null) throw new RecordNotFoundError(decodeKey);
      const current = decode(raw, decodeKey);
      const next = normalize(withIncrementedVersion(current, updater(current)), decodeKey);
      const committed = await client.multi().set(key, encode(next)).exec();
      if (committed !== null) return next;
    } finally {
      await client.unwatch().catch(() => undefined);
    }
  }
  throw new RecordConflictError(decodeKey);
}

function withIncrementedVersion<T>(current: T, next: T): T {
  if (!current || typeof current !== "object" || !next || typeof next !== "object") return next;
  const currentVersion = (current as Record<string, unknown>).version;
  return {
    ...(next as Record<string, unknown>),
    version: typeof currentVersion === "number" ? currentVersion + 1 : 2,
  } as T;
}

function sameStoredRecord(a: unknown, b: unknown): boolean {
  return stableStringify(withoutVersion(a)) === stableStringify(withoutVersion(b));
}

function withoutVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { version: _version, ...rest } = value as Record<string, unknown>;
  return rest;
}
