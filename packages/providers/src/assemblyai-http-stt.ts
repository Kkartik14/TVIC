import type { AudioFormat } from "@tvic/core";
import {
  cancelledError,
  isSampleRateHz,
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

const ASSEMBLYAI_PROVIDER = PROVIDER_NAMES.assemblyaiStt;
const ASSEMBLYAI_ERROR_CODE = "assemblyai.stt.error";
const MAX_ASSEMBLYAI_HTTP_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_TIMEOUT_MS = 60 * 60_000;

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

export const ASSEMBLYAI_DEFAULT_PRE_RECORDED_MODELS = Object.freeze([
  "universal-3-5-pro",
  "universal-2",
] as const);

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

function validatePreRecordedRequest(request: AssemblyAiPreRecordedSttRequest): {
  readonly audio?: Uint8Array;
  readonly audioUrl?: string;
} {
  const hasAudio = request.audio instanceof Uint8Array;
  const hasAudioUrl = typeof request.audioUrl === "string" && request.audioUrl.trim().length > 0;
  if (hasAudio === hasAudioUrl) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "AssemblyAI pre-recorded STT requires exactly one of audio or audioUrl",
        { provider: ASSEMBLYAI_PROVIDER },
      ),
    );
  }
  if (hasAudio && request.audio!.byteLength === 0) {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "AssemblyAI audio cannot be empty", {
        provider: ASSEMBLYAI_PROVIDER,
      }),
    );
  }
  if (hasAudioUrl && !isHttpUrl(request.audioUrl!)) {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "AssemblyAI audioUrl must be an HTTP(S) URL", {
        provider: ASSEMBLYAI_PROVIDER,
      }),
    );
  }
  if (request.mimeType !== undefined && !validHeaderValue(request.mimeType, 128)) {
    throw invalidRequest("AssemblyAI mimeType is invalid");
  }
  if (request.fileName !== undefined && !validHeaderValue(request.fileName, 256)) {
    throw invalidRequest("AssemblyAI fileName is invalid");
  }
  if (request.language !== undefined && !validText(request.language, 64)) {
    throw invalidRequest("AssemblyAI language is invalid");
  }
  if (request.prompt !== undefined && !validText(request.prompt, 16_384)) {
    throw invalidRequest("AssemblyAI prompt is invalid");
  }
  if (request.webhookUrl !== undefined && !isHttpUrl(request.webhookUrl)) {
    throw invalidRequest("AssemblyAI webhookUrl must be an HTTP(S) URL");
  }
  if (
    (request.webhookAuthHeaderName === undefined) !==
    (request.webhookAuthHeaderValue === undefined)
  ) {
    throw invalidRequest(
      "AssemblyAI webhookAuthHeaderName and webhookAuthHeaderValue must be provided together",
    );
  }
  if (
    request.webhookAuthHeaderName !== undefined &&
    !validHeaderValue(request.webhookAuthHeaderName, 256)
  ) {
    throw invalidRequest("AssemblyAI webhookAuthHeaderName is invalid");
  }
  if (
    request.webhookAuthHeaderValue !== undefined &&
    !validHeaderValue(request.webhookAuthHeaderValue, 4_096)
  ) {
    throw invalidRequest("AssemblyAI webhookAuthHeaderValue is invalid");
  }
  if (request.languageDetection === true && request.language !== undefined) {
    throw invalidRequest("AssemblyAI languageDetection cannot be combined with language");
  }
  if (
    request.speakerLabels !== true &&
    (request.speakersExpected !== undefined || request.speakerOptions)
  ) {
    throw invalidRequest("AssemblyAI speaker options require speakerLabels=true");
  }
  if (request.speakersExpected !== undefined) {
    validatePositiveInteger(request.speakersExpected, "speakersExpected", 100);
    if (request.speakerOptions !== undefined) {
      throw invalidRequest("AssemblyAI speakersExpected cannot be combined with speakerOptions");
    }
  }
  if (request.speakerOptions !== undefined) validateSpeakerOptions(request.speakerOptions);
  if (
    request.multichannel !== undefined &&
    request.dualChannel !== undefined &&
    request.multichannel !== request.dualChannel
  ) {
    throw invalidRequest("AssemblyAI multichannel and dualChannel cannot disagree");
  }
  validateRedactionOptions(request);
  if (
    request.speechThreshold !== undefined &&
    (!Number.isFinite(request.speechThreshold) ||
      request.speechThreshold < 0 ||
      request.speechThreshold > 1)
  ) {
    throw invalidRequest("AssemblyAI speechThreshold must be between 0 and 1");
  }
  for (const [name, value] of [
    ["languageDetection", request.languageDetection],
    ["punctuate", request.punctuate],
    ["formatText", request.formatText],
    ["disfluencies", request.disfluencies],
    ["speakerLabels", request.speakerLabels],
    ["multichannel", request.multichannel],
    ["dualChannel", request.dualChannel],
    ["redactPii", request.redactPii],
    ["redactPiiAudio", request.redactPiiAudio],
    ["redactPiiReturnUnredacted", request.redactPiiReturnUnredacted],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw invalidRequest(`AssemblyAI ${name} must be a boolean`);
    }
  }
  return {
    ...(hasAudio ? { audio: request.audio } : {}),
    ...(hasAudioUrl ? { audioUrl: request.audioUrl!.trim() } : {}),
  };
}

