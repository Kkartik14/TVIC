import {
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  TvicThrowableError,
} from "@tvic/core";

import { parseJsonObject, providerError } from "./common.js";

const SARVAM_TTS_HTTP_ERROR_BODY_MAX_BYTES = 64 * 1024;
const SARVAM_TTS_HTTP_ERROR_BODY_TIMEOUT_MS = 50;
const SARVAM_TTS_HTTP_CANCEL_TIMEOUT_MS = 1_000;
const SARVAM_TTS_HTTP_RESPONSE_INITIAL_CAPACITY = 4 * 1024;
export const SARVAM_TTS_HTTP_RESPONSE_MAX_FRAGMENTS = 65_536;
const SARVAM_TTS_HTTP_JSON_MAX_STRUCTURAL_TOKENS = 512;

export class SarvamTtsResponseTooLargeError extends Error {
  constructor() {
    super("Sarvam response body exceeded the size limit");
    this.name = "SarvamTtsResponseTooLargeError";
  }
}

export class SarvamTtsResponseTooFragmentedError extends Error {
  constructor() {
    super("Sarvam response body exceeded the fragment limit");
    this.name = "SarvamTtsResponseTooFragmentedError";
  }
}

export class SarvamTtsResponseTooComplexError extends Error {
  constructor() {
    super("Sarvam REST response exceeded the JSON structure limit");
    this.name = "SarvamTtsResponseTooComplexError";
  }
}

export class SarvamTtsRestResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SarvamTtsRestResponseError";
  }
}

interface SarvamRestResponse {
  readonly request_id?: unknown;
  readonly audios?: unknown;
}

/** Reject pathological JSON structure before JSON.parse allocates its values. */
export function assertSarvamTtsJsonStructureBounded(value: string): void {
  let index = 0;
  let structuralTokens = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 34) {
      let candidate = index + 1;
      let closed = false;
      while (candidate < value.length) {
        const quote = value.indexOf('"', candidate);
        if (quote === -1) return;

        let backslashCount = 0;
        for (
          let cursor = quote - 1;
          cursor > index && value.charCodeAt(cursor) === 92;
          cursor -= 1
        ) {
          backslashCount += 1;
        }
        if (backslashCount % 2 === 0) {
          index = quote + 1;
          closed = true;
          break;
        }
        candidate = quote + 1;
      }
      if (!closed) return;
      continue;
    }

    if (code === 44 || code === 123 || code === 125 || code === 91 || code === 93 || code === 58) {
      structuralTokens += 1;
      if (structuralTokens > SARVAM_TTS_HTTP_JSON_MAX_STRUCTURAL_TOKENS) {
        throw new SarvamTtsResponseTooComplexError();
      }
    }
    index += 1;
  }
}

export function parseSarvamRestResponse(body: string): {
  readonly audio: string;
  readonly requestId?: string;
} {
  assertSarvamTtsJsonStructureBounded(body);
  const parsed = parseJsonObject(body) as SarvamRestResponse | null;
  if (!parsed || !Array.isArray(parsed.audios) || parsed.audios.length !== 1) {
    throw new SarvamTtsRestResponseError("Sarvam REST returned an invalid audios response");
  }
  const audio = parsed.audios[0];
  if (typeof audio !== "string" || audio.length === 0) {
    throw new SarvamTtsRestResponseError("Sarvam REST returned an invalid audio payload");
  }
  const requestId =
    typeof parsed.request_id === "string" ? boundedString(parsed.request_id, 256) : undefined;
  return { audio, ...(requestId ? { requestId } : {}) };
}

