import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  cancelledError,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type { AudioFormat, TtsSynthesisRequest } from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  assertSupportedModel,
  normalizeProviderError,
  parseJsonObject,
  providerError,
  providerEventQueueOverflow,
} from "./common.js";
import {
  assertElevenLabsRequest,
  resolveDialogueVoices,
  toProviderPronunciationDictionaries,
} from "./elevenlabs-options.js";
import {
  ELEVENLABS_DIALOGUE_MAX_CHARACTERS,
  ELEVENLABS_DIALOGUE_MAX_VOICES,
  ELEVENLABS_TTS_CHARACTER_LIMITS,
  ELEVENLABS_TTS_PCM_OUTPUT_FORMAT,
  type ElevenLabsDialogueSynthesisRequest,
  type ElevenLabsHttpTtsProviderOptions,
  type ElevenLabsTtsHttpSynthesisRequest,
  type HttpTransport,
} from "./elevenlabs-http.js";

const ELEVENLABS_TTS_DEFAULT_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_DIALOGUE_DEFAULT_URL = "https://api.elevenlabs.io/v1/text-to-dialogue";
const ELEVENLABS_HTTP_ERROR_BODY_MAX_BYTES = 64 * 1024;
const ELEVENLABS_HTTP_RESPONSE_MAX_BYTES =
  Math.ceil((MAX_PROVIDER_TTS_OUTPUT_BYTES * 4) / 3) + 64 * 1024;

export function toSingleDialogueRequest(
  request: TtsSynthesisRequest,
  voiceId: string,
): ElevenLabsDialogueSynthesisRequest {
  return {
    ...request,
    inputs: [{ text: request.text, voiceId }],
  };
}

export function resolveModel(
  configuredModel: string,
  requestedModel: string | undefined,
  allowUnknownModel: boolean,
): string {
  const model = requestedModel ?? configuredModel;
  if (typeof model !== "string" || model.length === 0 || model.length > 128) {
    throw elevenLabsValidationError("ElevenLabs model id is invalid");
  }
  assertSupportedModel(
    PROVIDER_NAMES.elevenlabs,
    PROVIDER_CATALOG.elevenlabs.models,
    model,
    allowUnknownModel,
  );
  return model;
}

export function validateSpeechRequest(
  request: ElevenLabsTtsHttpSynthesisRequest,
  options: ElevenLabsHttpTtsProviderOptions,
  model: string,
  voice: string,
): void {
  assertElevenLabsFormat(request.format);
  assertElevenLabsText(request.text);
  const maxCharacters = ELEVENLABS_TTS_CHARACTER_LIMITS[model];
  if (
    request.text.length === 0 ||
    (maxCharacters !== undefined && request.text.length > maxCharacters)
  ) {
    throw elevenLabsValidationError(
      `ElevenLabs ${model} text must contain 1-${maxCharacters ?? "the provider limit"} characters`,
      {
        model,
        textCharacters: request.text.length,
        maxCharacters,
      },
    );
  }
  assertElevenLabsRequest(request, options, "tts", voice);
  validateStitching(request);
}

export function validateDialogueRequest(
  request: ElevenLabsDialogueSynthesisRequest,
  options: ElevenLabsHttpTtsProviderOptions,
  model: string,
  primaryVoice: string,
): readonly string[] {
  assertElevenLabsFormat(request.format);
  if (!Array.isArray(request.inputs) || request.inputs.length === 0) {
    throw elevenLabsValidationError("ElevenLabs dialogue inputs must contain at least one item");
  }
  const totalCharacters = request.inputs.reduce((total, input) => {
    if (!input || typeof input.text !== "string" || input.text.length === 0) {
      throw elevenLabsValidationError("ElevenLabs dialogue text must be a non-empty string");
    }
    assertVoice(input.voiceId);
    return total + input.text.length;
  }, 0);
  if (totalCharacters > ELEVENLABS_DIALOGUE_MAX_CHARACTERS) {
    throw elevenLabsValidationError(
      "ElevenLabs dialogue input exceeds the 2,000-character reliability limit",
      {
        totalCharacters,
        maxCharacters: ELEVENLABS_DIALOGUE_MAX_CHARACTERS,
      },
    );
  }
  const voices = [...new Set(request.inputs.map((input) => input.voiceId))];
  if (voices.length > ELEVENLABS_DIALOGUE_MAX_VOICES) {
    throw elevenLabsValidationError("ElevenLabs dialogue accepts at most ten unique voices", {
      voiceCount: voices.length,
    });
  }
  assertElevenLabsRequest(request, options, "dialogue", primaryVoice);
  resolveDialogueVoices(model, primaryVoice, voices);
  validateStitching(request);
  if (request.previousText !== undefined && request.previousText.length > 100) {
    throw elevenLabsValidationError(
      "ElevenLabs dialogue previousText accepts at most 100 characters",
    );
  }
  if (request.futureText !== undefined && request.futureText.length > 100) {
    throw elevenLabsValidationError(
      "ElevenLabs dialogue futureText accepts at most 100 characters",
    );
  }
  return voices;
}

