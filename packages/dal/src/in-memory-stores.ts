import { RecordConflictError, RecordNotFoundError } from "@tvic/core";
import {
  normalizeStoredSession,
  normalizeStoredToolCall,
  normalizeStoredTurn,
  stableStringify,
} from "@tvic/dal-codec";
import type {
  SessionId,
  SessionLease,
  SessionLeaseStore,
  SessionStore,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  ToolCallId,
  ToolCallStore,
  TurnId,
  TurnStore,
} from "@tvic/core";

export function sameRecord(a: unknown, b: unknown): boolean {
  return stableStringify(withoutVersion(a)) === stableStringify(withoutVersion(b));
}

function withoutVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { version: _version, ...rest } = value as Record<string, unknown>;
  return rest;
}

function conflict(kind: string, id: string): Error {
  return new RecordConflictError(`${kind}:${id}`);
}

function validateSessionRecord(record: StoredSessionRecord, key: string): StoredSessionRecord {
  return normalizeStoredSession(record, key);
}

function validateTurnRecord(record: StoredTurnRecord, key: string): StoredTurnRecord {
  return normalizeStoredTurn(record, key);
}

function validateToolCallRecord(record: StoredToolCallRecord, key: string): StoredToolCallRecord {
  return normalizeStoredToolCall(record, key);
}

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
    const existing = this.#records.get(record.session.id);
    if (existing && !sameRecord(existing, record)) {
      throw conflict("Session", record.session.id);
    }
    this.#records.set(
      record.session.id,
      validateSessionRecord(
        { ...record, version: existing?.version ?? record.version ?? 1 },
        `session:${record.session.id}`,
      ),
    );
  }

  async update(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    this.#assertOpen();
    const current = this.#records.get(id);
    if (!current) {
      throw new RecordNotFoundError(`session:${id}`);
    }
    const next = updater(current);
    const versioned = validateSessionRecord(
      { ...next, version: (current.version ?? 1) + 1 },
      `session:${id}`,
    );
    this.#records.set(id, versioned);
    return versioned;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Internal aggregate-transaction rollback hook. */
  restore(id: SessionId, record: StoredSessionRecord | null): void {
    if (record) this.#records.set(id, record);
    else this.#records.delete(id);
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
    return [...(this.#records.get(sessionId) ?? [])];
  }

  async put(record: StoredTurnRecord): Promise<void> {
    this.#assertOpen();
    const records = this.#records.get(record.turn.sessionId) ?? [];
    const existing = records.find((item) => item.turn.id === record.turn.id);
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw conflict("Turn", record.turn.id);
      }
      return;
    }
    this.#records.set(record.turn.sessionId, [
      ...records,
      validateTurnRecord({ ...record, version: record.version ?? 1 }, `turn:${record.turn.id}`),
    ]);
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
      throw new RecordNotFoundError(`turn:${sessionId}:${id}`);
    }

    const next = updater(current);
    const updated = [...records];
    const versioned = validateTurnRecord(
      { ...next, version: (current.version ?? 1) + 1 },
      `turn:${sessionId}:${id}`,
    );
    updated[index] = versioned;
    this.#records.set(sessionId, updated);
    return versioned;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Internal aggregate-transaction rollback hook. */
  restore(sessionId: SessionId, records: readonly StoredTurnRecord[]): void {
    if (records.length > 0) this.#records.set(sessionId, [...records]);
    else this.#records.delete(sessionId);
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
    return [...(this.#records.get(sessionId) ?? [])];
  }

  async put(record: StoredToolCallRecord): Promise<void> {
    this.#assertOpen();
    const records = this.#records.get(record.toolCall.sessionId) ?? [];
    const existing = records.find(
      (item) => item.toolCall.toolCallId === record.toolCall.toolCallId,
    );
    if (existing) {
      if (!sameRecord(existing, record)) {
        throw conflict("Tool call", record.toolCall.toolCallId);
      }
      return;
    }
    this.#records.set(record.toolCall.sessionId, [
      ...records,
      validateToolCallRecord(
        { ...record, version: record.version ?? 1 },
        `tool_call:${record.toolCall.toolCallId}`,
      ),
    ]);
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
      throw new RecordNotFoundError(`tool_call:${sessionId}:${id}`);
    }

    const next = updater(current);
    const updated = [...records];
    const versioned = validateToolCallRecord(
      { ...next, version: (current.version ?? 1) + 1 },
      `tool_call:${sessionId}:${id}`,
    );
    updated[index] = versioned;
    this.#records.set(sessionId, updated);
    return versioned;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Internal aggregate-transaction rollback hook. */
  restore(sessionId: SessionId, records: readonly StoredToolCallRecord[]): void {
    if (records.length > 0) this.#records.set(sessionId, [...records]);
    else this.#records.delete(sessionId);
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

export class InMemorySessionLeaseStore implements SessionLeaseStore {
  readonly #leases = new Map<SessionId, SessionLease>();
  readonly #now: () => number;
  #closed = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null> {
    this.#assertOpen();
    const now = this.#now();
    const current = this.#leases.get(sessionId);
    if (current && current.expiresAtMs > now) {
      return current.holder === holder ? current : null;
    }
    const lease: SessionLease = {
      sessionId,
      holder,
      fence: (current?.fence ?? 0) + 1,
      acquiredAtMs: now,
      renewedAtMs: now,
      expiresAtMs: now + ttlMs,
    };
    this.#leases.set(sessionId, lease);
    return lease;
  }

  async renew(
    sessionId: SessionId,
    holder: string,
    fence: number,
    ttlMs: number,
  ): Promise<SessionLease | null> {
    this.#assertOpen();
    const now = this.#now();
    const current = this.#leases.get(sessionId);
    if (
      !current ||
      current.holder !== holder ||
      current.fence !== fence ||
      current.expiresAtMs <= now
    ) {
      return null;
    }
    const renewed = { ...current, renewedAtMs: now, expiresAtMs: now + ttlMs };
    this.#leases.set(sessionId, renewed);
    return renewed;
  }

  async release(sessionId: SessionId, holder: string, fence: number): Promise<void> {
    this.#assertOpen();
    const current = this.#leases.get(sessionId);
    if (current?.holder === holder && current.fence === fence) {
      // Preserve the fence across release. A later owner must receive a
      // strictly higher fence; deleting the row would reset ownership to 1.
      this.#leases.set(sessionId, { ...current, expiresAtMs: this.#now() });
    }
  }

  async get(sessionId: SessionId): Promise<SessionLease | null> {
    this.#assertOpen();
    const current = this.#leases.get(sessionId);
    return current && current.expiresAtMs > this.#now() ? current : null;
  }

  async listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly sessionIds: readonly SessionId[]; readonly nextCursor?: string }> {
    this.#assertOpen();
    const ids = [...this.#leases.values()]
      .filter((lease) => lease.expiresAtMs <= options.nowMs)
      .map((lease) => lease.sessionId)
      .sort();
    const cursorIndex = options.cursor ? ids.findIndex((id) => id === options.cursor) : -1;
    const start = options.cursor ? (cursorIndex >= 0 ? cursorIndex + 1 : 0) : 0;
    const page = ids.slice(start, start + options.limit);
    const last = page.at(-1);
    return {
      sessionIds: page,
      ...(last && start + page.length < ids.length ? { nextCursor: last } : {}),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#leases.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SessionLeaseStore is closed");
  }
}
