import type { DurableError, NormalizedError } from "@tvic/core";
import {
  BackendUnavailableError,
  CorruptRecordError as DurableCorruptRecordError,
  InvalidArgumentError,
  isNormalizedError,
  isTvicErrorName,
  TVIC_ERROR_CODE_ALIASES,
  LeaseLostError,
  LeaseUnavailableError,
  MemoryBackendUnavailableError,
  MemoryEntryTooLargeError,
  MemorySessionQuotaExceededError,
  normalizeLegacyError,
  RecordConflictError,
  RecordNotFoundError,
} from "@tvic/core";
import type { PersistedKind } from "./index.js";

export class CorruptRecordError extends DurableCorruptRecordError {
  constructor(key: string, message: string, schemaVersion?: number) {
    super(key, message, schemaVersion);
    this.name = "CorruptRecordError";
  }
}

const PERSISTED_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const MAX_PERSISTED_ERROR_CODE_BYTES = 128;
const MAX_PERSISTED_METADATA_DEPTH = 6;
const MAX_PERSISTED_METADATA_NODES = 100;
const MAX_PERSISTED_METADATA_STRING_LENGTH = 256;

/**
 * The code list is generated from the 1.1.0 inventory. It is deliberately
 * local to the persistence boundary: a code that appears in a database is
 * not automatically allowed to control retry behavior just because it has a
 * valid shape.
 */
