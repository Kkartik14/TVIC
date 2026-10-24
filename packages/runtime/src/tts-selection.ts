import {
  querySpeechControlCatalog,
  hasSpeechControlCatalogFact,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validateTtsPronunciationDictionaries,
  validateTtsTextNormalization,
  validateTtsTextOperations,
  validationError,
} from "@tvic/core";
import type {
  SpeechControlCatalogSnapshot,
  TextToSpeechProvider,
  TtsTextOperation,
  TtsPronunciationDictionaryReference,
  TtsTextNormalization,
  UsageModelOrigin,
} from "@tvic/core";

export const MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES = 128;

export interface TtsCallSelectionInput {
  readonly model?: string;
  readonly modelSource?: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
  readonly voicesByLanguage?: Readonly<Record<string, string>>;
  readonly textOperations?: readonly TtsTextOperation[];
  readonly textNormalization?: TtsTextNormalization;
  readonly pronunciationDictionaries?: readonly TtsPronunciationDictionaryReference[];
}

export interface TtsCallSelection {
  readonly model?: string;
  readonly modelSource: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
  readonly textOperations?: readonly TtsTextOperation[];
  readonly textNormalization?: TtsTextNormalization;
  readonly pronunciationDictionaries?: readonly TtsPronunciationDictionaryReference[];
}

