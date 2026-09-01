import {
  decodeStoredSession,
  decodeStoredToolCall,
  decodeStoredTurn,
  normalizeStoredSession,
  normalizeStoredToolCall,
  normalizeStoredTurn,
  stableStringify,
} from "@tvic/dal-codec";
import { CorruptRecordError } from "@tvic/core";
import type {
  SessionId,
  SessionLease,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
} from "@tvic/core";

export interface SessionRow extends Record<string, unknown> {
  readonly id: string;
  readonly payload: unknown;
  readonly runtime: unknown;
  readonly version: number | string;
}

export interface TurnRow extends Record<string, unknown> {
  readonly id: string;
  readonly session_id: string;
  readonly payload: unknown;
  readonly runtime: unknown;
  readonly version: number | string;
}

export interface ToolCallRow extends Record<string, unknown> {
  readonly id: string;
  readonly session_id: string;
  readonly payload: unknown;
  readonly runtime: unknown;
  readonly version: number | string;
}

export interface LeaseRow extends Record<string, unknown> {
  readonly session_id: string;
  readonly holder: string;
  readonly fence: number | string;
  readonly acquired_at_ms: number | string;
  readonly renewed_at_ms: number | string;
  readonly expires_at_ms: number | string;
}

export function sessionValues(record: StoredSessionRecord): readonly unknown[] {
  const normalized = normalizeStoredSession(
    { ...record, version: record.version ?? 1 },
    `postgres:session:${record.session.id}`,
  );
  const session = normalized.session;
  const startedAt = "startedAt" in session ? session.startedAt : null;
  const endedAt = "endedAt" in session ? session.endedAt : null;
  return [
    session.id,
    session.agentId,
    session.status,
    session.createdAt,
    startedAt,
    endedAt,
    JSON.stringify(session),
    JSON.stringify(normalized.runtime),
    normalized.version ?? 1,
  ];
}

export function turnValues(record: StoredTurnRecord): readonly unknown[] {
  const normalized = normalizeStoredTurn(
    { ...record, version: record.version ?? 1 },
    `postgres:turn:${record.turn.sessionId}:${record.turn.id}`,
  );
  const turn = normalized.turn;
  const endedAt = "endedAt" in turn ? turn.endedAt : null;
  return [
    turn.sessionId,
    turn.id,
    turn.sequence,
    turn.status,
    turn.startedAt,
    endedAt,
    JSON.stringify(turn),
    JSON.stringify(normalized.runtime),
    normalized.version ?? 1,
  ];
}

export function toolCallValues(record: StoredToolCallRecord): readonly unknown[] {
  const normalized = normalizeStoredToolCall(
    { ...record, version: record.version ?? 1 },
    `postgres:tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
  );
  const toolCall = normalized.toolCall;
  const startedAt = "startedAt" in toolCall ? toolCall.startedAt : null;
  const endedAt = "endedAt" in toolCall ? toolCall.endedAt : null;
  return [
    toolCall.sessionId,
    toolCall.toolCallId,
    toolCall.turnId,
    toolCall.status,
    toolCall.queuedAt,
    startedAt,
    endedAt,
    JSON.stringify(toolCall),
    JSON.stringify(normalized.runtime),
    normalized.version ?? 1,
  ];
}

export function decodeSessionRow(row: SessionRow): StoredSessionRecord {
  return {
    ...decodeStoredSession(
      {
        kind: "session",
        schemaVersion: 1,
        payload: row.payload,
        runtime: row.runtime,
      },
      `postgres:session:${row.id}`,
    ),
    version: persistedVersion(row.version, `postgres:session:${row.id}`),
  };
}

export function decodeTurnRow(row: TurnRow): StoredTurnRecord {
  return {
    ...decodeStoredTurn(
      {
        kind: "turn",
        schemaVersion: 1,
        payload: row.payload,
        runtime: row.runtime,
      },
      `postgres:turn:${row.session_id}:${row.id}`,
    ),
    version: persistedVersion(row.version, `postgres:turn:${row.session_id}:${row.id}`),
  };
}

export function decodeToolRow(row: ToolCallRow): StoredToolCallRecord {
  return {
    ...decodeStoredToolCall(
      {
        kind: "tool_call",
        schemaVersion: 1,
        payload: row.payload,
        runtime: row.runtime,
      },
      `postgres:tool_call:${row.session_id}:${row.id}`,
    ),
    version: persistedVersion(row.version, `postgres:tool_call:${row.session_id}:${row.id}`),
  };
}

export function sameStoredRecord(a: unknown, b: unknown): boolean {
  return stableStringify(withoutVersion(a)) === stableStringify(withoutVersion(b));
}

export function leaseFromRow(row: LeaseRow): SessionLease {
  const key = `postgres:lease:${row.session_id}`;
  return {
    sessionId: row.session_id as SessionId,
    holder: row.holder,
    fence: persistedPositiveInteger(row.fence, key, "fence"),
    acquiredAtMs: persistedFiniteNumber(row.acquired_at_ms, key, "acquired_at_ms"),
    renewedAtMs: persistedFiniteNumber(row.renewed_at_ms, key, "renewed_at_ms"),
    expiresAtMs: persistedFiniteNumber(row.expires_at_ms, key, "expires_at_ms"),
  };
}

function withoutVersion(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { version: _version, ...rest } = value as Record<string, unknown>;
  return rest;
}

function persistedVersion(value: number | string, key: string): number {
  return persistedPositiveInteger(value, key, "version");
}

function persistedPositiveInteger(value: number | string, key: string, field: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new CorruptRecordError(key, `${field} must be a positive integer`);
  }
  return numeric;
}

function persistedFiniteNumber(value: number | string, key: string, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new CorruptRecordError(key, `${field} must be finite`);
  }
  return numeric;
}
