import { providerError, TVIC_ERROR_CODES, type NormalizedError } from "@tvic/core";

export const MAX_PROVIDER_ERROR_BODY_BYTES = 16 * 1024;
export const MAX_PROVIDER_ERROR_FIELD_CHARS = 4_096;
export const MAX_PROVIDER_ERROR_CODE_CHARS = 128;

type ProviderErrorClassificationKind =
  | "auth"
  | "quota_exceeded"
  | "rate_limited"
  | "invalid_request"
  | "upstream"
  | "protocol";

export interface ProviderErrorClassificationInput {
  readonly status?: number;
  readonly providerCode?: unknown;
  readonly providerType?: unknown;
  readonly message?: unknown;
  readonly bodyTruncated?: boolean;
  readonly bodyMalformed?: boolean;
}

export interface ProviderErrorClassification {
  readonly code: string;
  readonly retriable: boolean;
  readonly classification: ProviderErrorClassificationKind;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const EXHAUSTION_CODES = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "credits_exhausted",
  "balance_exhausted",
  "billing_required",
  "blocked_api_access",
]);
const EXHAUSTION_MESSAGES = new Set(["quota exceeded", "credits exhausted"]);
const AUTH_CODES = new Set([
  "invalid_api_key",
  "authentication_failed",
  "invalid_token",
  "unauthorized",
  "forbidden",
  "permission_denied",
]);
const INVALID_CODES = new Set([
  "invalid_request",
  "invalid_request_error",
  "invalid_model",
  "model_not_found",
  "unsupported_model",
  "invalid_voice",
  "unsupported_voice",
  "context_length_exceeded",
  "invalid_parameter",
  "invalid_schema",
]);
const RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "too_many_requests", "throttled"]);
const UPSTREAM_CODES = new Set([
  "capacity_exceeded",
  "conflict",
  "internal_server_error",
  "service_unavailable",
  "server_error",
  "upstream_error",
]);

export function classifyProviderError(
  input: ProviderErrorClassificationInput,
): ProviderErrorClassification {
  const code = boundedNormalizedToken(input.providerCode, MAX_PROVIDER_ERROR_CODE_CHARS);
  const type = boundedNormalizedToken(input.providerType, MAX_PROVIDER_ERROR_CODE_CHARS);
  const message = boundedNormalizedMessage(input.message);
  const statuses = validStatus(input.status) ? input.status : undefined;
  const oversized = hasOversizedField(input);
  const bodyMalformed = input.bodyMalformed === true;
  const candidates = [code, type].filter((value): value is string => value !== undefined);
  const metadata = {
    ...(statuses !== undefined ? { httpStatus: statuses } : {}),
    ...(boundedOriginal(input.providerCode, MAX_PROVIDER_ERROR_CODE_CHARS)
      ? { providerCode: boundedOriginal(input.providerCode, MAX_PROVIDER_ERROR_CODE_CHARS) }
      : {}),
    ...(boundedOriginal(input.providerType, MAX_PROVIDER_ERROR_CODE_CHARS)
      ? { providerType: boundedOriginal(input.providerType, MAX_PROVIDER_ERROR_CODE_CHARS) }
      : {}),
    ...(input.bodyTruncated === true ? { bodyTruncated: true } : {}),
    ...(bodyMalformed ? { bodyMalformed: true } : {}),
    ...(oversized ? { boundedFieldRejected: true } : {}),
  } satisfies Readonly<Record<string, unknown>>;

  if (
    candidates.some((candidate) => EXHAUSTION_CODES.has(candidate)) ||
    (message !== undefined && EXHAUSTION_MESSAGES.has(message))
  ) {
    return result(TVIC_ERROR_CODES.providerQuotaExceeded, false, "quota_exceeded", metadata);
  }

  if (
    statuses === 402 &&
    !candidates.some((candidate) =>
      ["invalid_api_key", "authentication_failed", "invalid_token"].includes(candidate),
    )
  ) {
    return result(TVIC_ERROR_CODES.providerQuotaExceeded, false, "quota_exceeded", metadata);
  }

  if (candidates.some((candidate) => AUTH_CODES.has(candidate))) {
    return result(TVIC_ERROR_CODES.providerAuthFailed, false, "auth", metadata);
  }

  if (candidates.some((candidate) => INVALID_CODES.has(candidate))) {
    return result(TVIC_ERROR_CODES.providerInvalidRequest, false, "invalid_request", metadata);
  }

  if (statuses === 429 || candidates.some((candidate) => RATE_LIMIT_CODES.has(candidate))) {
    return result(TVIC_ERROR_CODES.providerRateLimited, true, "rate_limited", metadata);
  }

  if (
    (statuses === 498 && candidates.includes("capacity_exceeded")) ||
    (statuses === 409 && candidates.includes("conflict")) ||
    statuses === 408 ||
    (statuses !== undefined && statuses >= 500 && statuses <= 599) ||
    candidates.some((candidate) => UPSTREAM_CODES.has(candidate))
  ) {
    return result(TVIC_ERROR_CODES.providerUpstreamFailed, true, "upstream", metadata);
  }

  if (statuses === 400) {
    return result(TVIC_ERROR_CODES.providerInvalidRequest, false, "invalid_request", metadata);
  }
  if (statuses === 409) {
    return result(TVIC_ERROR_CODES.providerProtocolInvalid, false, "protocol", metadata);
  }
  if (statuses === 401 || statuses === 403) {
    return result(TVIC_ERROR_CODES.providerAuthFailed, false, "auth", metadata);
  }
  if (statuses === 422) {
    return result(TVIC_ERROR_CODES.providerInputRejected, false, "invalid_request", metadata);
  }

  return result(TVIC_ERROR_CODES.providerProtocolInvalid, false, "protocol", metadata);
}

export function classifiedProviderError(
  provider: string,
  message: string,
  input: ProviderErrorClassificationInput,
): NormalizedError {
  const classification = classifyProviderError(input);
  return providerError(classification.code, message, {
    provider,
    retriable: classification.retriable,
    metadata: {
      ...classification.metadata,
      classification: classification.classification,
    },
  });
}

export async function readBoundedProviderErrorBody(
  response: Response,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = MAX_PROVIDER_ERROR_BODY_BYTES - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    truncated,
  };
}

function result(
  code: string,
  retriable: boolean,
  classification: ProviderErrorClassificationKind,
  metadata: Readonly<Record<string, unknown>>,
): ProviderErrorClassification {
  return { code, retriable, classification, metadata };
}

function boundedOriginal(value: unknown, maxBytes: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : undefined;
}

function boundedNormalizedToken(value: unknown, max: number): string | undefined {
  const original = boundedOriginal(value, max);
  return (
    original
      ?.trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_") || undefined
  );
}

function boundedNormalizedMessage(value: unknown): string | undefined {
  const original = boundedOriginal(value, MAX_PROVIDER_ERROR_FIELD_CHARS);
  return original?.trim().toLowerCase().replaceAll(/\s+/g, " ") || undefined;
}

function hasOversizedField(input: ProviderErrorClassificationInput): boolean {
  return (
    [input.providerCode, input.providerType].some(
      (value) =>
        typeof value === "string" &&
        Buffer.byteLength(value, "utf8") > MAX_PROVIDER_ERROR_CODE_CHARS,
    ) ||
    (typeof input.message === "string" &&
      Buffer.byteLength(input.message, "utf8") > MAX_PROVIDER_ERROR_FIELD_CHARS)
  );
}

function validStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}
