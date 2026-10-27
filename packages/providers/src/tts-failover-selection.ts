import {
  canonicalizeLanguageTag,
  evaluateTtsSelectionCompatibility,
  languageTagCandidates,
  sameAudioFormat,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validationError,
  type TextToSpeechProvider,
  type TtsProviderSelection,
  type TtsSynthesisRequest,
} from "@tvic/core";
import { validateTtsTextControls } from "./tts-text-controls.js";

export interface TtsFailoverRequestVariant {
  readonly when?: TtsProviderSelection;
  readonly fallback: Omit<TtsProviderSelection, "speed">;
}

type ProviderValueKind = "language" | "model" | "voice";

interface ResolvedFallbackSelection {
  readonly selection: TtsProviderSelection;
  readonly languageWasExplicitlySelected: boolean;
  readonly languageWasCallerSelected: boolean;
}

const MAX_TTS_FAILOVER_REQUEST_VARIANTS = 16;

export function normalizeFallbackRequestVariants(
  variants: readonly TtsFailoverRequestVariant[] | undefined,
): readonly TtsFailoverRequestVariant[] | undefined {
  if (variants === undefined) return undefined;
  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    variants.length > MAX_TTS_FAILOVER_REQUEST_VARIANTS
  ) {
    throw new TypeError(
      `TTS failover request variants must contain one to ${MAX_TTS_FAILOVER_REQUEST_VARIANTS} entries`,
    );
  }
  return Object.freeze(
    variants.map((variant) => {
      if (
        !variant ||
        typeof variant !== "object" ||
        Object.keys(variant).some((key) => key !== "when" && key !== "fallback") ||
        !Object.prototype.hasOwnProperty.call(variant, "fallback")
      ) {
        throw new TypeError("TTS failover request variant must declare fallback settings");
      }
      if (
        variant.fallback !== null &&
        typeof variant.fallback === "object" &&
        Object.prototype.hasOwnProperty.call(variant.fallback, "speed")
      ) {
        throw new TypeError("TTS failover fallback request variants cannot change per-call speed");
      }
      return Object.freeze({
        ...(variant.when !== undefined ? { when: snapshotTtsProviderSelection(variant.when) } : {}),
        fallback: snapshotTtsProviderSelection(variant.fallback),
      });
    }),
  );
}

export function resolveFallbackSelections(
  selection: TtsProviderSelection,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
  languageMatch: "exact" | "base-language" = "exact",
  conditionSelection: TtsProviderSelection = selection,
  fallbackProvider?: TextToSpeechProvider,
  languageWasCallerSelected = selection.language !== undefined,
  languageWasExplicitlySelected = languageWasCallerSelected,
): readonly TtsProviderSelection[] {
  return resolveFallbackSelectionEntries(
    selection,
    variants,
    hasRequestMapper,
    languageMatch,
    conditionSelection,
    fallbackProvider,
    languageWasCallerSelected,
    languageWasExplicitlySelected,
  ).map((entry) => entry.selection);
}