export function validateStitching(
  request: ElevenLabsTtsHttpSynthesisRequest | ElevenLabsDialogueSynthesisRequest,
): void {
  for (const [name, value] of [
    ["previousRequestIds", request.previousRequestIds],
    ["nextRequestIds", request.nextRequestIds],
  ] as const) {
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        value.length > 3 ||
        !value.every((id) => typeof id === "string" && id.length > 0))
    ) {
      throw elevenLabsValidationError(`ElevenLabs ${name} accepts at most three request ids`);
    }
  }
}

export function speechBody(
  request: ElevenLabsTtsHttpSynthesisRequest,
  options: ElevenLabsHttpTtsProviderOptions,
  model: string,
): Readonly<Record<string, unknown>> {
  return {
    text: request.text,
    model_id: model,
    ...(options.language && model !== "eleven_multilingual_v2"
      ? { language_code: options.language }
      : {}),
    voice_settings: {
      stability: options.stability ?? 0.5,
      similarity_boost: options.similarityBoost ?? 0.8,
      ...(options.useSpeakerBoost !== undefined
        ? { use_speaker_boost: options.useSpeakerBoost }
        : {}),
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
    },
    ...(options.pronunciationDictionaryLocators
      ? {
          pronunciation_dictionary_locators: toProviderPronunciationDictionaries(
            options.pronunciationDictionaryLocators,
          ),
        }
      : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.applyTextNormalization !== undefined
      ? { apply_text_normalization: options.applyTextNormalization }
      : {}),
    ...(options.applyLanguageTextNormalization !== undefined
      ? { apply_language_text_normalization: options.applyLanguageTextNormalization }
      : {}),
    ...(request.previousText !== undefined ? { previous_text: request.previousText } : {}),
    ...(request.nextText !== undefined ? { next_text: request.nextText } : {}),
    ...(request.previousRequestIds !== undefined
      ? { previous_request_ids: request.previousRequestIds }
      : {}),
    ...(request.nextRequestIds !== undefined ? { next_request_ids: request.nextRequestIds } : {}),
  };
}

export function dialogueBody(
  request: ElevenLabsDialogueSynthesisRequest,
  options: ElevenLabsHttpTtsProviderOptions,
  model: string,
): Readonly<Record<string, unknown>> {
  return {
    inputs: request.inputs.map((input) => ({ text: input.text, voice_id: input.voiceId })),
    model_id: model,
    ...(options.language && model !== "eleven_multilingual_v2"
      ? { language_code: options.language }
      : {}),
    settings: { stability: options.stability ?? 0.5 },
    ...(options.pronunciationDictionaryLocators
      ? {
          pronunciation_dictionary_locators: toProviderPronunciationDictionaries(
            options.pronunciationDictionaryLocators,
          ),
        }
      : {}),
    ...(options.seed !== undefined ? { seed: Math.max(1, options.seed) } : {}),
    ...(options.applyTextNormalization !== undefined
      ? { apply_text_normalization: options.applyTextNormalization }
      : {}),
    ...(request.previousText !== undefined ? { previous_text: request.previousText } : {}),
    ...(request.futureText !== undefined ? { future_text: request.futureText } : {}),
    ...(request.previousRequestIds !== undefined
      ? { previous_request_ids: request.previousRequestIds }
      : {}),
    ...(request.nextRequestIds !== undefined ? { next_request_ids: request.nextRequestIds } : {}),
  };
}

export function endpointUrl(
  options: ElevenLabsHttpTtsProviderOptions,
  protocol: "tts" | "dialogue",
  transport: HttpTransport,
  timestamped: boolean,
): string {
  const custom = protocol === "tts" ? options.url : options.dialogueUrl;
  if (custom) return custom;
  const base = protocol === "tts" ? ELEVENLABS_TTS_DEFAULT_URL : ELEVENLABS_DIALOGUE_DEFAULT_URL;
  if (protocol === "tts") {
    const voice = encodeURIComponent(options.voiceId);
    return `${base}/${voice}${transport === "http-stream" ? "/stream" : ""}${timestamped ? "/with-timestamps" : ""}`;
  }
  return `${base}${transport === "http-stream" ? "/stream" : ""}${timestamped ? "/with-timestamps" : ""}`;
}

