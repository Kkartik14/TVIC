import { PROVIDER_NAMES, TVIC_ERROR_CODES, TvicThrowableError, validationError } from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
import { SARVAM_TTS_V4_FLASH_MODEL, SARVAM_TTS_V4_FLASH_VOICES } from "./sarvam-tts-v4-voices.js";
import { SARVAM_TTS_SPEED_RANGE, sarvamTtsValidationError } from "./sarvam-tts-validation.js";

export { SARVAM_TTS_V4_FLASH_MODEL } from "./sarvam-tts-v4-voices.js";

export const SARVAM_TTS_MODELS = PROVIDER_CATALOG.sarvamTts.models;

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
  "or-IN",
  "en-IN",
] as const);

export type SarvamTtsLanguage = (typeof SARVAM_TTS_LANGUAGES)[number];
export type SarvamTtsVoiceLanguages = Readonly<Record<string, readonly SarvamTtsLanguage[]>>;

const MAX_SARVAM_TTS_VOICE_LANGUAGE_ENTRIES = 128;

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
const SARVAM_TTS_V4_LANGUAGE_SET = new Set([
  "hi-IN",
  "bn-IN",
  "en-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "or-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
]);

export interface SarvamTtsSelectionOptions {
  readonly modelId?: string;
  readonly language?: string;
  readonly voiceId?: string;
  readonly voiceLanguages?: SarvamTtsVoiceLanguages;
}

/** Shared configuration and selection hooks for Sarvam's transport adapters. */
export abstract class SarvamTtsSelectionProvider<Options extends SarvamTtsSelectionOptions> {
  readonly #options: Readonly<Options>;
  readonly #modelId: string;
  readonly #language: SarvamTtsLanguage;
  readonly #languageWasExplicitlyConfigured: boolean;

  protected constructor(options: Options) {
    const voiceLanguages = normalizeSarvamTtsVoiceLanguages(options.voiceLanguages);
    this.#options = Object.freeze({
      ...options,
      ...(voiceLanguages !== undefined ? { voiceLanguages } : {}),
    }) as Readonly<Options>;
    this.#modelId = this.#options.modelId ?? PROVIDER_CATALOG.sarvamTts.defaultModel;
    this.#language = resolveSarvamTtsLanguage(
      this.#options.language ?? ADAPTER_DEFAULTS.sarvamTts.language,
      this.#modelId,
    );
    this.#languageWasExplicitlyConfigured = this.#options.language !== undefined;
  }

  protected get providerOptions(): Readonly<Options> {
    return this.#options;
  }

  get configuredModel(): string {
    return this.#modelId;
  }

  get configuredModelSource(): "configured" | "not_reported" {
    return this.#options.modelId === undefined ? "not_reported" : "configured";
  }

  get configuredLanguage(): string {
    return this.#language;
  }

  get languageWasExplicitlyConfigured(): boolean {
    return this.#languageWasExplicitlyConfigured;
  }

  get configuredVoice(): string | undefined {
    return (
      this.#options.voiceId ??
      (isSarvamTtsV4FlashModel(this.#modelId) ? undefined : ADAPTER_DEFAULTS.sarvamTts.voice)
    );
  }

  supportsVoice(voice: string, model = this.#modelId): boolean {
    return isSarvamTtsVoiceSupported(voice, model);
  }

  supportsLanguage(language: string, model = this.#modelId): boolean {
    return sarvamTtsConfiguredLanguageSupported(
      language,
      this.#language,
      model,
      this.#languageWasExplicitlyConfigured,
    );
  }

  supportsTtsLanguage(
    language: string,
    model = this.#modelId,
    voice = this.configuredVoice,
  ): boolean {
    return sarvamTtsVoiceSupportsLanguage(language, model, voice, this.#options.voiceLanguages);
  }

  requiresTtsLanguageForModel(model = this.#modelId): boolean {
    return isSarvamTtsV4FlashModel(model);
  }

  requiresTtsVoiceForModel(model = this.#modelId): boolean {
    return isSarvamTtsV4FlashModel(model);
  }

  supportsTtsSpeed(speed: number, model = this.#modelId, voice = this.configuredVoice): boolean {
    return sarvamTtsSpeedSupported(speed, model, voice);
  }
}

export function isSarvamTtsV4FlashModel(model: string): boolean {
  return model === SARVAM_TTS_V4_FLASH_MODEL;
}

export function isSarvamTtsModelSupported(value: unknown): value is string {
  return typeof value === "string" && SARVAM_TTS_MODELS.some((model) => model === value);
}

export function sarvamTtsConfiguredLanguageSupported(
  value: string,
  configuredLanguage: string,
  model: string,
  languageWasExplicitlyConfigured: boolean,
): boolean {
  const language = normalizeSarvamTtsLanguage(value);
  return (
    language === configuredLanguage &&
    isSarvamTtsLanguageCompatible(language, model, languageWasExplicitlyConfigured)
  );
}

export function normalizeSarvamTtsLanguage(value: unknown): SarvamTtsLanguage | undefined {
  if (typeof value !== "string" || value.trim() !== value) return undefined;
  const match = /^([a-z]{2})-([a-z]{2})$/i.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const languageCode = match[1].toLowerCase();
  const language = `${languageCode === "od" ? "or" : languageCode}-${match[2].toUpperCase()}`;
  return SARVAM_TTS_LANGUAGE_SET.has(language) ? (language as SarvamTtsLanguage) : undefined;
}

export function sarvamTtsLanguageAliases(value: string): readonly string[] {
  const language = normalizeSarvamTtsLanguage(value);
  if (!language) return [];
  return language === "or-IN" ? ["or-IN", "od-IN"] : [language];
}

export function normalizeSarvamTtsVoiceLanguages(
  value: unknown,
): SarvamTtsVoiceLanguages | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw sarvamTtsValidationError("Sarvam voiceLanguages must be an object of language arrays");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SARVAM_TTS_VOICE_LANGUAGE_ENTRIES) {
    throw sarvamTtsValidationError(
      `Sarvam voiceLanguages must contain at most ${MAX_SARVAM_TTS_VOICE_LANGUAGE_ENTRIES} voices`,
    );
  }
  const result: Record<string, readonly SarvamTtsLanguage[]> = {};
  for (const [voice, values] of entries) {
    if (
      voice.trim().length === 0 ||
      voice.length > 255 ||
      voice.trim() !== voice ||
      /\s/u.test(voice)
    ) {
      throw sarvamTtsValidationError("Sarvam voiceLanguages contains an invalid voice id");
    }
    if (!Array.isArray(values)) {
      throw sarvamTtsValidationError(
        `Sarvam voiceLanguages.${voice} must be an array of supported language tags`,
      );
    }
    const languages: SarvamTtsLanguage[] = [];
    for (const item of values) {
      const language = normalizeSarvamTtsLanguage(item);
      if (!language) {
        throw sarvamTtsValidationError(
          `Sarvam voiceLanguages.${voice} contains an unsupported language tag`,
        );
      }
      if (!languages.includes(language)) languages.push(language);
    }
    Object.defineProperty(result, voice, {
      configurable: false,
      enumerable: true,
      value: Object.freeze(languages),
      writable: false,
    });
  }
  return Object.freeze(result);
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
  voiceLanguages: Readonly<Record<string, readonly string[]>> | undefined,
): boolean {
  const language = normalizeSarvamTtsLanguage(value);
  if (!language || !isSarvamTtsLanguageSupported(language, model)) return false;
  if (!isSarvamTtsV4FlashModel(model)) return true;
  if (!voice || !isSarvamTtsVoiceSupported(voice, model)) return false;
  // V4 uses the persona for voice/style and language_code for pronunciation
  // conventions. The model guide recommends cross-language auditioning and
  // documents Hindi-tagged personas for English requests, so persona IDs do
  // not restrict requests to the language embedded in the ID. Explicit host
  // metadata still narrows a known voice when present.
  const declaredLanguages =
    voiceLanguages && Object.prototype.hasOwnProperty.call(voiceLanguages, voice)
      ? voiceLanguages[voice]
      : undefined;
  return (
    declaredLanguages === undefined ||
    declaredLanguages.some(
      (voiceLanguage) => normalizeSarvamTtsLanguage(voiceLanguage) === language,
    )
  );
}