function resolveFallbackSelectionEntries(
  selection: TtsProviderSelection,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
  languageMatch: "exact" | "base-language",
  conditionSelection: TtsProviderSelection,
  fallbackProvider: TextToSpeechProvider | undefined,
  languageWasCallerSelected: boolean,
  languageWasExplicitlySelected = languageWasCallerSelected,
): readonly ResolvedFallbackSelection[] {
  if (!hasRequestMapper) {
    const { language: _language, ...withoutLanguage } = selection;
    void _language;
    return [
      {
        selection: Object.freeze({
          ...withoutLanguage,
          ...(languageWasExplicitlySelected && selection.language !== undefined
            ? { language: selection.language }
            : {}),
        }),
        languageWasExplicitlySelected,
        languageWasCallerSelected,
      },
    ];
  }
  if (!variants) return [];
  const fallbackDefaults = fallbackProvider
    ? effectiveProviderSelection(fallbackProvider, {})
    : selection;
  return variants
    .filter(
      (variant) =>
        matchesSelection(conditionSelection, variant.when, languageMatch) &&
        (!languageWasCallerSelected ||
          selection.language === undefined ||
          variant.fallback.language === undefined ||
          selectionValueMatches(
            "language",
            selection.language,
            variant.fallback.language,
            languageMatch,
          )),
    )
    .map((variant) => {
      const mapped = {
        ...fallbackDefaults,
        // The mapper may translate primary model and voice IDs to a different
        // provider's IDs. Only caller language and speed have provider-neutral
        // meaning when a variant leaves those fields open; the mapper's actual
        // output is checked against the fallback immediately before dispatch.
        ...(languageWasExplicitlySelected && selection.language !== undefined
          ? { language: selection.language }
          : {}),
        ...(selection.speed !== undefined ? { speed: selection.speed } : {}),
        ...variant.fallback,
      };
      const model = mapped.model ?? fallbackProvider?.configuredModel;
      if (
        fallbackProvider?.languageWasExplicitlyConfigured === false &&
        safelyRequiresTtsLanguageForModel(fallbackProvider, model) &&
        !languageWasExplicitlySelected &&
        variant.fallback.language === undefined
      ) {
        const { language: implicitLanguage, ...withoutImplicitLanguage } = mapped;
        void implicitLanguage;
        return {
          selection: Object.freeze(withoutImplicitLanguage),
          languageWasExplicitlySelected:
            languageWasExplicitlySelected || variant.fallback.language !== undefined,
          languageWasCallerSelected,
        };
      }
      return {
        selection: Object.freeze(mapped),
        languageWasExplicitlySelected:
          languageWasExplicitlySelected || variant.fallback.language !== undefined,
        languageWasCallerSelected,
      };
    });
}

function safelyRequiresTtsLanguageForModel(
  provider: TextToSpeechProvider,
  model?: string,
): boolean {
  try {
    return provider.requiresTtsLanguageForModel?.(model) === true;
  } catch {
    // Fail closed when resolving a declared fallback variant, without letting
    // a provider hook's exception escape failover setup.
    return true;
  }
}

export function selectionFromRequest(request: TtsSynthesisRequest): TtsProviderSelection {
  return {
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.voice !== undefined ? { voice: request.voice } : {}),
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
  };
}

export function supportsTtsFailoverSelection(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  selection: TtsProviderSelection,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
  languageMatch: "exact" | "base-language" = "exact",
  languageWasCallerSelected = selection.language !== undefined,
  languageWasExplicitlySelected = languageWasCallerSelected,
): boolean {
  if (
    !supportsTtsProviderSelection(
      primary,
      selection,
      languageWasExplicitlySelected,
      languageWasCallerSelected,
    )
  ) {
    return false;
  }
  // A request mapper's output is only knowable at synthesis time unless the
  // host supplied declarative variants. Preflight the primary here; validate
  // the mapped fallback request immediately before opening that provider.
  if (hasRequestMapper && variants === undefined) return true;
  const fallbackSelections = resolveFallbackSelectionEntries(
    selection,
    variants,
    hasRequestMapper,
    languageMatch,
    effectiveProviderSelection(primary, selection),
    fallback,
    languageWasCallerSelected,
    languageWasExplicitlySelected,
  );
  return (
    fallbackSelections.length > 0 &&
    fallbackSelections.every(
      ({
        selection: fallbackSelection,
        languageWasExplicitlySelected,
        languageWasCallerSelected,
      }) =>
        supportsTtsProviderSelection(
          fallback,
          fallbackSelection,
          languageWasExplicitlySelected,
          languageWasCallerSelected,
        ),
    )
  );
}

