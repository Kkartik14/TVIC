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

/**
 * Canonical error names used on `NormalizedError.name` and by `tvicErrorFromJSON`
 * to identify errors after JSON round-trips (the `Symbol.for('tvic.error')`
 * marker on `TvicThrowableError` is lost in JSON).
 *
 * Frozen at module load so third parties cannot mutate the registry at
 * runtime.
 */
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

const DEFAULT_ERROR_NAME_BY_CATEGORY: Readonly<Record<ErrorCategory, TvicErrorName>> = {
  validation: TVIC_ERROR_NAMES.ValidationError,
  auth: TVIC_ERROR_NAMES.AuthError,
  provider: TVIC_ERROR_NAMES.ProviderError,
  network: TVIC_ERROR_NAMES.ConnectionError,
  timeout: TVIC_ERROR_NAMES.TimeoutError,
  rate_limit: TVIC_ERROR_NAMES.RateLimitError,
  cancelled: TVIC_ERROR_NAMES.CancelledError,
  interrupted: TVIC_ERROR_NAMES.InterruptedError,
  tool: TVIC_ERROR_NAMES.ToolError,
  media: TVIC_ERROR_NAMES.MediaError,
  internal: TVIC_ERROR_NAMES.InternalError,
};

// A name is a semantic alias for a category, not an independent free-form
// label. SignatureError is intentionally the auth-specific alias, while the
// legacy InvalidRequestError and UnknownError names remain valid in their
// corresponding categories for JSON/persistence compatibility.
const ERROR_NAMES_BY_CATEGORY: Readonly<Record<ErrorCategory, ReadonlySet<TvicErrorName>>> = {
  validation: new Set([TVIC_ERROR_NAMES.ValidationError, TVIC_ERROR_NAMES.InvalidRequestError]),
  auth: new Set([TVIC_ERROR_NAMES.AuthError, TVIC_ERROR_NAMES.SignatureError]),
  provider: new Set([TVIC_ERROR_NAMES.ProviderError]),
  network: new Set([TVIC_ERROR_NAMES.ConnectionError]),
  timeout: new Set([TVIC_ERROR_NAMES.TimeoutError]),
  rate_limit: new Set([TVIC_ERROR_NAMES.RateLimitError]),
  cancelled: new Set([TVIC_ERROR_NAMES.CancelledError]),
  interrupted: new Set([TVIC_ERROR_NAMES.InterruptedError]),
  tool: new Set([TVIC_ERROR_NAMES.ToolError]),
  media: new Set([TVIC_ERROR_NAMES.MediaError]),
  internal: new Set([TVIC_ERROR_NAMES.InternalError, TVIC_ERROR_NAMES.UnknownError]),
};

export function isTvicErrorName(value: unknown): value is TvicErrorName {
  return typeof value === "string" && TVIC_ERROR_NAME_SET.has(value);
}

function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && ERROR_CATEGORIES.has(value as ErrorCategory);
}

/**
 * The cross-realm marker for TVIC errors. Lives on the `TvicThrowableError`
 * class instance, not on `NormalizedError`, because `JSON.stringify` strips
 * symbol-keyed properties. Use `tvicErrorFromJSON()` to re-hydrate.
 */
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