export function buildUrl(
  url: string,
  options: ElevenLabsHttpTtsProviderOptions,
  timestamped: boolean,
): string {
  const parsed = new URL(url);
  parsed.searchParams.set("output_format", ELEVENLABS_TTS_PCM_OUTPUT_FORMAT);
  if (options.enableLogging !== undefined)
    parsed.searchParams.set("enable_logging", String(options.enableLogging));
  if (options.optimizeStreamingLatency !== undefined)
    parsed.searchParams.set("optimize_streaming_latency", String(options.optimizeStreamingLatency));
  if (timestamped) parsed.searchParams.set("output_format", ELEVENLABS_TTS_PCM_OUTPUT_FORMAT);
  return parsed.toString();
}

export async function readRawAudioResponse(response: Response): Promise<Uint8Array> {
  if (!response.body)
    throw elevenLabsProtocolError("ElevenLabs REST response returned no audio body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_PROVIDER_TTS_OUTPUT_BYTES)
        throw providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const audio = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    audio.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (audio.byteLength === 0 || audio.byteLength % 2 !== 0) {
    throw elevenLabsProtocolError("ElevenLabs REST returned malformed PCM16 audio");
  }
  return audio;
}

export async function readTimestampedResponse(
  response: Response,
): Promise<{ readonly audio: Uint8Array; readonly alignment?: ParsedHttpAlignment }> {
  const text = await readBoundedResponseText(response, ELEVENLABS_HTTP_RESPONSE_MAX_BYTES);
  const parsed = parseJsonObject(text);
  if (!parsed) throw elevenLabsProtocolError("ElevenLabs timed response was not a JSON object");
  const audio = parsed.audio_base64;
  if (typeof audio !== "string")
    throw elevenLabsProtocolError("ElevenLabs timed response omitted audio_base64");
  const bytes = decodeBase64Pcm(audio);
  const alignment = parseHttpAlignment(parsed.alignment ?? parsed.normalized_alignment);
  return { audio: bytes, ...(alignment ? { alignment } : {}) };
}

export interface ParsedHttpAlignment {
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
}

export function parseHttpAlignment(value: unknown): ParsedHttpAlignment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const alignment = value as Record<string, unknown>;
  const tokens = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  if (!Array.isArray(tokens) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  if (
    tokens.length === 0 ||
    tokens.length !== starts.length ||
    tokens.length !== ends.length ||
    tokens.length > 4096
  )
    return null;
  if (!tokens.every((token) => typeof token === "string" && token.length <= 256)) return null;
  if (!starts.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0))
    return null;
  if (!ends.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0))
    return null;
  return {
    tokens: tokens as string[],
    startMs: (starts as number[]).map((time) => time * 1_000),
    endMs: (ends as number[]).map((time) => time * 1_000),
  };
}

export function decodeBase64Pcm(value: string): Uint8Array {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw elevenLabsProtocolError("ElevenLabs returned malformed base64 audio");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength % 2 !== 0 ||
    Buffer.from(bytes).toString("base64") !== value
  ) {
    throw elevenLabsProtocolError("ElevenLabs returned malformed PCM16 audio");
  }
  return bytes;
}

export function assertElevenLabsFormat(format: AudioFormat): void {
  if (
    format.encoding !== PCM16_16K_MONO.encoding ||
    format.sampleRateHz !== PCM16_16K_MONO.sampleRateHz ||
    format.channels !== PCM16_16K_MONO.channels
  ) {
    throw elevenLabsValidationError("ElevenLabs HTTP TTS requires 16kHz PCM16 mono output");
  }
}

export function assertElevenLabsText(value: unknown): asserts value is string {
  if (typeof value !== "string")
    throw elevenLabsValidationError("ElevenLabs text must be a string");
}

export function assertVoice(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw TvicThrowableError.from(
      validationError(TVIC_ERROR_CODES.providerVoiceUnsupported, "ElevenLabs voice id is invalid", {
        provider: PROVIDER_NAMES.elevenlabs,
      }),
    );
  }
  return value;
}

