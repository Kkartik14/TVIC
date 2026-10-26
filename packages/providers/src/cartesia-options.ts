import {
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  resolveProviderCapability,
  validationError,
} from "@tvic/core";
import { CARTESIA_CAPABILITY_FEATURES } from "./cartesia-capability-features.js";
import type { ProviderCapabilitySnapshot } from "@tvic/core";
import { PROVIDER_CATALOG } from "./catalog.js";
import type { ProviderModelLanguageSupport } from "./catalog.js";
import { canonicalizeLocale } from "./common.js";

export const CARTESIA_TTS_SPEED_RANGE = Object.freeze({ min: 0.6, max: 1.5 });

export function cartesiaTtsSpeedRanges(): readonly {
  readonly model: string;
  readonly min: number;
  readonly max: number;
}[] {
  return Object.freeze(
    PROVIDER_CATALOG.cartesia.models.map((model) =>
      Object.freeze({ model, ...CARTESIA_TTS_SPEED_RANGE }),
    ),
  );
}

export interface CartesiaGenerationConfig {
  readonly volume?: number;

  readonly speed?: number;

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
  if (
    !Number.isFinite(speed) ||
    speed < CARTESIA_TTS_SPEED_RANGE.min ||
    speed > CARTESIA_TTS_SPEED_RANGE.max
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        `Cartesia speed must be between ${CARTESIA_TTS_SPEED_RANGE.min} and ${CARTESIA_TTS_SPEED_RANGE.max}`,
        { provider: PROVIDER_NAMES.cartesia, metadata: { speed } },
      ),
    );
  }
}

export function cartesiaTtsLanguageSupported(
  value: string,
  model: string,
  configuredLocale?: string,
): boolean {
  const support = cartesiaLanguageSupport(model);
  const canonicalLocale = canonicalizeLocale(value);
  if (!canonicalLocale) return false;
  if (!support) return true;

  const locale = cartesiaLocaleTag(canonicalLocale);
  const language = cartesiaLanguageCode(new Intl.Locale(canonicalLocale).language);
  if (!support.languages.includes(language)) return false;
  if (locale !== language && !support.locales?.includes(locale)) return false;

  if (configuredLocale !== undefined) {
    const canonicalConfigured = canonicalizeLocale(configuredLocale);
    if (!canonicalConfigured) return false;
    const configured = cartesiaLocaleTag(canonicalConfigured);
    if (!configured || !support.locales?.includes(configured)) return false;
    if (cartesiaLanguageCode(new Intl.Locale(canonicalConfigured).language) !== language) {
      return false;
    }
    if (locale !== language && configured !== locale) return false;
  }

  return true;
}

export function cartesiaRequestLanguage(
  value: string,
  model: string,
  configuredLocale?: string,
): { readonly language: string; readonly locale?: string } {
  if (!cartesiaTtsLanguageSupported(value, model, configuredLocale)) {
    throw cartesiaSettingError(`Cartesia does not support language ${value} for model ${model}`);
  }

  const support = cartesiaLanguageSupport(model);
  const canonicalLocale = canonicalizeLocale(value);
  if (!canonicalLocale) {
    throw cartesiaSettingError(`Cartesia language ${value} is invalid for model ${model}`);
  }
  if (!support) {
    return configuredLocale !== undefined
      ? { language: "", locale: configuredLocale }
      : { language: value };
  }
  const locale = cartesiaLocaleTag(canonicalLocale);
  const configured =
    configuredLocale === undefined
      ? undefined
      : cartesiaLocaleTag(canonicalizeLocale(configuredLocale) ?? "");
  if (configured !== undefined) return { language: "", locale: configured };
  const language = cartesiaLanguageCode(new Intl.Locale(canonicalLocale).language);
  if (locale !== language) return { language: "", locale };
  return { language };
}

function cartesiaLanguageCode(language: string): string {
  return language === "fil" ? "tl" : language;
}

function cartesiaLocaleTag(locale: string): string {
  return locale.replace(/^fil(?=-|$)/u, "tl");
}

export function cartesiaHasLanguageMappingForModel(model: string): boolean {
  return cartesiaLanguageSupport(model) !== undefined;
}

function cartesiaLanguageSupport(model: string): ProviderModelLanguageSupport | undefined {
  return (
    PROVIDER_CATALOG.cartesia.languageSupport as readonly ProviderModelLanguageSupport[] | undefined
  )?.find((entry) => entry.models.includes(model));
}

export function assertCartesiaSpeedVoiceCapability(
  snapshots: readonly ProviderCapabilitySnapshot[] | undefined,
  voice: string,
  speed: number | undefined,
  evaluationTimeMs = Date.now(),
): void {
  if (speed === undefined || snapshots === undefined) {
    return;
  }
  const resolution = resolveProviderCapability(
    snapshots ?? [],
    {
      provider: PROVIDER_NAMES.cartesia,
      feature: CARTESIA_CAPABILITY_FEATURES.ttsVoiceIsPro,
      scope: "voice",
      voice,
    },
    evaluationTimeMs,
  );
  if (resolution.status === "supported" && resolution.value === false) return;

  const state =
    resolution.status === "unknown"
      ? resolution.reason
      : resolution.status === "supported"
        ? "professional_voice"
        : "unsupported";
  throw TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `Cartesia speed requires a verified non-professional voice, but its capability snapshot is ${state}`,
      { provider: PROVIDER_NAMES.cartesia },
    ),
  );
}

export function assertCartesiaVoiceAvailable(
  snapshots: readonly ProviderCapabilitySnapshot[] | undefined,
  model: string,
  voice: string,
  evaluationTimeMs = Date.now(),
): void {
  if (snapshots === undefined) return;
  const resolution = resolveProviderCapability(
    snapshots ?? [],
    {
      provider: PROVIDER_NAMES.cartesia,
      feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
      scope: "voice",
      model,
      voice,
    },
    evaluationTimeMs,
  );
  if (resolution.status === "supported") return;

  const state = resolution.status === "unknown" ? resolution.reason : "unsupported";
  throw TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `Cartesia requires a verified available voice, but its capability snapshot is ${state}`,
      { provider: PROVIDER_NAMES.cartesia },
    ),
  );
}

export function assertCartesiaTtsSettings(
  modelId: string,
  normalization: string | undefined,
  pronunciationDictId: string | undefined,
): void {
  if (normalization !== undefined) {
    try {
      if (normalization !== "auto" && normalization !== "off") {
        Intl.getCanonicalLocales(normalization);
      }
    } catch {
      throw cartesiaSettingError("Cartesia normalization must be auto, off, or a language tag");
    }
    if (!PROVIDER_CATALOG.cartesia.normalizationModels?.some((model) => model === modelId)) {
      throw cartesiaSettingError(`Cartesia normalization is unsupported for model ${modelId}`);
    }
  }
  if (pronunciationDictId !== undefined) {
    if (
      typeof pronunciationDictId !== "string" ||
      pronunciationDictId.trim().length === 0 ||
      pronunciationDictId.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(pronunciationDictId)
    ) {
      throw cartesiaSettingError("Cartesia pronunciation dictionary ID is invalid");
    }
    if (
      !PROVIDER_CATALOG.cartesia.pronunciationDictionaryModels?.some((model) => model === modelId)
    ) {
      throw cartesiaSettingError(
        `Cartesia pronunciation dictionaries are unsupported for model ${modelId}`,
      );
    }
  }
}

function cartesiaSettingError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.cartesia,
    }),
  );
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