export function assertMappedRequestMatchesVariant(
  mapped: TtsSynthesisRequest,
  variants: readonly TtsFailoverRequestVariant[],
  fallback: TextToSpeechProvider,
  primarySelection: TtsProviderSelection,
  languageMatch: "exact" | "base-language" = "exact",
  mappedLanguageWasExplicit = true,
  languageWasCallerSelected = false,
): string | undefined {
  const actual = effectiveProviderSelection(fallback, selectionFromRequest(mapped));
  const whenMatched = variants.filter((variant) =>
    matchesSelection(primarySelection, variant.when, languageMatch),
  );
  const eligible = whenMatched.filter(
    (variant) =>
      !languageWasCallerSelected ||
      primarySelection.language === undefined ||
      variant.fallback.language === undefined ||
      selectionValueMatches(
        "language",
        primarySelection.language,
        variant.fallback.language,
        languageMatch,
      ),
  );
  const matching = eligible.filter((variant) => {
    const effectiveFallback =
      !mappedLanguageWasExplicit && variant.fallback.language !== undefined
        ? { ...actual, language: variant.fallback.language }
        : actual;
    return matchesSelection(effectiveFallback, variant.fallback, languageMatch);
  });
  if (matching.length > 0) {
    return mappedLanguageWasExplicit
      ? undefined
      : matching.find((variant) => variant.fallback.language !== undefined)?.fallback.language;
  }

  const closestMismatch = eligible
    .map((variant) =>
      Object.keys(variant.fallback).filter(
        (key) =>
          !selectionValueMatches(
            key as keyof TtsProviderSelection,
            actual[key as keyof TtsProviderSelection],
            (variant.fallback as TtsProviderSelection)[key as keyof TtsProviderSelection],
            languageMatch,
          ),
      ),
    )
    .sort((left, right) => left.length - right.length)[0];
  const callerLanguageMismatch = whenMatched.length > 0 && eligible.length === 0;
  const mismatchedFields = callerLanguageMismatch
    ? "language"
    : eligible.length > 0
      ? closestMismatch?.join(", ") || "fallback settings"
      : [...new Set(variants.flatMap((variant) => Object.keys(variant.when ?? {})))].join(", ") ||
        "when";
  const mismatchKind =
    callerLanguageMismatch || eligible.length > 0 ? "fallback fields" : "variant conditions";
  throw TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `TTS failover mapping must match a declared fallback request variant; mismatched ${mismatchKind}: ${mismatchedFields}`,
      { provider: fallback.name },
    ),
  );
}

export function providerValueCatalog(
  provider: TextToSpeechProvider,
  kind: ProviderValueKind,
): readonly string[] | undefined {
  const values =
    kind === "language"
      ? provider.capabilities.languages
      : kind === "model"
        ? provider.capabilities.models
        : provider.capabilities.voices;
  return values && values.length > 0 ? values : undefined;
}

export function intersectProviderCatalogs(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  kind: ProviderValueKind,
): readonly string[] | undefined {
  const primaryValues = providerValueCatalog(primary, kind);
  const fallbackValues = providerValueCatalog(fallback, kind);
  if (!primaryValues || !fallbackValues) return undefined;
  const fallbackSet = new Set(fallbackValues);
  return primaryValues.filter((value) => fallbackSet.has(value));
}

export function canCheckProviderValue(
  provider: TextToSpeechProvider,
  kind: "language" | "voice",
): boolean {
  const values =
    kind === "language" ? provider.capabilities.languages : provider.capabilities.voices;
  if (kind === "language") {
    return (
      typeof provider.supportsLanguage === "function" ||
      typeof provider.supportsTtsLanguage === "function" ||
      (values?.length ?? 0) > 0
    );
  }
  return typeof provider.supportsVoice === "function" || (values?.length ?? 0) > 0;
}

export function providerSupportsValue(
  provider: TextToSpeechProvider,
  kind: "language" | "voice",
  value: string,
  model?: string,
): boolean {
  if (kind === "voice" && provider.capabilities.voiceSelection === "account_snapshot") {
    return true;
  }
  const selection = {
    ...(model !== undefined ? { model } : {}),
    [kind]: value,
  };
  return (
    evaluateTtsSelectionCompatibility(provider, selection, {
      checkModel: false,
      checkVoice: kind === "voice",
      checkLanguage: kind === "language",
      ...(kind === "language"
        ? { languageCompatibilityCandidates: languageTagCandidates(value) }
        : {}),
      checkRequiredFields: false,
      checkProviderSelection: false,
    }).length === 0
  );
}

