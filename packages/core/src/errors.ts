import {
  ACCESSOR_JSON_PROPERTY,
  exceedsJsonCausePrototypeDepth,
  hasAccessorInPrototypeChain,
  jsonDataProperty,
  MISSING_JSON_PROPERTY,
  serializeNormalizedError,
} from "./error-serialization.js";

export type ErrorCategory =
  | "validation"
  | "auth"
  | "provider"
  | "network"
  | "timeout"
  | "rate_limit"
  | "cancelled"
  | "interrupted"
  | "tool"
  | "media"
  | "internal";

const ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
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

const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
export const MAX_ERROR_CODE_UTF8_BYTES = 128;

export function isValidErrorCode(code: unknown): code is string {
  if (typeof code !== "string" || code.length > MAX_ERROR_CODE_UTF8_BYTES) return false;
  return ERROR_CODE_PATTERN.exec(code)?.[0] === code;
}

export const TVIC_ERROR_NAMES = Object.freeze({
  AuthError: "AuthError",
  RateLimitError: "RateLimitError",
  InvalidRequestError: "InvalidRequestError",
  ConnectionError: "ConnectionError",
  ProviderError: "ProviderError",
  SignatureError: "SignatureError",
  ValidationError: "ValidationError",
  TimeoutError: "TimeoutError",
  InternalError: "InternalError",
  MediaError: "MediaError",
  ToolError: "ToolError",
  CancelledError: "CancelledError",
  InterruptedError: "InterruptedError",
  UnknownError: "UnknownError",
} as const);

export type TvicErrorName = (typeof TVIC_ERROR_NAMES)[keyof typeof TVIC_ERROR_NAMES];

const TVIC_ERROR_NAME_SET: ReadonlySet<string> = new Set<TvicErrorName>(
  Object.values(TVIC_ERROR_NAMES),
);

type NonEmptyErrorNameList = readonly [TvicErrorName, ...TvicErrorName[]];

const ERROR_NAMES_BY_CATEGORY = Object.freeze({
  validation: [TVIC_ERROR_NAMES.ValidationError, TVIC_ERROR_NAMES.InvalidRequestError],
  auth: [TVIC_ERROR_NAMES.AuthError, TVIC_ERROR_NAMES.SignatureError],
  provider: [TVIC_ERROR_NAMES.ProviderError],
  network: [TVIC_ERROR_NAMES.ConnectionError],
  timeout: [TVIC_ERROR_NAMES.TimeoutError],
  rate_limit: [TVIC_ERROR_NAMES.RateLimitError],
  cancelled: [TVIC_ERROR_NAMES.CancelledError],
  interrupted: [TVIC_ERROR_NAMES.InterruptedError],
  tool: [TVIC_ERROR_NAMES.ToolError],
  media: [TVIC_ERROR_NAMES.MediaError],
  internal: [TVIC_ERROR_NAMES.InternalError, TVIC_ERROR_NAMES.UnknownError],
} as const satisfies Readonly<Record<ErrorCategory, NonEmptyErrorNameList>>);

const DEFAULT_ERROR_NAME_BY_CATEGORY = Object.freeze(
  Object.fromEntries(
    (Object.keys(ERROR_NAMES_BY_CATEGORY) as ErrorCategory[]).map((category) => [
      category,
      ERROR_NAMES_BY_CATEGORY[category][0],
    ]),
  ),
) as Readonly<Record<ErrorCategory, TvicErrorName>>;

export function isTvicErrorName(value: unknown): value is TvicErrorName {
  return typeof value === "string" && TVIC_ERROR_NAME_SET.has(value);
}

function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && ERROR_CATEGORIES.has(value as ErrorCategory);
}

export const TVIC_ERROR_MARKER: unique symbol = Symbol.for("tvic.error");

