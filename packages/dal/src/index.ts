import type {
  Memory,
  MemoryEntry,
  MemoryEntryId,
  MemoryPutOptions,
  MemoryQuery,
  MemoryRef,
  MemorySearchResult,
  SessionId,
  SessionStore,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  Timestamp,
  ToolCallId,
  ToolCallStore,
  TurnId,
  TurnStore,
} from "@tvic/core";

export class InMemorySessionStore implements SessionStore {
  readonly #records = new Map<SessionId, StoredSessionRecord>();
  #closed = false;

  async get(id: SessionId): Promise<StoredSessionRecord | null> {
    this.#assertOpen();
    return this.#records.get(id) ?? null;
  }

  async list(): Promise<readonly StoredSessionRecord[]> {
    this.#assertOpen();
    return [...this.#records.values()];
  }

  async put(record: StoredSessionRecord): Promise<void> {
    this.#assertOpen();
    this.#records.set(record.session.id, record);
  }

  async update(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    this.#assertOpen();
    const current = this.#records.get(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }
    const next = updater(current);
    this.#records.set(id, next);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SessionStore is closed");
    }
  }
}

export function createInMemorySessionStore(): InMemorySessionStore {
  return new InMemorySessionStore();
}

export class InMemoryTurnStore implements TurnStore {
  readonly #records = new Map<SessionId, StoredTurnRecord[]>();
  #closed = false;

  async get(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null> {
    this.#assertOpen();
    return this.#records.get(sessionId)?.find((record) => record.turn.id === id) ?? null;
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    this.#assertOpen();
    return this.#records.get(sessionId) ?? [];
  }

  async put(record: StoredTurnRecord): Promise<void> {
    this.#assertOpen();
    const records = this.#records.get(record.turn.sessionId) ?? [];
    this.#records.set(record.turn.sessionId, [...records, record]);
  }

  async update(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    this.#assertOpen();
    const records = this.#records.get(sessionId) ?? [];
    const index = records.findIndex((record) => record.turn.id === id);
    const current = index >= 0 ? records[index] : undefined;
    if (!current) {
      throw new Error(`Turn not found: ${id}`);
    }

    const next = updater(current);
    const updated = [...records];
    updated[index] = next;
    this.#records.set(sessionId, updated);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("TurnStore is closed");
    }
  }
}

export function createInMemoryTurnStore(): InMemoryTurnStore {
  return new InMemoryTurnStore();
}

export class InMemoryToolCallStore implements ToolCallStore {
  readonly #records = new Map<SessionId, StoredToolCallRecord[]>();
  #closed = false;

  async get(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null> {
    this.#assertOpen();
    return (
      this.#records.get(sessionId)?.find((record) => record.toolCall.toolCallId === id) ?? null
    );
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    this.#assertOpen();
    return this.#records.get(sessionId) ?? [];
  }

  async put(record: StoredToolCallRecord): Promise<void> {
    this.#assertOpen();
    const records = this.#records.get(record.toolCall.sessionId) ?? [];
    this.#records.set(record.toolCall.sessionId, [...records, record]);
  }

  async update(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    this.#assertOpen();
    const records = this.#records.get(sessionId) ?? [];
    const index = records.findIndex((record) => record.toolCall.toolCallId === id);
    const current = index >= 0 ? records[index] : undefined;
    if (!current) {
      throw new Error(`Tool call not found: ${id}`);
    }

    const next = updater(current);
    const updated = [...records];
    updated[index] = next;
    this.#records.set(sessionId, updated);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("ToolCallStore is closed");
    }
  }
}

export function createInMemoryToolCallStore(): InMemoryToolCallStore {
  return new InMemoryToolCallStore();
}

interface StoredMemoryEntry {
  readonly entry: MemoryEntry<unknown>;
  readonly expiresAtMs?: number;
}

export interface InMemoryMemoryOptions {
  readonly now?: () => Date;
  readonly idPrefix?: string;
}

export class InMemoryMemory implements Memory {
  readonly #entries = new Map<string, StoredMemoryEntry>();
  readonly #now: () => Date;
  readonly #idPrefix: string;
  #nextId = 1;

  constructor(options: InMemoryMemoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "mem";
  }