export function resolveTtsCallSelection(
  provider: TextToSpeechProvider | undefined,
  overrides: TtsCallSelectionInput,
  defaults: TtsCallSelectionInput = {},
  catalog?: SpeechControlCatalogSnapshot,
): TtsCallSelection {
  if (!provider) {
    if (Object.keys(overrides).length > 0 || Object.keys(defaults).length > 0) {
      invalidRequest("unknown", "TTS options require a configured TTS provider");
    }
    return Object.freeze({ modelSource: "not_reported" });
  }
  const model = selectValue(overrides.model, defaults.model, provider.configuredModel);
  const modelSource = resolveModelSource(provider, model, overrides, defaults);
  if (model !== undefined) validateModelOverride(provider, model, catalog);
  const requiresLanguage = provider.requiresTtsLanguageForModel?.(model) === true;
  const voiceLanguageMap = selectValue(
    overrides.voicesByLanguage,
    defaults.voicesByLanguage,
    undefined,
  );
  const configuredLanguageMustBeValidated =
    requiresLanguage ||
    provider.languageWasExplicitlyConfigured === true ||
    voiceLanguageMap !== undefined ||
    overrides.model !== undefined;
  const speed = overrides.speed;
  const requestedLanguage = selectValue(overrides.language, defaults.language, undefined);
  const normalizedRequestedLanguage = normalizeOptionalLanguage(requestedLanguage, provider.name);
  const configuredLanguage =
    normalizedRequestedLanguage === undefined && configuredLanguageMustBeValidated
      ? normalizeOptionalLanguage(provider.configuredLanguage, provider.name)
      : undefined;
  const configuredRequiredLanguage =
    requiresLanguage && provider.languageWasExplicitlyConfigured === true
      ? configuredLanguage
      : undefined;
  const language = normalizedRequestedLanguage ?? configuredRequiredLanguage;
  const validationLanguage = normalizedRequestedLanguage ?? configuredLanguage;
  const validateEffectiveLanguage =
    normalizedRequestedLanguage !== undefined ||
    requiresLanguage ||
    (configuredLanguageMustBeValidated && configuredLanguage !== undefined);
  const voicesByLanguage = normalizeVoiceLanguageMap(
    voiceLanguageMap,
    provider,
    model,
    speed,
    catalog,
  );
  const voiceLanguage = language ?? configuredLanguage;
  const mappedVoice = voiceLanguage ? voicesByLanguage?.[voiceLanguage] : undefined;
  const voice =
    overrides.voice ??
    mappedVoice ??
    selectValue(undefined, defaults.voice, provider.configuredVoice);
  if (
    voice !== undefined &&
    (overrides.voice !== undefined ||
      provider.requiresAccountVoiceCatalog === true ||
      (catalog !== undefined && hasSpeechControlCatalogFact(catalog, provider.name, "tts.voice")))
  ) {
    validateVoiceOverride(provider, voice, model, catalog);
  }
  const configuredVoiceIds = provider.ttsVoiceIdsForSelection?.({
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
  });
  if (configuredVoiceIds !== undefined) {
    for (const configuredVoice of configuredVoiceIds) {
      if (configuredVoice !== voice) {
        validateVoiceOverride(provider, configuredVoice, model, catalog);
      }
    }
  }
  if (requiresLanguage && language === undefined) {
    invalidRequest(
      provider.name,
      `Provider ${provider.name} requires a TTS language for model ${model ?? "default"}`,
    );
  }
  if (validateEffectiveLanguage) {
    if (validationLanguage === undefined) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} requires a TTS language for model ${model ?? "default"}`,
      );
    }
    const catalogLanguage = catalogControl(catalog, provider.name, "tts.language", model, voice);
    const languageSupportedByCatalog =
      catalogLanguage?.status === "supported" &&
      (catalogLanguage.fact.languages === undefined ||
        catalogLanguage.fact.languages.includes(validationLanguage));
    const catalogOwnsLanguage =
      catalog !== undefined &&
      ((provider.accountVoiceCatalogControls ?? []).includes("tts.language") ||
        hasSpeechControlCatalogFact(catalog, provider.name, "tts.language"));
    if (
      typeof provider.supportsTtsLanguage !== "function" &&
      typeof provider.supportsTtsSelection !== "function" &&
      !languageSupportedByCatalog
    ) {
      invalidRequest(
        provider.name,
        requestedLanguage !== undefined
          ? `Provider ${provider.name} does not declare support for request-level TTS language`
          : requiresLanguage
            ? `Provider ${provider.name} does not declare required TTS language compatibility`
            : `Provider ${provider.name} does not declare configured TTS language compatibility`,
      );
    }
    if (
      (catalogOwnsLanguage && !languageSupportedByCatalog) ||
      (!catalogOwnsLanguage &&
        provider.supportsTtsLanguage &&
        !provider.supportsTtsLanguage(validationLanguage, model, voice))
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support TTS language ${validationLanguage} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
      );
    }
  }
  if (overrides.speed !== undefined) {
    if (!Number.isFinite(overrides.speed) || overrides.speed <= 0) {
      invalidRequest(provider.name, "TTS speed must be a positive finite number");
    }
    const catalogSpeed = catalogControl(catalog, provider.name, "tts.speed", model, voice);
    const speedSupportedByCatalog =
      catalogSpeed?.status === "supported" &&
      withinCatalogLimits(overrides.speed, catalogSpeed.fact.limits);
    const catalogOwnsSpeed =
      catalog !== undefined && hasSpeechControlCatalogFact(catalog, provider.name, "tts.speed");
    if (
      typeof provider.supportsTtsSpeed !== "function" &&
      typeof provider.supportsTtsSelection !== "function" &&
      !speedSupportedByCatalog
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for request-level TTS speed`,
      );
    }
    if (
      (catalogOwnsSpeed && !speedSupportedByCatalog) ||
      (!catalogOwnsSpeed &&
        provider.supportsTtsSpeed &&
        !provider.supportsTtsSpeed(overrides.speed, model, voice))
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support TTS speed ${overrides.speed} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
      );
    }
  }
  const requestedTextOperations = selectValue(
    overrides.textOperations,
    defaults.textOperations,
    undefined,
  );
  let textOperations: readonly TtsTextOperation[] | undefined;
  if (requestedTextOperations !== undefined) {
    try {
      textOperations = validateTtsTextOperations(requestedTextOperations);
    } catch (error) {
      invalidRequest(
        provider.name,
        `Invalid TTS text operations: ${error instanceof Error ? error.message : "invalid value"}`,
      );
    }
    if (textOperations.length > 0) {
      if (typeof provider.supportsTtsTextOperations !== "function") {
        invalidRequest(
          provider.name,
          `Provider ${provider.name} does not declare support for typed TTS text operations`,
        );
      }
      if (provider.usageAccounting?.reportsTextCharacters !== true) {
        invalidRequest(
          provider.name,
          `Provider ${provider.name} must report provider-bound TTS characters for typed text operations`,
        );
      }
      if (
        !provider.supportsTtsTextOperations(textOperations, {
          ...(model !== undefined ? { model } : {}),
          ...(voice !== undefined ? { voice } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(overrides.speed !== undefined ? { speed: overrides.speed } : {}),
          ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
        })
      ) {
        invalidRequest(
          provider.name,
          `Provider ${provider.name} does not support the requested typed TTS text operations`,
        );
      }
    }
  }
  const requestedNormalization = selectValue(
    overrides.textNormalization,
    defaults.textNormalization,
    undefined,
  );
  let textNormalization: TtsTextNormalization | undefined;
  if (requestedNormalization !== undefined) {
    try {
      textNormalization = validateTtsTextNormalization(requestedNormalization);
    } catch (error) {
      invalidRequest(
        provider.name,
        `Invalid TTS text normalization: ${error instanceof Error ? error.message : "invalid value"}`,
      );
    }
    if (typeof provider.supportsTtsTextNormalization !== "function") {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for request-level TTS text normalization`,
      );
    }
    if (
      !provider.supportsTtsTextNormalization(textNormalization, {
        ...(model !== undefined ? { model } : {}),
        ...(voice !== undefined ? { voice } : {}),
        ...(language !== undefined ? { language } : {}),
        ...(overrides.speed !== undefined ? { speed: overrides.speed } : {}),
        ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
      })
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support the requested TTS text normalization`,
      );
    }
  }
  const requestedDictionaries = selectValue(
    overrides.pronunciationDictionaries,
    defaults.pronunciationDictionaries,
    undefined,
  );
  let pronunciationDictionaries: readonly TtsPronunciationDictionaryReference[] | undefined;
  if (requestedDictionaries !== undefined) {
    try {
      pronunciationDictionaries = validateTtsPronunciationDictionaries(requestedDictionaries);
    } catch (error) {
      invalidRequest(
        provider.name,
        `Invalid TTS pronunciation dictionaries: ${error instanceof Error ? error.message : "invalid value"}`,
      );
    }
    if (typeof provider.supportsTtsPronunciationDictionaries !== "function") {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for request-level TTS pronunciation dictionaries`,
      );
    }
    if (
      !provider.supportsTtsPronunciationDictionaries(pronunciationDictionaries, {
        ...(model !== undefined ? { model } : {}),
        ...(voice !== undefined ? { voice } : {}),
        ...(language !== undefined ? { language } : {}),
        ...(overrides.speed !== undefined ? { speed: overrides.speed } : {}),
        ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
      })
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support the requested TTS pronunciation dictionaries`,
      );
    }
  }
  const selection: TtsCallSelection = Object.freeze({
    ...(model !== undefined ? { model } : {}),
    modelSource,
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(overrides.speed !== undefined ? { speed: overrides.speed } : {}),
    ...(textOperations !== undefined && textOperations.length > 0 ? { textOperations } : {}),
    ...(textNormalization !== undefined ? { textNormalization } : {}),
    ...(pronunciationDictionaries !== undefined ? { pronunciationDictionaries } : {}),
  });
  if (
    provider.supportsTtsSelection &&
    !provider.supportsTtsSelection({
      ...selection,
      ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
    })
  ) {
    invalidRequest(provider.name, "Provider does not support the selected TTS settings");
  }
  return selection;
}

