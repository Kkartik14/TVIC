import type {
  Session,
  SessionRuntimeMetadata,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  ToolCall,
  ToolCallRuntimeMetadata,
  Turn,
  TurnRuntimeMetadata,
} from "@tvic/core";
import { CorruptRecordError as DurableCorruptRecordError, isNormalizedError } from "@tvic/core";

export const CURRENT_SCHEMA_VERSION = 1;

export type PersistedKind = "session" | "turn" | "tool_call" | "lease";

export interface PersistedEnvelope<T> {
  readonly kind: PersistedKind;
  readonly schemaVersion: number;
  readonly payload: T;
  readonly runtime?: Readonly<Record<string, unknown>>;
  readonly version?: number;
}

export class CorruptRecordError extends DurableCorruptRecordError {
  constructor(key: string, message: string, schemaVersion?: number) {
    super(key, message, schemaVersion);
    this.name = "CorruptRecordError";
  }
}

export function stableStringify(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>(), false);
}

/**
 * Serializes a value that will cross a JSON/JSONB adapter boundary. Unlike
 * `stableStringify`, this rejects `undefined` instead of treating it as an
 * omitted/null JSON value. It is intentionally limited to data that every
 * built-in persistence adapter can round-trip without changing its type.
 */
export function serializeJsonValue(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>(), true);
}

function stableStringifyValue(
  value: unknown,
  ancestors: WeakSet<object>,
  rejectUndefined: boolean,
): string {
  if (value === undefined) {
    if (rejectUndefined) {
      throw new TypeError("Cannot serialize undefined as a JSON value");
    }
    return "null";
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot stable-stringify a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot stable-stringify a ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Cannot stable-stringify a cyclic value");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Cannot stable-stringify a value with symbol-keyed properties");
  }
  ancestors.add(value);
  try {
    return stableStringifyObject(value, ancestors, rejectUndefined);
  } finally {
    ancestors.delete(value);
  }
}

function stableStringifyObject(
  value: object,
  ancestors: WeakSet<object>,
  rejectUndefined: boolean,
): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError("Cannot stable-stringify a non-JSON object");
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) =>
      stableStringifyValue(item, ancestors, rejectUndefined),
    ).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => rejectUndefined || item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${stableStringifyValue(item, ancestors, rejectUndefined)}`,
    )
    .join(",")}}`;
}

export function encodeEnvelope<T>(
  kind: PersistedKind,
  payload: T,
  runtime?: object,
  version?: number,
): string {
  const envelope: PersistedEnvelope<T> = {
    kind,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    payload,
    ...(runtime ? { runtime: runtime as Readonly<Record<string, unknown>> } : {}),
    ...(version !== undefined ? { version } : {}),
  };
  return stableStringify(envelope);
}

