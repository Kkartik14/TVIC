import { Buffer } from "node:buffer";

import {
  InvalidArgumentError,
  MemoryEntryTooLargeError,
  MemorySessionQuotaExceededError,
  RecordConflictError,
  type Memory,
  type MemoryCapabilities,
  type MemoryEntry,
  type MemoryEntryId,
  type MemoryKind,
  type MemoryPutOptions,
  type MemoryQuery,
  type MemoryRef,
  type Timestamp,
  type UserId,
} from "@tvic/core";
import { serializeJsonValue, stableStringify } from "@tvic/dal-codec";

interface StoredMemoryEntry {
  readonly entry: MemoryEntry<unknown>;
  readonly valueBytes: number;
  readonly expiresAtMs?: number;
  /** Internal ownership marker used by deleteForUser for session entries. */
  readonly memoryUserId?: UserId;
}

export interface InMemoryMemoryOptions {
  readonly now?: () => Date;
  readonly idPrefix?: string;
  /** Hard cap on the UTF-8 serialized memory value. Throws MemoryEntryTooLargeError. */
  readonly maxEntryBytes?: number;
}

const IN_MEMORY_MEMORY_CAPABILITIES: MemoryCapabilities = {
  search: { exact: true, vector: false, hybrid: false },
  write: { explicit: true, implicit: true, sessionQuota: true },
  retention: { ttl: true, policy: false },
  purge: { perEntry: true, perScope: true, tenant: true },
};

export class InMemoryMemory implements Memory {
  readonly name = "in-memory";
  readonly version = "0.1.0";
  readonly capabilities: MemoryCapabilities;
  readonly #entries = new Map<string, StoredMemoryEntry>();
  readonly #now: () => Date;
  readonly #idPrefix: string;
  readonly #maxEntryBytes: number | undefined;
  readonly #sessionBytes = new Map<string, number>();
  #nextId = 1;

  constructor(options: InMemoryMemoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "mem";
    if (
      options.maxEntryBytes !== undefined &&
      (!Number.isSafeInteger(options.maxEntryBytes) || options.maxEntryBytes <= 0)
    ) {
      throw new InvalidArgumentError(
        `maxEntryBytes must be a positive safe integer: ${options.maxEntryBytes}`,
      );
    }
    this.#maxEntryBytes = options.maxEntryBytes;
    this.capabilities = {
      ...IN_MEMORY_MEMORY_CAPABILITIES,
      ...(this.#maxEntryBytes !== undefined ? { maxEntryBytes: this.#maxEntryBytes } : {}),
    };
  }

  async get<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind = "raw",
  ): Promise<MemoryEntry<T> | null> {
    const stored = this.#getStored(ref, key, kind);
    return stored ? cloneMemoryEntry<T>(stored.entry) : null;
  }