export function sarvamTtsSpeedSupported(
  speed: number,
  model: string,
  voice: string | undefined,
): boolean {
  return (
    Number.isFinite(speed) &&
    speed >= SARVAM_TTS_SPEED_RANGE.min &&
    speed <= SARVAM_TTS_SPEED_RANGE.max &&
    isSarvamTtsModelSupported(model) &&
    (!isSarvamTtsV4FlashModel(model) || isSarvamTtsVoiceSupported(voice, model))
  );
}

export function resolveSarvamTtsVoice(model: string, requestedVoice?: string): string {
  if (isSarvamTtsV4FlashModel(model) && requestedVoice === undefined) {
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
  return isSarvamTtsV4FlashModel(model)
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
            ...(!isSarvamTtsV4FlashModel(model) ? { supportedVoices: SARVAM_TTS_VOICES } : {}),
          },
        },
      ),
    );
  }
}

export function isSarvamTtsLanguageSupported(value: unknown, model: string): value is string {
  const language = normalizeSarvamTtsLanguage(value);
  return (
    language !== undefined &&
    (!isSarvamTtsV4FlashModel(model) || SARVAM_TTS_V4_LANGUAGE_SET.has(language))
  );
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
    (!isSarvamTtsV4FlashModel(model) || languageWasExplicitlyConfigured) &&
    isSarvamTtsLanguageSupported(value, model)
  );
}

export function assertSarvamTtsLanguageExplicit(model: string, language: string | undefined): void {
  if (isSarvamTtsV4FlashModel(model) && language === undefined) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Sarvam Bulbul v4 requires a caller-selected language",
        { provider: PROVIDER_NAMES.sarvamTts, metadata: { model } },
      ),
    );
  }
}

function sarvamTtsLanguageError(value: unknown, model: string): TvicThrowableError {
  const supportedLanguages = isSarvamTtsV4FlashModel(model)
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
