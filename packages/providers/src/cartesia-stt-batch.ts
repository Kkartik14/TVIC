import type { SttBatchTranscription, SttBatchTranscriptionRequest, SttBatchWord } from "@tvic/core";
import {
  cancelledError,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  timeoutError,
  TVIC_ERROR_CODES,
  TvicThrowableError,
} from "@tvic/core";

import { PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";
import {
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  boundedProviderMetadata,
  normalizeSttConnectionError,
  parseJsonObject,
  providerError,
  validationError,
} from "./common.js";
import {
  classifiedProviderError,
  readBoundedProviderErrorBody,
} from "./provider-error-classifier.js";

export const CARTESIA_STT_DEFAULT_BATCH_URL = "https://api.cartesia.ai/stt";
export const CARTESIA_STT_DEFAULT_BATCH_MODEL = "ink-whisper";

const CARTESIA_STT_PROVIDER = PROVIDER_NAMES.cartesiaStt;
const CARTESIA_STT_ERROR_CODE = PROVIDER_ERROR_CODES.cartesiaStt;
const CARTESIA_STT_BATCH_HEADERS_TIMEOUT_MS = 10_000;
const CARTESIA_STT_BATCH_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const CARTESIA_STT_BATCH_MAX_WORDS = 100_000;

export interface CartesiaBatchSttOptions {
  readonly apiKey: string;
  readonly batchUrl: string;
  readonly batchModelId: string;
  readonly allowUnknownModel: boolean;
  readonly fetchImpl: typeof fetch;
}

export async function transcribeCartesiaBatch(
  request: SttBatchTranscriptionRequest,
  options: CartesiaBatchSttOptions,
): Promise<SttBatchTranscription> {
  validateBatchAudio(request);
  const model = request.model ?? options.batchModelId;
  const allowUnknownModel = request.allowUnknownModel ?? options.allowUnknownModel;
  assertSupportedModel(
    CARTESIA_STT_PROVIDER,
    PROVIDER_CATALOG.cartesiaStt.batchModels ?? [CARTESIA_STT_DEFAULT_BATCH_MODEL],
    model,
    allowUnknownModel,
  );
  const fileName = batchFileName(request.fileName);
  const mimeType = batchMimeType(request.mimeType);
  const timestampGranularities = validateTimestampGranularities(request.timestampGranularities);

  const url = new URL(options.batchUrl);
  if (request.format) {
    assertSttPcm16leFormat(request.format);
    assertSttSampleRate(
      CARTESIA_STT_PROVIDER,
      request.format.sampleRateHz,
      [8000, 16000, 22050, 24000, 44100, 48000],
    );
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(request.audio)], { type: mimeType }), fileName);
  form.append("model", model);
  if (request.language !== undefined) {
    form.append("language", validateBatchLanguage(request.language));
  }
  for (const granularity of timestampGranularities) {
    form.append("timestamp_granularities[]", granularity);
  }

  const controller = new AbortController();
  let removeCallerAbort = (): void => undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let headerTimedOut = false;
  if (request.signal?.aborted) {
    throw batchCancelledError();
  }
  if (request.signal) {
    const onAbort = (): void => controller.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    removeCallerAbort = () => request.signal?.removeEventListener("abort", onAbort);
  }
  headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, CARTESIA_STT_BATCH_HEADERS_TIMEOUT_MS);
  headerTimer.unref?.();

  try {
    const response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Cartesia-Version": PROVIDER_API_VERSIONS.cartesiaStt,
      },
      body: form,
      signal: controller.signal,
    });
    if (headerTimer) {
      clearTimeout(headerTimer);
      headerTimer = undefined;
    }
    if (!response.ok) {
      const body = await readBoundedProviderErrorBody(response);
      const parsed = parseJsonObject(body.text);
      const errorPayload = recordField(parsed, "error") ?? parsed;
      throw TvicThrowableError.from(
        classifiedProviderError(CARTESIA_STT_PROVIDER, "Cartesia batch STT request failed", {
          status: response.status,
          providerCode: errorPayload?.code,
          providerType: errorPayload?.type,
          message: errorPayload?.message ?? errorPayload?.title,
          bodyTruncated: body.truncated,
          bodyMalformed: body.text.trim().length > 0 && parsed === null,
        }),
      );
    }
    const body = await readCartesiaBatchResponse(response);
    const parsed = parseJsonObject(body);
    if (!parsed) {
      throw batchProtocolError("Cartesia batch STT returned malformed JSON");
    }
    return parseCartesiaBatchTranscription(parsed, model);
  } catch (error) {
    if (error instanceof TvicThrowableError) throw error;
    if (request.signal?.aborted) throw batchCancelledError();
    if (headerTimedOut) {
      throw TvicThrowableError.from(
        timeoutError(
          TVIC_ERROR_CODES.providerTransportTimeout,
          `Cartesia batch STT response headers timed out after ${CARTESIA_STT_BATCH_HEADERS_TIMEOUT_MS}ms`,
          { provider: CARTESIA_STT_PROVIDER },
        ),
      );
    }
    throw TvicThrowableError.from(
      normalizeSttConnectionError(error, {
        provider: CARTESIA_STT_PROVIDER,
        providerCode: CARTESIA_STT_ERROR_CODE,
      }),
    );
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
    removeCallerAbort();
  }
}

