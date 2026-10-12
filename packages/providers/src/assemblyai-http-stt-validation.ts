import type { AudioFormat } from "@tvic/core";
import { cancelledError, isSampleRateHz, PROVIDER_NAMES, TvicThrowableError } from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { assertSupportedModel, validationError } from "./common.js";
import type {
  AssemblyAiPreRecordedSttRequest,
  AssemblyAiRedactPiiAudioOptions,
  AssemblyAiSpeakerOptions,
  AssemblyAiSyncLiveSttRequest,
  AssemblyAiSyncSttRequest,
} from "./assemblyai-http-stt.js";

const ASSEMBLYAI_PROVIDER = PROVIDER_NAMES.assemblyaiStt;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_POLL_TIMEOUT_MS = 60 * 60_000;

export const ASSEMBLYAI_DEFAULT_PRE_RECORDED_MODELS = Object.freeze([
  "universal-3-5-pro",
  "universal-2",
] as const);

export function validatePreRecordedRequest(request: AssemblyAiPreRecordedSttRequest): {
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

export function resolvePreRecordedModels(
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

export function buildPreRecordedBody(
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

export function validateSyncRequest(request: AssemblyAiSyncSttRequest): void {
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

export function validateSyncLiveRequest(request: AssemblyAiSyncLiveSttRequest): void {
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

export function buildSyncConfig(
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

export function createSyncLiveMultipartBody(
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

export function safeMultipartFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/gu, "_");
}

export function syncLiveUrl(syncUrl: string): string {
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
    const options: AssemblyAiRedactPiiAudioOptions = request.redactPiiAudioOptions;
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

export function validatePreRecordedVocabulary(
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

export function validatePollOptions(intervalMs: number, timeoutMs: number): void {
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