export function decodeEnvelope<T>(
  raw: string | unknown,
  expectedKind: PersistedKind,
  key: string,
  validatePayload: (value: unknown) => value is T,
): PersistedEnvelope<T> {
  let value: unknown;
  try {
    value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  } catch (error) {
    throw new CorruptRecordError(
      key,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw new CorruptRecordError(key, "envelope must be an object");
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new CorruptRecordError(
      key,
      `unsupported schema version: ${String(schemaVersion)}`,
      typeof schemaVersion === "number" ? schemaVersion : undefined,
    );
  }
  if (value.kind !== expectedKind) {
    throw new CorruptRecordError(
      key,
      `expected ${expectedKind}, received ${String(value.kind)}`,
      schemaVersion,
    );
  }
  if (
    value.version !== undefined &&
    (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1)
  ) {
    throw new CorruptRecordError(key, "version must be a positive integer", schemaVersion);
  }
  if (!validatePayload(value.payload)) {
    throw new CorruptRecordError(key, "payload failed domain validation", schemaVersion);
  }
  if (value.runtime !== undefined && !isRecord(value.runtime)) {
    throw new CorruptRecordError(key, "runtime metadata must be an object", schemaVersion);
  }
  return {
    kind: expectedKind,
    schemaVersion,
    payload: value.payload,
    ...(value.runtime ? { runtime: value.runtime } : {}),
    ...(typeof value.version === "number" ? { version: value.version } : {}),
  };
}

export function encodeStoredSession(record: StoredSessionRecord): string {
  return encodeEnvelope("session", record.session, record.runtime, record.version);
}

export function decodeStoredSession(raw: string | unknown, key: string): StoredSessionRecord {
  const envelope = decodeEnvelope(raw, "session", key, isSession);
  return {
    session: envelope.payload,
    runtime: decodeSessionRuntime(envelope.runtime, key),
    ...(envelope.version !== undefined ? { version: envelope.version } : {}),
  };
}

/** Validates a record before an adapter writes it and returns its canonical form. */
export function normalizeStoredSession(
  record: StoredSessionRecord,
  key: string,
): StoredSessionRecord {
  return decodeStoredSession(encodeStoredSession(record), key);
}

export function encodeStoredTurn(record: StoredTurnRecord): string {
  return encodeEnvelope("turn", record.turn, record.runtime, record.version);
}

export function decodeStoredTurn(raw: string | unknown, key: string): StoredTurnRecord {
  const envelope = decodeEnvelope(raw, "turn", key, isTurn);
  return {
    turn: envelope.payload,
    runtime: decodeTurnRuntime(envelope.runtime, key),
    ...(envelope.version !== undefined ? { version: envelope.version } : {}),
  };
}

/** Validates a record before an adapter writes it and returns its canonical form. */
export function normalizeStoredTurn(record: StoredTurnRecord, key: string): StoredTurnRecord {
  return decodeStoredTurn(encodeStoredTurn(record), key);
}

export function encodeStoredToolCall(record: StoredToolCallRecord): string {
  return encodeEnvelope("tool_call", record.toolCall, record.runtime, record.version);
}

export function decodeStoredToolCall(raw: string | unknown, key: string): StoredToolCallRecord {
  const envelope = decodeEnvelope(raw, "tool_call", key, isToolCall);
  return {
    toolCall: envelope.payload,
    runtime: decodeToolRuntime(envelope.runtime, key),
    ...(envelope.version !== undefined ? { version: envelope.version } : {}),
  };
}

/** Validates a record before an adapter writes it and returns its canonical form. */
export function normalizeStoredToolCall(
  record: StoredToolCallRecord,
  key: string,
): StoredToolCallRecord {
  return decodeStoredToolCall(encodeStoredToolCall(record), key);
}

export type OutboxEnvelopeInput =
  | {
      readonly kind: "session";
      readonly payload: Session;
      readonly runtime: SessionRuntimeMetadata;
      readonly version: number;
    }
  | {
      readonly kind: "turn";
      readonly payload: Turn;
      readonly runtime: TurnRuntimeMetadata;
      readonly version: number;
    }
  | {
      readonly kind: "tool_call";
      readonly payload: ToolCall;
      readonly runtime: ToolCallRuntimeMetadata;
      readonly version: number;
    };

/**
 * Builds an outbox envelope through the same encode/decode path used by the
 * durable stores. The decode step is intentional: encode alone is not a
 * validator, while the decode step enforces schema and domain invariants.
 */
export function encodeOutboxEnvelope(
  input: OutboxEnvelopeInput,
  key: string,
): Readonly<Record<string, unknown>> {
  switch (input.kind) {
    case "session": {
      const decoded = decodeStoredSession(
        encodeStoredSession({
          session: input.payload,
          runtime: input.runtime,
          version: input.version,
        }),
        key,
      );
      return normalizedOutboxEnvelope("session", decoded.session, decoded.runtime, input.version);
    }
    case "turn": {
      const decoded = decodeStoredTurn(
        encodeStoredTurn({
          turn: input.payload,
          runtime: input.runtime,
          version: input.version,
        }),
        key,
      );
      return normalizedOutboxEnvelope("turn", decoded.turn, decoded.runtime, input.version);
    }
    case "tool_call": {
      const decoded = decodeStoredToolCall(
        encodeStoredToolCall({
          toolCall: input.payload,
          runtime: input.runtime,
          version: input.version,
        }),
        key,
      );
      return normalizedOutboxEnvelope(
        "tool_call",
        decoded.toolCall,
        decoded.runtime,
        input.version,
      );
    }
  }
}

/** Validates and canonicalizes an envelope read from the outbox or cache. */
export function decodeOutboxEnvelope(
  kind: "session" | "turn" | "tool_call",
  raw: unknown,
  key: string,
  expectedVersion: number,
): Readonly<Record<string, unknown>> {
  let decoded: StoredSessionRecord | StoredTurnRecord | StoredToolCallRecord;
  switch (kind) {
    case "session":
      decoded = decodeStoredSession(raw, key);
      break;
    case "turn":
      decoded = decodeStoredTurn(raw, key);
      break;
    case "tool_call":
      decoded = decodeStoredToolCall(raw, key);
      break;
  }
  if (decoded.version !== expectedVersion) {
    throw new CorruptRecordError(
      key,
      `envelope version ${String(decoded.version)} does not match outbox version ${expectedVersion}`,
    );
  }
  if ("session" in decoded) {
    return normalizedOutboxEnvelope("session", decoded.session, decoded.runtime, expectedVersion);
  }
  if ("turn" in decoded) {
    return normalizedOutboxEnvelope("turn", decoded.turn, decoded.runtime, expectedVersion);
  }
  return normalizedOutboxEnvelope("tool_call", decoded.toolCall, decoded.runtime, expectedVersion);
}

function normalizedOutboxEnvelope(
  kind: "session" | "turn" | "tool_call",
  payload: Session | Turn | ToolCall,
  runtime: SessionRuntimeMetadata | TurnRuntimeMetadata | ToolCallRuntimeMetadata,
  version: number,
): Readonly<Record<string, unknown>> {
  return {
    kind,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    payload,
    runtime,
    version,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key] !== "";
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value) || !hasString(value, "id") || !hasString(value, "agentId")) return false;
  if (!hasString(value, "status") || !isOneOf(value.status, SESSION_STATUSES)) return false;
  if (!isOneOf(value.channel, ["phone", "web_audio", "simulated"])) return false;
  if (
    !isTimestamp(value.createdAt) ||
    !isStringArray(value.memoryRefs) ||
    (value.callId !== undefined && typeof value.callId !== "string") ||
    !isOptionalRecord(value.metadata)
  )
    return false;
  if (
    !isRecord(value.state) ||
    !isRecord(value.state.variables) ||
    typeof value.state.turnSequence !== "number" ||
    !Number.isInteger(value.state.turnSequence) ||
    value.state.turnSequence < 0 ||
    !isStringArray(value.state.pendingToolCallIds)
  )
    return false;
  if (value.state.currentTurnId !== undefined && typeof value.state.currentTurnId !== "string")
    return false;
  if (["active", "interrupted", "waiting_for_tool", "ending"].includes(value.status)) {
    return isTimestamp(value.startedAt);
  }
  if (["completed", "failed", "cancelled"].includes(value.status)) {
    return (
      isTimestamp(value.startedAt) &&
      isTimestamp(value.endedAt) &&
      (value.status !== "failed" || isNormalizedError(value.error)) &&
      (value.status !== "cancelled" || isOneOf(value.cancelReason, SESSION_CANCEL_REASONS))
    );
  }
  return true;
}