function normalizeOptionalLanguage(
  value: string | undefined,
  provider: string,
): string | undefined {
  return value === undefined ? undefined : normalizeLanguage(value, provider);
}

function normalizeLanguage(value: string, provider: string): string {
  try {
    const [language] = Intl.getCanonicalLocales(value);
    if (language) return language;
  } catch {
    invalidRequest(provider, "TTS language must be a valid BCP-47 tag");
  }
  return invalidRequest(provider, "TTS language must be a valid BCP-47 tag");
}

function normalizeVoiceLanguageMap(
  input: Readonly<Record<string, string>> | undefined,
  provider: TextToSpeechProvider,
  model: string | undefined,
  speed: number | undefined,
  catalog?: SpeechControlCatalogSnapshot,
): Readonly<Record<string, string>> | undefined {
  if (input === undefined) return undefined;
  let entryCount = 0;
  for (const language in input) {
    if (
      Object.prototype.hasOwnProperty.call(input, language) &&
      ++entryCount > MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES
    ) {
      invalidRequest(
        provider.name,
        `TTS voice map must contain at most ${MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES} entries`,
      );
    }
  }
  const normalized: Record<string, string> = {};
  for (const [rawLanguage, voice] of Object.entries(input)) {
    const language = normalizeLanguage(rawLanguage, provider.name);
    if (Object.prototype.hasOwnProperty.call(normalized, language)) {
      invalidRequest(provider.name, `TTS voice map repeats language ${language}`);
    }
    if (typeof voice !== "string" || voice.trim().length === 0) {
      invalidRequest(
        provider.name,
        `TTS voice map entry for ${language} must be a non-empty voice id`,
      );
    }
    validateVoiceOverride(provider, voice, model, catalog);
    if (
      typeof provider.supportsTtsLanguage !== "function" &&
      typeof provider.supportsTtsSelection !== "function"
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for TTS language-to-voice compatibility`,
      );
    }
    if (
      (provider.supportsTtsLanguage && !provider.supportsTtsLanguage(language, model, voice)) ||
      (provider.supportsTtsSelection &&
        !provider.supportsTtsSelection({
          ...(model !== undefined ? { model } : {}),
          voice,
          language,
          ...(speed !== undefined ? { speed } : {}),
          ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
        }))
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support TTS language ${language} for model ${model ?? "default"} and voice ${voice}`,
      );
    }
    normalized[language] = voice;
  }
  return Object.freeze(normalized);
}