  async get<T = unknown>(ref: MemoryRef, key: string): Promise<MemoryEntry<T> | null> {
    const stored = this.#getStored(ref, key);
    return stored ? (stored.entry as MemoryEntry<T>) : null;
  }

  async put<T = unknown>(
    ref: MemoryRef,
    key: string,
    value: T,
    options: MemoryPutOptions = {},
  ): Promise<MemoryEntry<T>> {
    const now = this.#now();
    const existing = this.#getStored(ref, key);
    const entry: MemoryEntry<T> = {
      id: existing?.entry.id ?? this.#nextEntryId(),
      ref,
      key,
      value,
      createdAt: existing?.entry.createdAt ?? timestamp(now),
      updatedAt: timestamp(now),
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };

    this.#entries.set(entryKey(ref, key), {
      entry: entry as MemoryEntry<unknown>,
      ...(typeof options.ttlMs === "number" ? { expiresAtMs: now.getTime() + options.ttlMs } : {}),
    });

    return entry;
  }

  async append<T = unknown>(
    ref: MemoryRef,
    key: string,
    value: T,
    options: MemoryPutOptions = {},
  ): Promise<MemoryEntry<readonly T[]>> {
    const existing = this.#getStored(ref, key);
    const existingValue = existing?.entry.value;
    const nextValue = Array.isArray(existingValue)
      ? ([...existingValue, value] as readonly T[])
      : ([value] as readonly T[]);

    return this.put(ref, key, nextValue, options);
  }

  async search<T = unknown>(ref: MemoryRef, query: MemoryQuery): Promise<MemorySearchResult<T>> {
    const prefix = `${refKey(ref)}:`;
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const limit = query.limit ?? 100;
    const queryTags = query.tags ?? [];

    const entries = [...this.#entries.entries()]
      .filter(([key, stored]) => key.startsWith(prefix) && !this.#isExpired(stored))
      .map(([, stored]) => stored.entry)
      .filter((entry) => (query.key ? entry.key === query.key : true))
      .filter((entry) => (query.prefix ? entry.key.startsWith(query.prefix) : true))
      .filter((entry) => tagsMatch(entry.tags, queryTags));

    const page = entries.slice(offset, offset + limit) as readonly MemoryEntry<T>[];
    const nextOffset = offset + page.length;
    return {
      entries: page,
      ...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async delete(ref: MemoryRef, key: string): Promise<boolean> {
    return this.#entries.delete(entryKey(ref, key));
  }

  #getStored(ref: MemoryRef, key: string): StoredMemoryEntry | null {
    const keyValue = entryKey(ref, key);
    const stored = this.#entries.get(keyValue);
    if (!stored) {
      return null;
    }

    if (this.#isExpired(stored)) {
      this.#entries.delete(keyValue);
      return null;
    }

    return stored;
  }

  #isExpired(stored: StoredMemoryEntry): boolean {
    return typeof stored.expiresAtMs === "number" && stored.expiresAtMs <= this.#now().getTime();
  }

  #nextEntryId(): MemoryEntryId {
    const id = `${this.#idPrefix}_${this.#nextId}` as MemoryEntryId;
    this.#nextId += 1;
    return id;
  }
}

export function createInMemoryMemory(options: InMemoryMemoryOptions = {}): InMemoryMemory {
  return new InMemoryMemory(options);
}

function timestamp(date: Date): Timestamp {
  return date.toISOString() as Timestamp;
}

function refKey(ref: MemoryRef): string {
  switch (ref.scope) {
    case "session":
      return `session:${ref.sessionId}`;
    case "user":
      return `user:${ref.userId}`;
    case "organization":
      return `organization:${ref.organizationId}`;
    case "workflow":
      return `workflow:${ref.workflowId}`;
  }
  const unreachable: never = ref;
  throw new Error(`Unsupported memory ref: ${String(unreachable)}`);
}

function entryKey(ref: MemoryRef, key: string): string {
  return `${refKey(ref)}:${key}`;
}

function tagsMatch(
  entryTags: readonly string[] | undefined,
  queryTags: readonly string[],
): boolean {
  if (queryTags.length === 0) {
    return true;
  }

  const tags = new Set(entryTags ?? []);
  return queryTags.every((tag) => tags.has(tag));
}