const KNOWN_PERSISTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "agent.invalid_context_policy",
  "agent.invalid_memory_policy",
  "agent.provider_incompatible",
  "agent.reserved_tool_name",
  "assemblyai.stt.begin_cancelled",
  "assemblyai.stt.begin_timeout",
  "assemblyai.stt.error",
  "audio.normalization.channel_policy_invalid",
  "audio.normalization.channels_unsupported",
  "audio.normalization.finished",
  "audio.normalization.float_non_finite",
  "audio.normalization.incomplete_frame",
  "audio.normalization.input_encoding_unsupported",
  "audio.normalization.sample_rate_unsupported",
  "audio.normalization.target_unsupported",
  "call.cancelled",
  "cartesia.audio_format_invalid",
  "cartesia.tts.error",
  "deepgram.stt.error",
  "elevenlabs.stt.error",
  "elevenlabs.tts.error",
  "llm.context_limit",
  "llm.invalid_context_policy",
  "llm.provider.failed",
  "llm.provider.unexpected_eof",
  "llm.stalled",
  "media.audio_format_invalid",
  "media.input_failed",
  "memory.adapter_mismatch",
  "memory.capability_unsupported",
  "memory.invalid_input",
  "memory.invalid_key",
  "memory.invalid_kind",
  "memory.invalid_scope",
  "memory.invalid_value",
  "memory.no_organization_scope",
  "memory.no_user_scope",
  "memory.no_workflow_scope",
  "memory.scope_not_allowed",
  "memory.session_ended",
  "memory.session_purge_failed",
  "openai.http_error",
  "openai.response.failed",
  "openai.responses.error",
  "provider.auth_failed",
  "provider.connection_cancelled",
  "provider.connection_timeout",
  "provider.identity_mismatch",
  "provider.input_rejected",
  "provider.invalid_request",
  "provider.kind_mismatch",
  "provider.model_unsupported",
  "provider.protocol_invalid",
  "provider.rate_limited",
  "provider.sequence_invalid",
  "provider.session_expired",
  "provider.stream_buffer_overflow",
  "provider.upstream_failed",
  "provider.voice_unsupported",
  "runtime.session_start_timed_out",
  "sarvam.stt.error",
  "soniox.stt.begin_cancelled",
  "soniox.stt.error",
  "stt.audio_format_invalid",
  "stt.audio_format_mismatch",
  "stt.audio_incomplete_frame",
  "stt.audio_odd_byte_length",
  "stt.audio_offset_invalid",
  "stt.audio_session_mismatch",
  "stt.closed_unexpectedly",
  "stt.command_failed",
  "stt.commit_failed",
  "stt.commit_in_flight",
  "stt.commit_timeout",
  "stt.failed",
  "stt.model_unsupported",
  "stt.normalization_disabled_format_mismatch",
  "stt.open_cancelled",
  "stt.open_failed",
  "stt.open_timeout",
  "stt.open_timeout_invalid",
  "stt.provider.auth_failed",
  "stt.provider.input_rejected",
  "stt.provider.internal",
  "stt.provider.invalid_request",
  "stt.provider.protocol_error",
  "stt.provider.quota_exceeded",
  "stt.provider.rate_limited",
  "stt.provider.service_unavailable",
  "stt.provider.session_expired",
  "stt.provider_incompatible",
  "stt.reconnect.buffer_overflow",
  "stt.reconnect.closed",
  "stt.reconnect.conflicting_policy",
  "stt.reconnect.options_invalid",
  "stt.reconnect.recovery_exhausted",
  "stt.reconnect.timestamp_origin_changed",
  "stt.reconnect.timestamp_origin_unsupported",
  "stt.sample_rate_mismatch",
  "stt.sample_rate_unsupported",
  "stt.session_buffer_overflow",
  "stt.session_closed",
  "stt.soniox.endpoint_latency_adjustment_invalid",
  "stt.soniox.endpoint_sensitivity_invalid",
  "stt.soniox.max_endpoint_delay_invalid",
  "stt.stream_ended",
  "stt.transport.connect_failed",
  "stt.transport.connect_timeout",
  "stt.transport.unexpected_eof",
  "stt.transport.write_failed",
  "stt.vocabulary_invalid",
  "tool.cancelled",
  "tool.duplicate",
  "tool.execution_failed",
  "tool.failed",
  "tool.idempotency_conflict",
  "tool.idempotency_in_progress",
  "tool.input_not_serializable",
  "tool.input_validation_failed",
  "tool.invalid_terminal_state",
  "tool.not_found",
  "tool.output_validation_failed",
  "tool.record_timed_out",
  "tool.runtime_restarted",
  "tool.session_ended",
  "tool.start_timed_out",
  "tool.timeout",
  "tts.delivery_failed",
  "tts.empty_chunk",
  "tts.flush_out_of_order",
  "tts.stalled",
  "tts.transport.unexpected_eof",
  "turn.failed",
  "turn.persistence_failed",
  "twilio.audio_format_invalid",
  "twilio.media_stream.buffer_overflow",
  "twilio.media_stream.error",
  "twilio.outbound_dial_unsupported",
  "twilio.stream_sid_missing",
  "twilio.stream_socket_missing",
  "unknown.error",
  "voice_runtime.invalid_config",
  "voice_runtime.run_failed",
  "voice_runtime.start_cancelled",
  "voice_runtime.turn_failed",
  "web_client_audio.dial_unsupported",
  "web_client_audio.error",
  "web_client_audio.output_format_invalid",
  "web_client_audio.socket_missing",
]);

const PERSISTED_RETRY_POLICY: ReadonlySet<string> = new Set([
  "assemblyai.stt.begin_timeout",
  "llm.stalled",
  "provider.connection_timeout",
  "provider.upstream_failed",
  "runtime.session_start_timed_out",
  "stt.commit_timeout",
  "stt.open_timeout",
  "stt.stream_ended",
  "stt.transport.connect_failed",
  "stt.transport.connect_timeout",
  "stt.transport.unexpected_eof",
  "stt.transport.write_failed",
  "tool.record_timed_out",
  "tool.start_timed_out",
  "tts.stalled",
  "twilio.media_stream.buffer_overflow",
  "twilio.outbound_dial_unsupported",
  "twilio.stream_sid_missing",
  "twilio.stream_socket_missing",
  "web_client_audio.dial_unsupported",
  "web_client_audio.socket_missing",
]);

