import type { AudioFormat } from "@tvic/core";
import {
  cancelledError,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  timeoutError,
  TvicThrowableError,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  assertSupportedModel,
  normalizeProviderError,
  parseJsonObject,
  providerError,
  validationError,
} from "./common.js";
import {
  buildPreRecordedBody,
  buildSyncConfig,
  createSyncLiveMultipartBody,
  resolvePreRecordedModels,
  syncLiveUrl,
  validatePollOptions,
  validatePreRecordedRequest,
  validatePreRecordedVocabulary,
  validateSyncLiveRequest,
  validateSyncRequest,
} from "./assemblyai-http-stt-validation.js";

const ASSEMBLYAI_PROVIDER = PROVIDER_NAMES.assemblyaiStt;
const ASSEMBLYAI_ERROR_CODE = "assemblyai.stt.error";
const MAX_ASSEMBLYAI_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;

export type AssemblyAiPreRecordedModel =
  (typeof PROVIDER_CATALOG.assemblyai.preRecordedModels)[number];
export type AssemblyAiSyncModel = (typeof PROVIDER_CATALOG.assemblyai.syncModels)[number];

export interface AssemblyAiSpeakerOptions {
  readonly minSpeakersExpected?: number;
  readonly maxSpeakersExpected?: number;
  readonly includeSpeakerConfidence?: boolean;
}

export type AssemblyAiPiiSubstitution = "entity_name" | "hash";
export type AssemblyAiRedactedAudioQuality = "mp3" | "wav";

export interface AssemblyAiRedactPiiAudioOptions {
  readonly overrideAudioRedactionMethod?: "beep" | "silence";
  readonly returnRedactedNoSpeechAudio?: boolean;
}

