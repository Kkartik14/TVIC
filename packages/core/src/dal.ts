import type { Session } from "./session.js";
import type { ToolCall, ToolIdempotencyStore } from "./tool.js";
import type { Turn } from "./turn.js";
import type { SessionId, ToolCallId, TurnId } from "./ids.js";

export interface SessionLease {
  readonly sessionId: SessionId;
  readonly holder: string;
  readonly fence: number;
  readonly acquiredAtMs: number;
  readonly renewedAtMs: number;
  readonly expiresAtMs: number;
}

export interface SessionLeaseStore {
  acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null>;
  renew(
    sessionId: SessionId,
    holder: string,
    fence: number,
    ttlMs: number,
  ): Promise<SessionLease | null>;
  release(sessionId: SessionId, holder: string, fence: number): Promise<void>;
  get(sessionId: SessionId): Promise<SessionLease | null>;
  listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly sessionIds: readonly SessionId[];
    readonly nextCursor?: string;
  }>;
  close(): Promise<void>;
}

export interface DurableOutboxEvent {
  readonly id: string;
  readonly aggregateType: "session" | "turn" | "tool_call";
  readonly aggregateId: string;
  readonly sessionId: SessionId;
  readonly version: number;
  readonly fence: number;
  readonly envelope: Readonly<Record<string, unknown>>;
}

export interface SessionRuntimeMetadata {
  readonly monotonicStartedAtMs: number;
  readonly lastActivityWallAtMs?: number;
  readonly clockEpoch?: number;
  readonly clockDiscontinuityMs?: number;
}

export interface TurnRuntimeMetadata {
  readonly monotonicStartedAtMs: number;
  readonly recoveryGapMs?: number;
}

export interface ToolCallRuntimeMetadata {
  readonly monotonicQueuedAtMs: number;
}

export interface StoredSessionRecord {
  readonly session: Session;
  readonly runtime: SessionRuntimeMetadata;
  /** Persistence-local aggregate version used for outbox ordering/fencing. */
  readonly version?: number;
}

export interface StoredTurnRecord {
  readonly turn: Turn;
  readonly runtime: TurnRuntimeMetadata;
  readonly version?: number;
}

export interface StoredToolCallRecord {
  readonly toolCall: ToolCall;
  readonly runtime: ToolCallRuntimeMetadata;
  readonly version?: number;
}

export interface SessionStore {
  get(id: SessionId): Promise<StoredSessionRecord | null>;
  list(): Promise<readonly StoredSessionRecord[]>;
  put(record: StoredSessionRecord): Promise<void>;
  update(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord>;
  close(): Promise<void>;
}

export interface TurnStore {
  get(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null>;
  listBySession(sessionId: SessionId): Promise<readonly StoredTurnRecord[]>;
  put(record: StoredTurnRecord): Promise<void>;
  update(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord>;
  close(): Promise<void>;
}

export interface ToolCallStore {
  get(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null>;
  listBySession(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]>;
  put(record: StoredToolCallRecord): Promise<void>;
  update(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord>;
  close(): Promise<void>;
}

export interface DurableSessionTransaction {
  getSession(id: SessionId): Promise<StoredSessionRecord | null>;
  putSession(record: StoredSessionRecord): Promise<void>;
  updateSession(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord>;
  getTurn(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null>;
  listTurns(sessionId: SessionId): Promise<readonly StoredTurnRecord[]>;
  putTurn(record: StoredTurnRecord): Promise<void>;
  updateTurn(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord>;
  getToolCall(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null>;
  listToolCalls(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]>;
  putToolCall(record: StoredToolCallRecord): Promise<void>;
  updateToolCall(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord>;
  appendOutbox(event: DurableOutboxEvent): Promise<void>;
}

export interface DurableRuntimeStore {
  readonly sessions: SessionStore;
  readonly turns: TurnStore;
  readonly toolCalls: ToolCallStore;
  readonly leases: SessionLeaseStore;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  /**
   * Closes adapter-owned resources and background workers. When present,
   * Runtime.stop() delegates the complete durable-store shutdown to this
   * method instead of closing the aggregate stores independently. Adapters
   * that do not own background resources may omit it and retain the legacy
   * component-close behavior.
   */
  close?(): Promise<void>;
  /**
   * Atomically creates a session and acquires its first owner lease when the
   * backend supports that transaction boundary. Runtimes use the fallback
   * start-then-attach path only for adapters that do not implement it.
   */
  createSessionWithLease?(
    record: StoredSessionRecord,
    holder: string,
    ttlMs: number,
    initialEvent?: (lease: SessionLease) => DurableOutboxEvent,
  ): Promise<SessionLease | null>;
  runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T>;
  /**
   * Serialized compatibility boundary for callers that intentionally operate
   * without a live attachment. A store may provide rollback internally, but
   * the legacy CRUD interfaces cannot guarantee atomic rollback for arbitrary
   * custom stores. There is no ownership or fencing guarantee; realtime
   * attached paths must use runSessionTransaction.
   */
  runUnfencedSessionTransaction?<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T>;
}