function resolvePreRecordedModels(
  request: AssemblyAiPreRecordedSttRequest,
  allowUnknownModel: boolean,
): readonly string[] {
  if (request.model !== undefined && request.speechModels !== undefined) {
    throw invalidRequest("AssemblyAI model and speechModels cannot both be set");
  }
  const models =
    request.model !== undefined
      ? [request.model]
      : (request.speechModels ?? ASSEMBLYAI_DEFAULT_PRE_RECORDED_MODELS);
  if (!Array.isArray(models) || models.length === 0 || models.length > 2) {
    throw invalidRequest("AssemblyAI speechModels must contain one or two models");
  }
  const unique = new Set(models);
  if (unique.size !== models.length)
    throw invalidRequest("AssemblyAI speechModels cannot repeat models");
  for (const model of models) {
    if (typeof model !== "string" || model.length === 0) {
      throw invalidRequest("AssemblyAI speechModels must contain non-empty strings");
    }
    assertSupportedModel(
      ASSEMBLYAI_PROVIDER,
      PROVIDER_CATALOG.assemblyai.preRecordedModels,
      model,
      allowUnknownModel,
    );
  }
  return models;
}

function buildPreRecordedBody(
  request: AssemblyAiPreRecordedSttRequest,
  audioUrl: string,
  models: readonly string[],
): Readonly<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    speech_models: models,
  };
  const values: Readonly<Record<string, unknown>> = {
    language_code: request.language,
    language_detection: request.languageDetection,
    prompt: request.prompt,
    keyterms_prompt: request.vocabulary,
    punctuate: request.punctuate,
    format_text: request.formatText,
    disfluencies: request.disfluencies,
    speaker_labels: request.speakerLabels,
    speakers_expected: request.speakersExpected,
    speaker_options:
      request.speakerOptions === undefined
        ? undefined
        : {
            ...(request.speakerOptions.minSpeakersExpected !== undefined
              ? { min_speakers_expected: request.speakerOptions.minSpeakersExpected }
              : {}),
            ...(request.speakerOptions.maxSpeakersExpected !== undefined
              ? { max_speakers_expected: request.speakerOptions.maxSpeakersExpected }
              : {}),
            ...(request.speakerOptions.includeSpeakerConfidence !== undefined
              ? { include_speaker_confidence: request.speakerOptions.includeSpeakerConfidence }
              : {}),
          },
    multichannel: request.multichannel ?? request.dualChannel,
    redact_pii: request.redactPii,
    redact_pii_policies: request.redactPiiPolicies,
    redact_pii_sub: request.redactPiiSub,
    redact_pii_audio: request.redactPiiAudio,
    redact_pii_audio_quality: request.redactPiiAudioQuality,
    redact_pii_audio_options:
      request.redactPiiAudioOptions === undefined
        ? undefined
        : {
            ...(request.redactPiiAudioOptions.overrideAudioRedactionMethod !== undefined
              ? {
                  override_audio_redaction_method:
                    request.redactPiiAudioOptions.overrideAudioRedactionMethod,
                }
              : {}),
            ...(request.redactPiiAudioOptions.returnRedactedNoSpeechAudio !== undefined
              ? {
                  return_redacted_no_speech_audio:
                    request.redactPiiAudioOptions.returnRedactedNoSpeechAudio,
                }
              : {}),
          },
    redact_pii_return_unredacted: request.redactPiiReturnUnredacted,
    redact_static_entities:
      request.redactStaticEntities === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(request.redactStaticEntities).map(([label, terms]) => [
              label,
              [...terms],
            ]),
          ),
    speech_threshold: request.speechThreshold,
    webhook_url: request.webhookUrl,
    webhook_auth_header_name: request.webhookAuthHeaderName,
    webhook_auth_header_value: request.webhookAuthHeaderValue,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body[key] = value;
  }
  return body;
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