export function isNormalizedError(value: unknown): value is NormalizedError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    const candidate = value as Record<string, unknown>;
    const category = candidate.category;
    const name = candidate.name;
    return (
      isTvicErrorName(name) &&
      typeof candidate.code === "string" &&
      candidate.code.length > 0 &&
      isErrorCategory(category) &&
      ERROR_NAMES_BY_CATEGORY[category].has(name) &&
      typeof candidate.message === "string" &&
      candidate.message.length > 0 &&
      typeof candidate.retriable === "boolean" &&
      (candidate.provider === undefined || typeof candidate.provider === "string") &&
      (candidate.metadata === undefined ||
        (typeof candidate.metadata === "object" &&
          candidate.metadata !== null &&
          !Array.isArray(candidate.metadata)))
    );
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
    if (
      typeof error === "object" &&
      error !== null &&
      typeof (error as { readonly message?: unknown }).message === "string"
    ) {
      return (error as { readonly message: string }).message;
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

function isErrorLike(value: unknown): value is ErrorLike {
  try {
    if (value instanceof Error) {
      return true;
    }
    return (
      typeof value === "object" &&
      value !== null &&
      Object.prototype.toString.call(value) === "[object Error]" &&
      typeof (value as { readonly message?: unknown }).message === "string"
    );
  } catch {
    return false;
  }
}

function nonEmptyErrorMessage(error: unknown): string {
  const message = unknownErrorMessage(error);
  return message.length > 0 ? message : "Unknown error";
}

/**
 * Recognizes the pre-v2 normalized shape that did not carry `name`, then
 * upgrades it to the canonical name for its category. This is deliberately
 * separate from `isNormalizedError`: new callers must still be able to tell
 * whether a value is already current, while compatibility boundaries can
 * preserve old provider/runtime errors instead of reclassifying them.
 */
export function normalizeLegacyError(value: unknown): NormalizedError | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  try {
    const candidate = value as Record<string, unknown>;
    if (candidate.name !== undefined) {
      return null;
    }
    const category = candidate.category;
    if (
      typeof candidate.code !== "string" ||
      candidate.code.length === 0 ||
      !isErrorCategory(category) ||
      typeof candidate.message !== "string" ||
      candidate.message.length === 0 ||
      typeof candidate.retriable !== "boolean" ||
      (candidate.provider !== undefined && typeof candidate.provider !== "string") ||
      (candidate.metadata !== undefined &&
        (typeof candidate.metadata !== "object" ||
          candidate.metadata === null ||
          Array.isArray(candidate.metadata)))
    ) {
      return null;
    }

    const migrated: NormalizedError = {
      name: DEFAULT_ERROR_NAME_BY_CATEGORY[category],
      code: candidate.code,
      category,
      message: candidate.message,
      retriable: candidate.retriable,
      ...(candidate.provider !== undefined ? { provider: candidate.provider } : {}),
      ...(candidate.cause !== undefined ? { cause: candidate.cause } : {}),
      ...(candidate.metadata !== undefined
        ? { metadata: candidate.metadata as Readonly<Record<string, unknown>> }
        : {}),
    };
    return isNormalizedError(migrated) ? migrated : null;
  } catch {
    return null;
  }
}

