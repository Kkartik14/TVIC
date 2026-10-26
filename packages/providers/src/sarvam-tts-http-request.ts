import { PCM16_16K_MONO, PROVIDER_NAMES } from "@tvic/core";
import type { TtsSynthesisRequest } from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
import { assertSupportedModel } from "./common.js";
import {
  SARVAM_TTS_LANGUAGES,
  assertSarvamTtsLanguageExplicit,
  isSarvamTtsLanguageSupported,
  resolveSarvamTtsVoice,
} from "./sarvam-tts-model.js";
import {
  assertSarvamTtsTemperatureModel,
  assertSarvamTtsFormat,
  assertSarvamTtsNumber,
  SARVAM_TTS_SPEED_RANGE,
  sarvamTtsValidationError,
} from "./sarvam-tts-validation.js";
import { SARVAM_TTS_V4_FLASH_MODEL } from "./sarvam-tts-model.js";
import type { SarvamTtsHttpProviderOptions } from "./sarvam-tts-http-options.js";

export const SARVAM_TTS_REST_MAX_TEXT_CHARS = 2_500;
export const SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS = 3_500;

const SARVAM_TTS_REST_DEFAULT_URL = "https://api.sarvam.ai/text-to-speech";
const SARVAM_TTS_HTTP_STREAM_DEFAULT_URL = "https://api.sarvam.ai/text-to-speech/stream";

interface SarvamTtsHttpRequestOptions {
  readonly model: string;
  readonly language: string;
  readonly voice: string;
  readonly pace: number;
  readonly temperature?: number;
  readonly pronunciationDictionaryId?: string;
  readonly transport: "rest" | "http-stream";
}

export function resolveSarvamTtsHttpRequest(
  options: SarvamTtsHttpProviderOptions,
  configuredModel: string,
  request: TtsSynthesisRequest,
  transport: SarvamTtsHttpRequestOptions["transport"],
): SarvamTtsHttpRequestOptions {
  assertSarvamTtsFormat(request.format, "Sarvam HTTP TTS requires 16kHz PCM16 mono output");
  if (request.timestamps === true) {
    throw sarvamTtsValidationError("Sarvam Bulbul HTTP TTS does not provide alignment timestamps");
  }
  if (typeof request.text !== "string") {
    throw sarvamTtsValidationError("Sarvam TTS text must be a string");
  }
  const maxTextChars =
    transport === "rest" ? SARVAM_TTS_REST_MAX_TEXT_CHARS : SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS;
  if (request.text.length === 0 || request.text.length > maxTextChars) {
    throw sarvamTtsValidationError(
      `Sarvam ${transport === "rest" ? "REST" : "HTTP stream"} TTS text must contain 1-${maxTextChars} characters`,
      { maxTextChars, textChars: request.text.length },
    );
  }

  const model = request.model ?? configuredModel;
  assertSupportedModel(PROVIDER_NAMES.sarvamTts, PROVIDER_CATALOG.sarvamTts.models, model);
  assertSarvamTtsTemperatureModel(model, options.temperature);
  assertSarvamTtsLanguageExplicit(model, options.language);
  const voice = resolveSarvamTtsVoice(model, request.voice ?? options.voiceId);
  const language = options.language ?? ADAPTER_DEFAULTS.sarvamTts.language;
  if (!isSarvamTtsLanguageSupported(language, model)) {
    throw sarvamTtsValidationError("Sarvam Bulbul language is invalid", {
      language,
      supportedLanguages: SARVAM_TTS_LANGUAGES,
    });
  }
  const pace = request.speed ?? options.pace ?? ADAPTER_DEFAULTS.sarvamTts.pace;
  assertSarvamTtsNumber("pace", pace, SARVAM_TTS_SPEED_RANGE.min, SARVAM_TTS_SPEED_RANGE.max);
  const temperature =
    model === SARVAM_TTS_V4_FLASH_MODEL
      ? options.temperature
      : (options.temperature ?? ADAPTER_DEFAULTS.sarvamTts.temperature);
  if (temperature !== undefined) assertSarvamTtsNumber("temperature", temperature, 0.01, 1);
  if (
    options.pronunciationDictionaryId !== undefined &&
    (typeof options.pronunciationDictionaryId !== "string" ||
      options.pronunciationDictionaryId.length === 0 ||
      options.pronunciationDictionaryId.length > 256)
  ) {
    throw sarvamTtsValidationError("Sarvam pronunciationDictionaryId is invalid");
  }
  return {
    model,
    language,
    voice,
    pace,
    ...(temperature !== undefined ? { temperature } : {}),
    transport,
    ...(options.pronunciationDictionaryId
      ? { pronunciationDictionaryId: options.pronunciationDictionaryId }
      : {}),
  };
}

export function toSarvamTtsBody(
  text: string,
  options: SarvamTtsHttpRequestOptions,
): Readonly<Record<string, unknown>> {
  return {
    text,
    language_code: options.language,
    speaker: options.voice,
    model: options.model,
    pace: options.pace,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    speech_sample_rate: PCM16_16K_MONO.sampleRateHz,
    output_audio_codec: "wav",
    ...(options.pronunciationDictionaryId ? { dict_id: options.pronunciationDictionaryId } : {}),
  };
}

export function sarvamTtsHeaders(apiKey: string): Readonly<Record<string, string>> {
  return {
    "api-subscription-key": apiKey,
    "Content-Type": "application/json",
  };
}

export function sarvamTtsRestUrl(options: SarvamTtsHttpProviderOptions): string {
  return options.url ?? SARVAM_TTS_REST_DEFAULT_URL;
}

export function sarvamTtsHttpStreamUrl(options: SarvamTtsHttpProviderOptions): string {
  return options.url ?? SARVAM_TTS_HTTP_STREAM_DEFAULT_URL;
}
