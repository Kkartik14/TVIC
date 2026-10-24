import { TVIC_ERROR_CODES, PROVIDER_NAMES, TvicThrowableError, validationError } from "@tvic/core";

const CARTESIA_SONIC_36_LANGUAGES = new Set([
  "en",
  "de",
  "es",
  "fr",
  "ja",
  "pt",
  "zh",
  "hi",
  "ko",
  "it",
  "nl",
  "pl",
  "ru",
  "sv",
  "tr",
  "tl",
  "bg",
  "ro",
  "ar",
  "cs",
  "el",
  "fi",
  "hr",
  "ms",
  "sk",
  "da",
  "ta",
  "uk",
  "hu",
  "no",
  "vi",
  "bn",
  "th",
  "he",
  "ka",
  "id",
  "te",
  "gu",
  "kn",
  "ml",
  "mr",
  "pa",
  "or",
  "ur",
]);

const CARTESIA_SONIC_36_MODELS = new Set(["sonic-3.6", "sonic-3.6-2026-08-27"]);

const CARTESIA_SONIC_35_MODELS = new Set([
  "sonic-3.5",
  "sonic-3.5-2026-05-04",
  "sonic-3",
  "sonic-3-2026-01-12",
]);

const CARTESIA_SONIC_35_LANGUAGES = new Set(
  [...CARTESIA_SONIC_36_LANGUAGES].filter((language) => language !== "or" && language !== "ur"),
);

const CARTESIA_SONIC_36_LOCALES = new Set([
  "en-GB",
  "en-US",
  "en-IN",
  "en-IE",
  "en-ZA",
  "en-NZ",
  "en-SG",
  "en-AU",
  "en-CA",
  "es-ES",
  "es-MX",
  "es-US",
  "fr-FR",
  "fr-CA",
  "nl-NL",
  "nl-BE",
  "pt-PT",
  "pt-BR",
  "bg-BG",
  "bn-IN",
  "cs-CZ",
  "da-DK",
  "de-DE",
  "el-GR",
  "fi-FI",
  "gu-IN",
  "he-IL",
  "hi-IN",
  "hr-HR",
  "hu-HU",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ka-GE",
  "kn-IN",
  "ko-KR",
  "ml-IN",
  "mr-IN",
  "ms-MY",
  "no-NO",
  "or-IN",
  "pa-IN",
  "pl-PL",
  "ro-RO",
  "ru-RU",
  "sk-SK",
  "sv-SE",
  "ta-IN",
  "te-IN",
  "th-TH",
  "tl-PH",
  "tr-TR",
  "uk-UA",
  "ur-IN",
  "vi-VN",
  "zh-CN",
]);

interface CartesiaLanguageParts {
  readonly language: string;
  readonly locale?: string;
}

export function cartesiaTtsLanguageSupported(
  value: string,
  model: string,
  configuredLocale?: string,
): boolean {
  const parts = parseCartesiaLanguage(value);
  if (!parts) return false;
  const modelLanguages = cartesiaLanguagesForModel(model);
  if (!modelLanguages?.has(parts.language)) return false;
  if (
    parts.locale &&
    isCartesiaSonic36Model(model) &&
    !CARTESIA_SONIC_36_LOCALES.has(parts.locale)
  ) {
    return false;
  }
  if (configuredLocale) {
    const configured = parseCartesiaLanguage(configuredLocale);
    if (!configured || configured.language !== parts.language) return false;
    if (parts.locale && configured.locale && parts.locale !== configured.locale) return false;
    if (
      configured.locale &&
      isCartesiaSonic36Model(model) &&
      !CARTESIA_SONIC_36_LOCALES.has(configured.locale)
    ) {
      return false;
    }
  }
  return true;
}