export interface NormalizedError {
  readonly name: TvicErrorName;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retriable: boolean;
  readonly provider?: string;
  readonly cause?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ErrorFactoryOptions {
  readonly category?: ErrorCategory;
  readonly retriable?: boolean;
  readonly provider?: string;
  readonly cause?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const TRUSTED_NORMALIZED_ERRORS = new WeakSet<object>();

interface NormalizedErrorProperties {
  readonly name: unknown | typeof MISSING_JSON_PROPERTY;
  readonly code: unknown | typeof MISSING_JSON_PROPERTY;
  readonly category: unknown | typeof MISSING_JSON_PROPERTY;
  readonly message: unknown | typeof MISSING_JSON_PROPERTY;
  readonly retriable: unknown | typeof MISSING_JSON_PROPERTY;
  readonly provider: unknown | typeof MISSING_JSON_PROPERTY;
  readonly cause: unknown | typeof MISSING_JSON_PROPERTY;
  readonly metadata: unknown | typeof MISSING_JSON_PROPERTY;
}

interface ValidNormalizedErrorProperties extends NormalizedErrorProperties {
  readonly name: TvicErrorName;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retriable: boolean;
  readonly provider: string | undefined | typeof MISSING_JSON_PROPERTY;
}

function readNormalizedErrorProperties(value: object): NormalizedErrorProperties {
  return {
    name: jsonDataProperty(value, "name"),
    code: jsonDataProperty(value, "code"),
    category: jsonDataProperty(value, "category"),
    message: jsonDataProperty(value, "message"),
    retriable: jsonDataProperty(value, "retriable"),
    provider: jsonDataProperty(value, "provider"),
    cause: jsonDataProperty(value, "cause"),
    metadata: jsonDataProperty(value, "metadata"),
  };
}

function hasValidNormalizedErrorProperties(
  properties: NormalizedErrorProperties,
): properties is ValidNormalizedErrorProperties {
  const { name, code, category, message, retriable, provider, cause, metadata } = properties;
  return (
    isTvicErrorName(name) &&
    isValidErrorCode(code) &&
    isErrorCategory(category) &&
    ERROR_NAMES_BY_CATEGORY[category].some((candidate) => candidate === name) &&
    typeof message === "string" &&
    message.length > 0 &&
    typeof retriable === "boolean" &&
    cause !== ACCESSOR_JSON_PROPERTY &&
    (provider === MISSING_JSON_PROPERTY ||
      provider === undefined ||
      typeof provider === "string") &&
    (metadata === MISSING_JSON_PROPERTY ||
      metadata === undefined ||
      (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)))
  );
}

function normalizedErrorSnapshot(value: unknown): NormalizedError | null {
  if (typeof value !== "object" || value === null) return null;

  const properties = readNormalizedErrorProperties(value);
  if (!hasValidNormalizedErrorProperties(properties)) return null;
  const { name, code, category, message, retriable, provider, cause, metadata } = properties;

  if (TRUSTED_NORMALIZED_ERRORS.has(value)) return value as NormalizedError;
  return trustedNormalizedError({
    name,
    code,
    category,
    message,
    retriable,
    ...(provider !== MISSING_JSON_PROPERTY && provider !== undefined ? { provider } : {}),
    ...(cause !== MISSING_JSON_PROPERTY && cause !== undefined ? { cause } : {}),
    ...(metadata !== MISSING_JSON_PROPERTY && metadata !== undefined
      ? { metadata: metadata as Readonly<Record<string, unknown>> }
      : {}),
  });
}

function trustedNormalizedError(error: NormalizedError): NormalizedError {
  Object.freeze(error);
  TRUSTED_NORMALIZED_ERRORS.add(error);
  return error;
}

function withErrorName(error: NormalizedError, name: TvicErrorName): NormalizedError {
  return trustedNormalizedError({ ...error, name });
}

export function isNormalizedError(value: unknown): value is NormalizedError {
  if (typeof value !== "object" || value === null) return false;
  try {
    return hasValidNormalizedErrorProperties(readNormalizedErrorProperties(value));
  } catch {
    return false;
  }
}

export function unknownErrorMessage(error: unknown): string {
  try {
    if (typeof error === "symbol") {
      return error.toString();
    }
    if (isErrorLike(error)) {
      return error.message;
    }
    if (typeof error === "object" && error !== null) {
      const message = jsonDataProperty(error, "message");
      if (typeof message === "string") return message;
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}

interface ErrorLike {
  readonly name?: unknown;
  readonly message: string;
  readonly cause?: unknown;
}

type NormalizeUnknownErrorOptions = {
  readonly code: string;
  readonly category?: ErrorCategory;
  readonly provider?: string;
  readonly retriable?: boolean;
};

function isErrorLike(value: unknown): value is ErrorLike {
  if (typeof value !== "object" || value === null) return false;
  if (
    exceedsJsonCausePrototypeDepth(value) ||
    hasAccessorInPrototypeChain(value, Symbol.toStringTag)
  ) {
    return false;
  }
  try {
    if (typeof jsonDataProperty(value, "message") !== "string") return false;
    if (value instanceof Error) {
      return true;
    }
    return Object.prototype.toString.call(value) === "[object Error]";
  } catch {
    return false;
  }
}

function nonEmptyErrorMessage(error: unknown): string {
  const message = unknownErrorMessage(error);
  return typeof message === "string" && message.length > 0 ? message : "Unknown error";
}

function assertErrorCode(code: unknown): asserts code is string {
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("Normalized error code must be a non-empty string");
  }
  if (code.length > MAX_ERROR_CODE_UTF8_BYTES) {
    throw new TypeError("Normalized error code must not exceed 128 UTF-8 bytes");
  }
  if (!isValidErrorCode(code)) {
    throw new TypeError(
      "Normalized error code must match /^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$/",
    );
  }
}

export function normalizeLegacyError(value: unknown): NormalizedError | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  try {
    const properties = readNormalizedErrorProperties(value);
    const { name, code, category, message, retriable, provider, cause, metadata } = properties;
    if (name !== MISSING_JSON_PROPERTY && name !== undefined) {
      return null;
    }
    if (
      !isValidErrorCode(code) ||
      !isErrorCategory(category) ||
      typeof message !== "string" ||
      message.length === 0 ||
      typeof retriable !== "boolean" ||
      cause === ACCESSOR_JSON_PROPERTY ||
      (provider !== MISSING_JSON_PROPERTY &&
        provider !== undefined &&
        typeof provider !== "string") ||
      (metadata !== MISSING_JSON_PROPERTY &&
        metadata !== undefined &&
        (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)))
    ) {
      return null;
    }

    return trustedNormalizedError({
      name: DEFAULT_ERROR_NAME_BY_CATEGORY[category],
      code,
      category,
      message,
      retriable,
      ...(provider !== MISSING_JSON_PROPERTY && provider !== undefined ? { provider } : {}),
      ...(cause !== MISSING_JSON_PROPERTY && cause !== undefined ? { cause } : {}),
      ...(metadata !== MISSING_JSON_PROPERTY && metadata !== undefined
        ? { metadata: metadata as Readonly<Record<string, unknown>> }
        : {}),
    });
  } catch {
    return null;
  }
}