export interface AssemblyAiPreRecordedSttRequest {
  /** A complete local file or encoded media payload. */
  readonly audio?: Uint8Array;
  /** A public URL or AssemblyAI upload URL. Exactly one audio source is required. */
  readonly audioUrl?: string;
  /** Content type used when `audio` is uploaded. */
  readonly mimeType?: string;
  /** Filename used as the multipart upload filename. */
  readonly fileName?: string;
  /** Convenience single-model selector. Cannot be combined with speechModels. */
  readonly model?: string;
  /** Ordered model candidates. AssemblyAI may fall back to the next model. */
  readonly speechModels?: readonly string[];
  readonly language?: string;
  readonly languageDetection?: boolean;
  readonly prompt?: string;
  readonly vocabulary?: readonly string[];
  readonly punctuate?: boolean;
  readonly formatText?: boolean;
  readonly disfluencies?: boolean;
  readonly speakerLabels?: boolean;
  readonly speakersExpected?: number;
  readonly speakerOptions?: AssemblyAiSpeakerOptions;
  /** Current AssemblyAI name for separate-channel transcription. */
  readonly multichannel?: boolean;
  /** @deprecated Use `multichannel`. Kept as a compatibility alias. */
  readonly dualChannel?: boolean;
  readonly redactPii?: boolean;
  readonly redactPiiPolicies?: readonly string[];
  readonly redactPiiSub?: AssemblyAiPiiSubstitution;
  readonly redactPiiAudio?: boolean;
  readonly redactPiiAudioQuality?: AssemblyAiRedactedAudioQuality;
  readonly redactPiiAudioOptions?: AssemblyAiRedactPiiAudioOptions;
  readonly redactPiiReturnUnredacted?: boolean;
  readonly redactStaticEntities?: Readonly<Record<string, readonly string[]>>;
  readonly speechThreshold?: number;
  readonly webhookUrl?: string;
  readonly webhookAuthHeaderName?: string;
  readonly webhookAuthHeaderValue?: string;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

export interface AssemblyAiSyncSttRequest {
  /** Raw PCM16LE bytes. The format is sent in the Sync config part. */
  readonly audio: Uint8Array;
  readonly format: AudioFormat;
  readonly model?: string;
  readonly languageCodes?: readonly string[];
  readonly prompt?: string;
  readonly vocabulary?: readonly string[];
  readonly timestamps?: boolean;
  readonly fileName?: string;
  readonly signal?: AbortSignal;
}

export interface AssemblyAiSyncLiveSttRequest {
  /** Async PCM16LE chunks produced while the recording is in progress. */
  readonly audio: AsyncIterable<Uint8Array>;
  readonly format: AudioFormat;
  readonly model?: string;
  readonly languageCodes?: readonly string[];
  readonly prompt?: string;
  readonly vocabulary?: readonly string[];
  readonly timestamps?: boolean;
  readonly fileName?: string;
  readonly signal?: AbortSignal;
}

export interface AssemblyAiTranscriptWord {
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
  readonly confidence?: number;
  readonly speaker?: string;
  readonly [key: string]: unknown;
}

export interface AssemblyAiTranscriptUtterance {
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
  readonly confidence?: number;
  readonly speaker?: string;
  readonly words?: readonly AssemblyAiTranscriptWord[];
  readonly [key: string]: unknown;
}

export interface AssemblyAiPreRecordedSttResult {
  readonly id: string;
  readonly status: "completed";
  readonly modelId: string;
  readonly text: string;
  readonly languageCode?: string;
  readonly audioDurationMs?: number;
  readonly audioChannels?: number;
  readonly confidence?: number;
  readonly words: readonly AssemblyAiTranscriptWord[];
  readonly utterances: readonly AssemblyAiTranscriptUtterance[];
  /** Bounded provider response for fields not yet promoted into the TVIC shape. */
  readonly providerResponse: Readonly<Record<string, unknown>>;
}

export interface AssemblyAiSyncSttResult {
  readonly sessionId: string;
  readonly modelId: string;
  readonly text: string;
  readonly confidence?: number;
  readonly audioDurationMs?: number;
  readonly requestTimeMs?: number;
  readonly words: readonly AssemblyAiTranscriptWord[];
  readonly providerResponse: Readonly<Record<string, unknown>>;
}

export interface AssemblyAiHttpSttOptions {
  readonly apiKey: string;
  readonly preRecordedUrl: string;
  readonly uploadUrl: string;
  readonly syncUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly allowUnknownModel: boolean;
}

export { ASSEMBLYAI_DEFAULT_PRE_RECORDED_MODELS } from "./assemblyai-http-stt-validation.js";

export async function transcribeAssemblyAiPreRecorded(
  options: AssemblyAiHttpSttOptions,
  request: AssemblyAiPreRecordedSttRequest,
): Promise<AssemblyAiPreRecordedSttResult> {
  const source = validatePreRecordedRequest(request);
  const models = resolvePreRecordedModels(request, options.allowUnknownModel);
  validatePreRecordedVocabulary(request.vocabulary, models);
  const pollIntervalMs = request.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = request.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  validatePollOptions(pollIntervalMs, pollTimeoutMs);
  const audioUrl = source.audioUrl ?? (await uploadAudio(options, source.audio, request));
  const body = buildPreRecordedBody(request, audioUrl, models);
  const created = await requestJson(options, options.preRecordedUrl, body, request.signal);
  const transcriptId = readRequiredString(
    created,
    "id",
    "AssemblyAI did not return a transcript id",
  );

  const deadline = Date.now() + pollTimeoutMs;
  let current = created;
  while (true) {
    const status = readOptionalString(current, "status");
    if (status === "completed") {
      return normalizePreRecordedResult(current, transcriptId, models[0]!);
    }
    if (status === "error") {
      throw assemblyAiTranscriptError(current, transcriptId);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw TvicThrowableError.from(
        timeoutError(
          "assemblyai.stt.poll_timeout",
          `AssemblyAI pre-recorded transcription did not complete within ${pollTimeoutMs}ms`,
          { provider: ASSEMBLYAI_PROVIDER, metadata: { transcriptId, status } },
        ),
      );
    }
    await delay(Math.min(pollIntervalMs, remaining), request.signal);
    current = await requestJson(
      options,
      `${options.preRecordedUrl}/${encodeURIComponent(transcriptId)}`,
      undefined,
      request.signal,
    );
  }
}

export async function transcribeAssemblyAiSync(
  options: AssemblyAiHttpSttOptions,
  request: AssemblyAiSyncSttRequest,
): Promise<AssemblyAiSyncSttResult> {
  const model = request.model ?? PROVIDER_CATALOG.assemblyai.syncModels[0];
  assertSupportedModel(ASSEMBLYAI_PROVIDER, PROVIDER_CATALOG.assemblyai.syncModels, model, false);
  validateSyncRequest(request);

  const config = buildSyncConfig(request);

  const form = new FormData();
  form.append(
    "audio",
    new Blob([Buffer.from(request.audio)], { type: "audio/pcm" }),
    request.fileName ?? "audio.pcm",
  );
  form.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }));

  const response = await fetchHttp(options, options.syncUrl, {
    method: "POST",
    headers: {
      Authorization: options.apiKey,
      "X-AAI-Model": model,
    },
    body: form,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw assemblyAiHttpError(response.status, body, "sync");
  const parsed = parseJsonObject(body);
  if (!parsed) throw assemblyAiProtocolError("AssemblyAI Sync returned malformed JSON");
  return normalizeSyncResult(parsed, model);
}

export async function transcribeAssemblyAiSyncLive(
  options: AssemblyAiHttpSttOptions,
  request: AssemblyAiSyncLiveSttRequest,
): Promise<AssemblyAiSyncSttResult> {
  const model = request.model ?? PROVIDER_CATALOG.assemblyai.syncModels[0];
  assertSupportedModel(ASSEMBLYAI_PROVIDER, PROVIDER_CATALOG.assemblyai.syncModels, model, false);
  validateSyncLiveRequest(request);

  const boundary = `tvic-assemblyai-${globalThis.crypto.randomUUID()}`;
  const body = createSyncLiveMultipartBody(boundary, buildSyncConfig(request), request);
  const init: RequestInit & { readonly duplex: "half" } = {
    method: "POST",
    headers: {
      Authorization: options.apiKey,
      "X-AAI-Model": model,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
    duplex: "half",
    ...(request.signal ? { signal: request.signal } : {}),
  };
  const response = await fetchHttp(options, syncLiveUrl(options.syncUrl), init);
  const responseBody = await readBoundedResponseText(response);
  if (!response.ok) throw assemblyAiHttpError(response.status, responseBody, "sync live");
  const parsed = parseJsonObject(responseBody);
  if (!parsed) throw assemblyAiProtocolError("AssemblyAI Sync live returned malformed JSON");
  return normalizeSyncResult(parsed, model);
}

export async function warmAssemblyAiSync(
  options: AssemblyAiHttpSttOptions,
  model: string = PROVIDER_CATALOG.assemblyai.syncModels[0],
  signal?: AbortSignal,
): Promise<void> {
  assertSupportedModel(ASSEMBLYAI_PROVIDER, PROVIDER_CATALOG.assemblyai.syncModels, model, false);
  const warmUrl = options.syncUrl.replace(/\/transcribe$/u, "/warm");
  const response = await fetchHttp(options, warmUrl, {
    method: "GET",
    headers: { "X-AAI-Model": model },
    ...(signal ? { signal } : {}),
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw assemblyAiHttpError(response.status, body, "sync warm");
}

async function uploadAudio(
  options: AssemblyAiHttpSttOptions,
  audio: Uint8Array | undefined,
  request: AssemblyAiPreRecordedSttRequest,
): Promise<string> {
  if (!audio) throw invalidRequest("AssemblyAI audio bytes are missing");
  const response = await fetchHttp(options, options.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: options.apiKey,
      "Content-Type": request.mimeType ?? "application/octet-stream",
    },
    body: Buffer.from(audio),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw assemblyAiHttpError(response.status, body, "upload");
  const parsed = parseJsonObject(body);
  const uploadUrl = parsed ? readOptionalString(parsed, "upload_url") : undefined;
  if (!uploadUrl || !isHttpUrl(uploadUrl)) {
    throw assemblyAiProtocolError("AssemblyAI upload returned no valid upload_url");
  }
  return uploadUrl;
}

async function requestJson(
  options: AssemblyAiHttpSttOptions,
  url: string,
  body: Readonly<Record<string, unknown>> | undefined,
  signal: AbortSignal | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetchHttp(options, url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: options.apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const responseBody = await readBoundedResponseText(response);
  if (!response.ok) throw assemblyAiHttpError(response.status, responseBody, "pre-recorded");
  const parsed = parseJsonObject(responseBody);
  if (!parsed) throw assemblyAiProtocolError("AssemblyAI returned malformed JSON");
  return parsed;
}

async function fetchHttp(
  options: AssemblyAiHttpSttOptions,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await options.fetchImpl(input, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw TvicThrowableError.from(
        cancelledError("provider.request_cancelled", "AssemblyAI request was cancelled", {
          provider: ASSEMBLYAI_PROVIDER,
        }),
      );
    }
    throw TvicThrowableError.from(
      normalizeProviderError(error, {
        code: ASSEMBLYAI_ERROR_CODE,
        provider: ASSEMBLYAI_PROVIDER,
      }),
    );
  }
}

function normalizePreRecordedResult(
  body: Readonly<Record<string, unknown>>,
  transcriptId: string,
  modelId: string,
): AssemblyAiPreRecordedSttResult {
  const text = readTranscriptText(body, "AssemblyAI returned no transcript text");
  const words = normalizeWords(body.words);
  const utterances = normalizeUtterances(body.utterances);
  const languageCode = readOptionalString(body, "language_code");
  const audioDurationSeconds = readOptionalNumber(body, "audio_duration");
  const audioChannels = readOptionalNumber(body, "audio_channels");
  const confidence = readOptionalNumber(body, "confidence");
  return {
    id: transcriptId,
    status: "completed",
    modelId: readOptionalString(body, "speech_model_used") ?? modelId,
    text,
    ...(languageCode !== undefined ? { languageCode } : {}),
    ...(audioDurationSeconds !== undefined
      ? { audioDurationMs: audioDurationSeconds * 1_000 }
      : {}),
    ...(audioChannels !== undefined ? { audioChannels } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    words,
    utterances,
    providerResponse: body,
  };
}

function normalizeSyncResult(
  body: Readonly<Record<string, unknown>>,
  modelId: string,
): AssemblyAiSyncSttResult {
  const text = readTranscriptText(body, "AssemblyAI Sync returned no transcript text");
  const sessionId = readRequiredString(
    body,
    "session_id",
    "AssemblyAI Sync returned no session_id",
  );
  const words = normalizeWords(body.words);
  const confidence = readOptionalNumber(body, "confidence");
  const audioDurationMs = readOptionalNumber(body, "audio_duration_ms");
  const requestTimeMs = readOptionalNumber(body, "request_time_ms");
  return {
    sessionId,
    modelId,
    text,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(audioDurationMs !== undefined ? { audioDurationMs } : {}),
    ...(requestTimeMs !== undefined ? { requestTimeMs } : {}),
    words,
    providerResponse: body,
  };
}

function normalizeWords(value: unknown): readonly AssemblyAiTranscriptWord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100_000) {
    throw assemblyAiProtocolError("AssemblyAI returned malformed words");
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.text !== "string" || entry.text.length > 1_024) {
      throw assemblyAiProtocolError("AssemblyAI returned malformed word data");
    }
    return boundedRecord(entry) as AssemblyAiTranscriptWord;
  });
}

function normalizeUtterances(value: unknown): readonly AssemblyAiTranscriptUtterance[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100_000) {
    throw assemblyAiProtocolError("AssemblyAI returned malformed utterances");
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.text !== "string" || entry.text.length > 16_384) {
      throw assemblyAiProtocolError("AssemblyAI returned malformed utterance data");
    }
    const record = boundedRecord(entry) as AssemblyAiTranscriptUtterance;
    return {
      ...record,
      ...(entry.words !== undefined ? { words: normalizeWords(entry.words) } : {}),
    };
  });
}

function boundedRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (key.length > 128) continue;
    if (typeof candidate === "string") {
      if (candidate.length <= 16_384) result[key] = candidate;
    } else if (
      typeof candidate === "number" ||
      typeof candidate === "boolean" ||
      candidate === null
    ) {
      result[key] = candidate;
    } else if (Array.isArray(candidate)) {
      if (candidate.length <= 100_000) result[key] = candidate;
    } else if (isRecord(candidate)) {
      result[key] = candidate;
    }
  }
  return result;
}

function assemblyAiTranscriptError(
  body: Readonly<Record<string, unknown>>,
  transcriptId: string,
): TvicThrowableError {
  const message = readOptionalString(body, "error") ?? "AssemblyAI transcription failed";
  return TvicThrowableError.from(
    providerError(STT_ERROR_CODES.inputRejected, boundedMessage(message), {
      provider: ASSEMBLYAI_PROVIDER,
      retriable: false,
      metadata: { transcriptId, status: "error" },
    }),
  );
}

export function assemblyAiHttpError(
  status: number,
  body: string,
  operation: string,
): TvicThrowableError {
  const code =
    status === 401 || status === 403
      ? STT_ERROR_CODES.authFailed
      : status === 402 || status === 429
        ? STT_ERROR_CODES.rateLimited
        : status >= 400 && status < 500
          ? STT_ERROR_CODES.invalidRequest
          : STT_ERROR_CODES.serviceUnavailable;
  const parsed = parseJsonObject(body);
  const detail = parsed?.error ?? parsed?.message ?? parsed?.detail;
  const message =
    typeof detail === "string" && detail.length > 0
      ? boundedMessage(detail)
      : body.trim()
        ? boundedMessage(body.trim())
        : `AssemblyAI ${operation} request failed with HTTP ${status}`;
  return TvicThrowableError.from(
    providerError(code, message, {
      provider: ASSEMBLYAI_PROVIDER,
      retriable:
        code === STT_ERROR_CODES.rateLimited || code === STT_ERROR_CODES.serviceUnavailable,
      metadata: { httpStatus: status, operation },
    }),
  );
}

