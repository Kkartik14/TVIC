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

const ERROR_CATEGORIES: ReadonlySet<string> = new Set<ErrorCategory>([
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

export interface NormalizedError {
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
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.category === "string" &&
    ERROR_CATEGORIES.has(candidate.category) &&
    typeof candidate.message === "string" &&
    candidate.message.length > 0 &&
    typeof candidate.retriable === "boolean" &&
    (candidate.provider === undefined || typeof candidate.provider === "string") &&
    (candidate.metadata === undefined ||
      (typeof candidate.metadata === "object" &&
        candidate.metadata !== null &&
        !Array.isArray(candidate.metadata)))
  );
}

export function normalizedError(
  code: string,
  message: string,
  options: ErrorFactoryOptions = {},
): NormalizedError {
  return {
    code,
    category: options.category ?? "internal",
    message,
    retriable: options.retriable ?? false,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.cause ? { cause: options.cause } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

export function providerError(
  code: string,
  message: string,
  options: ErrorFactoryOptions = {},
): NormalizedError {
  return normalizedError(code, message, {
    ...options,
    category: options.category ?? "provider",
    retriable: options.retriable ?? true,
  });
}

export function mediaError(
  code: string,
  message = code,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  return normalizedError(code, message, {
    ...options,
    category: "media",
  });
}

export function validationError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  return normalizedError(code, message, {
    ...options,
    category: "validation",
    retriable: false,
  });
}

export function timeoutError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category"> = {},
): NormalizedError {
  return normalizedError(code, message, {
    ...options,
    category: "timeout",
    retriable: options.retriable ?? true,
  });
}

export function internalError(
  code: string,
  message: string,
  options: Omit<ErrorFactoryOptions, "category" | "retriable"> = {},
): NormalizedError {
  return normalizedError(code, message, {
    ...options,
    category: "internal",
    retriable: false,
  });
}

export function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  return normalizedError(options.code, unknownErrorMessage(error), {
    ...(options.category ? { category: options.category } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(typeof options.retriable === "boolean" ? { retriable: options.retriable } : {}),
    cause: error,
  });
}