export function normalizeUnknownError(
  error: unknown,
  options: NormalizeUnknownErrorOptions,
): NormalizedError {
  assertErrorCode(options.code);
  const marked = markedThrowablePayload(error);
  if (marked) {
    return marked;
  }
  const normalized = normalizedErrorSnapshot(error);
  if (normalized) return normalized;
  const legacy = normalizeLegacyError(error);
  if (legacy) {
    return legacy;
  }
  return normalizedErrorFromUnknown(error, options);
}

export function normalizedErrorFromUnknown(
  error: unknown,
  options: NormalizeUnknownErrorOptions,
): NormalizedError {
  return normalizedError(options.code, nonEmptyErrorMessage(error), {
    ...(options.category ? { category: options.category } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(typeof options.retriable === "boolean" ? { retriable: options.retriable } : {}),
    cause: error,
  });
}

function markedThrowablePayload(value: unknown): NormalizedError | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  try {
    if (jsonDataProperty(value, TVIC_ERROR_MARKER) !== true) {
      return null;
    }
    const payload = jsonDataProperty(value, "error");
    if (payload === MISSING_JSON_PROPERTY) return null;
    return normalizedErrorSnapshot(payload) ?? normalizeLegacyError(payload);
  } catch {
    return null;
  }
}

export function normalizedError(
  code: string,
  message: string,
  options: ErrorFactoryOptions = {},
): NormalizedError {
  const category = options.category ?? "internal";
  assertErrorCode(code);
  if (typeof message !== "string" || message.length === 0) {
    throw new TypeError("Normalized error message must be a non-empty string");
  }
  if (!isErrorCategory(category)) {
    throw new TypeError("Normalized error category is invalid");
  }
  if (options.retriable !== undefined && typeof options.retriable !== "boolean") {
    throw new TypeError("Normalized error retriable must be a boolean");
  }
  if (options.provider !== undefined && typeof options.provider !== "string") {
    throw new TypeError("Normalized error provider must be a string");
  }
  if (
    options.metadata !== undefined &&
    (typeof options.metadata !== "object" ||
      options.metadata === null ||
      Array.isArray(options.metadata))
  ) {
    throw new TypeError("Normalized error metadata must be an object");
  }
  return trustedNormalizedError({
    name: DEFAULT_ERROR_NAME_BY_CATEGORY[category],
    code,
    category,
    message,
    retriable: options.retriable ?? false,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

export function providerError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "provider",
    retriable: options.retriable ?? true,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.ProviderError);
}

export function mediaError(
  code: string,
  message = code,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "media",
  });
  return withErrorName(err, TVIC_ERROR_NAMES.MediaError);
}

export function validationError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "validation",
    retriable: false,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.ValidationError);
}