const PERSISTED_ERROR_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(TVIC_ERROR_CODE_ALIASES),
);

const PERSISTED_ERROR_CATEGORIES: Readonly<Record<string, string>> = {
  AuthError: "auth",
  RateLimitError: "rate_limit",
  InvalidRequestError: "validation",
  ConnectionError: "network",
  ProviderError: "provider",
  SignatureError: "auth",
  ValidationError: "validation",
  TimeoutError: "timeout",
  InternalError: "internal",
  MediaError: "media",
  ToolError: "tool",
  CancelledError: "cancelled",
  InterruptedError: "interrupted",
  UnknownError: "internal",
};

const PERSISTED_ERROR_NAME_BY_CATEGORY: Readonly<Record<string, string>> = {
  validation: "ValidationError",
  auth: "AuthError",
  provider: "ProviderError",
  network: "ConnectionError",
  timeout: "TimeoutError",
  rate_limit: "RateLimitError",
  cancelled: "CancelledError",
  interrupted: "InterruptedError",
  tool: "ToolError",
  media: "MediaError",
  internal: "InternalError",
};

export interface PersistedErrorRead {
  readonly error: NormalizedError;
  readonly knownCode: boolean;
  readonly migratedAlias: boolean;
}

export interface PersistedErrorCompatibilityDiagnostic {
  readonly adapter: "postgres" | "redis";
  readonly operation: "idempotency_alias_rewrite";
  readonly key: string;
  readonly legacyCode: string;
  readonly canonicalCode: string;
  readonly outcome: "rewrite_failed";
}

