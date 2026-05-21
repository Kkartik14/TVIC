import type { TraceExporter } from "./providers/trace-exporter.js";
import type { Session } from "./session.js";
import type { ToolCall } from "./tool.js";
import type { Turn } from "./turn.js";
import type { CorrelationId, SessionId, SpanId, ToolCallId, TurnId } from "./ids.js";

export interface SessionRuntimeMetadata {
  readonly monotonicStartedAtMs: number;
  readonly spanId: SpanId;
  readonly correlationId: CorrelationId;
  readonly traceExporters: readonly TraceExporter[];
}

export interface TurnRuntimeMetadata {
  readonly monotonicStartedAtMs: number;
  readonly spanId: SpanId;
  readonly correlationId: CorrelationId;
}

export interface ToolCallRuntimeMetadata {
  readonly monotonicQueuedAtMs: number;
  readonly spanId?: SpanId;
  readonly correlationId?: CorrelationId;
}

export interface StoredSessionRecord {
  readonly session: Session;
  readonly runtime: SessionRuntimeMetadata;
}

export interface StoredTurnRecord {
  readonly turn: Turn;
  readonly runtime: TurnRuntimeMetadata;
}

export interface StoredToolCallRecord {
  readonly toolCall: ToolCall;
  readonly runtime: ToolCallRuntimeMetadata;
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