  async put<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind,
    value: T,
    options: MemoryPutOptions = {},
  ): Promise<MemoryEntry<T>> {
    if (
      options.sessionUserId !== undefined &&
      (ref.scope !== "session" ||
        typeof options.sessionUserId !== "string" ||
        options.sessionUserId.trim().length === 0)
    ) {
      throw new InvalidArgumentError(
        "sessionUserId is only valid as a non-empty attribution for session-scope writes",
      );
    }
    validateSessionQuota(ref, options.maxSessionBytes);
    const now = this.#now();
    const storedRef = parseSerializedValue(serializeMemoryValue("ref", ref)) as MemoryRef;
    const serializedValue = serializeMemoryValue(key, value);
    const serializedTags =
      options.tags !== undefined ? serializeMemoryValue(`${key}:tags`, options.tags) : undefined;
    const serializedMetadata =
      options.metadata !== undefined
        ? serializeMemoryValue(`${key}:metadata`, options.metadata)
        : undefined;
    this.#enforceSize(key, serializedValue);
    const storedValue = parseSerializedValue(serializedValue) as T;
    const storedTags =
      serializedTags !== undefined ? parseMemoryTags(serializedTags, `${key}:tags`) : undefined;
    const storedMetadata =
      serializedMetadata !== undefined
        ? parseMemoryMetadata(serializedMetadata, `${key}:metadata`)
        : undefined;
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs < 0)) {
      throw new InvalidArgumentError(
        `ttlMs must be a non-negative finite number: ${options.ttlMs}`,
      );
    }
    const existing = this.#getStored(ref, key, kind);
    if (existing) {
      if (options.ifNotExists) {
        return cloneMemoryEntry<T>(existing.entry);
      }
      // Idempotent put: same (ref, key, kind) with identical serialized value
      // increments the version (touch) without throwing.
      if (!valuesEqual(existing.entry.value, storedValue)) {
        throw new RecordConflictError(`memory:${refKeyForError(ref)}:${kind}:${key}`);
      }
    }
    const valueBytes = Buffer.byteLength(serializedValue, "utf8");
    if (ref.scope === "session" && options.maxSessionBytes !== undefined) {
      const usedBytes = this.#sessionBytes.get(String(ref.sessionId)) ?? 0;
      const previousBytes = existing?.valueBytes ?? 0;
      const projectedBytes = usedBytes - previousBytes + valueBytes;
      if (projectedBytes > options.maxSessionBytes) {
        throw new MemorySessionQuotaExceededError(
          String(ref.sessionId),
          usedBytes - previousBytes,
          Math.max(0, valueBytes - previousBytes),
          options.maxSessionBytes,
        );
      }
    }
    const expiresAtMsValue =
      options.ttlMs !== undefined ? now.getTime() + options.ttlMs : existing?.entry.expiresAtMs;
    const entry: MemoryEntry<T> = {
      id: existing?.entry.id ?? this.#nextEntryId(),
      ref: storedRef,
      key,
      kind,
      value: storedValue,
      version: (existing?.entry.version ?? 0) + 1,
      createdAt: existing?.entry.createdAt ?? timestamp(now),
      updatedAt: timestamp(now),
      ...(storedTags !== undefined
        ? { tags: storedTags }
        : existing?.entry.tags
          ? { tags: existing.entry.tags }
          : {}),
      ...(storedMetadata !== undefined
        ? { metadata: storedMetadata }
        : existing?.entry.metadata
          ? { metadata: existing.entry.metadata }
          : {}),
      ...(expiresAtMsValue !== undefined ? { expiresAtMs: expiresAtMsValue } : {}),
    };

    const memoryUserId =
      ref.scope === "session" ? (options.sessionUserId ?? existing?.memoryUserId) : undefined;

    this.#entries.set(entryKey(ref, key, kind), {
      entry: entry as MemoryEntry<unknown>,
      valueBytes,
      ...(expiresAtMsValue !== undefined ? { expiresAtMs: expiresAtMsValue } : {}),
      ...(memoryUserId !== undefined ? { memoryUserId } : {}),
    });
    if (ref.scope === "session") {
      const sessionId = String(ref.sessionId);
      const usedBytes = this.#sessionBytes.get(sessionId) ?? 0;
      this.#sessionBytes.set(sessionId, usedBytes - (existing?.valueBytes ?? 0) + valueBytes);
    }

    return cloneMemoryEntry<T>(entry);
  }

  async list<T = unknown>(
    ref: MemoryRef,
    query: MemoryQuery = {},
  ): Promise<readonly MemoryEntry<T>[]> {
    const scopePrefix = `${refKey(ref)}:`;
    const offset = parseMemoryCursor(query.cursor);
    const limit = query.limit ?? 100;
    validateMemoryLimit(limit);
    const queryTags = query.tags ?? [];

    const entries = [...this.#entries.entries()]
      .filter(([key, stored]) => {
        if (!key.startsWith(scopePrefix)) return false;
        if (this.#isExpired(stored)) {
          this.#deleteStored(key, stored);
          return false;
        }
        return true;
      })
      .map(([, stored]) => cloneMemoryEntry<T>(stored.entry))
      .filter((entry) => query.key === undefined || entry.key === query.key)
      .filter((entry) => query.prefix === undefined || entry.key.startsWith(query.prefix))
      .filter((entry) => query.kind === undefined || entry.kind === query.kind)
      .filter((entry) => tagsMatch(entry.tags, queryTags))
      .sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.key.localeCompare(b.key) ||
          a.kind.localeCompare(b.kind),
      );

    return entries.slice(offset, offset + limit);
  }

  async delete(ref: MemoryRef, key: string, kind: MemoryKind = "raw"): Promise<boolean> {
    const storageKey = entryKey(ref, key, kind);
    const stored = this.#entries.get(storageKey);
    if (!stored) return false;
    this.#deleteStored(storageKey, stored);
    return true;
  }

  async deleteAll(ref: MemoryRef): Promise<number> {
    return this.#deleteAll(ref);
  }

  #deleteAll(ref: MemoryRef): number {
    const prefix = `${refKey(ref)}:`;
    let deleted = 0;
    for (const [key, stored] of this.#entries) {
      if (key.startsWith(prefix)) {
        this.#deleteStored(key, stored);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteForUser(userId: UserId): Promise<number> {
    // A user deletion is deliberately limited to user-owned data. Membership
    // in an organization/workflow does not make the user the owner of the
    // shared scope, so those scopes must be deleted explicitly by an
    // application authorization decision via deleteAll(ref).
    let deleted = 0;
    // Keep the user-scope and attributed-session deletions in one synchronous
    // section. An await here would let a same-process put run between the two
    // scans and survive the cascade.
    deleted += this.#deleteAll({ scope: "user", userId });
    // Session-scope cascade: scan all session-scope entries and drop the
    // ones explicitly attributed to the deleted user. O(n) but
    // `deleteForUser` is rare; session-end cleanup uses deleteAll directly.
    for (const [storageKey, stored] of this.#entries) {
      if (stored.entry.ref.scope !== "session") continue;
      if (stored.memoryUserId !== userId) continue;
      this.#deleteStored(storageKey, stored);
      deleted += 1;
    }
    return deleted;
  }

  #enforceSize(key: string, serializedValue: string): void {
    if (this.#maxEntryBytes === undefined) return;
    const size = Buffer.byteLength(serializedValue, "utf8");
    if (size > this.#maxEntryBytes) {
      throw new MemoryEntryTooLargeError(key, size, this.#maxEntryBytes);
    }
  }

  #getStored(ref: MemoryRef, key: string, kind: MemoryKind): StoredMemoryEntry | null {
    const keyValue = entryKey(ref, key, kind);
    const stored = this.#entries.get(keyValue);
    if (!stored) return null;
    if (this.#isExpired(stored)) {
      this.#deleteStored(keyValue, stored);
      return null;
    }
    return stored;
  }

  #isExpired(stored: StoredMemoryEntry): boolean {
    return typeof stored.expiresAtMs === "number" && stored.expiresAtMs <= this.#now().getTime();
  }

  #deleteStored(storageKey: string, stored: StoredMemoryEntry): void {
    if (!this.#entries.delete(storageKey)) return;
    if (stored.entry.ref.scope !== "session") return;
    const sessionId = String(stored.entry.ref.sessionId);
    const remaining = (this.#sessionBytes.get(sessionId) ?? 0) - stored.valueBytes;
    if (remaining > 0) this.#sessionBytes.set(sessionId, remaining);
    else this.#sessionBytes.delete(sessionId);
  }

  #nextEntryId(): MemoryEntryId {
    const id = `${this.#idPrefix}_${this.#nextId}` as MemoryEntryId;
    this.#nextId += 1;
    return id;
  }
}

