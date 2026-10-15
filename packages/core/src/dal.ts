import type { Session } from "./session.js";
import type { ToolCall, ToolIdempotencyStore } from "./tool.js";
import type { Turn } from "./turn.js";
import type { SessionId, ToolCallId, TurnId } from "./ids.js";
import { InvalidArgumentError } from "./dal-errors.js";

export const MAX_RECOVERY_PAGE_SIZE = 1_000;
export const MAX_SAFE_LEASE_TIMESTAMP = Number.MAX_SAFE_INTEGER;

export function assertLeaseTtlMs(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new InvalidArgumentError("Lease TTL must be a positive safe integer in milliseconds");
  }
}

export function assertLeaseFence(fence: number): void {
  if (!Number.isSafeInteger(fence) || fence < 1) {
    throw new InvalidArgumentError("Lease fence must be a positive safe integer");
  }
}

export function assertLeaseTimestampMs(timestampMs: number): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new InvalidArgumentError(
      "Lease timestamp must be a non-negative safe integer in milliseconds",
    );
  }
}

export function safeLeaseExpiryAt(nowMs: number, ttlMs: number): number {
  assertLeaseTtlMs(ttlMs);
  assertLeaseTimestampMs(nowMs);
  if (nowMs > MAX_SAFE_LEASE_TIMESTAMP - ttlMs) {
    throw new InvalidArgumentError("Lease expiry must be a non-negative safe integer timestamp");
  }
  return nowMs + ttlMs;
}

export function assertRecoveryPageSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECOVERY_PAGE_SIZE) {
    throw new RangeError(
      `Recovery page size must be an integer from 1 to ${MAX_RECOVERY_PAGE_SIZE}`,
    );
  }
}

export interface SessionLease {
  readonly sessionId: SessionId;
  readonly holder: string;
  readonly fence: number;
  readonly generationId: string;
  readonly acquiredAtMs: number;
  readonly renewedAtMs: number;
  readonly expiresAtMs: number;
}

export interface SessionRecoveryCandidate {
  readonly sessionId: SessionId;
  readonly fence: number;
  readonly generationId: string;
}

export interface SessionLeaseStore {
  acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null>;
  renew(
    sessionId: SessionId,
    holder: string,
    fence: number,
    ttlMs: number,
    generationId: string,
  ): Promise<SessionLease | null>;
  release(sessionId: SessionId, holder: string, fence: number, generationId: string): Promise<void>;
  get(sessionId: SessionId): Promise<SessionLease | null>;
  listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly candidates: readonly SessionRecoveryCandidate[];
    readonly corruptLeaseSessionIds?: readonly SessionId[];
    readonly nextCursor?: string;
  }>;
  acknowledgeRecoveryCandidate(candidate: SessionRecoveryCandidate): Promise<void>;
  close(): Promise<void>;
}

export interface DurableOutboxEvent {
  readonly id: string;
  readonly aggregateType: "session" | "turn" | "tool_call";
  readonly aggregateId: string;
  readonly sessionId: SessionId;
  readonly sessionIncarnation?: number;
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
  close?(): Promise<void>;
  createSessionWithLease?(
    record: StoredSessionRecord,
    holder: string,
    ttlMs: number,
    initialEvent?: (lease: SessionLease) => DurableOutboxEvent,
  ): Promise<SessionLease | null>;
  runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T>;
  runUnfencedSessionTransaction?<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T>;
}