export interface PersistedErrorRewriteOptions {
  readonly adapter: PersistedErrorCompatibilityDiagnostic["adapter"];
  readonly key: string;
  readonly read: PersistedErrorRead;
  readonly rewrite: (error: NormalizedError) => void | Promise<void>;
  readonly onCompatibilityDiagnostic?: (diagnostic: PersistedErrorCompatibilityDiagnostic) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateLegacyPayload(
  kind: PersistedKind,
  payload: unknown,
  key: string,
  schemaVersion: number,
): unknown {
  if (!isRecord(payload)) return payload;
  const shouldMigrate =
    (kind === "session" && payload.status === "failed") ||
    (kind === "turn" && payload.status === "failed") ||
    (kind === "tool_call" &&
      (payload.status === "failed" ||
        payload.status === "timed_out" ||
        payload.status === "cancelled"));
  if (!shouldMigrate) return payload;
  if (!hasOwnDataProperty(payload, "error")) return payload;
  const read = readPersistedError(payload.error);
  if (read === null) {
    throw new CorruptRecordError(key, "invalid persisted error", schemaVersion);
  }
  return read.error === payload.error ? payload : { ...payload, error: read.error };
}

/**
 * Rehydrates normalized errors written before `NormalizedError.name` became a
 * required persisted field. Durable adapters use this for records whose error
 * is stored outside a versioned session/turn/tool envelope (for example,
 * idempotency rows).
 *
 * Current errors are returned unchanged. Invalid values return `null` so each
 * adapter can report a corrupt record at its own storage key.
 */
export function normalizePersistedError(value: unknown): NormalizedError | null {
  if (isNormalizedError(value)) return value;
  return normalizeLegacyError(value);
}

/**
 * Reads an error from a JSON/JSONB boundary. Shape-valid but unknown codes are
 * retained for diagnosis and forced non-retriable. Only codes in the checked
 * inventory may restore their retry policy. Registered aliases are rewritten
 * in memory and retain their old code in bounded metadata for diagnosis.
 */
export function readPersistedError(value: unknown): PersistedErrorRead | null {
  const candidate = readPersistedErrorFields(value);
  if (candidate === null) return null;
  const alias = PERSISTED_ERROR_ALIASES.get(candidate.code);
  const canonicalCode = alias ?? candidate.code;
  const knownCode = alias !== undefined || KNOWN_PERSISTED_ERROR_CODES.has(canonicalCode);
  const migratedMetadata =
    alias === undefined
      ? candidate.metadata
      : {
          ...(candidate.metadata ?? {}),
          legacyCode: candidate.code,
        };
  const error: NormalizedError = {
    name: candidate.name,
    code: canonicalCode,
    category: candidate.category,
    message: candidate.message,
    retriable: knownCode && PERSISTED_RETRY_POLICY.has(canonicalCode),
    ...(candidate.provider !== undefined ? { provider: candidate.provider } : {}),
    ...(candidate.cause !== undefined ? { cause: candidate.cause } : {}),
    ...(migratedMetadata !== undefined ? { metadata: migratedMetadata } : {}),
  };
  if (!isNormalizedError(error)) return null;
  return { error, knownCode, migratedAlias: alias !== undefined };
}

/**
 * Rewrites one legacy idempotency error after a successful read. A rewrite is
 * best-effort by design: callers keep using the canonical in-memory value if
 * storage is temporarily unavailable, while receiving one secret-free
 * diagnostic for the failed rewrite.
 */
export async function rewritePersistedErrorIfAlias(
  options: PersistedErrorRewriteOptions,
): Promise<boolean> {
  if (!options.read.migratedAlias) return false;
  const legacyCode = readLegacyCode(options.read.error);
  if (!legacyCode) return false;
  try {
    await options.rewrite(options.read.error);
    return true;
  } catch {
    const diagnostic: PersistedErrorCompatibilityDiagnostic = {
      adapter: options.adapter,
      operation: "idempotency_alias_rewrite",
      key: safeDiagnosticKey(options.key),
      legacyCode,
      canonicalCode: options.read.error.code,
      outcome: "rewrite_failed",
    };
    try {
      options.onCompatibilityDiagnostic?.(diagnostic);
    } catch {
      // A diagnostic sink must not turn a readable durable record into a
      // failed request.
    }
    return false;
  }
}

interface PersistedErrorFields {
  readonly name: NormalizedError["name"];
  readonly code: string;
  readonly category: NormalizedError["category"];
  readonly message: string;
  readonly provider?: string;
  readonly cause?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function readPersistedErrorFields(value: unknown): PersistedErrorFields | null {
  if (!isRecord(value)) return null;
  try {
    const code = ownDataValue(value, "code");
    const category = ownDataValue(value, "category");
    const message = ownDataValue(value, "message");
    const retriable = ownDataValue(value, "retriable");
    if (
      typeof code !== "string" ||
      !PERSISTED_ERROR_CODE_PATTERN.test(code) ||
      code.length > MAX_PERSISTED_ERROR_CODE_BYTES ||
      typeof category !== "string" ||
      !PERSISTED_ERROR_NAME_BY_CATEGORY[category] ||
      typeof message !== "string" ||
      message.length === 0 ||
      typeof retriable !== "boolean"
    ) {
      return null;
    }
    const rawName = ownDataValue(value, "name");
    let name: NormalizedError["name"];
    if (rawName === undefined) {
      name = PERSISTED_ERROR_NAME_BY_CATEGORY[category] as NormalizedError["name"];
    } else if (isTvicErrorName(rawName) && PERSISTED_ERROR_CATEGORIES[rawName] === category) {
      name = rawName;
    } else {
      return null;
    }
    const provider = ownDataValue(value, "provider");
    if (provider !== undefined && typeof provider !== "string") return null;
    const causeResult = readSafeNestedValue(value, "cause", "cause", new WeakSet<object>(), {
      maxDepth: MAX_PERSISTED_METADATA_DEPTH,
      maxNodes: MAX_PERSISTED_METADATA_NODES,
      maxStringLength: MAX_PERSISTED_METADATA_STRING_LENGTH,
      redactSecrets: false,
    });
    if (!causeResult.ok) return null;
    const metadataResult = readSafeNestedValue(
      value,
      "metadata",
      "metadata",
      new WeakSet<object>(),
      {
        maxDepth: MAX_PERSISTED_METADATA_DEPTH,
        maxNodes: MAX_PERSISTED_METADATA_NODES,
        maxStringLength: MAX_PERSISTED_METADATA_STRING_LENGTH,
        redactSecrets: true,
      },
    );
    if (!metadataResult.ok) return null;
    if (metadataResult.value !== undefined && !isRecord(metadataResult.value)) return null;
    return {
      name,
      code,
      category: category as NormalizedError["category"],
      message,
      ...(provider !== undefined ? { provider } : {}),
      ...(causeResult.value !== undefined ? { cause: causeResult.value } : {}),
      ...(metadataResult.value !== undefined
        ? { metadata: metadataResult.value as Readonly<Record<string, unknown>> }
        : {}),
    };
  } catch {
    return null;
  }
}

function hasOwnDataProperty(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.value !== undefined;
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

interface NestedReadOptions {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringLength: number;
  readonly redactSecrets: boolean;
}

type NestedReadResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function readSafeNestedValue(
  parent: object,
  property: string,
  path: string,
  ancestors: WeakSet<object>,
  options: NestedReadOptions,
): NestedReadResult {
  const descriptor = Object.getOwnPropertyDescriptor(parent, property);
  if (!descriptor) return { ok: true, value: undefined };
  if (!("value" in descriptor)) return { ok: false };
  return sanitizePersistedValue(descriptor.value, path, ancestors, options, 0, { count: 0 });
}

function sanitizePersistedValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  options: NestedReadOptions,
  depth: number,
  nodes: { count: number },
): NestedReadResult {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value)
      ? { ok: false }
      : { ok: true, value };
  }
  if (typeof value === "string") {
    if (value.length > options.maxStringLength) return { ok: false };
    return {
      ok: true,
      value: options.redactSecrets && isSecretPath(path) ? "[REDACTED]" : redactUrl(value),
    };
  }
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || typeof value === "function") return { ok: false };
  if (depth >= options.maxDepth || ancestors.has(value) || nodes.count >= options.maxNodes) {
    return { ok: false };
  }
  nodes.count += 1;
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return { ok: false };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
      return { ok: false };
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) return { ok: false };
        const item = sanitizePersistedValue(
          descriptor.value,
          path + "." + index,
          ancestors,
          options,
          depth + 1,
          nodes,
        );
        if (!item.ok) return item;
        items.push(item.value);
      }
      return { ok: true, value: items };
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return { ok: false };
      if (options.redactSecrets && isSecretPath(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      const nested = sanitizePersistedValue(
        descriptor.value,
        path + "." + key,
        ancestors,
        options,
        depth + 1,
        nodes,
      );
      if (!nested.ok) return nested;
      if (nested.value !== undefined) output[key] = nested.value;
    }
    return { ok: true, value: output };
  } catch {
    return { ok: false };
  } finally {
    ancestors.delete(value);
  }
}