export function cartesiaRequestLanguage(
  value: string,
  model: string,
  configuredLocale?: string,
): CartesiaLanguageParts {
  if (!cartesiaTtsLanguageSupported(value, model, configuredLocale)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.ttsLanguageUnsupported,
        `Cartesia does not support TTS language ${value} for model ${model}`,
        { provider: PROVIDER_NAMES.cartesia, metadata: { model, language: value } },
      ),
    );
  }
  const parts = parseCartesiaLanguage(value);
  if (!parts) {
    throw TvicThrowableError.from(
      validationError(TVIC_ERROR_CODES.ttsLanguageUnsupported, "Invalid Cartesia TTS language", {
        provider: PROVIDER_NAMES.cartesia,
      }),
    );
  }
  if (configuredLocale && isCartesiaSonic36Model(model)) {
    const configured = parseCartesiaLanguage(configuredLocale);
    if (!configured) throw new Error("Cartesia configured locale was not valid during request resolution");
    return { language: "", locale: configured.locale ?? configured.language };
  }
  if (isCartesiaSonic36Model(model)) {
    return parts.locale
      ? { language: "", locale: parts.locale }
      : { language: "", locale: parts.language };
  }
  return { language: parts.language };
}

function cartesiaLanguagesForModel(model: string): ReadonlySet<string> | undefined {
  if (CARTESIA_SONIC_36_MODELS.has(model)) return CARTESIA_SONIC_36_LANGUAGES;
  if (CARTESIA_SONIC_35_MODELS.has(model)) return CARTESIA_SONIC_35_LANGUAGES;
  return undefined;
}

function isCartesiaSonic36Model(model: string): boolean {
  return CARTESIA_SONIC_36_MODELS.has(model);
}

function parseCartesiaLanguage(value: string): CartesiaLanguageParts | undefined {
  const match = /^([a-z]{2})(?:-([a-z]{2}))?$/i.exec(value);
  if (!match?.[1]) return undefined;
  const language = match[1].toLowerCase();
  const region = match[2]?.toUpperCase();
  return {
    language,
    ...(region ? { locale: `${language}-${region}` } : {}),
  };
}

export interface CartesiaGenerationConfig {
  /** Relative output volume; Cartesia interprets the value for the selected model. */
  readonly volume?: number;
  /** Relative speaking speed; a request-level speed overrides this value. */
  readonly speed?: number;
  /** Optional Sonic emotion/style control. */
  readonly emotion?: string;
}

export function assertCartesiaOptions(
  generationConfig: CartesiaGenerationConfig | undefined,
  maxBufferDelayMs: number,
): void {
  if (generationConfig?.volume !== undefined && !Number.isFinite(generationConfig.volume)) {
    throw TvicThrowableError.from(
      validationError(TVIC_ERROR_CODES.providerInvalidRequest, "Cartesia volume must be finite", {
        provider: PROVIDER_NAMES.cartesia,
      }),
    );
  }
  if (generationConfig?.speed !== undefined) {
    assertCartesiaSpeed(generationConfig.speed);
  }
  if (
    generationConfig?.emotion !== undefined &&
    (generationConfig.emotion.length === 0 || generationConfig.emotion.length > 128)
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia emotion must contain between 1 and 128 characters",
        { provider: PROVIDER_NAMES.cartesia },
      ),
    );
  }
  if (!Number.isInteger(maxBufferDelayMs) || maxBufferDelayMs < 0 || maxBufferDelayMs > 5000) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia maxBufferDelayMs must be an integer from 0 through 5000",
        { provider: PROVIDER_NAMES.cartesia, metadata: { maxBufferDelayMs } },
      ),
    );
  }
}

export function assertCartesiaSpeed(speed: number | undefined): void {
  if (speed === undefined) return;
  if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.5) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia speed must be between 0.6 and 1.5",
        { provider: PROVIDER_NAMES.cartesia, metadata: { speed } },
      ),
    );
  }
}

export function cartesiaGenerationConfig(
  configured: CartesiaGenerationConfig | undefined,
  requestSpeed: number | undefined,
): Readonly<Record<string, unknown>> {
  const generationConfig = {
    ...(configured ?? {}),
    ...(requestSpeed !== undefined ? { speed: requestSpeed } : {}),
  };
  return Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {};
}