function validateBatchAudio(request: SttBatchTranscriptionRequest): void {
  if (!(request.audio instanceof Uint8Array) || request.audio.byteLength === 0) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia batch STT requires a non-empty Uint8Array audio payload",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
}

function batchFileName(value: string | undefined): string {
  const fileName = value ?? "audio.bin";
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName.includes("\r") ||
    fileName.includes("\n")
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia batch STT fileName must contain 1 to 255 characters without line breaks",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
  return fileName;
}

function batchMimeType(value: string | undefined): string {
  const mimeType = value ?? "application/octet-stream";
  if (
    typeof mimeType !== "string" ||
    mimeType.length === 0 ||
    mimeType.length > 128 ||
    mimeType.includes("\r") ||
    mimeType.includes("\n")
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia batch STT mimeType must contain 1 to 128 characters without line breaks",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
  return mimeType;
}

function validateBatchLanguage(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16 ||
    value.trim() !== value
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia batch STT language must contain 1 to 16 non-whitespace characters",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
  return value;
}

function validateTimestampGranularities(values: readonly string[] | undefined): readonly "word"[] {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > 1 || values.some((value) => value !== "word")) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia batch STT currently supports only one timestamp granularity: word",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
  return values as readonly "word"[];
}

function recordField(
  value: Readonly<Record<string, unknown>> | null,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  const candidate = value?.[field];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Readonly<Record<string, unknown>>)
    : undefined;
}

function parseCartesiaBatchTranscription(
  message: Readonly<Record<string, unknown>>,
  model: string,
): SttBatchTranscription {
  if (message.type !== "transcript" || typeof message.text !== "string") {
    throw batchProtocolError("Cartesia batch STT returned an invalid transcript response");
  }
  const requestId = responseString(message.request_id, "request_id");
  const language = responseString(message.language, "language");
  const durationMs =
    message.duration === undefined
      ? undefined
      : secondsToMilliseconds(message.duration, "duration");
  const words = parseBatchWords(message.words);
  const metadata = boundedProviderMetadata({
    cartesia: {
      batch: true,
      model,
      ...(requestId ? { requestId } : {}),
    },
  });
  return {
    text: message.text,
    ...(requestId ? { requestId } : {}),
    ...(language ? { language } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(words ? { words } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseBatchWords(value: unknown): readonly SttBatchWord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CARTESIA_STT_BATCH_MAX_WORDS) {
    throw batchProtocolError("Cartesia batch STT returned an invalid words array");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw batchProtocolError("Cartesia batch STT returned an invalid word");
    }
    const word = responseString((item as Record<string, unknown>).word, "word");
    if (!word) throw batchProtocolError("Cartesia batch STT returned a word without text");
    const startMs = secondsToMilliseconds((item as Record<string, unknown>).start, "word.start");
    const endMs = secondsToMilliseconds((item as Record<string, unknown>).end, "word.end");
    if (endMs < startMs) {
      throw batchProtocolError("Cartesia batch STT returned a word with inverted timestamps");
    }
    return { word, startMs, endMs };
  });
}

function responseString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4_096) {
    throw batchProtocolError(`Cartesia batch STT returned an invalid ${field}`);
  }
  return value;
}

function secondsToMilliseconds(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER / 1_000
  ) {
    throw batchProtocolError(`Cartesia batch STT returned an invalid ${field}`);
  }
  return value * 1_000;
}

async function readCartesiaBatchResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > CARTESIA_STT_BATCH_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw batchProtocolError("Cartesia batch STT response exceeded the bounded response limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function batchProtocolError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(STT_ERROR_CODES.protocolError, message, {
      provider: CARTESIA_STT_PROVIDER,
      retriable: false,
    }),
  );
}

function batchCancelledError(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("provider.connection_cancelled", "Cartesia batch STT request was cancelled", {
      provider: CARTESIA_STT_PROVIDER,
    }),
  );
}