function isSecretPath(path: string): boolean {
  return /(?:authorization|api[_-]?key|password|token|secret|credential|private[_-]?key)/i.test(
    path,
  );
}

function redactUrl(value: string): string {
  return value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}

function readLegacyCode(error: NormalizedError): string | undefined {
  const metadata = error.metadata;
  const legacyCode = metadata ? ownDataValue(metadata, "legacyCode") : undefined;
  return typeof legacyCode === "string" ? legacyCode : undefined;
}

function safeDiagnosticKey(key: string): string {
  return key.length > 256 ? key.slice(0, 253) + "..." : key;
}

/** Strict parser for the small durable-error envelope used by recovery jobs. */
export function decodeDurableErrorRecord(raw: unknown, key: string): DurableError {
  if (!isRecord(raw)) throw new CorruptRecordError(key, "durable error record must be an object");
  const kind = ownDataValue(raw, "kind");
  const schemaVersion = ownDataValue(raw, "schemaVersion");
  const error = ownDataValue(raw, "error");
  if (kind !== "durable_error" || schemaVersion !== 1 || !isRecord(error)) {
    throw new CorruptRecordError(key, "invalid durable error envelope", 1);
  }
  const name = ownDataValue(error, "name");
  const code = ownDataValue(error, "code");
  const message = ownDataValue(error, "message");
  const retriable = ownDataValue(error, "retriable");
  const policy = durableErrorPolicy(code);
  if (
    !policy ||
    name !== policy.name ||
    typeof message !== "string" ||
    message.length === 0 ||
    retriable !== policy.retriable
  ) {
    throw new CorruptRecordError(key, "invalid durable error payload", 1);
  }
  return createDurableError(policy.code, message, key);
}

