import {
  decodeStoredSession,
  decodeStoredToolCall,
  decodeStoredTurn,
  encodeStoredSession,
  encodeStoredToolCall,
  encodeStoredTurn,
  normalizeStoredSession,
  normalizeStoredToolCall,
  normalizeStoredTurn,
} from "@tvic/dal-codec";
import type {
  SessionId,
  SessionStore,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  ToolCallId,
  ToolCallStore,
  TurnId,
  TurnStore,
} from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";
import {
  sessionIndexKey,
  sessionKey,
  toolCallKey,
  toolIndexKey,
  turnIndexKey,
  turnKey,
} from "./keys.js";
import { readProjectedSessionIncarnation, withRedisBoundary } from "./redis-helpers.js";
import { atomicUpdate, putIfAbsent } from "./redis-transaction.js";

const MAX_CONCURRENT_RECORD_READS = 32;

async function readSessionProjectionIncarnation(
  client: RedisClient,
  options: RedisStoreOptions,
  sessionId: SessionId,
): Promise<number | null | undefined> {
  return readProjectedSessionIncarnation(
    client,
    `${sessionKey(options.prefix, sessionId)}:cache_meta`,
  );
}

async function belongsToProjectedSessionIncarnation(
  client: RedisClient,
  recordKey: string,
  sessionIncarnation: number | null | undefined,
): Promise<boolean> {
  if (sessionIncarnation === undefined) return true;
  if (sessionIncarnation === null) return false;
  const recordIncarnation = await readProjectedSessionIncarnation(
    client,
    `${recordKey}:cache_meta`,
  );
  return recordIncarnation === sessionIncarnation;
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workerCount = Math.min(values.length, concurrency);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!failed) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        try {
          results[index] = await map(values[index]!);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );

  if (failed) throw failure;
  return results;
}

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
      const records = await mapWithConcurrency(keys, MAX_CONCURRENT_RECORD_READS, async (key) => {
        const raw = await this.client.get(key);
        return raw === null ? null : decodeStoredSession(raw, `redis:${key}`);
      });
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
      const key = turnKey(this.options.prefix, sessionId, id);
      const raw = await this.client.get(key);
      if (raw === null) return null;
      const sessionIncarnation = await readSessionProjectionIncarnation(
        this.client,
        this.options,
        sessionId,
      );
      if (!(await belongsToProjectedSessionIncarnation(this.client, key, sessionIncarnation))) {
        return null;
      }
      return decodeStoredTurn(raw, `redis:turn:${sessionId}:${id}`);
    });
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    return withRedisBoundary(async () => {
      const sessionIncarnation = await readSessionProjectionIncarnation(
        this.client,
        this.options,
        sessionId,
      );
      const keys = await this.client.zrange(turnIndexKey(this.options.prefix, sessionId), 0, -1);
      const records = await mapWithConcurrency(keys, MAX_CONCURRENT_RECORD_READS, async (key) => {
        const raw = await this.client.get(key);
        if (
          raw === null ||
          !(await belongsToProjectedSessionIncarnation(this.client, key, sessionIncarnation))
        ) {
          return null;
        }
        return decodeStoredTurn(raw, `redis:${key}`);
      });
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
      const key = toolCallKey(this.options.prefix, sessionId, id);
      const raw = await this.client.get(key);
      if (raw === null) return null;
      const sessionIncarnation = await readSessionProjectionIncarnation(
        this.client,
        this.options,
        sessionId,
      );
      if (!(await belongsToProjectedSessionIncarnation(this.client, key, sessionIncarnation))) {
        return null;
      }
      return decodeStoredToolCall(raw, `redis:tool_call:${sessionId}:${id}`);
    });
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    return withRedisBoundary(async () => {
      const sessionIncarnation = await readSessionProjectionIncarnation(
        this.client,
        this.options,
        sessionId,
      );
      const keys = await this.client.zrange(toolIndexKey(this.options.prefix, sessionId), 0, -1);
      const records = await mapWithConcurrency(keys, MAX_CONCURRENT_RECORD_READS, async (key) => {
        const raw = await this.client.get(key);
        if (
          raw === null ||
          !(await belongsToProjectedSessionIncarnation(this.client, key, sessionIncarnation))
        ) {
          return null;
        }
        return decodeStoredToolCall(raw, `redis:${key}`);
      });
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