function assemblyAiHttpError(status: number, body: string, operation: string): TvicThrowableError {
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

function validateSyncRequest(request: AssemblyAiSyncSttRequest): void {
  if (!(request.audio instanceof Uint8Array) || request.audio.byteLength === 0) {
    throw invalidRequest("AssemblyAI Sync audio must be non-empty bytes");
  }
  validateSyncFormat(request.format);
  const bytesPerFrame = request.format.channels * 2;
  if (request.audio.byteLength % bytesPerFrame !== 0) {
    throw invalidRequest("AssemblyAI Sync audio must contain complete PCM samples");
  }
  const durationMs =
    (request.audio.byteLength / bytesPerFrame / request.format.sampleRateHz) * 1_000;
  if (durationMs < 80 || durationMs > 120_000) {
    throw invalidRequest("AssemblyAI Sync accepts audio from 80ms through 120 seconds");
  }
  validateSyncOptions(request);
}

function validateSyncLiveRequest(request: AssemblyAiSyncLiveSttRequest): void {
  if (!isAsyncIterable(request.audio)) {
    throw invalidRequest("AssemblyAI Sync live audio must be an AsyncIterable");
  }
  validateSyncFormat(request.format);
  validateSyncOptions(request);
}

function validateSyncOptions(
  request: Pick<
    AssemblyAiSyncSttRequest,
    "languageCodes" | "prompt" | "vocabulary" | "model" | "fileName" | "timestamps"
  >,
): void {
  if (request.languageCodes !== undefined) {
    if (
      !Array.isArray(request.languageCodes) ||
      request.languageCodes.length === 0 ||
      request.languageCodes.length > 32 ||
      request.languageCodes.some((language) => !validText(language, 16))
    ) {
      throw invalidRequest("AssemblyAI Sync languageCodes must contain 1-32 language codes");
    }
  }
  if (request.prompt !== undefined && !validText(request.prompt, 6_000)) {
    throw invalidRequest("AssemblyAI Sync prompt is invalid");
  }
  if (request.vocabulary !== undefined) validateSyncVocabulary(request.vocabulary);
  if (request.model !== undefined && typeof request.model !== "string") {
    throw invalidRequest("AssemblyAI Sync model must be a string");
  }
  if (request.fileName !== undefined && !validHeaderValue(request.fileName, 256)) {
    throw invalidRequest("AssemblyAI Sync fileName is invalid");
  }
  if (request.timestamps !== undefined && typeof request.timestamps !== "boolean") {
    throw invalidRequest("AssemblyAI Sync timestamps must be a boolean");
  }
}

function validateSyncFormat(format: AudioFormat): void {
  if (format.encoding !== "pcm_s16le" || (format.channels !== 1 && format.channels !== 2)) {
    throw invalidRequest("AssemblyAI Sync requires PCM16LE mono or stereo audio");
  }
  if (!isSampleRateHz(format.sampleRateHz)) {
    throw invalidRequest("AssemblyAI Sync received an unsupported sample rate");
  }
}

function buildSyncConfig(
  request: Pick<
    AssemblyAiSyncSttRequest,
    "format" | "languageCodes" | "prompt" | "vocabulary" | "timestamps"
  >,
): Readonly<Record<string, unknown>> {
  const config: Record<string, unknown> = {
    sample_rate: request.format.sampleRateHz,
    channels: request.format.channels,
  };
  if (request.languageCodes !== undefined) config.language_codes = request.languageCodes;
  if (request.prompt !== undefined) config.prompt = request.prompt;
  if (request.vocabulary !== undefined) config.keyterms_prompt = request.vocabulary;
  if (request.timestamps !== undefined) config.timestamps = request.timestamps;
  return config;
}

function createSyncLiveMultipartBody(
  boundary: string,
  config: Readonly<Record<string, unknown>>,
  request: AssemblyAiSyncLiveSttRequest,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const fileName = safeMultipartFileName(request.fileName ?? "audio.pcm");
  const bytesPerFrame = request.format.channels * 2;
  const maxBytes = request.format.sampleRateHz * bytesPerFrame * 120;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let totalBytes = 0;
  let ended = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="config"\r\n` +
            `Content-Type: application/json\r\n\r\n` +
            `${JSON.stringify(config)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="audio"; filename="${fileName}"\r\n` +
            `Content-Type: audio/pcm\r\n\r\n`,
        ),
      );
      iterator = request.audio[Symbol.asyncIterator]();
    },
    async pull(controller) {
      if (ended || !iterator) return;
      try {
        if (request.signal?.aborted) {
          throw cancelledError(
            "provider.request_cancelled",
            "AssemblyAI Sync live request was cancelled",
            { provider: ASSEMBLYAI_PROVIDER },
          );
        }
        const next = await iterator.next();
        if (next.done) {
          const durationMs = (totalBytes / bytesPerFrame / request.format.sampleRateHz) * 1_000;
          if (durationMs < 80) {
            throw invalidRequest("AssemblyAI Sync accepts at least 80ms of audio");
          }
          controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
          ended = true;
          controller.close();
          return;
        }
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array) || chunk.byteLength % bytesPerFrame !== 0) {
          throw invalidRequest("AssemblyAI Sync live chunks must contain complete PCM samples");
        }
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          throw invalidRequest("AssemblyAI Sync accepts audio through 120 seconds");
        }
        if (chunk.byteLength > 0) controller.enqueue(new Uint8Array(chunk));
      } catch (error) {
        ended = true;
        controller.error(error);
      }
    },
    async cancel() {
      ended = true;
      await iterator?.return?.();
    },
  });
}

function safeMultipartFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function syncLiveUrl(syncUrl: string): string {
  return syncUrl.replace(/\/transcribe\/?$/u, "/transcribe/live");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}

function validateSyncVocabulary(values: readonly string[]): void {
  if (
    !Array.isArray(values) ||
    values.length > 100 ||
    values.some((value) => !validText(value, 8_000)) ||
    values.reduce((total, value) => total + value.length, 0) > 8_000
  ) {
    throw invalidRequest(
      "AssemblyAI Sync vocabulary accepts at most 100 terms and 8000 characters",
    );
  }
}

function validateSpeakerOptions(options: AssemblyAiSpeakerOptions): void {
  for (const [name, value] of [
    ["minSpeakersExpected", options.minSpeakersExpected],
    ["maxSpeakersExpected", options.maxSpeakersExpected],
  ] as const) {
    if (value !== undefined) validatePositiveInteger(value, name, 100);
  }
  if (
    options.minSpeakersExpected !== undefined &&
    options.maxSpeakersExpected !== undefined &&
    options.minSpeakersExpected > options.maxSpeakersExpected
  ) {
    throw invalidRequest("AssemblyAI speaker minimum cannot exceed maximum");
  }
  if (
    options.includeSpeakerConfidence !== undefined &&
    typeof options.includeSpeakerConfidence !== "boolean"
  ) {
    throw invalidRequest("AssemblyAI includeSpeakerConfidence must be a boolean");
  }
}

function validateRedactionOptions(request: AssemblyAiPreRecordedSttRequest): void {
  const hasRedactionOption =
    request.redactPiiPolicies !== undefined ||
    request.redactPiiSub !== undefined ||
    request.redactPiiAudio !== undefined ||
    request.redactPiiAudioQuality !== undefined ||
    request.redactPiiAudioOptions !== undefined ||
    request.redactPiiReturnUnredacted !== undefined ||
    request.redactStaticEntities !== undefined;
  if (hasRedactionOption && request.redactPii !== true) {
    throw invalidRequest("AssemblyAI redaction options require redactPii=true");
  }
  if (request.redactPii === true) {
    if (
      request.redactPiiPolicies === undefined ||
      !Array.isArray(request.redactPiiPolicies) ||
      request.redactPiiPolicies.length === 0 ||
      request.redactPiiPolicies.length > 100 ||
      request.redactPiiPolicies.some((policy) => !validText(policy, 128))
    ) {
      throw invalidRequest(
        "AssemblyAI redactPii requires 1-100 non-empty redactPiiPolicies entries",
      );
    }
  }
  if (
    request.redactPiiSub !== undefined &&
    request.redactPiiSub !== "entity_name" &&
    request.redactPiiSub !== "hash"
  ) {
    throw invalidRequest("AssemblyAI redactPiiSub must be entity_name or hash");
  }
  if (request.redactPiiAudioQuality !== undefined) {
    if (request.redactPiiAudioQuality !== "mp3" && request.redactPiiAudioQuality !== "wav") {
      throw invalidRequest("AssemblyAI redactPiiAudioQuality must be mp3 or wav");
    }
    if (request.redactPiiAudio !== true) {
      throw invalidRequest("AssemblyAI redactPiiAudioQuality requires redactPiiAudio=true");
    }
  }
  if (request.redactPiiAudioOptions !== undefined) {
    if (request.redactPiiAudio !== true) {
      throw invalidRequest("AssemblyAI redactPiiAudioOptions requires redactPiiAudio=true");
    }
    const options = request.redactPiiAudioOptions;
    if (
      options.overrideAudioRedactionMethod !== undefined &&
      options.overrideAudioRedactionMethod !== "beep" &&
      options.overrideAudioRedactionMethod !== "silence"
    ) {
      throw invalidRequest("AssemblyAI overrideAudioRedactionMethod must be beep or silence");
    }
    if (
      options.returnRedactedNoSpeechAudio !== undefined &&
      typeof options.returnRedactedNoSpeechAudio !== "boolean"
    ) {
      throw invalidRequest("AssemblyAI returnRedactedNoSpeechAudio must be a boolean");
    }
  }
  if (request.redactPiiAudio === true && request.redactPii !== true) {
    throw invalidRequest("AssemblyAI redactPiiAudio requires redactPii=true");
  }
  if (request.redactPiiReturnUnredacted === true && request.redactPii !== true) {
    throw invalidRequest("AssemblyAI redactPiiReturnUnredacted requires redactPii=true");
  }
  if (request.redactStaticEntities !== undefined) {
    const entries = Object.entries(request.redactStaticEntities);
    if (entries.length === 0 || entries.length > 100) {
      throw invalidRequest("AssemblyAI redactStaticEntities must contain 1-100 labels");
    }
    for (const [label, terms] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(label)) {
        throw invalidRequest("AssemblyAI redactStaticEntities labels are invalid");
      }
      if (
        !Array.isArray(terms) ||
        terms.length === 0 ||
        terms.length > 100 ||
        terms.some((term) => !validText(term, 8_000))
      ) {
        throw invalidRequest("AssemblyAI redactStaticEntities terms are invalid");
      }
    }
  }
}

function validateVocabulary(values: readonly string[], maxCount: number, maxLength: number): void {
  if (
    !Array.isArray(values) ||
    values.length > maxCount ||
    values.some((value) => !validText(value, maxLength))
  ) {
    throw invalidRequest(`AssemblyAI vocabulary accepts at most ${maxCount} bounded terms`);
  }
}

function validatePreRecordedVocabulary(
  values: readonly string[] | undefined,
  models: readonly string[],
): void {
  if (values === undefined) return;
  const maxCount = models.includes("universal-2") ? 200 : 1_000;
  validateVocabulary(values, maxCount, 8_000);
  if (values.some((value) => value.trim().split(/\s+/u).length > 6)) {
    throw invalidRequest("AssemblyAI pre-recorded keyterms accept at most six words per term");
  }
}

function validatePollOptions(intervalMs: number, timeoutMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 50 || intervalMs > MAX_POLL_INTERVAL_MS) {
    throw invalidRequest(
      `AssemblyAI pollIntervalMs must be between 50 and ${MAX_POLL_INTERVAL_MS}`,
    );
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < intervalMs ||
    timeoutMs > MAX_POLL_TIMEOUT_MS
  ) {
    throw invalidRequest("AssemblyAI pollTimeoutMs is outside the supported range");
  }
}

function validatePositiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw invalidRequest(`AssemblyAI ${name} must be an integer from 1 to ${max}`);
  }
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

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validHeaderValue(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\r\n\u0000]/u.test(value)
  );
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
