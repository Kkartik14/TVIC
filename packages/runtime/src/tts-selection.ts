import {
  canonicalizeLanguageTag,
  evaluateTtsSelectionCompatibility,
  languageTagCandidates,
  normalizeLanguageStringMap,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type {
  ProviderCapabilitySnapshot,
  TextToSpeechProvider,
  TtsProviderSelection,
  TtsProviderSelectionContext,
  TtsTextControl,
  UsageModelOrigin,
} from "@tvic/core";

export const MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES = 128;

declare const TTS_CALL_SELECTION_BRAND: unique symbol;
const resolvedTtsCallSelections = new WeakSet<object>();
const selectionProviders = new WeakMap<object, TextToSpeechProvider | undefined>();
const selectionLanguageProvenance = new WeakMap<
  object,
  { readonly callerSelected: boolean; readonly explicitlySelected: boolean }
>();

export interface TtsCallSelectionInput {
  readonly model?: string;
  readonly modelSource?: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly speed?: number;
  readonly voicesByLanguage?: Readonly<Record<string, string>>;
  readonly textControls?: readonly TtsTextControl[];
  readonly providerCapabilitySnapshots?: readonly ProviderCapabilitySnapshot[];
  readonly providerCapabilityEvaluationTimeMs?: number;
}

/** Capability facts evaluated for one call; they travel with the call selection into TTS requests. */
export interface TtsCallCapabilityContext {
  readonly textControls?: readonly TtsTextControl[];
  readonly providerCapabilitySnapshots?: readonly ProviderCapabilitySnapshot[];
  readonly providerCapabilityEvaluationTimeMs?: number;
}

/** Immutable selection produced by resolveTtsCallSelection for one provider call. */
export interface TtsCallSelection {
  readonly [TTS_CALL_SELECTION_BRAND]: true;
  readonly model?: string;
  readonly modelSource: UsageModelOrigin;
  readonly voice?: string;
  readonly language?: string;
  readonly languageWasExplicitlySelected: boolean;
  readonly languageWasCallerSelected: boolean;
  readonly speed?: number;
  readonly textControls?: readonly TtsTextControl[];
  readonly providerCapabilitySnapshots?: readonly ProviderCapabilitySnapshot[];
  readonly providerCapabilityEvaluationTimeMs?: number;
}

export function resolveTtsCallSelection(
  provider: TextToSpeechProvider | undefined,
  overrides: TtsCallSelectionInput,
  defaults: TtsCallSelectionInput = {},
): TtsCallSelection {
  if (!provider) {
    return createResolvedTtsCallSelection(
      {
        modelSource: overrides.modelSource ?? defaults.modelSource ?? "not_reported",
        languageWasCallerSelected:
          nonEmptyOverride(overrides.language) !== undefined ||
          selectionLanguageProvenance.get(defaults)?.callerSelected === true,
        languageWasExplicitlySelected:
          nonEmptyOverride(overrides.language) !== undefined ||
          nonEmptyOverride(defaults.language) !== undefined ||
          selectionLanguageProvenance.get(defaults)?.explicitlySelected === true,
      },
      undefined,
    );
  }
  const capabilityContext = capabilityContextOf(overrides, defaults);
  const requestedModel = nonEmptyOverride(overrides.model);
  const requestedVoice = nonEmptyOverride(overrides.voice);
  const model = selectValue(requestedModel, defaults.model, provider.configuredModel);
  const modelSource = resolveModelSource(provider, model, overrides, defaults);
  const speed = selectValue(overrides.speed, defaults.speed, undefined);
  const callerLanguage = nonEmptyOverride(overrides.language);
  const requestedLanguage = selectValue(callerLanguage, defaults.language, undefined);
  const normalizedRequestedLanguage = normalizeOptionalLanguage(requestedLanguage, provider.name);
  const languageWasCallerSelected =
    callerLanguage !== undefined ||
    selectionLanguageProvenance.get(defaults)?.callerSelected === true;
  const languageWasExplicitlySelected =
    callerLanguage !== undefined ||
    nonEmptyOverride(defaults.language) !== undefined ||
    selectionLanguageProvenance.get(defaults)?.explicitlySelected === true;
  const voiceForRequirement =
    requestedVoice ?? selectValue(undefined, defaults.voice, provider.configuredVoice);
  const requiresLanguage = ttsSelectionRequiresLanguage(
    provider,
    {
      ...(model !== undefined ? { model } : {}),
      ...(voiceForRequirement !== undefined ? { voice: voiceForRequirement } : {}),
      ...(normalizedRequestedLanguage !== undefined
        ? { language: normalizedRequestedLanguage }
        : {}),
      ...(speed !== undefined ? { speed } : {}),
    },
    {
      languageWasExplicitlySelected,
      languageWasCallerSelected,
    },
  );
  const voiceLanguageMap = selectValue(
    overrides.voicesByLanguage,
    defaults.voicesByLanguage,
    undefined,
  );
  const shouldNormalizeConfiguredLanguage =
    normalizedRequestedLanguage === undefined &&
    provider.configuredLanguage !== undefined &&
    requiresLanguage;
  const hasCombinedSelectionOverride =
    typeof provider.supportsTtsSelection === "function" &&
    (requestedModel !== undefined || requestedVoice !== undefined);
  const shouldCanonicalizeConfiguredLanguage =
    normalizedRequestedLanguage === undefined &&
    provider.configuredLanguage !== undefined &&
    (voiceLanguageMap !== undefined || hasCombinedSelectionOverride);
  const configuredLanguage =
    normalizedRequestedLanguage === undefined
      ? shouldNormalizeConfiguredLanguage
        ? normalizeOptionalLanguage(provider.configuredLanguage, provider.name)
        : shouldCanonicalizeConfiguredLanguage
          ? canonicalizeConfiguredLanguage(provider.configuredLanguage)
          : provider.configuredLanguage
      : undefined;
  const configuredRequiredLanguage =
    requiresLanguage && provider.languageWasExplicitlyConfigured === true
      ? configuredLanguage
      : undefined;
  const language = normalizedRequestedLanguage ?? configuredRequiredLanguage;
  const validationLanguage = normalizedRequestedLanguage ?? configuredLanguage;
  const voiceLanguage = language ?? configuredLanguage;
  const voicesByLanguage = normalizeVoiceLanguageMap(voiceLanguageMap, provider.name);
  const mappedVoiceLanguage =
    voiceLanguage && voicesByLanguage
      ? findMappedVoiceLanguage(voicesByLanguage, voiceLanguage)
      : undefined;
  const mappedVoice =
    mappedVoiceLanguage === undefined ? undefined : voicesByLanguage?.[mappedVoiceLanguage];
  const voice =
    requestedVoice ??
    mappedVoice ??
    selectValue(undefined, defaults.voice, provider.configuredVoice);
  const mappedVoiceValidationRequired = mappedVoice !== undefined && requestedVoice === undefined;
  const inheritedLanguageMayChangeCompatibility =
    configuredLanguage !== undefined &&
    normalizedRequestedLanguage === undefined &&
    hasCombinedSelectionOverride;
  const validateEffectiveLanguage =
    normalizedRequestedLanguage !== undefined ||
    requiresLanguage ||
    mappedVoiceValidationRequired ||
    inheritedLanguageMayChangeCompatibility;
  const candidateSelection: TtsProviderSelection = {
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
  const compatibilityIssues = evaluateTtsSelectionCompatibility(provider, candidateSelection, {
    checkModel: requestedModel !== undefined,
    checkVoice:
      voice !== undefined &&
      (requestedVoice !== undefined ||
        mappedVoice !== undefined ||
        model !== provider.configuredModel),
    voiceOverride: requestedVoice !== undefined || mappedVoice !== undefined,
    checkLanguage: validateEffectiveLanguage || mappedVoiceValidationRequired,
    ...(validationLanguage !== undefined ? { languageForValidation: validationLanguage } : {}),
    ...(validationLanguage !== undefined
      ? {
          languageCompatibilityCandidates: languageTagCandidates(validationLanguage),
        }
      : {}),
    languageIsExplicit:
      languageWasExplicitlySelected || provider.languageWasExplicitlyConfigured !== false,
    languageWasExplicitlySelected,
    languageWasCallerSelected,
    requireLanguageDeclaration:
      normalizedRequestedLanguage !== undefined ||
      requiresLanguage ||
      mappedVoiceValidationRequired,
    checkSpeed: speed !== undefined,
    requireSpeedDeclaration: speed !== undefined,
    checkRequiredFields: true,
    checkProviderSelection: true,
    ...(capabilityContext.providerCapabilitySnapshots !== undefined
      ? { providerCapabilitySnapshots: capabilityContext.providerCapabilitySnapshots }
      : {}),
    ...(capabilityContext.providerCapabilityEvaluationTimeMs !== undefined
      ? {
          providerCapabilityEvaluationTimeMs: capabilityContext.providerCapabilityEvaluationTimeMs,
        }
      : {}),
  });
  if (compatibilityIssues.length > 0) {
    const issue = compatibilityIssues[0]!;
    let message = issue.message;
    if (
      issue.requirement === "language" &&
      issue.message === `Provider ${provider.name} does not declare TTS language support`
    ) {
      message =
        requestedLanguage !== undefined
          ? `Provider ${provider.name} does not declare support for request-level TTS language`
          : requiresLanguage
            ? `Provider ${provider.name} does not declare required TTS language compatibility`
            : `Provider ${provider.name} does not declare configured TTS language compatibility`;
    }
    throwTtsSelectionIssue(provider.name, issue.requirement, message);
  }
  const selection = createResolvedTtsCallSelection(
    {
      ...candidateSelection,
      modelSource,
      languageWasExplicitlySelected,
      languageWasCallerSelected,
      ...capabilityContext,
    },
    provider,
  );
  return selection;
}

/** Returns a copy of a resolved selection that also carries the call's capability context. */
export function withTtsCallCapabilityContext(
  selection: TtsCallSelection,
  context: TtsCallCapabilityContext,
): TtsCallSelection {
  assertResolvedTtsCallSelection(selection);
  return createResolvedTtsCallSelection(
    {
      ...selection,
      ...capabilityContextOf(context, {}),
    },
    selectionProviders.get(selection),
  );
}

/**
 * Whether the provider needs a language for this selection. A throwing adapter hook is reported
 * as a typed validation error instead of escaping as a raw exception.
 */
export function ttsSelectionRequiresLanguage(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
  context?: TtsProviderSelectionContext,
): boolean {
  try {
    const bySelection =
      provider.requiresTtsLanguageForSelection === undefined
        ? undefined
        : provider.requiresTtsLanguageForSelection(selection, context);
    return (bySelection ?? provider.requiresTtsLanguageForModel?.(selection.model)) === true;
  } catch (error) {
    if (error instanceof TvicThrowableError) throw error;
    return invalidRequest(
      provider.name,
      "TTS provider language requirement hook failed while resolving the call selection",
    );
  }
}

export function assertResolvedTtsCallSelection(
  value: unknown,
  provider?: TextToSpeechProvider,
): asserts value is TtsCallSelection {
  if (typeof value !== "object" || value === null || !resolvedTtsCallSelections.has(value)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "ttsSelection must be produced by resolveTtsCallSelection",
      ),
    );
  }
  if (arguments.length > 1 && selectionProviders.get(value) !== provider) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "ttsSelection was resolved for a different TTS provider",
        { ...(provider?.name !== undefined ? { provider: provider.name } : {}) },
      ),
    );
  }
}