function isTurn(value: unknown): value is Turn {
  if (!isRecord(value) || !hasString(value, "id") || !hasString(value, "sessionId")) return false;
  if (
    !isOneOf(value.status, TURN_STATUSES) ||
    typeof value.sequence !== "number" ||
    !Number.isInteger(value.sequence) ||
    value.sequence < 1 ||
    !isRecord(value.input) ||
    !isRecord(value.output) ||
    !isStringArray(value.input.mediaEventIds) ||
    !isStringArray(value.output.mediaEventIds) ||
    !isStringArray(value.toolCallIds) ||
    !isRecord(value.latency) ||
    !isOptionalRecord(value.metadata) ||
    !isOptionalRecord(value.input.metadata) ||
    !isOptionalRecord(value.output.metadata) ||
    !isTimestamp(value.startedAt)
  )
    return false;
  if (
    (value.input.transcript !== undefined && typeof value.input.transcript !== "string") ||
    (value.output.text !== undefined && typeof value.output.text !== "string") ||
    !isTurnLatency(value.latency)
  )
    return false;
  if (value.status === "completed" || value.status === "cancelled" || value.status === "failed") {
    return (
      isTimestamp(value.endedAt) &&
      (value.status !== "failed" || isNormalizedError(value.error)) &&
      (value.status !== "cancelled" || isOneOf(value.reason, TURN_CANCEL_REASONS))
    );
  }
  return true;
}

function isToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value) || !hasString(value, "toolCallId") || !hasString(value, "sessionId")) {
    return false;
  }
  if (
    !isOneOf(value.status, TOOL_CALL_STATUSES) ||
    !hasString(value, "toolId") ||
    !hasString(value, "toolName") ||
    !hasString(value, "turnId") ||
    typeof value.attempts !== "number" ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 1 ||
    !isTimestamp(value.queuedAt) ||
    (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") ||
    !isOptionalRecord(value.metadata)
  )
    return false;
  if (
    value.status === "running" ||
    value.status === "succeeded" ||
    value.status === "failed" ||
    value.status === "timed_out" ||
    value.status === "cancelled"
  ) {
    if (!isTimestamp(value.startedAt)) return false;
  }
  if (value.status === "succeeded") return isTimestamp(value.endedAt) && "output" in value;
  if (value.status === "failed" || value.status === "timed_out" || value.status === "cancelled") {
    return isTimestamp(value.endedAt) && isNormalizedError(value.error);
  }
  return true;
}

const SESSION_STATUSES = [
  "created",
  "starting",
  "active",
  "interrupted",
  "waiting_for_tool",
  "ending",
  "completed",
  "failed",
  "cancelled",
] as const;
const TURN_STATUSES = [
  "started",
  "listening",
  "thinking",
  "calling_tool",
  "speaking",
  "interrupted",
  "completed",
  "cancelled",
  "failed",
] as const;
const TOOL_CALL_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
const SESSION_CANCEL_REASONS = [
  "caller_hangup",
  "transport_lost",
  "recovery_expired",
  "operator_requested",
  "shutdown",
] as const;
const TURN_CANCEL_REASONS = [
  "barge_in",
  "dtmf",
  "explicit",
  "timeout",
  "not_heard",
  "transport_lost",
  "lease_lost",
  "runtime_restarted",
] as const;

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    value === new Date(value).toISOString()
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isTurnLatency(value: Record<string, unknown>): boolean {
  const fields = [
    "listenedMs",
    "endpointMs",
    "firstTokenMs",
    "firstAudioMs",
    "toolMs",
    "interruptionTailMs",
    "totalMs",
    "recoveryGapMs",
  ];
  return fields.every(
    (field) => value[field] === undefined || (isFiniteNumber(value[field]) && value[field] >= 0),
  );
}

function decodeSessionRuntime(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): StoredSessionRecord["runtime"] {
  if (!value || !isFiniteNumber(value.monotonicStartedAtMs)) {
    throw new CorruptRecordError(key, "missing monotonicStartedAtMs");
  }
  if (
    !isOptionalFiniteNumber(value.lastActivityWallAtMs) ||
    !isOptionalFiniteNumber(value.clockEpoch) ||
    !isOptionalFiniteNumber(value.clockDiscontinuityMs)
  ) {
    throw new CorruptRecordError(key, "invalid session runtime metadata");
  }
  return {
    monotonicStartedAtMs: value.monotonicStartedAtMs,
    ...(isFiniteNumber(value.lastActivityWallAtMs)
      ? { lastActivityWallAtMs: value.lastActivityWallAtMs }
      : {}),
    ...(isFiniteNumber(value.clockEpoch) ? { clockEpoch: value.clockEpoch } : {}),
    ...(isFiniteNumber(value.clockDiscontinuityMs)
      ? { clockDiscontinuityMs: value.clockDiscontinuityMs }
      : {}),
  };
}

function decodeTurnRuntime(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): StoredTurnRecord["runtime"] {
  if (!value || !isFiniteNumber(value.monotonicStartedAtMs)) {
    throw new CorruptRecordError(key, "missing monotonicStartedAtMs");
  }
  if (!isOptionalFiniteNumber(value.recoveryGapMs)) {
    throw new CorruptRecordError(key, "invalid turn runtime metadata");
  }
  return {
    monotonicStartedAtMs: value.monotonicStartedAtMs,
    ...(isFiniteNumber(value.recoveryGapMs) ? { recoveryGapMs: value.recoveryGapMs } : {}),
  };
}

function decodeToolRuntime(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): StoredToolCallRecord["runtime"] {
  if (!value || !isFiniteNumber(value.monotonicQueuedAtMs)) {
    throw new CorruptRecordError(key, "missing monotonicQueuedAtMs");
  }
  return { monotonicQueuedAtMs: value.monotonicQueuedAtMs };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}
