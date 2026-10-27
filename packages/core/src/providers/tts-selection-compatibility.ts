import type {
  TextToSpeechProvider,
  TtsLanguageRequirementDescription,
  TtsProviderSelection,
  TtsProviderSelectionContext,
} from "./tts.js";
import { languageTagCandidates } from "../language.js";
import type { Provider, ProviderTtsSpeedRange } from "../provider.js";

export type TtsSelectionRequirement = "model" | "voice" | "language" | "speed" | "selection";

export interface TtsSelectionCompatibilityIssue {
  readonly requirement: TtsSelectionRequirement;
  readonly message: string;
}

/**
 * Controls which parts of an already-resolved TTS selection are checked.
 * Selection precedence and language-to-voice mapping belong to the caller.
 */
export interface TtsSelectionCompatibilityOptions {
  readonly checkModel?: boolean;
  readonly checkVoice?: boolean;
  readonly checkLanguage?: boolean;
  readonly checkSpeed?: boolean;
  readonly checkRequiredFields?: boolean;
  readonly checkProviderSelection?: boolean;
  /** Let a complete provider hook own combined catalog checks. */
  readonly selectionHookOverridesCatalog?: boolean;
  readonly voiceOverride?: boolean;
  readonly requireModelDeclaration?: boolean;
  readonly requireLanguageDeclaration?: boolean;
  readonly requireSpeedDeclaration?: boolean;
  readonly languageForValidation?: string;
  /** Override the default BCP-47 parent-tag candidates used with static catalogs. */
  readonly languageCompatibilityCandidates?: readonly string[];
  readonly languageIsExplicit?: boolean;
  readonly languageWasExplicitlySelected?: boolean;
  readonly languageWasCallerSelected?: boolean;
  /** Call-scoped capability facts forwarded to adapter hooks. */
  readonly providerCapabilitySnapshots?: TtsProviderSelectionContext["providerCapabilitySnapshots"];
  readonly providerCapabilityEvaluationTimeMs?: number;
}

/**
 * Shared compatibility check for a resolved provider selection. Providers may
 * use this from supportsTtsSelection with checkProviderSelection disabled, then
 * add any wire-route constraints that only that adapter knows about.
 */