function assemblyAiProtocolError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(STT_ERROR_CODES.protocolError, message, {
      provider: ASSEMBLYAI_PROVIDER,
      retriable: false,
    }),
  );
}

function readRequiredString(
  body: Readonly<Record<string, unknown>>,
  key: string,
  message: string,
): string {
  const value = readOptionalString(body, key);
  if (!value) throw assemblyAiProtocolError(message);
  return value;
}

function readTranscriptText(body: Readonly<Record<string, unknown>>, message: string): string {
  const value = body.text;
  if (typeof value !== "string" || value.length > 65_536) {
    throw assemblyAiProtocolError(message);
  }
  return value;
}

function readOptionalString(
  body: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length <= 65_536 ? value : undefined;
}

function readOptionalNumber(
  body: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function invalidRequest(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    validationError("provider.invalid_request", message, { provider: ASSEMBLYAI_PROVIDER }),
  );
}

function boundedMessage(value: string): string {
  return value.length <= 1_024 ? value : `${value.slice(0, 1_021)}...`;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_ASSEMBLYAI_HTTP_RESPONSE_BYTES) {
      throw assemblyAiProtocolError("AssemblyAI HTTP response exceeded the size limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ASSEMBLYAI_HTTP_RESPONSE_BYTES) {
        await reader.cancel();
        throw assemblyAiProtocolError("AssemblyAI HTTP response exceeded the size limit");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The response body is already closed.
    }
    throw error;
  }
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw TvicThrowableError.from(
      cancelledError("provider.request_cancelled", "AssemblyAI request was cancelled", {
        provider: ASSEMBLYAI_PROVIDER,
      }),
    );
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        TvicThrowableError.from(
          cancelledError("provider.request_cancelled", "AssemblyAI request was cancelled", {
            provider: ASSEMBLYAI_PROVIDER,
          }),
        ),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
