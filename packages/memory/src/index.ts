import type {
  Memory,
  MemoryEntry,
  MemoryEntryId,
  MemoryPutOptions,
  MemoryQuery,
  MemoryRef,
  MemorySearchResult,
  Timestamp,
} from "@tvic/core";

interface StoredMemoryEntry {
  readonly entry: MemoryEntry<unknown>;
  readonly expiresAtMs?: number;
}

export interface InMemoryMemoryOptions {
  readonly now?: () => Date;
  readonly idPrefix?: string;
}

function timestamp(date: Date): Timestamp {
  return date.toISOString() as Timestamp;
}

function memoryEntryId(value: string): MemoryEntryId {
  return value as MemoryEntryId;
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
}

function entryKey(ref: MemoryRef, key: string): string {
  return `${refKey(ref)}:${key}`;
}

function tagsMatch(entryTags: readonly string[] | undefined, queryTags: readonly string[]): boolean {
  if (queryTags.length === 0) {
    return true;
  }

  const tags = new Set(entryTags ?? []);
  return queryTags.every((tag) => tags.has(tag));
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

  async search<T = unknown>(
    ref: MemoryRef,
    query: MemoryQuery,
  ): Promise<MemorySearchResult<T>> {
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
    const id = memoryEntryId(`${this.#idPrefix}_${this.#nextId}`);
    this.#nextId += 1;
    return id;
  }
}

export function createInMemoryMemory(options: InMemoryMemoryOptions = {}): InMemoryMemory {
  return new InMemoryMemory(options);
}

export type {
  Memory,
  MemoryEntry,
  MemoryPutOptions,
  MemoryQuery,
  MemoryRef,
  MemorySearchResult,
};
