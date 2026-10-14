import {
  isNormalizedError,
  jsonSerializableNormalizedError,
  normalizedErrorFromTvicError,
  validationError,
} from "@tvic/core";
import type { NormalizedError } from "@tvic/core";

export function stableStringify(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>());
}

export function stableStringifyForPersistence(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>(), true);
}

export function snapshotJsonValue<T>(value: T): T {
  return JSON.parse(stableStringifyForPersistence(value)) as T;
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
  return normalizedErrorFromTvicError(value);
}

function serializableNormalizedError(error: NormalizedError): Readonly<Record<string, unknown>> {
  const serialized = jsonSerializableNormalizedError(error);
  return {
    name: serialized.name,
    code: serialized.code,
    category: serialized.category,
    message: serialized.message,
    retriable: serialized.retriable,
    ...(serialized.provider !== undefined ? { provider: serialized.provider } : {}),
    ...(serialized.cause !== undefined ? { cause: serialized.cause } : {}),
    ...(serialized.metadata !== undefined ? { metadata: serialized.metadata } : {}),
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