export async function elevenLabsHttpResponseError(response: Response): Promise<TvicThrowableError> {
  const body = await readBoundedResponseText(response).catch(() => "");
  const parsed = parseJsonObject(body);
  const nested = asRecord(parsed?.detail) ?? asRecord(parsed?.error);
  const providerCode =
    typeof nested?.status === "string"
      ? boundedString(nested.status, 128)
      : typeof parsed?.code === "string"
        ? boundedString(parsed.code, 128)
        : undefined;
  const message =
    typeof nested?.message === "string"
      ? boundedString(nested.message, 1_024)
      : typeof parsed?.detail === "string"
        ? boundedString(parsed.detail, 1_024)
        : typeof parsed?.message === "string"
          ? boundedString(parsed.message, 1_024)
          : `ElevenLabs TTS request failed with HTTP ${response.status}`;
  const metadata = { httpStatus: response.status, ...(providerCode ? { providerCode } : {}) };
  if (
    /credit|balance|quota/.test(`${providerCode ?? ""} ${message}`.toLowerCase()) ||
    response.status === 429
  ) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerRateLimited, message, {
        provider: PROVIDER_NAMES.elevenlabs,
        metadata,
      }),
    );
  }
  if (response.status === 401 || response.status === 403) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerAuthFailed, message, {
        provider: PROVIDER_NAMES.elevenlabs,
        metadata,
      }),
    );
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
        provider: PROVIDER_NAMES.elevenlabs,
        metadata,
      }),
    );
  }
  if (response.status === 408 || response.status === 409 || response.status >= 500) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerUpstreamFailed, message, {
        provider: PROVIDER_NAMES.elevenlabs,
        metadata,
        retriable: true,
      }),
    );
  }
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      metadata,
      retriable: false,
    }),
  );
}

export function elevenLabsHttpTransportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  controllerSignal: AbortSignal,
): TvicThrowableError {
  if (callerSignal?.aborted) {
    return TvicThrowableError.from(
      cancelledError("provider.connection_cancelled", "ElevenLabs TTS request was cancelled", {
        provider: PROVIDER_NAMES.elevenlabs,
      }),
    );
  }
  if (controllerSignal.aborted && controllerSignal.reason instanceof TvicThrowableError)
    return controllerSignal.reason;
  return TvicThrowableError.from(
    normalizeProviderError(error, {
      code: PROVIDER_ERROR_CODES.elevenlabsTts,
      provider: PROVIDER_NAMES.elevenlabs,
    }),
  );
}

export function normalizeElevenLabsHttpError(error: unknown): TvicThrowableError {
  if (error instanceof TvicThrowableError) return error;
  return TvicThrowableError.from(
    normalizeProviderError(error, {
      code: PROVIDER_ERROR_CODES.elevenlabsTts,
      provider: PROVIDER_NAMES.elevenlabs,
    }),
  );
}

export function elevenLabsProtocolError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    }),
  );
}

export function elevenLabsValidationError(
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      ...(metadata ? { metadata } : {}),
    }),
  );
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = ELEVENLABS_HTTP_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("ElevenLabs response body exceeded the size limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function boundedString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

export class JsonObjectAccumulator {
  #decoder = new TextDecoder();
  #buffer = "";

  push(bytes: Uint8Array): readonly Readonly<Record<string, unknown>>[] {
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    return this.#drain(false);
  }

  finish(): readonly Readonly<Record<string, unknown>>[] {
    this.#buffer += this.#decoder.decode();
    const values = this.#drain(true);
    if (this.#buffer.trim().length !== 0)
      throw elevenLabsProtocolError("ElevenLabs timed stream ended with incomplete JSON");
    return values;
  }

  #drain(final: boolean): Readonly<Record<string, unknown>>[] {
    const values: Readonly<Record<string, unknown>>[] = [];
    let start = 0;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let objectStart = -1;
    for (let index = 0; index < this.#buffer.length; index += 1) {
      const char = this.#buffer[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" && depth === 0) {
        objectStart = index;
        depth = 1;
        continue;
      }
      if (char === "{" && depth > 0) depth += 1;
      else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && objectStart >= 0) {
          const raw = this.#buffer.slice(objectStart, index + 1);
          const parsed = parseJsonObject(raw);
          if (!parsed)
            throw elevenLabsProtocolError("ElevenLabs timed stream returned malformed JSON");
          values.push(parsed);
          start = index + 1;
          objectStart = -1;
        }
      }
    }
    if (start > 0) this.#buffer = this.#buffer.slice(start);
    if (final && this.#buffer.trim().length > 0 && depth === 0) {
      throw elevenLabsProtocolError("ElevenLabs timed stream returned trailing data");
    }
    if (this.#buffer.length > MAX_PROVIDER_FRAME_BYTES)
      throw elevenLabsProtocolError("ElevenLabs timed JSON frame exceeded the size limit");
    return values;
  }
}