function createResolvedTtsCallSelection(
  value: Omit<TtsCallSelection, typeof TTS_CALL_SELECTION_BRAND>,
  provider: TextToSpeechProvider | undefined,
): TtsCallSelection {
  const selection = Object.freeze(value);
  resolvedTtsCallSelections.add(selection);
  selectionProviders.set(selection, provider);
  selectionLanguageProvenance.set(selection, {
    callerSelected: value.languageWasCallerSelected,
    explicitlySelected: value.languageWasExplicitlySelected,
  });
  return selection as TtsCallSelection;
}

function capabilityContextOf(
  overrides: TtsCallCapabilityContext,
  defaults: TtsCallCapabilityContext,
): TtsCallCapabilityContext {
  const textControls = overrides.textControls ?? defaults.textControls;
  const snapshots = overrides.providerCapabilitySnapshots ?? defaults.providerCapabilitySnapshots;
  const evaluationTimeMs =
    overrides.providerCapabilityEvaluationTimeMs ?? defaults.providerCapabilityEvaluationTimeMs;
  return {
    ...(textControls !== undefined ? { textControls } : {}),
    ...(snapshots !== undefined ? { providerCapabilitySnapshots: snapshots } : {}),
    ...(evaluationTimeMs !== undefined
      ? { providerCapabilityEvaluationTimeMs: evaluationTimeMs }
      : {}),
  };
}

