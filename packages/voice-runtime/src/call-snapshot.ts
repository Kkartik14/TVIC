import type {
  AudioFormat,
  CallSnapshot,
  ErrorCategory,
  MediaTransport,
  NormalizedError,
} from "@tvic/core";
import {
  isNormalizedError,
  isSampleRateHz,
  isTvicErrorName,
  TvicThrowableError,
  validationError,
} from "@tvic/core";

const MAX_DEPTH = 6;
const MAX_OWN_KEYS = 100;
const MAX_STRING_BYTES = 4_096;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  "validation",
  "auth",
  "provider",
  "network",
  "timeout",
  "rate_limit",
  "cancelled",
  "interrupted",
  "tool",
  "media",
  "internal",
]);
const MISSING = Symbol("missing-call-property");

type JsonSnapshot =
  | null
  | boolean
  | number
  | string
  | JsonSnapshot[]
  | { [key: string]: JsonSnapshot };

class CallSnapshotInputError extends Error {}

function invalidCall(message: string): never {
  throw TvicThrowableError.from(validationError("voice_runtime.invalid_call", message));
}

function fail(message: string): never {
  throw new CallSnapshotInputError(message);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is object {
  if (!isObject(value) || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    fail("call contains an object whose prototype cannot be inspected");
  }
}

function ownKeys(value: object): readonly PropertyKey[] {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("call contains an object whose own keys cannot be inspected");
  }
  if (keys.length > MAX_OWN_KEYS) fail(`call records may contain at most ${MAX_OWN_KEYS} own keys`);
  return keys;
}

function ownData(value: object, property: PropertyKey): unknown | typeof MISSING {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, property);
  } catch {
    fail(`call property ${String(property)} could not be inspected`);
  }
  if (descriptor === undefined) return MISSING;
  if (!("value" in descriptor)) fail(`call property ${String(property)} must be a data property`);
  return descriptor.value;
}

function required(value: object, property: string): unknown {
  const result = ownData(value, property);
  if (result === MISSING) fail(`call.${property} is required`);
  return result;
}

function optional(value: object, property: string): unknown | typeof MISSING {
  return ownData(value, property);
}

