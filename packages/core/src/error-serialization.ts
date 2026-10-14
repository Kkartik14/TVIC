import type { NormalizedError } from "./errors.js";

const MAX_JSON_CAUSE_DEPTH = 8;
const MAX_JSON_CAUSE_NODES = 256;
const MAX_JSON_CAUSE_ARRAY_LENGTH = 256;
const MAX_JSON_CAUSE_PROTOTYPE_DEPTH = 32;
const MAX_JSON_CAUSE_STRING_LENGTH = 256;
export const MISSING_JSON_PROPERTY = Symbol("missing-json-property");
export const ACCESSOR_JSON_PROPERTY = Symbol("accessor-json-property");

interface JsonCauseState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

interface ErrorSerializationContext {
  readonly marker: symbol;
  readonly isNormalizedError: (value: unknown) => value is NormalizedError;
}

export function serializeNormalizedError(
  error: NormalizedError,
  marker: symbol,
  isNormalizedError: ErrorSerializationContext["isNormalizedError"],
): NormalizedError {
  const context = { marker, isNormalizedError };
  const message = boundedJsonCauseString(error.message);
  const provider =
    error.provider === undefined ? undefined : boundedJsonCauseString(error.provider);
  const { cause: originalCause, metadata: originalMetadata, ...errorWithoutNestedValues } = error;
  const cause =
    originalCause === undefined
      ? undefined
      : serializeJsonValue(
          originalCause,
          { seen: new WeakSet<object>(), nodes: 0 },
          0,
          true,
          context,
        );
  const metadata =
    originalMetadata === undefined
      ? undefined
      : serializeJsonValue(
          originalMetadata,
          { seen: new WeakSet<object>(), nodes: 0 },
          0,
          false,
          context,
        );
  if (
    message === error.message &&
    provider === error.provider &&
    cause === originalCause &&
    metadata === originalMetadata
  ) {
    return error;
  }
  return {
    ...errorWithoutNestedValues,
    message,
    ...(provider !== undefined ? { provider } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(metadata !== undefined ? { metadata: isJsonObject(metadata) ? metadata : {} } : {}),
  };
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonDataProperty(
  value: object,
  property: PropertyKey,
): unknown | typeof MISSING_JSON_PROPERTY {
  const seen = new Set<object>();
  let current: object | null = value;
  let depth = 0;
  try {
    while (current !== null && !seen.has(current)) {
      if (depth >= MAX_JSON_CAUSE_PROTOTYPE_DEPTH) return MISSING_JSON_PROPERTY;
      depth += 1;
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) return "value" in descriptor ? descriptor.value : ACCESSOR_JSON_PROPERTY;
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return MISSING_JSON_PROPERTY;
  }
  return MISSING_JSON_PROPERTY;
}

function safeNormalizedErrorSummary(
  value: unknown,
  context: ErrorSerializationContext,
): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null) return null;
  const name = jsonDataProperty(value, "name");
  const code = jsonDataProperty(value, "code");
  const category = jsonDataProperty(value, "category");
  const message = jsonDataProperty(value, "message");
  const retriable = jsonDataProperty(value, "retriable");
  const provider = jsonDataProperty(value, "provider");
  const metadata = jsonDataProperty(value, "metadata");
  if (
    typeof name !== "string" ||
    typeof code !== "string" ||
    typeof category !== "string" ||
    typeof message !== "string" ||
    message.length === 0 ||
    typeof retriable !== "boolean" ||
    (provider !== MISSING_JSON_PROPERTY &&
      provider !== undefined &&
      typeof provider !== "string") ||
    (metadata !== MISSING_JSON_PROPERTY &&
      metadata !== undefined &&
      (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)))
  ) {
    return null;
  }
  const candidate = {
    name,
    code,
    category,
    message,
    retriable,
    ...(provider !== MISSING_JSON_PROPERTY && provider !== undefined ? { provider } : {}),
    ...(metadata !== MISSING_JSON_PROPERTY && metadata !== undefined ? { metadata } : {}),
  };
  if (!context.isNormalizedError(candidate)) return null;
  return { name, code, message: boundedJsonCauseString(message) };
}

function safeNativeErrorSummary(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null) return null;
  if (hasAccessorInPrototypeChain(value, Symbol.toStringTag)) return null;
  try {
    if (Object.prototype.toString.call(value) !== "[object Error]") return null;
  } catch {
    return null;
  }
  const name = jsonDataProperty(value, "name");
  const message = jsonDataProperty(value, "message");
  return typeof name === "string" && typeof message === "string"
    ? { name: boundedJsonCauseString(name), message: boundedJsonCauseString(message) }
    : null;
}