export async function sarvamTtsHttpResponseError(
  response: Response,
  signal?: AbortSignal,
  onProgress?: () => void,
  callerSignal?: AbortSignal,
): Promise<TvicThrowableError> {
  if (response.status === 408 || response.status === 409 || response.status >= 500) {
    if (response.body) {
      try {
        void cancelResponseReader(response.body.getReader());
      } catch {
        // The HTTP status is already authoritative for retry safety.
      }
    }
    return TvicThrowableError.from(
      providerError(
        TVIC_ERROR_CODES.providerUpstreamFailed,
        `Sarvam TTS request failed with HTTP ${response.status}`,
        {
          provider: PROVIDER_NAMES.sarvamTts,
          retriable: false,
          metadata: { httpStatus: response.status, outcomeUnknown: true },
        },
      ),
    );
  }
  const diagnosticsController = new AbortController();
  const forwardAbort = (): void => diagnosticsController.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const diagnosticsTimer = setTimeout(
    () => diagnosticsController.abort(new Error("Sarvam error diagnostics timed out")),
    SARVAM_TTS_HTTP_ERROR_BODY_TIMEOUT_MS,
  );
  let body = "";
  try {
    body = await readBoundedResponseText(
      response,
      SARVAM_TTS_HTTP_ERROR_BODY_MAX_BYTES,
      diagnosticsController.signal,
      onProgress,
    );
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason ?? error;
    if (signal?.aborted) throw signal.reason ?? error;
  } finally {
    clearTimeout(diagnosticsTimer);
    signal?.removeEventListener("abort", forwardAbort);
  }
  const parsed = parseJsonObject(body);
  const nested = asRecord(parsed?.error);
  const providerCode =
    typeof nested?.code === "string"
      ? boundedString(nested.code, 128)
      : typeof parsed?.code === "string"
        ? boundedString(parsed.code, 128)
        : undefined;
  const message =
    typeof nested?.message === "string"
      ? boundedString(nested.message, 1_024)
      : typeof parsed?.message === "string"
        ? boundedString(parsed.message, 1_024)
        : `Sarvam TTS request failed with HTTP ${response.status}`;
  const metadata = {
    httpStatus: response.status,
    ...(providerCode ? { providerCode } : {}),
  };
  const providerOptions = {
    provider: PROVIDER_NAMES.sarvamTts,
    metadata,
  } as const;
  if (response.status === 401 || response.status === 403) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerAuthFailed, message, providerOptions),
    );
  }
  if (providerCode === "insufficient_quota_error") {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerQuotaExceeded, message, {
        ...providerOptions,
        retriable: false,
      }),
    );
  }
  if (providerCode === "rate_limit_exceeded_error") {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerRateLimited, message, providerOptions),
    );
  }
  if (response.status === 402) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerQuotaExceeded, message, {
        ...providerOptions,
        retriable: false,
      }),
    );
  }
  if (response.status === 429) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerRateLimited, message, providerOptions),
    );
  }
  if (response.status === 400 || response.status === 422) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerInvalidRequest, message, providerOptions),
    );
  }
  if (response.status >= 400 && response.status < 500) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerInvalidRequest, message, providerOptions),
    );
  }
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.sarvamTts, message, {
      ...providerOptions,
      retriable: false,
    }),
  );
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = SARVAM_TTS_HTTP_ERROR_BODY_MAX_BYTES,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let capacity = 0;
  let total = 0;
  let fragments = 0;
  let done = false;
  try {
    while (true) {
      const result = await readResponseChunk(reader, signal);
      onProgress?.();
      if (result.done) {
        done = true;
        break;
      }
      fragments += 1;
      if (fragments > SARVAM_TTS_HTTP_RESPONSE_MAX_FRAGMENTS) {
        throw new SarvamTtsResponseTooFragmentedError();
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new SarvamTtsResponseTooLargeError();
      }
      const requiredCapacity = total;
      if (requiredCapacity > capacity) {
        capacity = Math.min(
          maxBytes,
          Math.max(
            requiredCapacity,
            capacity === 0 ? SARVAM_TTS_HTTP_RESPONSE_INITIAL_CAPACITY : capacity * 2,
          ),
        );
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, total - result.value.byteLength));
        bytes = grown;
      }
      bytes.set(result.value, total - result.value.byteLength);
    }
  } finally {
    if (done) {
      reader.releaseLock();
    } else {
      void cancelResponseReader(reader);
    }
  }
  return new TextDecoder().decode(bytes.subarray(0, total));
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (!signal) return reader.read();
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => reader.cancel())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SARVAM_TTS_HTTP_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // A hostile body may leave a read pending after cancellation timed out.
    }
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function boundedString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}
