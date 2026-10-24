import { PROVIDER_NAMES, TVIC_ERROR_CODES, TvicThrowableError, validationError } from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
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
  "or-IN",
  "en-IN",
] as const);

export type SarvamTtsLanguage = (typeof SARVAM_TTS_LANGUAGES)[number];
export type SarvamTtsVoiceLanguages = Readonly<Record<string, readonly SarvamTtsLanguage[]>>;

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
const SARVAM_TTS_V4_LANGUAGE_SET = new Set<SarvamTtsLanguage>([
  "hi-IN",
  "bn-IN",
  "en-IN",
  "gu-IN",
  "kn-IN",
  "mr-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
]);

export function normalizeSarvamTtsLanguage(value: unknown): SarvamTtsLanguage | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const match = /^([a-z]{2})-([a-z]{2})$/i.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const language = `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
  return SARVAM_TTS_LANGUAGE_SET.has(language) ? (language as SarvamTtsLanguage) : undefined;
}

export function toSarvamTtsLanguageCode(value: string): string {
  const language = normalizeSarvamTtsLanguage(value);
  if (!language) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Sarvam Bulbul language is invalid",
        {
          provider: PROVIDER_NAMES.sarvamTts,
          metadata: { language: value, supportedLanguages: SARVAM_TTS_LANGUAGES },
        },
      ),
    );
  }
  return language === "or-IN" ? "od-IN" : language;
}

export function sarvamTtsVoiceSupportsLanguage(
  value: string,
  model: string,
  voice: string | undefined,
  configuredLanguage: string | undefined,
  configuredVoice: string | undefined,
  voiceLanguages: Readonly<Record<string, readonly string[]>> | undefined,
): boolean {
  const language = normalizeSarvamTtsLanguage(value);
  if (!language || !isSarvamTtsLanguageSupported(language, model)) return false;
  if (model !== SARVAM_TTS_V4_FLASH_MODEL) return true;
  if (!voice || !isSarvamTtsVoiceSupported(voice, model)) return false;
  if (voice === configuredVoice && normalizeSarvamTtsLanguage(configuredLanguage) === language) {
    return true;
  }
  return (
    voiceLanguages?.[voice]?.some((voiceLanguage) => {
      return normalizeSarvamTtsLanguage(voiceLanguage) === language;
    }) ?? false
  );
}

export function sarvamTtsSpeedSupported(
  speed: number,
  model: string,
  voice: string | undefined,
): boolean {
  return (
    Number.isFinite(speed) &&
    speed >= 0.5 &&
    speed <= 2.0 &&
    PROVIDER_CATALOG.sarvamTts.models.some((supportedModel) => supportedModel === model) &&
    (model !== SARVAM_TTS_V4_FLASH_MODEL || isSarvamTtsVoiceSupported(voice, model))
  );
}

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

export function isSarvamTtsLanguageSupported(value: unknown, model: string): value is string {
  const language = normalizeSarvamTtsLanguage(value);
  return language !== undefined && (sarvamTtsLanguagesForModel(model)?.includes(language) ?? false);
}

export function sarvamTtsLanguagesForModel(
  model: string,
): readonly SarvamTtsLanguage[] | undefined {
  if (!PROVIDER_CATALOG.sarvamTts.models.some((supportedModel) => supportedModel === model)) {
    return undefined;
  }
  const languages =
    model === SARVAM_TTS_V4_FLASH_MODEL ? [...SARVAM_TTS_V4_LANGUAGE_SET] : SARVAM_TTS_LANGUAGES;
  return Object.freeze([...languages]);
}

export function resolveSarvamTtsLanguage(value: unknown, model: string): SarvamTtsLanguage {
  const language = normalizeSarvamTtsLanguage(value);
  if (!language || !isSarvamTtsLanguageSupported(language, model)) {
    throw sarvamTtsLanguageError(value, model);
  }
  return language;
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
    throw sarvamTtsLanguageError(value, model);
  }
}

function sarvamTtsLanguageError(value: unknown, model: string): TvicThrowableError {
  const supportedLanguages =
    model === SARVAM_TTS_V4_FLASH_MODEL
      ? SARVAM_TTS_LANGUAGES.filter((language) => SARVAM_TTS_V4_LANGUAGE_SET.has(language))
      : SARVAM_TTS_LANGUAGES;
  return sarvamTtsLanguageUnsupportedError(value, model, undefined, supportedLanguages);
}

export function sarvamTtsLanguageUnsupportedError(
  value: unknown,
  model: string,
  voice?: string,
  supportedLanguages: readonly SarvamTtsLanguage[] = SARVAM_TTS_LANGUAGES,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.ttsLanguageUnsupported,
      voice === undefined
        ? "Sarvam Bulbul language is invalid"
        : `Sarvam Bulbul v4 voice ${voice} is not declared for language ${String(value)}`,
      {
        provider: PROVIDER_NAMES.sarvamTts,
        metadata: {
          language: typeof value === "string" ? value : undefined,
          supportedLanguages,
          ...(voice !== undefined ? { voice } : {}),
          model,
        },
      },
    ),
  );
}