export function timeoutError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "timeout",
    retriable: options.retriable ?? true,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.TimeoutError);
}

export function internalError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "internal",
    retriable: false,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.InternalError);
}

export function authError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "auth",
    retriable: false,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.AuthError);
}

export function rateLimitError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "rate_limit",
    retriable: true,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.RateLimitError);
}

export function connectionError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "network",
    retriable: options.retriable ?? true,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.ConnectionError);
}

export function signatureError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "auth",
    retriable: false,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.SignatureError);
}

export function cancelledError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "cancelled",
    retriable: false,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.CancelledError);
}

export function interruptedError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "interrupted",
    retriable: false,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.InterruptedError);
}

export function toolError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  const err = normalizedError(code, message, {
    ...options,
    category: "tool",
    retriable: options.retriable ?? true,
  });
  return withErrorName(err, TVIC_ERROR_NAMES.ToolError);
}

export function normalizedErrorFromErrorLike(value: ErrorLike): NormalizedError {
  const nameValue = jsonDataProperty(value, "name");
  const name = typeof nameValue === "string" ? nameValue : "unknown";
  const cause = jsonDataProperty(value, "cause");
  const derivedCode = `error.${errorNameCodeSegment(name)}`;
  const code = derivedCode.length <= MAX_ERROR_CODE_UTF8_BYTES ? derivedCode : "unknown.error";
  return normalizedError(code, nonEmptyErrorMessage(value), {
    category: "internal",
    retriable: false,
    cause: cause === MISSING_JSON_PROPERTY || cause === ACCESSOR_JSON_PROPERTY ? value : cause,
  });
}

export class TvicThrowableError extends Error {
  readonly [TVIC_ERROR_MARKER] = true as const;
  readonly error: NormalizedError;
  override readonly name: TvicErrorName;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retriable: boolean;
  readonly provider?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(error: NormalizedError) {
    const safeError = normalizedErrorSnapshot(error);
    if (!safeError) {
      throw new TypeError("TvicThrowableError requires a valid NormalizedError");
    }
    super(safeError.message);
    this.name = safeError.name;
    this.error = safeError;
    this.code = safeError.code;
    this.category = safeError.category;
    this.retriable = safeError.retriable;
    if (safeError.provider !== undefined) {
      this.provider = safeError.provider;
    }
    if (safeError.metadata !== undefined) {
      this.metadata = safeError.metadata;
    }
    if (safeError.cause !== undefined) {
      this.cause = safeError.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static from(value: unknown): TvicThrowableError {
    const marked = markedThrowablePayload(value);
    if (marked) {
      try {
        if (value instanceof TvicThrowableError) {
          return value;
        }
      } catch {}
      return new TvicThrowableError(marked);
    }
    const normalized = normalizedErrorSnapshot(value);
    if (normalized) {
      return new TvicThrowableError(normalized);
    }
    const legacy = normalizeLegacyError(value);
    if (legacy) {
      return new TvicThrowableError(legacy);
    }
    if (isErrorLike(value)) {
      const inner = normalizedErrorFromErrorLike(value);
      return new TvicThrowableError(inner);
    }
    const fallback = normalizedError("unknown.error", nonEmptyErrorMessage(value), {
      category: "internal",
      retriable: false,
      cause: value,
    });
    return new TvicThrowableError(fallback);
  }

  toJSON(): NormalizedError {
    return jsonSerializableNormalizedError(this.error);
  }
}

export function jsonSerializableNormalizedError(
  error: NormalizedError,
  transformString?: (value: string) => string,
): NormalizedError {
  const snapshot = normalizedErrorSnapshot(error);
  if (!snapshot) {
    throw new TypeError("Cannot serialize an invalid NormalizedError");
  }
  return serializeNormalizedError(snapshot, TVIC_ERROR_MARKER, isNormalizedError, transformString);
}

function errorNameCodeSegment(name: string): string {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (normalized.length === 0) return "unknown";
  return /^[a-z]/.test(normalized) ? normalized : `error_${normalized}`;
}

export function isTvicError(value: unknown): value is NormalizedError | TvicThrowableError {
  try {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    return normalizedErrorSnapshot(value) !== null && markedThrowablePayload(value) !== null;
  } catch {
    return false;
  }
}

export function normalizedErrorFromTvicError(value: unknown): NormalizedError | null {
  if (typeof value !== "object" || value === null || normalizedErrorSnapshot(value) === null) {
    return null;
  }
  return markedThrowablePayload(value);
}

export function tvicErrorFromJSON(value: unknown): NormalizedError | null {
  return normalizedErrorSnapshot(value);
}
