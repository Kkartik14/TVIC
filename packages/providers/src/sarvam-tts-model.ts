import { PROVIDER_NAMES, TVIC_ERROR_CODES, TvicThrowableError, validationError } from "@tvic/core";

import { ADAPTER_DEFAULTS } from "./catalog.js";
import { SARVAM_TTS_V4_FLASH_MODEL, SARVAM_TTS_V4_FLASH_VOICES } from "./sarvam-tts-v4-voices.js";

export { SARVAM_TTS_V4_FLASH_MODEL } from "./sarvam-tts-v4-voices.js";

export const SARVAM_TTS_LANGUAGES = Object.freeze([
  "hi-IN",
  "bn-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "pa-IN",
  "od-IN",
  "en-IN",
] as const);

export type SarvamTtsLanguage = (typeof SARVAM_TTS_LANGUAGES)[number];

export const SARVAM_TTS_VOICES = Object.freeze([
  "shubh",
  "aditya",
  "ritu",
  "priya",
  "neha",
  "rahul",
  "pooja",
  "rohan",
  "simran",
  "kavya",
  "amit",
  "dev",
  "ishita",
  "shreya",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "roopa",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "anand",
  "tanya",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "shruti",
  "suhani",
  "mohit",
  "kavitha",
  "rehan",
  "soham",
  "rupali",
] as const);

export type SarvamTtsVoice = (typeof SARVAM_TTS_VOICES)[number];

const SARVAM_TTS_LANGUAGE_SET = new Set<string>(SARVAM_TTS_LANGUAGES);
const SARVAM_TTS_VOICE_SET = new Set<string>(SARVAM_TTS_VOICES);
const SARVAM_TTS_V4_FLASH_VOICE_SET = new Set<string>(SARVAM_TTS_V4_FLASH_VOICES);

export function resolveSarvamTtsVoice(model: string, requestedVoice?: string): string {
  if (model === SARVAM_TTS_V4_FLASH_MODEL && requestedVoice === undefined) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerVoiceUnsupported,
        "Sarvam Bulbul v4 requires a caller-selected voice",
        {
          provider: PROVIDER_NAMES.sarvamTts,
          metadata: { model, supportedVoices: SARVAM_TTS_V4_FLASH_VOICES },
        },
      ),
    );
  }
  const voice = requestedVoice ?? ADAPTER_DEFAULTS.sarvamTts.voice;
  assertSarvamTtsVoice(voice, model);
  return voice;
}

export function isSarvamTtsVoiceSupported(value: unknown, model: string): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    /\s/u.test(value)
  ) {
    return false;
  }
  return model === SARVAM_TTS_V4_FLASH_MODEL
    ? SARVAM_TTS_V4_FLASH_VOICE_SET.has(value)
    : SARVAM_TTS_VOICE_SET.has(value);
}

function assertSarvamTtsVoice(value: unknown, model: string): asserts value is string {
  if (!isSarvamTtsVoiceSupported(value, model)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerVoiceUnsupported,
        `Sarvam ${model} voice is invalid`,
        {
          provider: PROVIDER_NAMES.sarvamTts,
          metadata: {
            voice: typeof value === "string" ? value : undefined,
            ...(model === SARVAM_TTS_V4_FLASH_MODEL ? {} : { supportedVoices: SARVAM_TTS_VOICES }),
          },
        },
      ),
    );
  }
}

export function isSarvamTtsLanguageSupported(value: unknown, _model: string): value is string {
  return typeof value === "string" && SARVAM_TTS_LANGUAGE_SET.has(value);
}

export function isSarvamTtsLanguageCompatible(
  value: unknown,
  model: string,
  languageWasExplicitlyConfigured: boolean,
): value is string {
  return (
    (model !== SARVAM_TTS_V4_FLASH_MODEL || languageWasExplicitlyConfigured) &&
    isSarvamTtsLanguageSupported(value, model)
  );
}

export function assertSarvamTtsLanguageExplicit(model: string, language: string | undefined): void {
  if (model === SARVAM_TTS_V4_FLASH_MODEL && language === undefined) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Sarvam Bulbul v4 requires a caller-selected language",
        { provider: PROVIDER_NAMES.sarvamTts, metadata: { model } },
      ),
    );
  }
}

export function assertSarvamTtsLanguage(value: unknown, model: string): asserts value is string {
  if (!isSarvamTtsLanguageSupported(value, model)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Sarvam Bulbul language is invalid",
        {
          provider: PROVIDER_NAMES.sarvamTts,
          metadata: {
            language: typeof value === "string" ? value : undefined,
            supportedLanguages: SARVAM_TTS_LANGUAGES,
          },
        },
      ),
    );
  }
}