export function supportsTtsFailoverLanguage(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  language: string,
  model: string | undefined,
  voice: string | undefined,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  hasRequestMapper: boolean,
  languageMatch: "exact" | "base-language" = "exact",
  languageWasCallerSelected = true,
  languageWasExplicitlySelected = languageWasCallerSelected,
): boolean {
  return supportsTtsFailoverSelection(
    primary,
    fallback,
    {
      language,
      ...(model !== undefined ? { model } : {}),
      ...(voice !== undefined ? { voice } : {}),
    },
    variants,
    hasRequestMapper,
    languageMatch,
    languageWasCallerSelected,
    languageWasExplicitlySelected,
  );
}

export function providerSupportsTtsVoiceOverride(
  provider: TextToSpeechProvider,
  voice: string,
  model?: string,
  language?: string,
): boolean {
  return (
    evaluateTtsSelectionCompatibility(
      provider,
      {
        voice,
        ...(model !== undefined ? { model } : {}),
        ...(language !== undefined ? { language } : {}),
      },
      {
        checkModel: false,
        checkVoice: true,
        checkLanguage: false,
        voiceOverride: true,
        checkRequiredFields: false,
        checkProviderSelection: false,
      },
    ).length === 0
  );
}

export function assertFallbackRequestSupported(
  fallback: TextToSpeechProvider,
  request: TtsSynthesisRequest,
  languageWasCallerSelected = request.selectionContext?.languageWasCallerSelected ??
    request.language !== undefined,
  languageWasExplicitlySelected = languageWasCallerSelected,
): void {
  validateTtsTextControls(fallback, request);
  const outputFormats = fallback.capabilities.audio?.output;
  if (!outputFormats?.some((format) => sameAudioFormat(format, request.format))) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        `TTS failover fallback ${fallback.name} does not declare support for the requested output format`,
        { provider: fallback.name, metadata: { format: request.format } },
      ),
    );
  }

  const model = request.model ?? fallback.configuredModel;
  const voice = request.voice ?? fallback.configuredVoice;
  const language = request.language ?? fallback.configuredLanguage;
  const selection: TtsProviderSelection = {
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
  };
  const issue = evaluateFailoverSelection(
    fallback,
    selection,
    languageWasExplicitlySelected || fallback.languageWasExplicitlyConfigured !== false,
    languageWasCallerSelected,
    languageWasExplicitlySelected,
  )[0];
  if (issue) throwFallbackSelectionIssue(fallback, issue, selection);
}

function snapshotTtsProviderSelection(value: TtsProviderSelection): TtsProviderSelection {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => key !== "model" && key !== "voice" && key !== "language" && key !== "speed",
    )
  ) {
    throw new TypeError(
      "TTS failover selection must contain only model, voice, language, and speed",
    );
  }
  const { model, voice, language, speed } = value;
  if (
    (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) ||
    (voice !== undefined && (typeof voice !== "string" || voice.trim().length === 0)) ||
    (language !== undefined && (typeof language !== "string" || language.trim().length === 0)) ||
    (speed !== undefined && (!Number.isFinite(speed) || speed <= 0))
  ) {
    throw new TypeError("TTS failover selection contains an invalid setting");
  }
  return Object.freeze({
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(speed !== undefined ? { speed } : {}),
  });
}

function supportsTtsProviderSelection(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
  languageWasExplicitlySelected = selection.language !== undefined,
  languageWasCallerSelected = selection.language !== undefined,
): boolean {
  return (
    evaluateFailoverSelection(
      provider,
      selection,
      languageWasExplicitlySelected || provider.languageWasExplicitlyConfigured !== false,
      languageWasCallerSelected,
      languageWasExplicitlySelected,
    ).length === 0
  );
}

