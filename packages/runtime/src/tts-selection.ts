import { TVIC_ERROR_CODES, TvicThrowableError, validationError } from "@tvic/core";
import type { TextToSpeechProvider, UsageModelOrigin } from "@tvic/core";

export interface TtsCallSelectionInput {
  readonly model?: string;
  readonly modelSource?: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
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
  const voice = selectValue(overrides.voice, defaults.voice, provider.configuredVoice);
  const modelSource = resolveModelSource(provider, model, overrides, defaults);
  if (overrides.model !== undefined) validateModelOverride(provider, overrides.model);
  if (overrides.voice !== undefined) validateVoiceOverride(provider, overrides.voice, model);
  if (overrides.language !== undefined) {
    if (typeof provider.supportsTtsLanguage !== "function") {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for request-level TTS language`,
      );
    }
    if (!provider.supportsTtsLanguage(overrides.language, model, voice)) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support TTS language ${overrides.language} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
      );
    }
  }
  if (overrides.speed !== undefined) {
    if (!Number.isFinite(overrides.speed) || overrides.speed <= 0) {
      invalidRequest(provider.name, "TTS speed must be a positive finite number");
    }
    if (typeof provider.supportsTtsSpeed !== "function") {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not declare support for request-level TTS speed`,
      );
    }
    if (!provider.supportsTtsSpeed(overrides.speed, model, voice)) {
      invalidRequest(
        provider.name,
        `Provider ${provider.name} does not support TTS speed ${overrides.speed} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
      );
    }
  }
  return Object.freeze({
    ...(model !== undefined ? { model } : {}),
    modelSource,
    ...(voice !== undefined ? { voice } : {}),
    ...(overrides.language !== undefined ? { language: overrides.language } : {}),
    ...(overrides.speed !== undefined ? { speed: overrides.speed } : {}),
  });
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