function boundedString(value: unknown, field: string, nonEmpty = false): string {
  if (typeof value !== "string") fail(`call.${field} must be a string`);
  if (nonEmpty && value.trim().length === 0) fail(`call.${field} must be non-empty`);
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    fail(`call.${field} exceeds the ${MAX_STRING_BYTES}-byte string limit`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const candidate = boundedString(value, field, true);
  let canonical: string;
  try {
    canonical = new Date(candidate).toISOString();
  } catch {
    fail(`call.${field} must be a finite canonical ISO timestamp`);
  }
  if (canonical !== candidate) fail(`call.${field} must be a finite canonical ISO timestamp`);
  return candidate;
}

function optionalBoundedString(
  value: unknown | typeof MISSING,
  field: string,
  nonEmpty = false,
): string | undefined {
  if (value === MISSING || value === undefined) return undefined;
  return boundedString(value, field, nonEmpty);
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function sanitizeJson(
  value: unknown,
  depth: number,
  seen: Set<object>,
  path: string,
): JsonSnapshot {
  if (value === null) return null;
  if (typeof value === "string") return boundedString(value, path);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} must contain only finite numbers`);
    return value;
  }
  if (!isObject(value)) fail(`${path} must contain only JSON-safe values`);
  if (depth > MAX_DEPTH) fail(`call value at ${path} exceeds the maximum depth of ${MAX_DEPTH}`);
  if (seen.has(value)) fail(`call value at ${path} contains a cycle`);
  seen.add(value);
  try {
    const keys = ownKeys(value);
    if (Array.isArray(value)) {
      const lengthValue = ownData(value, "length");
      if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue)) {
        fail(`${path} array length is invalid`);
      }
      if (lengthValue > MAX_OWN_KEYS)
        fail(`${path} arrays may contain at most ${MAX_OWN_KEYS} items`);
      const result: JsonSnapshot[] = [];
      for (let index = 0; index < lengthValue; index += 1) {
        const item = ownData(value, String(index));
        if (item === MISSING) fail(`${path}[${index}] is missing`);
        result.push(sanitizeJson(item, depth + 1, seen, `${path}[${index}]`));
      }
      for (const key of keys) {
        if (typeof key === "symbol") fail(`${path} contains a symbol key`);
        if (key !== "length" && !/^\d+$/.test(String(key))) {
          // Array extensions are not part of the JSON metadata contract.
          fail(`${path} contains a non-index property`);
        }
      }
      return freeze(result);
    }
    if (!isPlainRecord(value)) fail(`${path} must be a plain record`);
    const result: { [key: string]: JsonSnapshot } = Object.create(null) as {
      [key: string]: JsonSnapshot;
    };
    const stringKeys: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") fail(`${path} contains a symbol key`);
      stringKeys.push(key);
    }
    stringKeys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const key of stringKeys) {
      const item = ownData(value, key);
      if (item === MISSING) fail(`${path}.${key} disappeared during inspection`);
      result[key] = sanitizeJson(item, depth + 1, seen, `${path}.${key}`);
    }
    return freeze(result);
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: JsonSnapshot): string {
  return JSON.stringify(value);
}

function metadataSnapshot(
  value: unknown | typeof MISSING,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === MISSING || value === undefined) return undefined;
  if (!isPlainRecord(value)) fail(`call.${field} must be a plain record`);
  const copy = sanitizeJson(value, 1, new Set(), `call.${field}`);
  if (Array.isArray(copy) || copy === null || typeof copy !== "object") {
    fail(`call.${field} must be a plain record`);
  }
  if (Buffer.byteLength(canonicalJson(copy), "utf8") > MAX_METADATA_BYTES) {
    fail(`call.${field} exceeds the ${MAX_METADATA_BYTES}-byte metadata limit`);
  }
  return copy as Readonly<Record<string, unknown>>;
}

function audioFormat(value: unknown, field: string): AudioFormat {
  if (!isPlainRecord(value)) fail(`call.${field} must be a plain audio format`);
  ownKeys(value);
  const encoding = required(value, "encoding");
  if (encoding !== "pcm_s16le" && encoding !== "pcm_s16be" && encoding !== "pcm_f32le") {
    fail(`call.${field}.encoding must be a normalized PCM encoding`);
  }
  const sampleRateHz = required(value, "sampleRateHz");
  if (!isSampleRateHz(sampleRateHz)) {
    fail(`call.${field}.sampleRateHz is unsupported`);
  }
  const channels = required(value, "channels");
  if (channels !== 1 && channels !== 2) fail(`call.${field}.channels must be 1 or 2`);
  const frameDuration = optional(value, "frameDurationMs");
  if (
    frameDuration !== MISSING &&
    frameDuration !== undefined &&
    (typeof frameDuration !== "number" || !Number.isFinite(frameDuration) || frameDuration <= 0)
  ) {
    fail(`call.${field}.frameDurationMs must be a positive finite number`);
  }
  return freeze({
    encoding,
    sampleRateHz,
    channels,
    ...(frameDuration !== MISSING && frameDuration !== undefined
      ? { frameDurationMs: frameDuration }
      : {}),
  }) as AudioFormat;
}

function copyMediaTransport(value: unknown): MediaTransport {
  if (!isPlainRecord(value)) fail("call.mediaTransport must be a plain record");
  ownKeys(value);
  if (required(value, "kind") !== "websocket") {
    fail('call.mediaTransport.kind must be "websocket"');
  }
  const format = audioFormat(required(value, "format"), "mediaTransport.format");
  const remoteEndpoint = optionalBoundedString(
    optional(value, "remoteEndpoint"),
    "mediaTransport.remoteEndpoint",
  );
  const metadata = metadataSnapshot(optional(value, "metadata"), "mediaTransport.metadata");
  return freeze({
    kind: "websocket",
    format,
    ...(remoteEndpoint !== undefined ? { remoteEndpoint } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }) as MediaTransport;
}

function normalizedErrorSnapshot(value: unknown): NormalizedError {
  if (!isPlainRecord(value)) fail("call.error must be a normalized error record");
  ownKeys(value);
  const name = required(value, "name");
  const code = required(value, "code");
  const category = required(value, "category");
  const message = required(value, "message");
  const retriable = required(value, "retriable");
  if (!isTvicErrorName(name)) fail("call.error.name is not a TVIC error name");
  if (typeof code !== "string" || !ERROR_CODE_PATTERN.test(code)) {
    fail("call.error.code is not a valid namespaced error code");
  }
  if (typeof category !== "string" || !ERROR_CATEGORIES.has(category as ErrorCategory)) {
    fail("call.error.category is invalid");
  }
  if (typeof message !== "string" || message.length === 0) fail("call.error.message is invalid");
  boundedString(message, "error.message");
  if (typeof retriable !== "boolean") fail("call.error.retriable must be boolean");
  const provider = optionalBoundedString(optional(value, "provider"), "error.provider");
  const metadata = metadataSnapshot(optional(value, "metadata"), "error.metadata");
  const snapshot = freeze({
    name,
    code,
    category,
    message,
    retriable,
    ...(provider !== undefined ? { provider } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
  if (!isNormalizedError(snapshot)) fail("call.error is not structurally normalized");
  return snapshot;
}

function ensureNoField(value: object, property: string, field: string): void {
  const candidate = optional(value, property);
  if (candidate !== MISSING && candidate !== undefined) fail(`${field}.${property} is not allowed`);
}

function ensureOrder(
  createdAt: string,
  startedAt: string | undefined,
  endedAt: string | undefined,
): void {
  if (startedAt !== undefined && createdAt > startedAt) fail("call timestamps are out of order");
  if (startedAt !== undefined && endedAt !== undefined && startedAt > endedAt) {
    fail("call timestamps are out of order");
  }
  if (startedAt === undefined && endedAt !== undefined && createdAt > endedAt) {
    fail("call timestamps are out of order");
  }
}

/** Validate, sanitize, and deeply freeze a caller-provided call record. */
export function buildCallSnapshot(value: unknown): CallSnapshot {
  try {
    if (!isPlainRecord(value)) fail("call must be a plain record");
    ownKeys(value);
    const id = boundedString(required(value, "id"), "id", true);
    const provider = boundedString(required(value, "provider"), "provider", true);
    const direction = required(value, "direction");
    if (direction !== "inbound" && direction !== "outbound") fail("call.direction is invalid");
    const from = boundedString(required(value, "from"), "from", true);
    const to = boundedString(required(value, "to"), "to", true);
    const sessionId = optionalBoundedString(optional(value, "sessionId"), "sessionId", true);
    const mediaTransport = copyMediaTransport(required(value, "mediaTransport"));
    const metadata = metadataSnapshot(optional(value, "metadata"), "metadata");
    const status = required(value, "status");
    const createdAt = timestamp(required(value, "createdAt"), "createdAt");
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let error: NormalizedError | undefined;
    switch (status) {
      case "created":
      case "ringing":
        ensureNoField(value, "startedAt", "call");
        ensureNoField(value, "endedAt", "call");
        ensureNoField(value, "error", "call");
        break;
      case "connected":
      case "active":
      case "held":
        startedAt = timestamp(required(value, "startedAt"), "startedAt");
        ensureNoField(value, "endedAt", "call");
        ensureNoField(value, "error", "call");
        break;
      case "ended":
        startedAt = timestamp(required(value, "startedAt"), "startedAt");
        endedAt = timestamp(required(value, "endedAt"), "endedAt");
        ensureNoField(value, "error", "call");
        break;
      case "failed":
        const maybeStartedAt = optional(value, "startedAt");
        startedAt =
          maybeStartedAt === MISSING || maybeStartedAt === undefined
            ? undefined
            : timestamp(maybeStartedAt, "startedAt");
        endedAt = timestamp(required(value, "endedAt"), "endedAt");
        error = normalizedErrorSnapshot(required(value, "error"));
        break;
      default:
        fail("call.status is invalid");
    }
    ensureOrder(createdAt, startedAt, endedAt);
    const snapshot = freeze({
      id,
      provider,
      direction,
      from,
      to,
      ...(sessionId !== undefined ? { sessionId } : {}),
      mediaTransport,
      ...(metadata !== undefined ? { metadata } : {}),
      createdAt,
      status,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(error !== undefined ? { error } : {}),
    }) as CallSnapshot;
    if (
      Buffer.byteLength(canonicalJson(snapshot as unknown as JsonSnapshot), "utf8") >
      MAX_SNAPSHOT_BYTES
    ) {
      fail(`call snapshot exceeds the ${MAX_SNAPSHOT_BYTES}-byte limit`);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TvicThrowableError) throw error;
    if (error instanceof CallSnapshotInputError) return invalidCall(error.message);
    return invalidCall("call could not be safely inspected");
  }
}