function evaluateFailoverSelection(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
  languageIsExplicit: boolean,
  languageWasCallerSelected: boolean,
  languageWasExplicitlySelected: boolean,
): ReturnType<typeof evaluateTtsSelectionCompatibility> {
  const effectiveSelection = effectiveProviderSelection(provider, selection);
  return evaluateTtsSelectionCompatibility(provider, effectiveSelection, {
    checkModel: effectiveSelection.model !== undefined,
    // Account-backed voices are proven by capability snapshots, not a catalog.
    checkVoice:
      effectiveSelection.voice !== undefined &&
      provider.capabilities.voiceSelection !== "account_snapshot",
    voiceOverride: selection.voice !== undefined,
    checkLanguage: effectiveSelection.language !== undefined,
    ...(effectiveSelection.language !== undefined
      ? { languageCompatibilityCandidates: languageTagCandidates(effectiveSelection.language) }
      : {}),
    checkSpeed: effectiveSelection.speed !== undefined,
    checkRequiredFields: true,
    languageIsExplicit,
    languageWasCallerSelected,
    languageWasExplicitlySelected,
    requireSpeedDeclaration: effectiveSelection.speed !== undefined,
    checkProviderSelection: true,
    // A complete adapter hook may account for models and catalogs the wrapper
    // cannot infer, especially after a host mapper rewrites the request.
    selectionHookOverridesCatalog: true,
  });
}

function throwFallbackSelectionIssue(
  fallback: TextToSpeechProvider,
  issue: ReturnType<typeof evaluateTtsSelectionCompatibility>[number],
  selection: TtsProviderSelection,
): never {
  const details = { provider: fallback.name, metadata: { ...selection } };
  switch (issue.requirement) {
    case "model":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.providerModelUnsupported, issue.message, details),
      );
    case "voice":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.providerVoiceUnsupported, issue.message, details),
      );
    case "language":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.ttsLanguageUnsupported, issue.message, details),
      );
    case "speed":
    case "selection":
      throw TvicThrowableError.from(
        validationError(TVIC_ERROR_CODES.providerInvalidRequest, issue.message, details),
      );
  }
}

function matchesSelection(
  selection: TtsProviderSelection,
  expected: TtsProviderSelection | undefined,
  languageMatch: "exact" | "base-language",
): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => {
    return selectionValueMatches(
      key as keyof TtsProviderSelection,
      selection[key as keyof TtsProviderSelection],
      value,
      languageMatch,
    );
  });
}

function selectionValueMatches(
  key: keyof TtsProviderSelection,
  actual: TtsProviderSelection[keyof TtsProviderSelection],
  expected: TtsProviderSelection[keyof TtsProviderSelection],
  languageMatch: "exact" | "base-language",
): boolean {
  if (key === "language" && typeof actual === "string" && typeof expected === "string") {
    return languageMatch === "base-language"
      ? ttsLanguageBase(actual) === ttsLanguageBase(expected)
      : normalizeTtsLanguageAlias(actual) === normalizeTtsLanguageAlias(expected);
  }
  return actual === expected;
}

export function effectiveProviderSelection(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
): TtsProviderSelection {
  const model = selection.model ?? provider.configuredModel;
  const voice = selection.voice ?? provider.configuredVoice;
  const language = selection.language ?? provider.configuredLanguage;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(voice !== undefined ? { voice } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(selection.speed !== undefined ? { speed: selection.speed } : {}),
  };
}

export function ttsLanguageBase(language: string): string {
  return normalizeTtsLanguageAlias(language).split("-", 1)[0] ?? "";
}

export function normalizeTtsLanguageAlias(language: string): string {
  const alias = language.toLowerCase().replace(/^od(?=-|$)/u, "or");
  return canonicalizeLanguageTag(alias) ?? alias;
}
