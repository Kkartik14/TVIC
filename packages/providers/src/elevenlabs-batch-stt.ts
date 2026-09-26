import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  sameAudioFormat,
  TvicThrowableError,
} from "@tvic/core";
import type { AudioFormat } from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  assertSupportedModel,
  normalizeProviderError,
  parseJsonObject,
  providerError,
  validationError,
} from "./common.js";

export type ElevenLabsBatchTimestampGranularity = "none" | "word" | "character";
export type ElevenLabsEntityDetection = string | readonly string[];

export interface ElevenLabsBatchSttRequest {
  readonly audio: Uint8Array;
  readonly format: AudioFormat;
  readonly model?: string;
  readonly language?: string;
  readonly keyterms?: readonly string[];
  readonly tagAudioEvents?: boolean;
  readonly diarize?: boolean;
  readonly numSpeakers?: number;
  readonly timestampsGranularity?: ElevenLabsBatchTimestampGranularity;
  readonly diarizationThreshold?: number;
  readonly entityDetection?: ElevenLabsEntityDetection;
  readonly noVerbatim?: boolean;
  readonly signal?: AbortSignal;
}

export interface ElevenLabsBatchSttResult {
  readonly modelId: string;
  readonly text: string;
  readonly languageCode?: string;
  readonly languageProbability?: number;
  readonly words: readonly Readonly<Record<string, unknown>>[];
  readonly entities?: readonly Readonly<Record<string, unknown>>[];
}

interface ElevenLabsBatchOptions {
  readonly apiKey: string;
  readonly url: string;
  readonly fetchImpl: typeof fetch;
}

const MAX_ELEVENLABS_BATCH_RESPONSE_BYTES = 4 * 1024 * 1024;

export function isElevenLabsBatchModel(model: string): boolean {
  return model === "scribe_v2" || model === "scribe_v2_medical";
}

