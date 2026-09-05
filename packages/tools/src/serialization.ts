import { isNormalizedError, isTvicError, TvicThrowableError, validationError } from "@tvic/core";
import type { NormalizedError } from "@tvic/core";

export function stableStringify(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>());
}

export function stableStringifyForPersistence(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>(), true);
}

function stableStringifyValue(
  value: unknown,
  ancestors: WeakSet<object>,
  rejectUndefined = false,
): string {
  if (value === null) return "null";
  if (value === undefined) {
    if (rejectUndefined) {
      throw new TypeError("Cannot serialize undefined as a JSON value");
    }
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Cannot stable-stringify a non-finite number");
    }
    return JSON.stringify(value);
  }
  // Keep throwable normalized errors durable in idempotency hashes and
  // persisted tool records by serializing their plain payload.
  const tvicError = tvicErrorPayload(value);
  if (tvicError) {
    return stableStringifyNormalizedError(tvicError, ancestors, rejectUndefined);
  }
  if (isNormalizedError(value)) {
    return stableStringifyNormalizedError(value, ancestors, rejectUndefined);
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
    return `[${Array.from(value, (item) => stableStringifyValue(item, ancestors, rejectUndefined)).join(",")}]`;
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

function tvicErrorPayload(value: unknown): NormalizedError | null {
  if (value instanceof TvicThrowableError) {
    return isNormalizedError(value.error) ? value.error : null;
  }
  if (!isTvicError(value)) {
    return null;
  }
  const candidate = value as NormalizedError & { readonly error?: unknown };
  return isNormalizedError(candidate.error)
    ? candidate.error
    : isNormalizedError(value)
      ? value
      : null;
}

function serializableNormalizedError(error: NormalizedError): Readonly<Record<string, unknown>> {
  return {
    name: error.name,
    code: error.code,
    category: error.category,
    message: error.message,
    retriable: error.retriable,
    ...(error.provider !== undefined ? { provider: error.provider } : {}),
    ...(error.cause !== undefined ? { cause: serializableErrorCause(error.cause) } : {}),
    ...(error.metadata !== undefined ? { metadata: error.metadata } : {}),
  };
}

function stableStringifyNormalizedError(
  error: NormalizedError,
  ancestors: WeakSet<object>,
  rejectUndefined: boolean,
): string {
  if (ancestors.has(error)) {
    throw new TypeError("Cannot stable-stringify a cyclic value");
  }
  ancestors.add(error);
  try {
    return stableStringifyObject(serializableNormalizedError(error), ancestors, rejectUndefined);
  } finally {
    ancestors.delete(error);
  }
}

function serializableErrorCause(cause: unknown): unknown {
  if (cause instanceof TvicThrowableError) {
    return errorCauseSummary(cause.error);
  }
  if (isTvicError(cause)) {
    const candidate = cause as NormalizedError & { readonly error?: unknown };
    if (isNormalizedError(candidate.error)) {
      return errorCauseSummary(candidate.error);
    }
    if (isNormalizedError(cause)) {
      return errorCauseSummary(cause);
    }
  }
  if (isNormalizedError(cause)) {
    return errorCauseSummary(cause);
  }
  if (isErrorObject(cause)) {
    return {
      name: typeof cause.name === "string" ? cause.name : "Error",
      message: cause.message,
    };
  }
  if (typeof cause === "symbol" || typeof cause === "bigint" || typeof cause === "function") {
    return String(cause);
  }
  return cause;
}

function isErrorObject(
  value: unknown,
): value is { readonly name?: unknown; readonly message: string } {
  if (value instanceof Error) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Error]" &&
    typeof (value as { readonly message?: unknown }).message === "string"
  );
}

function errorCauseSummary(error: NormalizedError): Readonly<Record<string, string>> {
  return { name: error.name, code: error.code, message: error.message };
}

export function serializabilityError(
  value: unknown,
  label: "input" | "output",
): NormalizedError | null {
  try {
    stableStringifyForPersistence(value);
    return null;
  } catch (error) {
    return validationError(
      `tool.${label}_not_serializable`,
      `Tool ${label} cannot be persisted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
