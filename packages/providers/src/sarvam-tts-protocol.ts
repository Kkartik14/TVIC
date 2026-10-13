import { PROVIDER_NAMES, TVIC_ERROR_CODES } from "@tvic/core";

import { providerError } from "./common.js";

export function sarvamTtsCloseError(
  code = 1006,
  reason?: Buffer,
  audioStarted = false,
  requestSubmitted = audioStarted,
) {
  const closeReason = reason?.toString("utf8");
  const rateLimited = code === 1003 && /\brate limit exceeded\b/i.test(closeReason ?? "");
  const transientClose = rateLimited || code === 1001 || code === 1006 || code === 1011;
  const outcomeUnknown = audioStarted || (requestSubmitted && !rateLimited);
  const retriable = !outcomeUnknown && transientClose;
  const error = providerError(
    rateLimited
      ? TVIC_ERROR_CODES.providerRateLimited
      : transientClose
        ? TVIC_ERROR_CODES.providerUpstreamFailed
        : TVIC_ERROR_CODES.providerProtocolInvalid,
    "Sarvam TTS socket closed before generation completed",
    {
      provider: PROVIDER_NAMES.sarvamTts,
      retriable,
      metadata: {
        wsCloseCode: code,
        ...(closeReason ? { wsCloseReason: closeReason } : {}),
      },
    },
  );
  return outcomeUnknown
    ? {
        ...error,
        retriable: false,
        metadata: {
          ...(error.metadata ?? {}),
          ...(audioStarted ? { audioStarted: true } : {}),
          outcomeUnknown: true,
        },
      }
    : error;
}

export function sarvamTtsProtocolError(
  vendorCode: string | undefined,
  message: string,
  audioStarted = false,
  requestSubmitted = audioStarted,
) {
  const value = (vendorCode ? `${vendorCode} ${message}` : message).toLowerCase();
  const numericCode = /^\d{3}$/u.test(vendorCode ?? "") ? Number(vendorCode) : undefined;
  const numericStatusCode =
    numericCode === 401 || numericCode === 403
      ? TVIC_ERROR_CODES.providerAuthFailed
      : numericCode === 402
        ? TVIC_ERROR_CODES.providerQuotaExceeded
        : numericCode === 429
          ? TVIC_ERROR_CODES.providerRateLimited
          : numericCode === 400 || numericCode === 422
            ? TVIC_ERROR_CODES.providerInvalidRequest
            : numericCode === 408 ||
                numericCode === 409 ||
                (numericCode !== undefined && numericCode >= 500)
              ? TVIC_ERROR_CODES.providerUpstreamFailed
              : undefined;
  const code =
    numericStatusCode ??
    (/auth|key|credential|forbidden|permission/.test(value)
      ? TVIC_ERROR_CODES.providerAuthFailed
      : /quota|balance|credit/.test(value)
        ? TVIC_ERROR_CODES.providerQuotaExceeded
        : /\b(?:too[\s_-]+many[\s_-]+requests|rate[\s_-]*limit(?:ed|ing)?|rate[\s_-]+exceeded|throttl(?:e|ed|ing))\b/u.test(
              value,
            )
          ? TVIC_ERROR_CODES.providerRateLimited
          : /model|voice|invalid|request|parameter|schema|text|language/.test(value)
            ? TVIC_ERROR_CODES.providerInvalidRequest
            : TVIC_ERROR_CODES.providerUpstreamFailed);
  const error = providerError(code, message, {
    provider: PROVIDER_NAMES.sarvamTts,
    retriable:
      code === TVIC_ERROR_CODES.providerRateLimited ||
      code === TVIC_ERROR_CODES.providerUpstreamFailed,
    metadata: {
      ...(vendorCode ? { providerCode: vendorCode } : {}),
    },
  });
  const knownRejection =
    code === TVIC_ERROR_CODES.providerAuthFailed ||
    code === TVIC_ERROR_CODES.providerQuotaExceeded ||
    code === TVIC_ERROR_CODES.providerRateLimited ||
    code === TVIC_ERROR_CODES.providerInvalidRequest;
  const outcomeUnknown = audioStarted || (requestSubmitted && !knownRejection);
  return outcomeUnknown
    ? {
        ...error,
        retriable: false,
        metadata: {
          ...(error.metadata ?? {}),
          ...(audioStarted ? { audioStarted: true } : {}),
          outcomeUnknown: true,
        },
      }
    : error;
}