export async function transcribeElevenLabsBatch(
  options: ElevenLabsBatchOptions,
  request: ElevenLabsBatchSttRequest,
  configuredModel: string,
  allowUnknownModel: boolean,
): Promise<ElevenLabsBatchSttResult> {
  const model =
    request.model ?? (isElevenLabsBatchModel(configuredModel) ? configuredModel : "scribe_v2");
  assertSupportedModel(
    PROVIDER_NAMES.elevenlabsStt,
    PROVIDER_CATALOG.elevenlabsStt.models,
    model,
    allowUnknownModel,
  );
  if (!isElevenLabsBatchModel(model)) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        `ElevenLabs model ${model} uses realtime transcription; use open() instead of transcribe()`,
        {
          provider: PROVIDER_NAMES.elevenlabsStt,
          metadata: { model, transport: "websocket" },
        },
      ),
    );
  }
  assertBatchRequest(request);

  const body = new FormData();
  body.append("file", new Blob([Buffer.from(request.audio)]), "audio.pcm");
  body.append("model_id", model);
  body.append("file_format", "pcm_s16le_16");
  if (request.language) body.append("language_code", request.language);
  for (const keyterm of request.keyterms ?? []) body.append("keyterms", keyterm);
  if (request.tagAudioEvents !== undefined) {
    body.append("tag_audio_events", String(request.tagAudioEvents));
  }
  if (request.diarize !== undefined) body.append("diarize", String(request.diarize));
  if (request.numSpeakers !== undefined) body.append("num_speakers", String(request.numSpeakers));
  if (request.timestampsGranularity !== undefined) {
    body.append("timestamps_granularity", request.timestampsGranularity);
  }
  if (request.diarizationThreshold !== undefined) {
    body.append("diarization_threshold", String(request.diarizationThreshold));
  }
  if (typeof request.entityDetection === "string") {
    body.append("entity_detection", request.entityDetection);
  } else {
    for (const entity of request.entityDetection ?? []) body.append("entity_detection", entity);
  }
  if (request.noVerbatim !== undefined) body.append("no_verbatim", String(request.noVerbatim));

  let response: Response;
  try {
    response = await options.fetchImpl(options.url, {
      method: "POST",
      headers: { "xi-api-key": options.apiKey },
      body,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch (error) {
    throw TvicThrowableError.from(
      normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.elevenlabsStt,
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }

  const responseText = await readBoundedResponseText(response);
  if (!response.ok) throw elevenLabsBatchHttpError(response.status, responseText);
  return normalizeBatchResult(responseText, model);
}

function assertBatchRequest(request: ElevenLabsBatchSttRequest): void {
  if (!(request.audio instanceof Uint8Array)) {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "ElevenLabs batch STT audio must be bytes", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  if (!isAudioFormat(request.format) || !sameAudioFormat(request.format, PCM16_16K_MONO)) {
    throw TvicThrowableError.from(
      validationError(
        "stt.audio_format_invalid",
        "ElevenLabs batch STT requires 16kHz PCM16 mono input",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  if (request.audio.byteLength < 3_200 || request.audio.byteLength % 2 !== 0) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "ElevenLabs batch STT PCM16LE input must contain at least 100ms of complete samples",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  const keyterms = request.keyterms ?? [];
  if (
    !Array.isArray(keyterms) ||
    keyterms.length > 1_000 ||
    keyterms.some(
      (term) =>
        typeof term !== "string" ||
        term.length === 0 ||
        term.length >= 50 ||
        term.split(/\s+/u).length > 5 ||
        /[<>()[\]{}\\\u0000-\u001f\u007f]/u.test(term),
    )
  ) {
    throw TvicThrowableError.from(
      validationError(
        "stt.vocabulary_invalid",
        "ElevenLabs batch STT supports at most 1000 keyterms under 50 characters and 5 words each",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  if (
    request.language !== undefined &&
    (typeof request.language !== "string" ||
      request.language.length === 0 ||
      request.language.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(request.language))
  ) {
    throw TvicThrowableError.from(
      validationError("stt.language_invalid", "ElevenLabs language code is invalid", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  if (
    request.numSpeakers !== undefined &&
    (!Number.isInteger(request.numSpeakers) || request.numSpeakers < 1 || request.numSpeakers > 32)
  ) {
    throw TvicThrowableError.from(
      validationError("stt.speaker_count_invalid", "ElevenLabs speaker count must be 1-32", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  if (
    request.diarizationThreshold !== undefined &&
    (!Number.isFinite(request.diarizationThreshold) ||
      request.diarizationThreshold < 0.1 ||
      request.diarizationThreshold > 0.4)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "stt.diarization_threshold_invalid",
        "ElevenLabs diarization threshold must be between 0.1 and 0.4",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  if (request.diarizationThreshold !== undefined && request.diarize !== true) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "ElevenLabs diarizationThreshold requires diarize=true",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  if (
    typeof request.entityDetection === "object" &&
    request.entityDetection !== null &&
    !Array.isArray(request.entityDetection)
  ) {
    throw TvicThrowableError.from(
      validationError("stt.entity_detection_invalid", "ElevenLabs entity detection is invalid", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  } else if (Array.isArray(request.entityDetection)) {
    if (
      request.entityDetection.length === 0 ||
      request.entityDetection.length > 65 ||
      request.entityDetection.some(
        (entity) =>
          typeof entity !== "string" ||
          entity.length === 0 ||
          entity.length > 128 ||
          /[\u0000-\u001f\u007f]/u.test(entity),
      )
    ) {
      throw TvicThrowableError.from(
        validationError(
          "stt.entity_detection_invalid",
          "ElevenLabs entity detection accepts at most 65 bounded entity types",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
  } else if (
    request.entityDetection !== undefined &&
    (typeof request.entityDetection !== "string" ||
      request.entityDetection.length === 0 ||
      request.entityDetection.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(request.entityDetection))
  ) {
    throw TvicThrowableError.from(
      validationError("stt.entity_detection_invalid", "ElevenLabs entity detection is invalid", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  if (
    request.timestampsGranularity !== undefined &&
    request.timestampsGranularity !== "none" &&
    request.timestampsGranularity !== "word" &&
    request.timestampsGranularity !== "character"
  ) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "ElevenLabs timestampsGranularity must be none, word, or character",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  for (const [name, value] of [
    ["tagAudioEvents", request.tagAudioEvents],
    ["diarize", request.diarize],
    ["noVerbatim", request.noVerbatim],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw TvicThrowableError.from(
        validationError("provider.invalid_request", `ElevenLabs ${name} must be a boolean`, {
          provider: PROVIDER_NAMES.elevenlabsStt,
        }),
      );
    }
  }
  if (request.diarize !== true && request.numSpeakers !== undefined) {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "ElevenLabs numSpeakers requires diarize=true", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  if (request.diarizationThreshold !== undefined && request.numSpeakers !== undefined) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "ElevenLabs diarizationThreshold cannot be combined with numSpeakers",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
}

function normalizeBatchResult(body: string, modelId: string): ElevenLabsBatchSttResult {
  const parsed = parseJsonObject(body);
  if (!parsed || typeof parsed.text !== "string" || parsed.text.length > 65_536) {
    throw batchProtocolError("ElevenLabs batch STT returned malformed transcript data");
  }
  const words = boundedWords(parsed.words);
  if (words === null) throw batchProtocolError("ElevenLabs batch STT returned malformed words");
  const languageCode = parsed.language_code;
  const languageProbability = parsed.language_probability;
  if (
    (languageCode !== undefined &&
      (typeof languageCode !== "string" || languageCode.length > 64)) ||
    (languageProbability !== undefined &&
      (typeof languageProbability !== "number" ||
        !Number.isFinite(languageProbability) ||
        languageProbability < 0 ||
        languageProbability > 1))
  ) {
    throw batchProtocolError("ElevenLabs batch STT returned malformed language data");
  }
  const entities = boundedEntities(parsed.entities);
  if (entities === null)
    throw batchProtocolError("ElevenLabs batch STT returned malformed entities");
  return {
    modelId,
    text: parsed.text,
    ...(typeof languageCode === "string" ? { languageCode } : {}),
    ...(typeof languageProbability === "number" ? { languageProbability } : {}),
    words: words ?? [],
    ...(entities !== undefined ? { entities } : {}),
  };
}

function boundedWords(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4_096) return null;
  const words: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const word = entry as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    if (word.text !== undefined) {
      if (typeof word.text !== "string" || word.text.length > 256) return null;
      normalized.text = word.text;
    }
    for (const key of ["type"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "string" || word[key].length > 128) return null;
        normalized[key] = word[key];
      }
    }
    if (word.speaker_id !== undefined) {
      if (
        word.speaker_id !== null &&
        (typeof word.speaker_id !== "string" || word.speaker_id.length > 128)
      ) {
        return null;
      }
      normalized.speaker_id = word.speaker_id;
    }
    if (word.channel_index !== undefined) {
      if (
        word.channel_index !== null &&
        (typeof word.channel_index !== "number" ||
          !Number.isSafeInteger(word.channel_index) ||
          word.channel_index < 0)
      ) {
        return null;
      }
      normalized.channel_index = word.channel_index;
    }
    for (const key of ["start", "end"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "number" || !Number.isFinite(word[key]) || word[key] < 0) {
          return null;
        }
        normalized[key] = word[key];
      }
    }
    if (typeof word.start === "number" && typeof word.end === "number" && word.end < word.start) {
      return null;
    }
    if (word.logprob !== undefined) {
      if (typeof word.logprob !== "number" || !Number.isFinite(word.logprob)) return null;
      normalized.logprob = word.logprob;
    }
    words.push(normalized);
  }
  return words;
}

function boundedEntities(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4_096) return null;
  const entities: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const entity: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(entry)) {
      if (key.length > 128 || Object.keys(entity).length >= 32) return null;
      if (typeof field === "string") {
        if (field.length > 1_024) return null;
        entity[key] = field;
      } else if (typeof field === "number") {
        if (!Number.isFinite(field)) return null;
        entity[key] = field;
      } else if (typeof field === "boolean") {
        entity[key] = field;
      } else {
        return null;
      }
    }
    entities.push(entity);
  }
  return entities;
}

function batchProtocolError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(STT_ERROR_CODES.protocolError, message, {
      provider: PROVIDER_NAMES.elevenlabsStt,
      retriable: false,
    }),
  );
}

export function elevenLabsBatchHttpError(status: number, body: string): TvicThrowableError {
  const code =
    status === 401 || status === 403
      ? STT_ERROR_CODES.authFailed
      : status === 402
        ? STT_ERROR_CODES.quotaExceeded
        : status === 429
          ? STT_ERROR_CODES.rateLimited
          : status >= 400 && status < 500
            ? STT_ERROR_CODES.invalidRequest
            : STT_ERROR_CODES.serviceUnavailable;
  let message = `ElevenLabs batch STT request failed with ${status}`;
  const parsed = parseJsonObject(body);
  const detail = parsed?.detail ?? parsed?.error ?? parsed?.message;
  if (typeof detail === "string" && detail.length > 0) {
    message = boundedErrorMessage(detail);
  } else if (body.trim()) {
    message = boundedErrorMessage(body.trim());
  }
  return TvicThrowableError.from(
    providerError(code, message, {
      provider: PROVIDER_NAMES.elevenlabsStt,
      retriable:
        code === STT_ERROR_CODES.rateLimited || code === STT_ERROR_CODES.serviceUnavailable,
      metadata: { status },
    }),
  );
}

function boundedErrorMessage(value: string): string {
  return value.length <= 1_024 ? value : value.slice(0, 1_021) + "...";
}

function isAudioFormat(value: unknown): value is AudioFormat {
  if (typeof value !== "object" || value === null) return false;
  const format = value as Record<string, unknown>;
  return (
    typeof format.encoding === "string" &&
    typeof format.sampleRateHz === "number" &&
    typeof format.channels === "number"
  );
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) {
    try {
      const text = await response.text();
      return Buffer.byteLength(text, "utf8") <= MAX_ELEVENLABS_BATCH_RESPONSE_BYTES ? text : "";
    } catch {
      return "";
    }
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
      if (bytes > MAX_ELEVENLABS_BATCH_RESPONSE_BYTES) {
        await reader.cancel();
        return "";
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The body is already closed.
    }
    return "";
  }
}