interface DurableErrorPolicy {
  readonly code: import("@tvic/core").DurableErrorCode;
  readonly name: string;
  readonly retriable: boolean;
}

function durableErrorPolicy(value: unknown): DurableErrorPolicy | null {
  const policies: Readonly<Record<string, DurableErrorPolicy>> = {
    BACKEND_UNAVAILABLE: {
      code: "BACKEND_UNAVAILABLE",
      name: "BackendUnavailableError",
      retriable: true,
    },
    CORRUPT_RECORD: { code: "CORRUPT_RECORD", name: "CorruptRecordError", retriable: false },
    INVALID_ARGUMENT: {
      code: "INVALID_ARGUMENT",
      name: "InvalidArgumentError",
      retriable: false,
    },
    LEASE_LOST: { code: "LEASE_LOST", name: "LeaseLostError", retriable: false },
    LEASE_UNAVAILABLE: {
      code: "LEASE_UNAVAILABLE",
      name: "LeaseUnavailableError",
      retriable: true,
    },
    MEMORY_BACKEND_UNAVAILABLE: {
      code: "MEMORY_BACKEND_UNAVAILABLE",
      name: "MemoryBackendUnavailableError",
      retriable: true,
    },
    MEMORY_ENTRY_TOO_LARGE: {
      code: "MEMORY_ENTRY_TOO_LARGE",
      name: "MemoryEntryTooLargeError",
      retriable: false,
    },
    MEMORY_SESSION_QUOTA_EXCEEDED: {
      code: "MEMORY_SESSION_QUOTA_EXCEEDED",
      name: "MemorySessionQuotaExceededError",
      retriable: false,
    },
    RECORD_CONFLICT: { code: "RECORD_CONFLICT", name: "RecordConflictError", retriable: false },
    RECORD_NOT_FOUND: { code: "RECORD_NOT_FOUND", name: "RecordNotFoundError", retriable: false },
  };
  return typeof value === "string" ? (policies[value] ?? null) : null;
}

function createDurableError(
  code: import("@tvic/core").DurableErrorCode,
  message: string,
  key: string,
): DurableError {
  switch (code) {
    case "BACKEND_UNAVAILABLE":
      return new BackendUnavailableError(message);
    case "CORRUPT_RECORD":
      return new CorruptRecordError(key, message, 1);
    case "INVALID_ARGUMENT":
      return new InvalidArgumentError(message);
    case "LEASE_LOST":
      return new LeaseLostError(message);
    case "LEASE_UNAVAILABLE":
      return new LeaseUnavailableError(message);
    case "MEMORY_BACKEND_UNAVAILABLE":
      return new MemoryBackendUnavailableError(message);
    case "MEMORY_ENTRY_TOO_LARGE":
      return new MemoryEntryTooLargeError(message, 0, 0);
    case "MEMORY_SESSION_QUOTA_EXCEEDED":
      return new MemorySessionQuotaExceededError(message, 0, 0, 0);
    case "RECORD_CONFLICT":
      return new RecordConflictError(message);
    case "RECORD_NOT_FOUND":
      return new RecordNotFoundError(message);
  }
}