function serializeMemoryValue(key: string, value: unknown): string {
  try {
    return serializeJsonValue(value);
  } catch (error) {
    throw new InvalidArgumentError(
      `Memory value ${key} must be a finite, acyclic JSON-compatible value: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function parseSerializedValue(serialized: string): unknown {
  return JSON.parse(serialized);
}

function parseMemoryTags(serialized: string, key: string): readonly string[] {
  const value = parseSerializedValue(serialized);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new InvalidArgumentError(`Memory tags ${key} must be an array of strings`);
  }
  return value as readonly string[];
}

function parseMemoryMetadata(serialized: string, key: string): Readonly<Record<string, unknown>> {
  const value = parseSerializedValue(serialized);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError(`Memory metadata ${key} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function cloneMemoryEntry<T>(entry: MemoryEntry<unknown>): MemoryEntry<T> {
  return parseSerializedValue(serializeJsonValue(entry)) as MemoryEntry<T>;
}

function parseMemoryCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new InvalidArgumentError(
      `Memory cursor must be a non-negative decimal offset: ${cursor}`,
    );
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new InvalidArgumentError(`Memory cursor exceeds the safe integer range: ${cursor}`);
  }
  return offset;
}

function validateMemoryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new InvalidArgumentError(`Memory limit must be a positive safe integer: ${limit}`);
  }
}

function validateSessionQuota(ref: MemoryRef, maxSessionBytes: number | undefined): void {
  if (maxSessionBytes === undefined) return;
  if (ref.scope !== "session") {
    throw new InvalidArgumentError("maxSessionBytes is only valid for session-scope writes");
  }
  if (!Number.isSafeInteger(maxSessionBytes) || maxSessionBytes < 0) {
    throw new InvalidArgumentError(
      `maxSessionBytes must be a non-negative safe integer: ${maxSessionBytes}`,
    );
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
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
      return `session:${encodeKeyPart(ref.sessionId)}`;
    case "user":
      return `user:${encodeKeyPart(ref.userId)}`;
    case "organization":
      return `organization:${encodeKeyPart(ref.organizationId)}`;
    case "workflow":
      return `workflow:${encodeKeyPart(ref.workflowId)}`;
  }
  const unreachable: never = ref;
  throw new Error(`Unsupported memory ref: ${String(unreachable)}`);
}

function entryKey(ref: MemoryRef, key: string, kind: MemoryKind): string {
  return `${refKey(ref)}:${encodeKeyPart(kind)}:${encodeKeyPart(key)}`;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function refKeyForError(ref: MemoryRef): string {
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

function tagsMatch(
  entryTags: readonly string[] | undefined,
  queryTags: readonly string[],
): boolean {
  if (queryTags.length === 0) return true;
  const tags = new Set(entryTags ?? []);
  return queryTags.every((tag) => tags.has(tag));
}