function validateModelOverride(
  provider: TextToSpeechProvider,
  model: string,
  catalog?: SpeechControlCatalogSnapshot,
): void {
  if (model.trim().length === 0) invalidRequest(provider.name, "TTS model must be non-empty");
  if (catalog && hasSpeechControlCatalogFact(catalog, provider.name, "tts.model")) {
    const result = querySpeechControlCatalog(catalog, {
      provider: provider.name,
      control: "tts.model",
      model,
    });
    if (result.status !== "supported") {
      invalidRequest(
        provider.name,
        `Speech control catalog ${result.status} for TTS model ${model}`,
      );
    }
  }
  const supportedModels = provider.capabilities.models;
  if (
    supportedModels?.includes(model) ||
    model === provider.configuredModel ||
    provider.allowUnknownModel === true
  ) {
    return;
  }
  if (supportedModels === undefined || supportedModels.length === 0) {
    invalidRequest(provider.name, `Provider ${provider.name} does not declare TTS model support`);
  }
  invalidRequest(provider.name, `Provider ${provider.name} does not support model ${model}`);
}

function validateVoiceOverride(
  provider: TextToSpeechProvider,
  voice: string,
  model: string | undefined,
  catalog?: SpeechControlCatalogSnapshot,
): void {
  if (voice.trim().length === 0) invalidRequest(provider.name, "TTS voice must be non-empty");
  if (provider.requiresAccountVoiceCatalog === true && catalog === undefined) {
    invalidRequest(provider.name, "TTS voice selection requires a current account voice catalog");
  }
  const accountVoiceCatalogProviders = provider.accountVoiceCatalogProviders ?? [provider.name];
  const catalogProvidersWithVoiceFacts = catalog
    ? accountVoiceCatalogProviders.filter((catalogProvider) =>
        hasSpeechControlCatalogFact(catalog, catalogProvider, "tts.voice"),
      )
    : [];
  const providerOwnsVoiceCatalog =
    provider.requiresAccountVoiceCatalog === true || catalogProvidersWithVoiceFacts.length > 0;
  let catalogSupportsVoice = false;
  if (catalog !== undefined && providerOwnsVoiceCatalog) {
    const results = accountVoiceCatalogProviders
      .filter((catalogProvider) =>
        hasSpeechControlCatalogFact(catalog, catalogProvider, "tts.voice"),
      )
      .map((catalogProvider) =>
        querySpeechControlCatalog(catalog, {
          provider: catalogProvider,
          control: "tts.voice",
          ...(model !== undefined ? { model } : {}),
          voice,
        }),
      );
    const supportedCatalog = results.find((result) => result.status === "supported");
    if (supportedCatalog === undefined) {
      const status = results[0]?.status ?? "unknown";
      invalidRequest(
        provider.name,
        `Speech control catalog ${status} for TTS voice ${voice} at model ${model ?? "default"}`,
      );
    }
    catalogSupportsVoice = true;
  }
  const selection = {
    ...(model !== undefined ? { model } : {}),
    voice,
    ...(catalog !== undefined ? { speechControlCatalog: catalog } : {}),
  };
  if (!(catalogSupportsVoice && provider.supportsTtsSelection)) {
    if (typeof provider.supportsVoice === "function") {
      if (!provider.supportsVoice(voice, model)) {
        invalidRequest(provider.name, `Provider ${provider.name} does not support voice ${voice}`);
      }
    } else if (provider.supportsTtsSelection && !provider.supportsTtsSelection(selection)) {
      invalidRequest(provider.name, `Provider ${provider.name} does not support voice ${voice}`);
    }
  }
  if (!provider.supportsVoice && !provider.supportsTtsSelection) {
    if (provider.capabilities.voices?.includes(voice) || voice === provider.configuredVoice) return;
    if (provider.capabilities.voices !== undefined && provider.capabilities.voices.length > 0) {
      invalidRequest(provider.name, `Provider ${provider.name} does not support voice ${voice}`);
    }
    if (catalog === undefined) {
      invalidRequest(provider.name, `Provider ${provider.name} does not declare TTS voice support`);
    }
  }
}