export function evaluateTtsSelectionCompatibility(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
  options: TtsSelectionCompatibilityOptions = {},
): readonly TtsSelectionCompatibilityIssue[] {
  const issues: TtsSelectionCompatibilityIssue[] = [];
  const model = selection.model ?? provider.configuredModel;
  const voice = selection.voice ?? provider.configuredVoice;
  const language =
    options.languageForValidation ?? selection.language ?? provider.configuredLanguage;
  const speed = selection.speed;
  const selectionHookOverridesCatalog =
    options.selectionHookOverridesCatalog === true &&
    typeof provider.supportsTtsSelection === "function";
  const selectionContext: TtsProviderSelectionContext = {
    languageWasExplicitlySelected:
      options.languageWasExplicitlySelected ?? selection.language !== undefined,
    languageWasCallerSelected:
      options.languageWasCallerSelected ?? selection.language !== undefined,
    ...(options.providerCapabilitySnapshots !== undefined
      ? { providerCapabilitySnapshots: options.providerCapabilitySnapshots }
      : {}),
    ...(options.providerCapabilityEvaluationTimeMs !== undefined
      ? { providerCapabilityEvaluationTimeMs: options.providerCapabilityEvaluationTimeMs }
      : {}),
  };

  if (
    !selectionHookOverridesCatalog &&
    (options.checkModel ?? selection.model !== undefined) &&
    model !== undefined
  ) {
    const models = provider.capabilities.models;
    if (
      models !== undefined &&
      models.length > 0 &&
      !models.includes(model) &&
      model !== provider.configuredModel &&
      provider.allowUnknownModel !== true
    ) {
      issues.push({
        requirement: "model",
        message: `Provider ${provider.name} does not support model ${model}`,
      });
    } else if (
      (models === undefined || models.length === 0) &&
      options.requireModelDeclaration === true &&
      typeof provider.supportsTtsSelection !== "function"
    ) {
      issues.push({
        requirement: "model",
        message: `Provider ${provider.name} does not declare support for model ${model}`,
      });
    }
  }

  if (options.checkRequiredFields === true) {
    let requirementHookFailed = false;
    let requiresLanguage = false;
    let requiresVoice = false;
    try {
      requiresLanguage =
        (provider.requiresTtsLanguageForSelection?.(selection, selectionContext) ??
          provider.requiresTtsLanguageForModel?.(model)) === true;
      requiresVoice = voice === undefined && provider.requiresTtsVoiceForModel?.(model) === true;
    } catch {
      requirementHookFailed = true;
    }
    if (requirementHookFailed) {
      issues.push({
        requirement: "selection",
        message: `Provider ${provider.name} selection requirement hook failed`,
      });
    }
    const languageIsExplicit =
      options.languageIsExplicit ??
      (selection.language !== undefined || provider.languageWasExplicitlyConfigured !== false);
    let requirementDescription: TtsLanguageRequirementDescription | undefined;
    if (requiresLanguage) {
      try {
        requirementDescription = provider.describeTtsLanguageRequirement?.(
          selection,
          selectionContext,
        );
      } catch {
        issues.push({
          requirement: "selection",
          message: `Provider ${provider.name} language requirement description hook failed`,
        });
      }
    }
    const requirementProvider = requirementDescription?.provider ?? provider.name;
    const requirementModel = requirementDescription?.model ?? model;
    if (requiresLanguage && language === undefined) {
      issues.push({
        requirement: "language",
        message: `Provider ${requirementProvider} requires a TTS language for model ${requirementModel ?? "default"}`,
      });
    } else if (requiresLanguage && !languageIsExplicit) {
      issues.push({
        requirement: "language",
        message: `Provider ${requirementProvider} requires an explicitly selected TTS language for model ${requirementModel ?? "default"}`,
      });
    }
    if (requiresVoice) {
      issues.push({
        requirement: "voice",
        message: `Provider ${provider.name} requires a TTS voice for model ${model ?? "default"}`,
      });
    }
  }

  if (
    !selectionHookOverridesCatalog &&
    (options.checkVoice ?? selection.voice !== undefined) &&
    voice !== undefined
  ) {
    const voiceCatalog = provider.capabilities.voices;
    const hasVoiceSupport =
      typeof provider.supportsVoice === "function" ||
      typeof provider.supportsTtsVoiceOverride === "function" ||
      typeof provider.supportsTtsSelection === "function" ||
      (voiceCatalog?.length ?? 0) > 0;
    if (
      hasVoiceSupport &&
      !supportsVoice(
        provider,
        voice,
        model,
        language,
        options.voiceOverride === true,
        selectionContext,
      )
    ) {
      issues.push({
        requirement: "voice",
        message: `Provider ${provider.name} does not support voice ${voice}`,
      });
    }
  }

  if (
    !selectionHookOverridesCatalog &&
    (options.checkLanguage ?? selection.language !== undefined) &&
    language !== undefined
  ) {
    const languages = provider.capabilities.languages;
    const hasLanguageSupport =
      typeof provider.supportsTtsLanguage === "function" ||
      typeof provider.supportsLanguage === "function" ||
      typeof provider.supportsTtsSelection === "function" ||
      (languages?.length ?? 0) > 0;
    if (!hasLanguageSupport && options.requireLanguageDeclaration === true) {
      issues.push({
        requirement: "language",
        message: `Provider ${provider.name} does not declare TTS language support`,
      });
    } else if (
      hasLanguageSupport &&
      !supportsLanguage(provider, language, model, voice, selectionContext) &&
      !(
        provider.supportsTtsLanguage === undefined &&
        provider.supportsLanguage === undefined &&
        (options.languageCompatibilityCandidates ?? languageTagCandidates(language)).some(
          (candidate) => languages?.includes(candidate),
        )
      )
    ) {
      issues.push({
        requirement: "language",
        message: `Provider ${provider.name} does not support TTS language ${language} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
      });
    }
  } else if (
    !selectionHookOverridesCatalog &&
    options.requireLanguageDeclaration === true &&
    language === undefined
  ) {
    issues.push({
      requirement: "language",
      message: `Provider ${provider.name} requires a TTS language for model ${model ?? "default"}`,
    });
  }

  if (!selectionHookOverridesCatalog && (options.checkSpeed ?? speed !== undefined)) {
    if (speed === undefined || !Number.isFinite(speed) || speed <= 0) {
      if (speed !== undefined) {
        issues.push({
          requirement: "speed",
          message: "TTS speed must be a positive finite number",
        });
      }
    } else if (provider.supportsTtsSpeed) {
      let supported = false;
      try {
        supported = provider.supportsTtsSpeed.call(provider, speed, model, voice, selectionContext);
      } catch {
        supported = false;
      }
      if (!supported) {
        issues.push({
          requirement: "speed",
          message: `Provider ${provider.name} does not support TTS speed ${speed} for model ${model ?? "default"} and voice ${voice ?? "default"}`,
        });
      }
    } else if (declaredTtsSpeedRange(provider, model) !== undefined) {
      if (!isTtsSpeedInDeclaredRange(provider, speed, model)) {
        issues.push({
          requirement: "speed",
          message: `Provider ${provider.name} does not support TTS speed ${speed} for model ${model ?? "default"}`,
        });
      }
    } else if (
      options.requireSpeedDeclaration === true &&
      typeof provider.supportsTtsSelection !== "function"
    ) {
      issues.push({
        requirement: "speed",
        message: `Provider ${provider.name} does not declare support for request-level TTS speed`,
      });
    }
  }

  if (
    issues.length === 0 &&
    options.checkProviderSelection !== false &&
    provider.supportsTtsSelection
  ) {
    let supported = false;
    try {
      supported = provider.supportsTtsSelection.call(
        provider,
        {
          ...(model !== undefined ? { model } : {}),
          ...(voice !== undefined ? { voice } : {}),
          ...(language !== undefined ? { language } : {}),
          ...(speed !== undefined ? { speed } : {}),
        },
        selectionContext,
      );
    } catch {
      // A broken capability hook makes this selection unsupported. Keep it a
      // preflight result instead of letting third-party code crash setup.
      supported = false;
    }
    if (!supported) {
      issues.push({
        requirement: "selection",
        message: "Provider does not support the selected TTS settings",
      });
    }
  }

  return issues;
}

function supportsLanguage(
  provider: TextToSpeechProvider,
  language: string,
  model: string | undefined,
  voice: string | undefined,
  context: TtsProviderSelectionContext,
): boolean {
  try {
    if (provider.supportsTtsLanguage) {
      return provider.supportsTtsLanguage.call(provider, language, model, voice, context);
    }
    if (provider.supportsLanguage) return provider.supportsLanguage.call(provider, language, model);
  } catch {
    return false;
  }
  const languages = provider.capabilities.languages;
  return languages && languages.length > 0 ? languages.includes(language) : true;
}

function supportsVoice(
  provider: TextToSpeechProvider,
  voice: string,
  model: string | undefined,
  language: string | undefined,
  override: boolean,
  context: TtsProviderSelectionContext,
): boolean {
  try {
    if (override && provider.supportsTtsVoiceOverride) {
      return provider.supportsTtsVoiceOverride.call(provider, voice, model, language, context);
    }
    if (provider.supportsVoice) return provider.supportsVoice.call(provider, voice, model);
    if (provider.supportsTtsVoiceOverride) {
      return provider.supportsTtsVoiceOverride.call(provider, voice, model, language, context);
    }
  } catch {
    return false;
  }
  const voices = provider.capabilities.voices;
  return voices && voices.length > 0
    ? voices.includes(voice) || provider.configuredVoice === voice
    : true;
}

/** Returns the adapter-declared request speed range for a model, if any. */
export function declaredTtsSpeedRange(
  provider: Provider,
  model: string | undefined,
): ProviderTtsSpeedRange | undefined {
  return provider.capabilities.ttsSpeedRanges?.find((entry) => entry.model === model);
}

/** Checks a speed against the declared range; an undeclared or malformed range rejects. */
export function isTtsSpeedInDeclaredRange(
  provider: Provider,
  speed: number,
  model: string | undefined,
): boolean {
  const range = declaredTtsSpeedRange(provider, model);
  return (
    range !== undefined &&
    Number.isFinite(speed) &&
    Number.isFinite(range.min) &&
    Number.isFinite(range.max) &&
    range.min <= range.max &&
    speed >= range.min &&
    speed <= range.max
  );
}
