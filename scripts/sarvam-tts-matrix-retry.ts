export function isRetriable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retriable" in error &&
    (error as { retriable?: unknown }).retriable === true
  );
}

export function isCreditExhausted(error: unknown): boolean {
  const metadata =
    typeof error === "object" && error !== null && "metadata" in error
      ? (error as { metadata?: unknown }).metadata
      : undefined;
  const providerCode =
    typeof metadata === "object" && metadata !== null && "providerCode" in metadata
      ? (metadata as { providerCode?: unknown }).providerCode
      : undefined;
  if (providerCode === "insufficient_quota_error") return true;
  if (providerCode === "rate_limit_exceeded_error") return false;
  const httpStatus =
    typeof metadata === "object" && metadata !== null && "httpStatus" in metadata
      ? (metadata as { httpStatus?: unknown }).httpStatus
      : undefined;
  if (errorCode(error) === "provider.rate_limited" && (httpStatus === 429 || httpStatus === 503)) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /credit|balance|quota/.test(
    `${message} ${typeof providerCode === "string" ? providerCode : ""}`.toLowerCase(),
  );
}

export function shouldRetrySarvamTtsMatrixError(error: unknown): boolean {
  return (
    isRetriable(error) &&
    !isCreditExhausted(error) &&
    !isAmbiguousSarvamTtsMatrixOutcome(error) &&
    errorCode(error) === "provider.rate_limited"
  );
}

/**
 * A provider outcome is ambiguous unless the error explicitly says the
 * request was rejected before synthesis. Matrix resume must not replay these
 * requests without an operator decision because Sarvam exposes no idempotency
 * key for TTS synthesis.
 */
export function isAmbiguousSarvamTtsMatrixOutcome(error: unknown): boolean {
  const metadata =
    typeof error === "object" && error !== null && "metadata" in error
      ? (error as { metadata?: unknown }).metadata
      : undefined;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "outcomeUnknown" in metadata &&
    metadata.outcomeUnknown === true
  ) {
    return true;
  }
  const code = errorCode(error);
  return !new Set([
    "provider.auth_failed",
    "provider.invalid_request",
    "provider.input_rejected",
    "provider.model_unsupported",
    "provider.voice_unsupported",
    "provider.quota_exceeded",
    "provider.rate_limited",
  ]).has(code ?? "");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