function catalogControl(
  catalog: SpeechControlCatalogSnapshot | undefined,
  provider: string,
  control: string,
  model: string | undefined,
  voice: string | undefined,
): ReturnType<typeof querySpeechControlCatalog> | undefined {
  if (!catalog) return undefined;
  if (!hasSpeechControlCatalogFact(catalog, provider, control)) {
    return undefined;
  }
  return querySpeechControlCatalog(catalog, {
    provider,
    control,
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
  });
}

function withinCatalogLimits(
  value: number,
  limits: Readonly<Record<string, number | string | boolean>> | undefined,
): boolean {
  const minimum = limits?.min;
  const maximum = limits?.max;
  return (
    (minimum === undefined || (typeof minimum === "number" && value >= minimum)) &&
    (maximum === undefined || (typeof maximum === "number" && value <= maximum))
  );
}

function resolveModelSource(
  provider: TextToSpeechProvider,
  model: string | undefined,
  overrides: TtsCallSelectionInput,
  defaults: TtsCallSelectionInput,
): UsageModelOrigin {
  if (overrides.model !== undefined) return "request";
  if (defaults.modelSource !== undefined) return defaults.modelSource;
  if (provider.configuredModelSource !== undefined) return provider.configuredModelSource;
  return model === undefined ? "not_reported" : "configured";
}

function selectValue<T>(
  override: T | undefined,
  fallback: T | undefined,
  configured: T | undefined,
): T | undefined {
  return override ?? fallback ?? configured;
}

function invalidRequest(provider: string, message: string): never {
  throw TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider,
    }),
  );
}