export function normalizeUnknownError(
  error: unknown,
  options: {
    readonly code: string;
    readonly category?: ErrorCategory;
    readonly provider?: string;
    readonly retriable?: boolean;
  },
): NormalizedError {
  if (isNormalizedError(error)) {
    return error;
  }
  const marked = markedThrowablePayload(error);
  if (marked) {
    return marked;
  }
  const legacy = normalizeLegacyError(error);
  if (legacy) {
    return legacy;
  }
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
    const candidate = value as Record<symbol, unknown> & { readonly error?: unknown };
    if (candidate[TVIC_ERROR_MARKER] !== true) {
      return null;
    }
    if (isNormalizedError(candidate.error)) {
      return candidate.error;
    }
    return normalizeLegacyError(candidate.error);
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
  if (typeof code !== "string" || code.length === 0) {
    throw new TypeError("Normalized error code must be a non-empty string");
  }
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
  return {
    name: DEFAULT_ERROR_NAME_BY_CATEGORY[category],
    code,
    category,
    message,
    retriable: options.retriable ?? false,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
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
  return { ...err, name: TVIC_ERROR_NAMES.ProviderError };
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
  return { ...err, name: TVIC_ERROR_NAMES.MediaError };
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
  return { ...err, name: TVIC_ERROR_NAMES.ValidationError };
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
  return { ...err, name: TVIC_ERROR_NAMES.TimeoutError };
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
  return { ...err, name: TVIC_ERROR_NAMES.InternalError };
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
  return { ...err, name: TVIC_ERROR_NAMES.AuthError };
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
  return { ...err, name: TVIC_ERROR_NAMES.RateLimitError };
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
  return { ...err, name: TVIC_ERROR_NAMES.ConnectionError };
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
  return { ...err, name: TVIC_ERROR_NAMES.SignatureError };
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
  return { ...err, name: TVIC_ERROR_NAMES.CancelledError };
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
  return { ...err, name: TVIC_ERROR_NAMES.InterruptedError };
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
  return { ...err, name: TVIC_ERROR_NAMES.ToolError };
}

/**
 * A throwable Error that carries a `NormalizedError` and the cross-realm
 * `Symbol.for('tvic.error')` marker. Use `TvicThrowableError.from(value)`
 * to construct — it normalizes unknown values, preserves the original cause,
 * and reuses already-thrown `TvicThrowableError` instances.
 *
 * Note: the marker is lost in `JSON.stringify` because symbol-keyed
 * properties are dropped. Use `tvicErrorFromJSON()` to re-hydrate.
 * Error-like values from another realm in the same JavaScript agent are
 * recognized by their intrinsic Error tag, not only by `instanceof`.
 */
export class TvicThrowableError extends Error {
  readonly [TVIC_ERROR_MARKER] = true as const;
  readonly error: NormalizedError;
  override readonly name: TvicErrorName;
  // Convenience accessors as own properties so `toMatchObject({code, ...})`
  // works in vitest. We assign them in the constructor.
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retriable: boolean;
  readonly provider?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(error: NormalizedError) {
    if (!isNormalizedError(error)) {
      throw new TypeError("TvicThrowableError requires a valid NormalizedError");
    }
    super(error.message);
    this.name = error.name;
    this.error = error;
    this.code = error.code;
    this.category = error.category;
    this.retriable = error.retriable;
    if (error.provider !== undefined) {
      this.provider = error.provider;
    }
    if (error.metadata !== undefined) {
      this.metadata = error.metadata;
    }
    if (error.cause !== undefined) {
      this.cause = error.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static from(value: unknown): TvicThrowableError {
    if (value instanceof TvicThrowableError && isNormalizedError(value.error)) {
      return value;
    }
    const marked = markedThrowablePayload(value);
    if (marked) {
      return new TvicThrowableError(marked);
    }
    if (isNormalizedError(value)) {
      return new TvicThrowableError(value);
    }
    const legacy = normalizeLegacyError(value);
    if (legacy) {
      return new TvicThrowableError(legacy);
    }
    if (isErrorLike(value)) {
      const name = typeof value.name === "string" ? value.name : "unknown";
      const code = `error.${name}`;
      const inner = normalizedError(code, nonEmptyErrorMessage(value), {
        category: "internal",
        retriable: false,
        cause: value.cause !== undefined ? value.cause : value,
      });
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
    return this.error.cause === undefined
      ? this.error
      : { ...this.error, cause: jsonSerializableCause(this.error.cause) };
  }
}

function jsonSerializableCause(cause: unknown): unknown {
  const marked = markedThrowablePayload(cause);
  if (marked) {
    return errorCauseSummary(marked);
  }
  if (isNormalizedError(cause)) {
    return errorCauseSummary(cause);
  }
  if (cause instanceof TvicThrowableError && isNormalizedError(cause.error)) {
    return errorCauseSummary(cause.error);
  }
  if (isErrorLike(cause)) {
    return {
      name: typeof cause.name === "string" ? cause.name : "Error",
      message: cause.message,
    };
  }
  return cause;
}

function errorCauseSummary(error: NormalizedError): Readonly<Record<string, string>> {
  return { name: error.name, code: error.code, message: error.message };
}

/**
 * Type guard that detects a `TvicThrowableError` instance *or* any object
 * that carries the cross-realm `Symbol.for('tvic.error')` marker. Works
 * across Web Workers, iframes, and `vm` contexts because `Symbol.for` is
 * the only symbol-sharing primitive within the same JavaScript agent. Separate
 * workers require JSON serialization or another explicit transport.
 *
 * The marker is an *identity tag*, not a security boundary: a hostile party
 * who can write into your realm can also fake the marker. The structural
 * companion to this guard is `isNormalizedError`, which checks the actual
 * `NormalizedError` field shape.
 *
 * Does NOT work across `JSON.parse` boundaries — use `tvicErrorFromJSON()`.
 */
export function isTvicError(value: unknown): value is NormalizedError | TvicThrowableError {
  try {
    if (value instanceof TvicThrowableError) {
      return isNormalizedError(value.error) && isNormalizedError(value);
    }
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Record<symbol, unknown>;
    if (candidate[TVIC_ERROR_MARKER] !== true) {
      return false;
    }
    // The marker is present, but a real TVIC error also satisfies the
    // structural `NormalizedError` shape. Without this check, the type guard
    // would lie: callers reading `error.name`, `error.code`, etc. would crash.
    return isNormalizedError(value);
  } catch {
    return false;
  }
}

/**
 * Re-hydrate a `NormalizedError` after a `JSON.parse` round-trip. The
 * `Symbol.for('tvic.error')` marker is lost in JSON, so `isTvicError()`
 * returns `false` for parsed values. This factory re-derives the TVIC
 * identity by checking the `name` field against the canonical
 * `TVIC_ERROR_NAMES` set.
 *
 * Returns `null` if the value cannot be re-hydrated to a valid
 * `NormalizedError` (unknown name, empty message, wrong field types).
 * Callers should always null-check the return value.
 */
export function tvicErrorFromJSON(value: unknown): NormalizedError | null {
  // JSON.parse produces the plain structural representation already. Do not
  // silently fill malformed fields with normalizedError() defaults: that would
  // turn an invalid payload into a different, apparently valid error.
  return isNormalizedError(value) ? value : null;
}
