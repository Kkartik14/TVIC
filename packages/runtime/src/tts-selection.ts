import { TVIC_ERROR_CODES, TvicThrowableError, validationError } from "@tvic/core";
import type { TextToSpeechProvider, UsageModelOrigin } from "@tvic/core";

export const MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES = 128;

export interface TtsCallSelectionInput {
  readonly model?: string;
  readonly modelSource?: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
  readonly voicesByLanguage?: Readonly<Record<string, string>>;
}

export interface TtsCallSelection {
  readonly model?: string;
  readonly modelSource: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
}

export function resolveTtsCallSelection(
  provider: TextToSpeechProvider | undefined,
  overrides: TtsCallSelectionInput,
  defaults: TtsCallSelectionInput = {},
): TtsCallSelection {
  if (!provider) {
    if (Object.keys(overrides).length > 0 || Object.keys(defaults).length > 0) {
      invalidRequest("unknown", "TTS options require a configured TTS provider");
    }
    return Object.freeze({ modelSource: "not_reported" });
  }
  const model = selectValue(overrides.model, defaults.model, provider.configuredModel);
  const modelSource = resolveModelSource(provider, model, overrides, defaults);
  if (overrides.model !== undefined) validateModelOverride(provider, overrides.model);
  const requiresLanguage = provider.requiresTtsLanguageForModel?.(model) === true;
  const voiceLanguageMap = selectValue(
    overrides.voicesByLanguage,
    defaults.voicesByLanguage,
    undefined,
  );
  const speed = overrides.speed;
  const requestedLanguage = selectValue(overrides.language, defaults.language, undefined);
  const normalizedRequestedLanguage = normalizeOptionalLanguage(requestedLanguage, provider.name);
  const configuredLanguage =
    normalizedRequestedLanguage === undefined
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
    configuredLanguage !== undefined;
  const voicesByLanguage = normalizeVoiceLanguageMap(voiceLanguageMap, provider, model, speed);
  const voiceLanguage = language ?? configuredLanguage;
  const mappedVoice = voiceLanguage ? voicesByLanguage?.[voiceLanguage] : undefined;
  const voice =
    overrides.voice ??
    mappedVoice ??
    selectValue(undefined, defaults.voice, provider.configuredVoice);
  if (
    voice !== undefined &&
    (overrides.voice !== undefined || model !== provider.configuredModel)
  ) {
    validateVoiceOverride(provider, voice, model);
  }
  if (requiresLanguage && language === undefined) {
    invalidRequest(
      provider.name,
      `Provider ${provider.name} requires a TTS language for model ${model ?? "default"}`,
    );
  }
  if (validateEffectiveLanguage) {
    if (
      typeof provider.supportsTtsLanguage !== "function" &&
      typeof provider.supportsTtsSelection !== "function"
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
    if (validationLanguage === undefined) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} requires a TTS language for model ${model ?? "default"}`,
      );
    }
    if (
      provider.supportsTtsLanguage &&
      !provider.supportsTtsLanguage(validationLanguage, model, voice)
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
    if (
      typeof provider.supportsTtsSpeed !== "function" &&
      typeof provider.supportsTtsSelection !== "function"
    ) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for request-level TTS speed`,
      );
    }
    if (provider.supportsTtsSpeed && !provider.supportsTtsSpeed(overrides.speed, model, voice)) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support TTS speed ${overrides.speed} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
      );
    }
  }
  const selection: TtsCallSelection = Object.freeze({
    ...(model !== undefined ? { model } : {}),
    modelSource,
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(overrides.speed !== undefined ? { speed: overrides.speed } : {}),
  });
  if (provider.supportsTtsSelection && !provider.supportsTtsSelection(selection)) {
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
    validateVoiceOverride(provider, voice, model);
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

function validateModelOverride(provider: TextToSpeechProvider, model: string): void {
  if (model.trim().length === 0) invalidRequest(provider.name, "TTS model must be non-empty");
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
): void {
  if (voice.trim().length === 0) invalidRequest(provider.name, "TTS voice must be non-empty");
  if (typeof provider.supportsVoice === "function") {
    if (provider.supportsVoice(voice, model)) return;
    invalidRequest(provider.name, `Provider ${provider.name} does not support voice ${voice}`);
  }
  if (provider.capabilities.voices?.includes(voice) || voice === provider.configuredVoice) return;
  if (provider.capabilities.voices === undefined || provider.capabilities.voices.length === 0) {
    invalidRequest(provider.name, `Provider ${provider.name} does not declare TTS voice support`);
  }
  invalidRequest(provider.name, `Provider ${provider.name} does not support voice ${voice}`);
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