export function hasAccessorInPrototypeChain(value: object, property: PropertyKey): boolean {
  const seen = new Set<object>();
  let current: object | null = value;
  let depth = 0;
  try {
    while (current !== null && !seen.has(current)) {
      if (depth >= MAX_JSON_CAUSE_PROTOTYPE_DEPTH) return true;
      depth += 1;
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) return !("value" in descriptor);
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return true;
  }
  return current !== null;
}

export function exceedsJsonCausePrototypeDepth(value: object): boolean {
  const seen = new Set<object>();
  let current: object | null = value;
  let depth = 0;
  try {
    while (current !== null && !seen.has(current)) {
      if (depth >= MAX_JSON_CAUSE_PROTOTYPE_DEPTH) return true;
      depth += 1;
      seen.add(current);
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return true;
  }
  return current !== null;
}

function boundedJsonCauseString(value: string): string {
  const wellFormed = makeWellFormed(value);
  if (wellFormed.length <= MAX_JSON_CAUSE_STRING_LENGTH) return wellFormed;
  let end = MAX_JSON_CAUSE_STRING_LENGTH - "[Truncated]".length;
  if (isHighSurrogate(wellFormed.charCodeAt(end - 1))) end -= 1;
  return `${wellFormed.slice(0, end)}[Truncated]`;
}

function makeWellFormed(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isHighSurrogate(codeUnit)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (isLowSurrogate(codeUnit)) {
      result += "\uFFFD";
    } else {
      result += value[index]!;
    }
  }
  return result;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function serializeJsonValue(
  value: unknown,
  state: JsonCauseState,
  depth: number,
  summarizeErrors: boolean,
  context: ErrorSerializationContext,
): unknown {
  let addedToSeen = false;
  try {
    if (depth >= MAX_JSON_CAUSE_DEPTH) return "[MaxDepth]";
    if (state.nodes >= MAX_JSON_CAUSE_NODES) return "[MaxNodes]";
    state.nodes += 1;

    if (typeof value === "object" && value !== null && exceedsJsonCausePrototypeDepth(value)) {
      return "[MaxDepth]";
    }

    if (summarizeErrors && typeof value === "object" && value !== null) {
      const marker = jsonDataProperty(value, context.marker);
      if (marker === true) {
        const marked = safeNormalizedErrorSummary(jsonDataProperty(value, "error"), context);
        if (marked) return marked;
      }
      const normalized = safeNormalizedErrorSummary(value, context);
      if (normalized) return normalized;
      const native = safeNativeErrorSummary(value);
      if (native) return native;
    }

    if (value === null || typeof value !== "object") {
      if (typeof value === "string") return boundedJsonCauseString(value);
      if (typeof value === "bigint") return boundedJsonCauseString(value.toString());
      if (typeof value === "symbol") return boundedJsonCauseString(value.toString());
      if (typeof value === "function") {
        const name = jsonDataProperty(value, "name");
        const safeName = typeof name === "string" ? boundedJsonCauseString(name) : "anonymous";
        return boundedJsonCauseString(`[Function ${safeName}]`);
      }
      return value;
    }
    if (state.seen.has(value)) return "[Circular]";
    state.seen.add(value);
    addedToSeen = true;

    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const length = Math.min(value.length, MAX_JSON_CAUSE_ARRAY_LENGTH);
      for (let index = 0; index < length; index += 1) {
        if (state.nodes >= MAX_JSON_CAUSE_NODES) {
          result.push("[MaxNodes]");
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        result.push(
          descriptor && "value" in descriptor
            ? serializeJsonValue(descriptor.value, state, depth + 1, summarizeErrors, context)
            : null,
        );
      }
      if (value.length > length) result.push("[Truncated]");
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const key in value) {
      if (state.nodes >= MAX_JSON_CAUSE_NODES) {
        Object.defineProperty(result, "[Truncated]", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: "[MaxNodes]",
        });
        break;
      }
      state.nodes += 1;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (key.length > MAX_JSON_CAUSE_STRING_LENGTH) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: serializeJsonValue(descriptor.value, state, depth + 1, summarizeErrors, context),
      });
    }
    return result;
  } catch {
    return "[Unserializable cause]";
  } finally {
    if (addedToSeen && typeof value === "object" && value !== null) {
      state.seen.delete(value);
    }
  }
}