function nonEmptyOverride(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function normalizeOptionalLanguage(
  value: string | undefined,
  provider: string,
): string | undefined {
  return value === undefined ? undefined : normalizeLanguage(value, provider);
}

function canonicalizeConfiguredLanguage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return canonicalizeLanguageTag(value) ?? value;
}

function normalizeLanguage(value: string, provider: string): string {
  return (
    canonicalizeLanguageTag(value) ??
    invalidRequest(provider, "TTS language must be a valid BCP-47 tag")
  );
}

function normalizeVoiceLanguageMap(
  input: Readonly<Record<string, string>> | undefined,
  provider: string,
): Readonly<Record<string, string>> | undefined {
  if (input === undefined) return undefined;
  const result = normalizeLanguageStringMap(input, MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES);
  if (result.ok) return result.value;
  switch (result.reason) {
    case "invalid_object":
      return invalidRequest(provider, "TTS voice map must be an object");
    case "too_many_entries":
      return invalidRequest(
        provider,
        `TTS voice map must contain at most ${MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES} entries`,
      );
    case "invalid_language":
      return invalidRequest(provider, "TTS language must be a valid BCP-47 tag");
    case "duplicate_language":
      return invalidRequest(provider, `TTS voice map repeats language ${result.language}`);
    case "invalid_value":
      return invalidRequest(
        provider,
        `TTS voice map entry for ${result.language} must be a non-empty voice id`,
      );
  }
}

function findMappedVoiceLanguage(
  voicesByLanguage: Readonly<Record<string, string>>,
  language: string,
): string | undefined {
  let candidate = language;
  while (true) {
    if (Object.prototype.hasOwnProperty.call(voicesByLanguage, candidate)) return candidate;
    const separator = candidate.lastIndexOf("-");
    if (separator < 0) return undefined;
    candidate = candidate.slice(0, separator);
  }
}

function resolveModelSource(
  provider: TextToSpeechProvider,
  model: string | undefined,
  overrides: TtsCallSelectionInput,
  defaults: TtsCallSelectionInput,
): UsageModelOrigin {
  if (overrides.modelSource !== undefined) return overrides.modelSource;
  if (nonEmptyOverride(overrides.model) !== undefined) return "request";
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

function throwTtsSelectionIssue(
  provider: string,
  requirement: "model" | "voice" | "language" | "speed" | "selection",
  message: string,
): never {
  const details = { provider };
  switch (requirement) {
    case "model":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.providerModelUnsupported, message, details),
      );
    case "voice":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.providerVoiceUnsupported, message, details),
      );
    case "language":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.ttsLanguageUnsupported, message, details),
      );
    case "speed":
    case "selection":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, details),
      );
  }
}
