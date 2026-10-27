import { isDeepStrictEqual } from "node:util";

import {
  cancelledError,
  countUnicodeCodePoints,
  createProviderCapabilitySnapshots,
  evaluateProviderCompatibility,
  sameAudioFormat,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validationError,
  type NormalizedError,
  type Provider,
  type ProviderCapabilityQuery,
  type ProviderCapabilities,
  type ProviderCapabilitySnapshotVoice,
  type ProviderTtsVoiceCapabilityRequirement,
  type ProviderTtsVoiceMapping,
  type TextToSpeechProvider,
  type TtsEvent,
  type TtsProviderSelection,
  type TtsProviderSelectionContext,
  type TtsLanguageRequirementDescription,
  type TtsStream,
  type TtsSynthesisRequest,
  type TtsUsageReporter,
} from "@tvic/core";
import {
  assertFallbackRequestSupported,
  assertMappedRequestMatchesVariant,
  canCheckProviderValue,
  effectiveProviderSelection,
  intersectProviderCatalogs,
  normalizeFallbackRequestVariants,
  normalizeTtsLanguageAlias,
  providerSupportsTtsVoiceOverride,
  providerSupportsValue,
  providerValueCatalog,
  resolveFallbackSelections,
  selectionFromRequest,
  supportsTtsFailoverLanguage,
  supportsTtsFailoverSelection,
  ttsLanguageBase,
  type TtsFailoverRequestVariant,
} from "./tts-failover-selection.js";
import { validateTtsTextControls } from "./tts-text-controls.js";

export type { TtsFailoverRequestVariant } from "./tts-failover-selection.js";

export type TtsFailoverPhase = "synthesize" | "stream";

export interface TtsFailoverContext {
  readonly phase: TtsFailoverPhase;
  readonly primary: TextToSpeechProvider;
  readonly fallback: TextToSpeechProvider;
  readonly request: TtsSynthesisRequest;
  /** The mapped request after it passes fallback validation. */
  readonly fallbackRequest: TtsSynthesisRequest;
  /** The primary provider failure that triggered the fallback mapping attempt. */
  readonly error: NormalizedError;
}

export interface TtsFailoverProviderOptions {
  readonly primary: TextToSpeechProvider;
  readonly fallback: TextToSpeechProvider;
  readonly mapFallbackRequest?: (
    request: TtsSynthesisRequest,
    error: NormalizedError,
  ) => TtsSynthesisRequest;
  readonly fallbackRequestVariants?: readonly TtsFailoverRequestVariant[];
  readonly languageMatch?: "exact" | "base-language";
  readonly shouldFallback?: (error: NormalizedError, request: TtsSynthesisRequest) => boolean;
  /** Observes a validated fallback request immediately before dispatch. */
  readonly onFallback?: (context: TtsFailoverContext) => void | PromiseLike<void>;
  readonly name?: string;
}

const NON_OPERATIONAL_PROVIDER_ERRORS = new Set<string>([
  TVIC_ERROR_CODES.providerAuthFailed,
  TVIC_ERROR_CODES.providerInvalidRequest,
  TVIC_ERROR_CODES.providerInputRejected,
  TVIC_ERROR_CODES.providerModelUnsupported,
  TVIC_ERROR_CODES.providerVoiceUnsupported,
  TVIC_ERROR_CODES.providerSessionExpired,
  TVIC_ERROR_CODES.providerProtocolInvalid,
  TVIC_ERROR_CODES.providerIdentityMismatch,
  TVIC_ERROR_CODES.providerSequenceInvalid,
  TVIC_ERROR_CODES.providerStreamBufferOverflow,
]);
const TTS_FAILOVER_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_FAILOVER_PRE_AUDIO_EVENT_BYTES = 1_048_576;
const MAX_FAILOVER_EVENT_ESTIMATE_DEPTH = 64;
const MAX_FAILOVER_EVENT_ESTIMATE_NODES = 65_536;
const MAX_FALLBACK_FAILURE_MESSAGE_CODE_POINTS = 512;
const MAX_FALLBACK_FAILURE_PROVIDER_CODE_POINTS = 128;

export function createTtsFailoverProvider(
  options: TtsFailoverProviderOptions,
): TextToSpeechProvider {
  assertTtsProvider(options.primary, "primary");
  assertTtsProvider(options.fallback, "fallback");
  assertCompatibleOutputFormats(options.primary, options.fallback);
  const languageMatch = options.languageMatch ?? "exact";
  assertCompatibleLanguages(options.primary, options.fallback, languageMatch);

  const shouldFallback = options.shouldFallback ?? defaultShouldFallback;
  const fallbackRequestVariants = normalizeFallbackRequestVariants(options.fallbackRequestVariants);
  // Without a host mapper, declared variants map the fallback request themselves.
  const hasRequestMapper =
    options.mapFallbackRequest !== undefined || fallbackRequestVariants !== undefined;
  const preservesRequestModel =
    options.mapFallbackRequest === undefined
      ? fallbackRequestVariants === undefined
      : fallbackRequestVariants?.every((variant) => variant.fallback.model === undefined) === true;
  const fallbackVoiceMappings = fallbackVoiceMappingsFromVariants(
    fallbackRequestVariants,
    options.fallback,
  );
  assertFallbackConfiguredModelSelections(options.fallback, fallbackRequestVariants);
  assertDialogueVoiceMappings(options.primary, options.fallback, fallbackVoiceMappings);
  const allowUnknownModel = hasRequestMapper
    ? options.primary.allowUnknownModel === true
    : options.primary.allowUnknownModel === true && options.fallback.allowUnknownModel === true;
  const configuredPrimarySelection = effectiveProviderSelection(options.primary, {});
  const configuredFallbackSelections = resolveFallbackSelections(
    configuredPrimarySelection,
    fallbackRequestVariants,
    hasRequestMapper,
    languageMatch,
    configuredPrimarySelection,
    options.fallback,
    false,
  );
  const fallbackNeedsCallerSelectedLanguage =
    configuredFallbackSelections.some((selection) => {
      const model = selection.model ?? options.fallback.configuredModel;
      return (
        safelyRequiresTtsLanguageForModel(options.fallback, model) &&
        selection.language === undefined &&
        (options.fallback.configuredLanguage === undefined ||
          options.fallback.languageWasExplicitlyConfigured === false)
      );
    }) ||
    fallbackVariantRequiresCallerLanguage(
      options.fallback,
      fallbackRequestVariants,
      configuredPrimarySelection,
      languageMatch,
    );
  const languageWasExplicitlyConfigured = fallbackNeedsCallerSelectedLanguage
    ? false
    : options.primary.languageWasExplicitlyConfigured;
  const name = options.name ?? `tts-failover:${options.primary.name}->${options.fallback.name}`;
  const mapFallbackRequest =
    options.mapFallbackRequest ??
    (fallbackRequestVariants !== undefined
      ? (request: TtsSynthesisRequest) =>
          mapRequestWithFallbackVariants(
            request,
            options.primary,
            options.fallback,
            fallbackRequestVariants,
            languageMatch,
            name,
          )
      : (request: TtsSynthesisRequest) => request);
  const fallbackSelectionIsKnown =
    options.mapFallbackRequest === undefined || fallbackVoiceMappings !== undefined;
  const capabilities = failoverCapabilities(
    options.primary,
    options.fallback,
    fallbackVoiceMappings,
    fallbackSelectionIsKnown,
    preservesRequestModel,
    hasRequestMapper,
  );
  const requiredCapabilityQueries = mergeRequiredCapabilityQueries(
    options.primary.requiredCapabilityQueries,
    fallbackCapabilityQueries(options.fallback.requiredCapabilityQueries, fallbackSelectionIsKnown),
  );
  const requiredTtsVoiceCapabilities = mergeRequiredTtsVoiceCapabilities(
    options.primary,
    fallbackSelectionIsKnown ? options.fallback : undefined,
  );
  const providerCapabilitySnapshotProviders = Object.freeze([
    ...new Set([
      ...providerCapabilitySnapshotProvidersFor(options.primary),
      ...providerCapabilitySnapshotProvidersFor(options.fallback),
    ]),
  ]);
  const providerCapabilitySnapshotVoices = failoverCapabilitySnapshotVoices(
    options.primary,
    options.fallback,
    fallbackVoiceMappings,
  );
  const requiresDeclaredTtsVoiceMappingForCapabilitySnapshots =
    options.primary.requiresDeclaredTtsVoiceMappingForCapabilitySnapshots === true ||
    options.fallback.requiresDeclaredTtsVoiceMappingForCapabilitySnapshots === true ||
    (options.mapFallbackRequest !== undefined &&
      fallbackVoiceMappings === undefined &&
      options.fallback.capabilities.voiceSelection === "account_snapshot");
  const requiredCapabilityQueriesForModel = (model: string, voice?: string) => {
    const mappings = fallbackVoiceMappingsForSelection(
      fallbackVoiceMappings,
      model,
      voice ?? options.primary.configuredVoice,
    );
    const fallbackQueries =
      mappings.length === 0
        ? [requiredCapabilityQueriesForSelection(options.fallback, model, voice)]
        : mappings.map((mapping) =>
            requiredCapabilityQueriesForSelection(
              options.fallback,
              mapping.model ?? model,
              mapping.voice,
            ),
          );
    return mergeRequiredCapabilityQueries(
      requiredCapabilityQueriesForSelection(options.primary, model, voice),
      ...fallbackQueries.map((queries) =>
        fallbackCapabilityQueries(
          queries,
          options.mapFallbackRequest === undefined || mappings.length > 0,
        ),
      ),
    );
  };
  const supportsConfiguredModelSelection = (model: string, voice?: string) => {
    if (options.primary.supportsConfiguredModelSelection?.(model, voice) === false) return false;
    const mappings = fallbackVoiceMappingsForSelection(
      fallbackVoiceMappings,
      model,
      voice ?? options.primary.configuredVoice,
    );
    if (options.mapFallbackRequest !== undefined && mappings.length === 0) return true;
    if (mappings.length === 0) {
      return options.fallback.supportsConfiguredModelSelection?.(model, voice) !== false;
    }
    return mappings.every(
      (mapping) =>
        options.fallback.supportsConfiguredModelSelection?.(
          mapping.model ?? model,
          mapping.voice,
        ) !== false,
    );
  };
  const requestValidator: Provider = {
    name,
    kind: "tts",
    version: "0.1.0",
    capabilities,
    ...(options.primary.configuredModel !== undefined
      ? { configuredModel: options.primary.configuredModel }
      : {}),
  };

  const startFallback = async (
    originalError: unknown,
    request: TtsSynthesisRequest,
    phase: TtsFailoverPhase,
    fallbackCancellationSignal?: AbortSignal,
  ): Promise<TtsStream> => {
    if (request.timestamps === true && options.fallback.capabilities.timestamps === false) {
      throw originalError;
    }
    const error = TvicThrowableError.from(originalError).error;
    if (error.metadata?.outcomeUnknown === true) throw originalError;
    if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
      throw requestCancelledError();
    }
    let shouldUseFallback: boolean;
    try {
      shouldUseFallback = shouldFallback(error, snapshotTtsRequest(request));
    } catch (fallbackError) {
      throw preservePrimaryFailure(originalError, fallbackError);
    }
    if (!shouldUseFallback) throw originalError;
    if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
      throw requestCancelledError();
    }

    const effectivePrimaryRequest: TtsSynthesisRequest = {
      ...request,
      ...(request.model === undefined && options.primary.configuredModel !== undefined
        ? { model: options.primary.configuredModel }
        : {}),
      ...(request.voice === undefined && options.primary.configuredVoice !== undefined
        ? { voice: options.primary.configuredVoice }
        : {}),
    };
    const primarySelection = effectiveProviderSelection(
      options.primary,
      selectionFromRequest(effectivePrimaryRequest),
    );
    const languageWasCallerSelected =
      effectivePrimaryRequest.selectionContext?.languageWasCallerSelected ??
      effectivePrimaryRequest.language !== undefined;
    const languageWasExplicitlySelected =
      effectivePrimaryRequest.selectionContext?.languageWasExplicitlySelected ??
      effectivePrimaryRequest.selectionContext?.languageWasCallerSelected ??
      effectivePrimaryRequest.language !== undefined;
    let fallbackRequest: TtsSynthesisRequest = effectivePrimaryRequest;
    try {
      const requestSnapshot = snapshotTtsRequest(effectivePrimaryRequest);
      const requestForMapping = snapshotTtsRequest(effectivePrimaryRequest, true);
      const mapped = mapFallbackRequest(requestForMapping, error);
      // Selection provenance is runtime-owned, so a mapper that rebuilds the
      // request does not have to copy it.
      const { selectionContext: _mappedContext, ...mappedFields } = snapshotTtsRequest(mapped);
      void _mappedContext;
      const mappedRequest: TtsSynthesisRequest = {
        ...mappedFields,
        ...(requestSnapshot.selectionContext !== undefined
          ? { selectionContext: requestSnapshot.selectionContext }
          : {}),
      };
      assertMappedRequest(requestSnapshot, mappedRequest, options.fallback.name);
      fallbackRequest =
        requestSnapshot.providerCapabilitySnapshots !== undefined
          ? {
              ...mappedRequest,
              providerCapabilitySnapshots: requestSnapshot.providerCapabilitySnapshots,
            }
          : mappedRequest;
      const mapperIntroducedLanguage =
        mappedRequest.language !== undefined && mappedRequest.language !== requestSnapshot.language;
      if (
        languageWasCallerSelected &&
        requestSnapshot.language !== undefined &&
        mappedRequest.language !== undefined
      ) {
        assertCallerLanguageCompatible(
          requestSnapshot.language,
          mappedRequest.language,
          languageMatch,
          options.fallback.name,
        );
      }
      const variantLanguage =
        fallbackRequestVariants === undefined
          ? undefined
          : assertMappedRequestMatchesVariant(
              fallbackRequest,
              fallbackRequestVariants,
              options.fallback,
              primarySelection,
              languageMatch,
              mapperIntroducedLanguage,
              languageWasCallerSelected,
            );
      if (variantLanguage !== undefined) {
        // Variants override fallback defaults during preflight, so dispatch
        // must send that same declared language (including after base-language
        // matching accepts an inherited or omitted tag).
        fallbackRequest = { ...fallbackRequest, language: variantLanguage };
      } else if (
        languageWasExplicitlySelected &&
        requestSnapshot.language !== undefined &&
        mappedRequest.language === undefined
      ) {
        // A mapper may omit the field, but it cannot drop a language the host
        // explicitly selected for this call.
        fallbackRequest = { ...fallbackRequest, language: requestSnapshot.language };
      } else if (
        !languageWasExplicitlySelected &&
        !mapperIntroducedLanguage &&
        fallbackRequest.language === requestSnapshot.language
      ) {
        // A configured primary language is not portable across providers.
        // Let the fallback use its own configured default unless the host,
        // mapper, or a declared variant selected a language for this call.
        const { language: _inheritedLanguage, ...withoutInheritedLanguage } = fallbackRequest;
        void _inheritedLanguage;
        fallbackRequest = withoutInheritedLanguage;
      }
      assertFallbackRequestSupported(
        options.fallback,
        fallbackRequest,
        languageWasCallerSelected,
        languageWasExplicitlySelected || mapperIntroducedLanguage || variantLanguage !== undefined,
      );
    } catch (fallbackError) {
      if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
        throw requestCancelledError();
      }
      throw preservePrimaryFailure(originalError, fallbackError);
    }
    if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
      throw requestCancelledError();
    }
    notifyFallback(options.onFallback, {
      phase,
      primary: options.primary,
      fallback: options.fallback,
      request: snapshotTtsRequest(request),
      fallbackRequest: snapshotTtsRequest(fallbackRequest),
      error,
    });
    if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
      throw requestCancelledError();
    }
    const providerRequest = fallbackCancellationSignal
      ? {
          ...fallbackRequest,
          signal: combineAbortSignals(fallbackRequest.signal, fallbackCancellationSignal),
        }
      : fallbackRequest;
    const fallbackStream = await synthesizeWithAbort(options.fallback, providerRequest);
    if (providerRequest.signal?.aborted) {
      await settleCleanup(() => fallbackStream.cancel());
      throw requestCancelledError();
    }
    return fallbackStream;
  };

  return {
    name,
    kind: "tts",
    version: "0.1.0",
    usageAccounting: {
      reportsTextCharacters: true,
      ...(preservesRequestModel ? { usesRequestModelForUsage: true } : {}),
    },
    ...(providerCapabilitySnapshotProviders.length > 0
      ? { providerCapabilitySnapshotProviders }
      : {}),
    ...(providerCapabilitySnapshotVoices.length > 0 ? { providerCapabilitySnapshotVoices } : {}),
    ...(requiresDeclaredTtsVoiceMappingForCapabilitySnapshots
      ? { requiresDeclaredTtsVoiceMappingForCapabilitySnapshots: true }
      : {}),
    capabilities,
    ...(requiredCapabilityQueries.length > 0 ? { requiredCapabilityQueries } : {}),
    requiredCapabilityQueriesForModel,
    supportsConfiguredModelSelection,
    ...(requiredTtsVoiceCapabilities.length > 0 ? { requiredTtsVoiceCapabilities } : {}),
    ...(allowUnknownModel ? { allowUnknownModel: true } : {}),
    ...(options.primary.configuredModel !== undefined
      ? { configuredModel: options.primary.configuredModel }
      : {}),
    ...(options.primary.configuredModelSource !== undefined
      ? { configuredModelSource: options.primary.configuredModelSource }
      : {}),
    ...(options.primary.configuredVoice !== undefined
      ? { configuredVoice: options.primary.configuredVoice }
      : {}),
    ...(options.primary.configuredLanguage !== undefined
      ? { configuredLanguage: options.primary.configuredLanguage }
      : {}),
    ...(languageWasExplicitlyConfigured !== undefined ? { languageWasExplicitlyConfigured } : {}),
    requiresTtsLanguageForModel: (model?: string) => {
      const selection = { ...(model !== undefined ? { model } : {}) };
      const primarySelection = effectiveProviderSelection(options.primary, selection);
      return (
        safelyRequiresTtsLanguageForModel(options.primary, model) ||
        resolveFallbackSelections(
          selection,
          fallbackRequestVariants,
          hasRequestMapper,
          languageMatch,
          primarySelection,
          options.fallback,
        ).some(
          (fallbackSelection) =>
            safelyRequiresTtsLanguageForModel(
              options.fallback,
              fallbackSelection.model ?? options.fallback.configuredModel,
            ) &&
            fallbackSelection.language === undefined &&
            (options.fallback.configuredLanguage === undefined ||
              options.fallback.languageWasExplicitlyConfigured === false),
        ) ||
        fallbackVariantRequiresCallerLanguage(
          options.fallback,
          fallbackRequestVariants,
          {
            ...((model ?? options.primary.configuredModel) !== undefined
              ? { model: model ?? options.primary.configuredModel }
              : {}),
          },
          languageMatch,
        )
      );
    },
    requiresTtsLanguageForSelection: (
      selection: TtsProviderSelection,
      context?: TtsProviderSelectionContext,
    ) => {
      const primarySelection = effectiveProviderSelection(options.primary, selection);
      const languageWasCallerSelected =
        context?.languageWasCallerSelected ?? selection.language !== undefined;
      const languageWasExplicitlySelected =
        context?.languageWasExplicitlySelected ??
        context?.languageWasCallerSelected ??
        selection.language !== undefined;
      const fallbackSelections = resolveFallbackSelections(
        selection,
        fallbackRequestVariants,
        hasRequestMapper,
        languageMatch,
        primarySelection,
        options.fallback,
        languageWasCallerSelected,
        languageWasExplicitlySelected,
      );
      return (
        safelyRequiresTtsLanguageForSelection(options.primary, primarySelection, context) ||
        fallbackSelections.some((fallbackSelection) =>
          selectionNeedsCallerLanguage(options.fallback, fallbackSelection, context),
        ) ||
        fallbackVariantRequiresCallerLanguage(
          options.fallback,
          fallbackRequestVariants,
          primarySelection,
          languageMatch,
          languageWasExplicitlySelected,
        )
      );
    },
    describeTtsLanguageRequirement: (
      selection: TtsProviderSelection,
      context?: TtsProviderSelectionContext,
    ): TtsLanguageRequirementDescription | undefined => {
      const primarySelection = effectiveProviderSelection(options.primary, selection);
      if (safelyRequiresTtsLanguageForSelection(options.primary, primarySelection, context)) {
        return {
          provider: options.primary.name,
          ...(primarySelection.model !== undefined ? { model: primarySelection.model } : {}),
        };
      }
      const languageWasCallerSelected =
        context?.languageWasCallerSelected ?? selection.language !== undefined;
      const languageWasExplicitlySelected =
        context?.languageWasExplicitlySelected ??
        context?.languageWasCallerSelected ??
        selection.language !== undefined;
      const fallbackSelections = resolveFallbackSelections(
        selection,
        fallbackRequestVariants,
        hasRequestMapper,
        languageMatch,
        primarySelection,
        options.fallback,
        languageWasCallerSelected,
        languageWasExplicitlySelected,
      );
      const missingLanguageSelection = fallbackSelections.find((fallbackSelection) =>
        selectionNeedsCallerLanguage(options.fallback, fallbackSelection, context),
      );
      if (missingLanguageSelection) {
        return {
          provider: options.fallback.name,
          ...((missingLanguageSelection.model ?? options.fallback.configuredModel) !== undefined
            ? { model: missingLanguageSelection.model ?? options.fallback.configuredModel }
            : {}),
        };
      }
      if (
        fallbackVariantRequiresCallerLanguage(
          options.fallback,
          fallbackRequestVariants,
          primarySelection,
          languageMatch,
          languageWasExplicitlySelected,
        )
      ) {
        const requiredVariant = fallbackRequestVariants?.find((variant) => {
          const model = variant.fallback.model ?? options.fallback.configuredModel;
          return (
            variant.fallback.language === undefined &&
            variantConditionsMatchWithoutLanguage(primarySelection, variant.when, languageMatch) &&
            safelyRequiresTtsLanguageForModel(options.fallback, model) &&
            (options.fallback.configuredLanguage === undefined ||
              options.fallback.languageWasExplicitlyConfigured === false)
          );
        });
        return {
          provider: options.fallback.name,
          ...((requiredVariant?.fallback.model ?? options.fallback.configuredModel) !== undefined
            ? { model: requiredVariant?.fallback.model ?? options.fallback.configuredModel }
            : {}),
        };
      }
      return undefined;
    },
    requiresTtsVoiceForModel: (model?: string) =>
      safelyRequiresTtsVoiceForModel(options.primary, model) ||
      resolveFallbackSelections(
        { ...(model !== undefined ? { model } : {}) },
        fallbackRequestVariants,
        hasRequestMapper,
        languageMatch,
        effectiveProviderSelection(options.primary, {
          ...(model !== undefined ? { model } : {}),
        }),
        options.fallback,
      ).some(
        (selection) =>
          safelyRequiresTtsVoiceForModel(
            options.fallback,
            selection.model ?? options.fallback.configuredModel,
          ) &&
          selection.voice === undefined &&
          options.fallback.configuredVoice === undefined,
      ),
    ...(canCheckProviderValue(options.primary, "language") &&
    canCheckProviderValue(options.fallback, "language")
      ? {
          supportsLanguage: (language: string, model?: string) =>
            providerSupportsValue(options.primary, "language", language, model) &&
            (hasRequestMapper ||
              providerSupportsValue(options.fallback, "language", language, model)),
        }
      : {}),
    ...(canCheckProviderValue(options.primary, "language") &&
    (hasRequestMapper || canCheckProviderValue(options.fallback, "language"))
      ? {
          supportsTtsLanguage: (
            language: string,
            model?: string,
            voice?: string,
            context?: TtsProviderSelectionContext,
          ) =>
            supportsTtsFailoverLanguage(
              options.primary,
              options.fallback,
              language,
              model,
              voice,
              fallbackRequestVariants,
              hasRequestMapper,
              languageMatch,
              context?.languageWasCallerSelected ?? true,
              context?.languageWasExplicitlySelected ?? context?.languageWasCallerSelected ?? true,
            ),
        }
      : {}),
    ...(canCheckProviderValue(options.primary, "voice") &&
    (hasRequestMapper || canCheckProviderValue(options.fallback, "voice"))
      ? {
          supportsVoice: (voice: string, model?: string) =>
            providerSupportsValue(options.primary, "voice", voice, model) &&
            (hasRequestMapper || providerSupportsValue(options.fallback, "voice", voice, model)),
        }
      : {}),
    supportsTtsVoiceOverride: (
      voice: string,
      model?: string,
      language?: string,
      context?: TtsProviderSelectionContext,
    ) => {
      if (!providerSupportsTtsVoiceOverride(options.primary, voice, model, language)) return false;
      if (hasRequestMapper && fallbackRequestVariants === undefined) return true;
      const selection = {
        voice,
        ...(model !== undefined ? { model } : {}),
        ...(language !== undefined ? { language } : {}),
      };
      const fallbackSelections = resolveFallbackSelections(
        selection,
        fallbackRequestVariants,
        hasRequestMapper,
        languageMatch,
        effectiveProviderSelection(options.primary, selection),
        options.fallback,
        context?.languageWasCallerSelected ?? language !== undefined,
        context?.languageWasExplicitlySelected ??
          context?.languageWasCallerSelected ??
          language !== undefined,
      );
      return (
        fallbackSelections.length > 0 &&
        fallbackSelections.every((selection) => {
          const fallbackVoice = selection.voice ?? options.fallback.configuredVoice;
          if (
            fallbackVoice === undefined &&
            safelyRequiresTtsVoiceForModel(
              options.fallback,
              selection.model ?? options.fallback.configuredModel,
            )
          ) {
            return false;
          }
          if (fallbackVoice === undefined) return true;
          return providerSupportsTtsVoiceOverride(
            options.fallback,
            fallbackVoice,
            selection.model ?? options.fallback.configuredModel,
            selection.language,
          );
        })
      );
    },
    supportsTtsSelection: (
      selection: TtsProviderSelection,
      context?: TtsProviderSelectionContext,
    ) =>
      supportsTtsFailoverSelection(
        options.primary,
        options.fallback,
        selection,
        fallbackRequestVariants,
        hasRequestMapper,
        languageMatch,
        context?.languageWasCallerSelected ?? selection.language !== undefined,
        context?.languageWasExplicitlySelected ??
          context?.languageWasCallerSelected ??
          selection.language !== undefined,
      ),
    async synthesize(request): Promise<TtsStream> {
      request = validateTtsTextControls(requestValidator, snapshotTtsRequest(request));
      if (request.providerCapabilitySnapshots !== undefined) {
        request = {
          ...request,
          providerCapabilitySnapshots: createProviderCapabilitySnapshots(
            request.providerCapabilitySnapshots,
          ),
        };
      }
      const effectivePrimaryRequest = withProviderDefaults(request, options.primary);
      // Snapshots cannot validate an undeclared account-backed fallback voice, so
      // fail before the primary rather than only once failover is needed.
      if (
        requiresDeclaredTtsVoiceMappingForCapabilitySnapshots &&
        request.providerCapabilitySnapshots !== undefined
      ) {
        throw missingFallbackVoiceMappingError(name, effectivePrimaryRequest, true);
      }
      assertTtsSpeedSupported(options.primary, effectivePrimaryRequest);
      if (options.mapFallbackRequest === undefined) {
        // Declared and identity mappings are known now, so an unmapped selection
        // or an unsupported fallback speed fails before the primary is opened.
        assertTtsSpeedSupported(
          options.fallback,
          mapFallbackRequest(snapshotTtsRequest(effectivePrimaryRequest), undefined as never),
        );
      }
      let primaryStream: TtsStream;
      try {
        primaryStream = await synthesizeWithAbort(options.primary, snapshotTtsRequest(request));
      } catch (error) {
        return startFallback(error, request, "synthesize");
      }
      if (request.signal?.aborted) {
        await settleCleanup(() => primaryStream.cancel());
        throw requestCancelledError();
      }
      return createFailoverStream(primaryStream, request, startFallback);
    },
  };
}

function createFailoverStream(
  primaryStream: TtsStream,
  request: TtsSynthesisRequest,
  startFallback: (
    error: unknown,
    request: TtsSynthesisRequest,
    phase: TtsFailoverPhase,
    fallbackCancellationSignal?: AbortSignal,
  ) => Promise<TtsStream>,
): TtsStream {
  let activeStream = primaryStream;
  let activeIterator: AsyncIterator<TtsEvent> | undefined;
  let usingFallback = false;
  let sawAudio = false;
  let cancelled = false;
  let completed = false;
  let cancelPromise: Promise<void> | undefined;
  const streamCancelPromises = new WeakMap<object, Promise<void>>();
  const iteratorReturnPromises = new WeakMap<object, Promise<void>>();
  const fallbackStartupController = new AbortController();
  const cancelStream = (stream: TtsStream): Promise<void> => {
    const existing = streamCancelPromises.get(stream);
    if (existing) return existing;
    const cancellation = settleCleanup(() => stream.cancel());
    streamCancelPromises.set(stream, cancellation);
    return cancellation;
  };
  const closeActiveIterator = (iterator: AsyncIterator<TtsEvent> | undefined): Promise<void> => {
    if (!iterator?.return) return Promise.resolve();
    const existing = iteratorReturnPromises.get(iterator);
    if (existing) return existing;
    const closing = settleCleanup(async () => {
      await iterator.return?.();
    });
    iteratorReturnPromises.set(iterator, closing);
    return closing;
  };

  const events = (async function* (): AsyncIterable<TtsEvent> {
    let pendingPrimaryEvents: TtsEvent[] = [];
    let pendingPrimaryEventBytes = 0;
    let primaryEventsCommitted = false;
    try {
      activeIterator = activeStream.events[Symbol.asyncIterator]();
      while (!cancelled) {
        let step: IteratorResult<TtsEvent>;
        try {
          step = await raceWithAbort(activeIterator.next(), fallbackStartupController.signal);
        } catch (error) {
          if (usingFallback || sawAudio || primaryEventsCommitted || cancelled) throw error;

          pendingPrimaryEvents = [];
          pendingPrimaryEventBytes = 0;
          await Promise.all([closeActiveIterator(activeIterator), cancelStream(activeStream)]);
          if (cancelled) throw error;
          const fallbackStream = await startFallback(
            error,
            request,
            "stream",
            fallbackStartupController.signal,
          );
          if (cancelled) {
            await settleCleanup(() => fallbackStream.cancel());
            throw error;
          }
          usingFallback = true;
          activeStream = fallbackStream;
          activeIterator = activeStream.events[Symbol.asyncIterator]();
          continue;
        }

        if (step.done) {
          for (const event of pendingPrimaryEvents) yield event;
          pendingPrimaryEvents = [];
          pendingPrimaryEventBytes = 0;
          completed = true;
          return;
        }
        if (usingFallback || sawAudio) {
          if (step.value.type === "media.audio.chunk") sawAudio = true;
          yield step.value;
          continue;
        }
        if (step.value.type === "media.audio.chunk") {
          sawAudio = true;
          for (const event of pendingPrimaryEvents) yield event;
          pendingPrimaryEvents = [];
          pendingPrimaryEventBytes = 0;
          yield step.value;
          continue;
        }

        const eventBytes = estimateTtsEventBytes(step.value);
        if (pendingPrimaryEventBytes + eventBytes > MAX_FAILOVER_PRE_AUDIO_EVENT_BYTES) {
          primaryEventsCommitted = true;
          for (const event of pendingPrimaryEvents) yield event;
          pendingPrimaryEvents = [];
          pendingPrimaryEventBytes = 0;
          yield step.value;
          continue;
        }
        pendingPrimaryEvents.push(step.value);
        pendingPrimaryEventBytes += eventBytes;
      }
    } finally {
      if (!completed && !cancelled) {
        await Promise.all([cancelStream(activeStream), closeActiveIterator(activeIterator)]);
      }
      await closeActiveIterator(activeIterator);
    }
  })();

  return {
    events,
    async cancel(): Promise<void> {
      if (!cancelPromise) {
        cancelPromise = (async () => {
          cancelled = true;
          fallbackStartupController.abort();
          await Promise.all([cancelStream(activeStream), closeActiveIterator(activeIterator)]);
        })();
      }
      await cancelPromise;
    },
  };
}

function defaultShouldFallback(error: NormalizedError): boolean {
  if (NON_OPERATIONAL_PROVIDER_ERRORS.has(error.code)) return false;
  return error.retriable;
}

function notifyFallback(
  observer: TtsFailoverProviderOptions["onFallback"],
  context: TtsFailoverContext,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(context)).catch(() => undefined);
  } catch {}
}

function preservePrimaryFailure(primary: unknown, fallbackFailure: unknown): TvicThrowableError {
  const primaryError = TvicThrowableError.from(primary);
  const fallbackError = TvicThrowableError.from(fallbackFailure).error;
  const fallbackProvider = fallbackError.provider;
  return new TvicThrowableError({
    ...primaryError.error,
    metadata: {
      ...(primaryError.error.metadata ?? {}),
      fallbackValidationFailure: {
        code: fallbackError.code,
        category: fallbackError.category,
        message: Array.from(fallbackError.message)
          .slice(0, MAX_FALLBACK_FAILURE_MESSAGE_CODE_POINTS)
          .join(""),
        ...(fallbackProvider !== undefined
          ? {
              provider: Array.from(fallbackProvider)
                .slice(0, MAX_FALLBACK_FAILURE_PROVIDER_CODE_POINTS)
                .join(""),
            }
          : {}),
      },
    },
  });
}

function requestCancelledError(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("provider.connection_cancelled", "TTS request was cancelled"),
  );
}

function combineAbortSignals(
  requestSignal: AbortSignal | undefined,
  fallbackCancellationSignal: AbortSignal,
): AbortSignal {
  return requestSignal
    ? AbortSignal.any([requestSignal, fallbackCancellationSignal])
    : fallbackCancellationSignal;
}

function settleCleanup(operation: () => void | PromiseLike<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve()
      .then(operation)
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TTS_FAILOVER_CLEANUP_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function synthesizeWithAbort(
  provider: TextToSpeechProvider,
  request: TtsSynthesisRequest,
): Promise<TtsStream> {
  const signal = request.signal;
  if (signal?.aborted) return Promise.reject(requestCancelledError());

  const usageReporter = request.usageReporter;
  const providerReportsTextCharacters = provider.usageAccounting?.reportsTextCharacters === true;
  const childUsageReporter: TtsUsageReporter | undefined = usageReporter
    ? {
        report: (observation) => usageReporter.report(observation),
        beginOperation: (input) => usageReporter.beginOperation(input),
        reportTextCharacters: (characters) => {
          if (providerReportsTextCharacters) usageReporter.reportTextCharacters(characters);
        },
      }
    : undefined;
  const providerRequest = childUsageReporter
    ? { ...request, usageReporter: childUsageReporter }
    : request;
  const synthesis = Promise.resolve().then(() => {
    if (!providerReportsTextCharacters) {
      usageReporter?.reportTextCharacters(countUnicodeCodePoints(providerRequest.text));
    }
    return provider.synthesize(providerRequest);
  });
  if (!signal) return synthesis;

  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(requestCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });

  return Promise.race([synthesis, aborted])
    .then(
      (stream) => {
        if (signal.aborted) {
          void settleCleanup(() => stream.cancel());
          throw requestCancelledError();
        }
        return stream;
      },
      (error: unknown) => {
        if (signal.aborted) {
          void synthesis
            .then(
              (stream) => settleCleanup(() => stream.cancel()),
              () => undefined,
            )
            .catch(() => undefined);
          throw requestCancelledError();
        }
        throw error;
      },
    )
    .finally(removeAbortListener);
}

function assertTtsProvider(provider: TextToSpeechProvider, role: string): void {
  if (!provider || provider.kind !== "tts" || typeof provider.synthesize !== "function") {
    throw new TypeError(`TTS ${role} provider must implement synthesize()`);
  }
}

function assertCompatibleOutputFormats(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
): void {
  const primaryFormats = primary.capabilities.audio?.output;
  const fallbackFormats = fallback.capabilities.audio?.output;
  if (!primaryFormats || !fallbackFormats) return;
  if (
    primaryFormats.some(
      (format) => !fallbackFormats.some((candidate) => sameAudioFormat(format, candidate)),
    )
  ) {
    throw new TypeError(
      `TTS failover providers must share at least the primary output formats (${primary.name} -> ${fallback.name})`,
    );
  }
}

function assertCompatibleLanguages(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  languageMatch: "exact" | "base-language",
): void {
  const primaryLanguage = primary.configuredLanguage;
  const fallbackLanguage = fallback.configuredLanguage;
  if (primaryLanguage === undefined && fallbackLanguage === undefined) return;
  if (primaryLanguage === undefined || fallbackLanguage === undefined) {
    throw new TypeError(
      `TTS failover providers must both declare compatible configured languages (${primary.name} -> ${fallback.name})`,
    );
  }
  const exactMatch =
    normalizeTtsLanguageAlias(primaryLanguage) === normalizeTtsLanguageAlias(fallbackLanguage);
  const baseLanguageMatch =
    languageMatch === "base-language" &&
    ttsLanguageBase(primaryLanguage) === ttsLanguageBase(fallbackLanguage);
  if (!exactMatch && !baseLanguageMatch) {
    throw new TypeError(
      `TTS failover providers must use compatible configured languages (${primary.name}: ${primaryLanguage} -> ${fallback.name}: ${fallbackLanguage})`,
    );
  }
}

function fallbackVariantRequiresCallerLanguage(
  fallback: TextToSpeechProvider,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  selection: TtsProviderSelection,
  languageMatch: "exact" | "base-language",
  languageWasExplicitlySelected = selection.language !== undefined,
): boolean {
  if (variants === undefined || languageWasExplicitlySelected) return false;
  const applicable = variants.filter((variant) =>
    variantConditionsMatchWithoutLanguage(selection, variant.when, languageMatch),
  );
  if (applicable.length === 0) return false;
  return applicable.some((variant) => {
    const fallbackModel = variant.fallback.model ?? fallback.configuredModel;
    return (
      variant.fallback.language === undefined &&
      safelyRequiresTtsLanguageForModel(fallback, fallbackModel) &&
      (fallback.configuredLanguage === undefined ||
        fallback.languageWasExplicitlyConfigured === false)
    );
  });
}

function variantConditionsMatchWithoutLanguage(
  selection: TtsProviderSelection,
  condition: TtsProviderSelection | undefined,
  languageMatch: "exact" | "base-language",
): boolean {
  if (condition === undefined) return true;
  return Object.entries(condition).every(([rawKey, expected]) => {
    const key = rawKey as keyof TtsProviderSelection;
    if (key === "language" && selection.language === undefined) return true;
    const actual = selection[key];
    if (actual === undefined) return false;
    if (key === "language" && typeof actual === "string" && typeof expected === "string") {
      return languageMatch === "base-language"
        ? ttsLanguageBase(actual) === ttsLanguageBase(expected)
        : normalizeTtsLanguageAlias(actual) === normalizeTtsLanguageAlias(expected);
    }
    return actual === expected;
  });
}

function selectionNeedsCallerLanguage(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
  context?: TtsProviderSelectionContext,
): boolean {
  return (
    safelyRequiresTtsLanguageForSelection(provider, selection, context) &&
    selection.language === undefined &&
    (provider.configuredLanguage === undefined ||
      provider.languageWasExplicitlyConfigured === false)
  );
}

function safelyRequiresTtsLanguageForModel(
  provider: TextToSpeechProvider,
  model?: string,
): boolean {
  try {
    return provider.requiresTtsLanguageForModel?.(model) === true;
  } catch {
    // A broken requirement hook must not escape failover construction. Treat
    // it conservatively as requiring a language so later preflight fails closed.
    return true;
  }
}

function safelyRequiresTtsLanguageForSelection(
  provider: TextToSpeechProvider,
  selection: TtsProviderSelection,
  context?: TtsProviderSelectionContext,
): boolean {
  try {
    return (
      (provider.requiresTtsLanguageForSelection?.(selection, context) ??
        safelyRequiresTtsLanguageForModel(provider, selection.model)) === true
    );
  } catch {
    return true;
  }
}

function safelyRequiresTtsVoiceForModel(provider: TextToSpeechProvider, model?: string): boolean {
  try {
    return provider.requiresTtsVoiceForModel?.(model) === true;
  } catch {
    return true;
  }
}

function assertCallerLanguageCompatible(
  callerLanguage: string,
  mappedLanguage: string,
  languageMatch: "exact" | "base-language",
  fallbackProvider: string,
): void {
  const matches =
    languageMatch === "base-language"
      ? ttsLanguageBase(callerLanguage) === ttsLanguageBase(mappedLanguage)
      : normalizeTtsLanguageAlias(callerLanguage) === normalizeTtsLanguageAlias(mappedLanguage);
  if (matches) return;
  throw TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `TTS failover mapping for ${fallbackProvider} changes the caller-selected language from ${callerLanguage} to ${mappedLanguage}`,
      {
        provider: fallbackProvider,
        metadata: { callerLanguage, mappedLanguage, languageMatch },
      },
    ),
  );
}

function snapshotTtsRequest(
  request: TtsSynthesisRequest,
  cloneCapabilitySnapshots = false,
): TtsSynthesisRequest {
  const knownFields = new Set([
    "sessionId",
    "turnId",
    "voice",
    "model",
    "language",
    "format",
    "speed",
    "timestamps",
    "metadata",
    "usageReporter",
    "signal",
    "text",
    "stream",
    "selectionContext",
    "textControls",
    "providerCapabilitySnapshots",
    "providerCapabilityEvaluationTimeMs",
  ]);
  const extensionFields: Record<string, unknown> = {};
  for (const key in request) {
    if (!knownFields.has(key)) {
      extensionFields[key] = (request as TtsSynthesisRequest & Record<string, unknown>)[key];
    }
  }
  for (const key of Object.getOwnPropertySymbols(request)) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor?.enumerable) {
      Object.defineProperty(extensionFields, key, {
        configurable: true,
        enumerable: true,
        value: (request as TtsSynthesisRequest & Record<symbol, unknown>)[key],
        writable: true,
      });
    }
  }
  return {
    ...extensionFields,
    sessionId: request.sessionId,
    turnId: request.turnId,
    ...(request.voice !== undefined ? { voice: request.voice } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.language !== undefined ? { language: request.language } : {}),
    format: { ...request.format },
    ...(request.speed !== undefined ? { speed: request.speed } : {}),
    ...(request.textControls !== undefined ? { textControls: request.textControls } : {}),
    ...(request.providerCapabilitySnapshots !== undefined
      ? {
          providerCapabilitySnapshots: cloneCapabilitySnapshots
            ? structuredClone(request.providerCapabilitySnapshots)
            : request.providerCapabilitySnapshots,
        }
      : {}),
    ...(request.providerCapabilityEvaluationTimeMs !== undefined
      ? { providerCapabilityEvaluationTimeMs: request.providerCapabilityEvaluationTimeMs }
      : {}),
    ...(request.timestamps !== undefined ? { timestamps: request.timestamps } : {}),
    ...(request.metadata !== undefined ? { metadata: snapshotMetadata(request.metadata) } : {}),
    ...(request.usageReporter !== undefined ? { usageReporter: request.usageReporter } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    text: request.text,
    stream: request.stream,
    ...(request.selectionContext !== undefined
      ? { selectionContext: Object.freeze({ ...request.selectionContext }) }
      : {}),
  };
}

function assertMappedRequest(
  original: TtsSynthesisRequest,
  mapped: TtsSynthesisRequest,
  fallbackProvider: string,
): void {
  if (
    mapped.sessionId !== original.sessionId ||
    mapped.turnId !== original.turnId ||
    !sameAudioFormat(mapped.format, original.format) ||
    mapped.signal !== original.signal ||
    mapped.text !== original.text ||
    mapped.speed !== original.speed ||
    mapped.stream !== original.stream ||
    mapped.timestamps !== original.timestamps ||
    mapped.usageReporter !== original.usageReporter ||
    mapped.providerCapabilityEvaluationTimeMs !== original.providerCapabilityEvaluationTimeMs ||
    !isDeepStrictEqual(mapped.providerCapabilitySnapshots, original.providerCapabilitySnapshots) ||
    !isDeepStrictEqual(mapped.textControls ?? [], original.textControls ?? []) ||
    !isDeepStrictEqual(mapped.metadata, original.metadata)
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "TTS failover request mapping may change only provider-specific fields such as model or voice",
        { provider: fallbackProvider },
      ),
    );
  }
}

function snapshotMetadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  try {
    return structuredClone(value);
  } catch (error) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "TTS failover metadata must be structured-cloneable",
        {
          cause: error,
        },
      ),
    );
  }
}

function raceWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(requestCancelledError());

  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(requestCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  return Promise.race([Promise.resolve(operation), aborted]).finally(removeAbortListener);
}

function failoverCapabilities(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  fallbackVoiceMappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  fallbackSelectionIsKnown: boolean,
  speedRangesCanSurviveFallback: boolean,
  preservePrimarySelectionCatalog: boolean,
): ProviderCapabilities {
  const models = preservePrimarySelectionCatalog
    ? providerValueCatalog(primary, "model")
    : intersectProviderCatalogs(primary, fallback, "model");
  const languages = intersectProviderCatalogs(primary, fallback, "language");
  const voices = preservePrimarySelectionCatalog
    ? providerValueCatalog(primary, "voice")
    : intersectProviderCatalogs(primary, fallback, "voice");
  const voiceSnapshotProviders = [
    { provider: primary, include: true },
    { provider: fallback, include: fallbackSelectionIsKnown },
  ]
    .flatMap(({ provider, include }) =>
      include
        ? provider.capabilities.voiceSelection === "account_snapshot"
          ? (provider.capabilities.voiceSnapshotProviders ?? [provider.name])
          : []
        : [],
    )
    .filter((providerName, index, values) => values.indexOf(providerName) === index);
  const modelSnapshotProviders = [
    ...(primary.capabilities.modelSnapshotProviders ?? []),
    ...(fallback.capabilities.modelSnapshotProviders ?? []),
  ].filter((providerName, index, values) => values.indexOf(providerName) === index);
  const ttsTextControls = primary.capabilities.ttsTextControls;
  const ttsSpeedRanges = speedRangesCanSurviveFallback
    ? intersectTtsSpeedRanges(
        primary.capabilities.ttsSpeedRanges,
        fallback.capabilities.ttsSpeedRanges,
      )
    : undefined;
  const {
    models: _primaryModels,
    languages: _primaryLanguages,
    voices: _primaryVoices,
    ttsTextControls: _primaryTextControls,
    ttsSpeedRanges: _primaryTtsSpeedRanges,
    voiceSelection: _primaryVoiceSelection,
    voiceSnapshotProviders: _primaryVoiceSnapshotProviders,
    modelSnapshotProviders: _primaryModelSnapshotProviders,
    ...primaryCapabilities
  } = primary.capabilities;
  void _primaryModels;
  void _primaryLanguages;
  void _primaryVoices;
  void _primaryTextControls;
  void _primaryTtsSpeedRanges;
  void _primaryVoiceSelection;
  void _primaryVoiceSnapshotProviders;
  void _primaryModelSnapshotProviders;
  const audio = failoverAudioCapabilities(primary, fallback);

  return {
    ...primaryCapabilities,
    ...(audio !== undefined ? { audio } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(languages !== undefined ? { languages } : {}),
    ...(voices !== undefined ? { voices } : {}),
    ...(ttsTextControls !== undefined ? { ttsTextControls } : {}),
    ...(ttsSpeedRanges !== undefined ? { ttsSpeedRanges } : {}),
    ...(voiceSnapshotProviders.length > 0
      ? { voiceSelection: "account_snapshot" as const, voiceSnapshotProviders }
      : {}),
    ...(modelSnapshotProviders.length > 0 ? { modelSnapshotProviders } : {}),
    ...(fallbackVoiceMappings !== undefined
      ? {
          ttsVoiceMappings: Object.freeze(
            (fallbackVoiceMappings ?? []).map((mapping) =>
              Object.freeze({
                ...mapping,
                requestedProvider: primary.name,
                provider: fallback.name,
                ...(mapping.model !== undefined
                  ? { model: mapping.model }
                  : fallback.configuredModel !== undefined
                    ? { model: fallback.configuredModel }
                    : {}),
              }),
            ),
          ),
        }
      : {}),
    streaming: {
      input: false,
      output: primary.capabilities.streaming.output && fallback.capabilities.streaming.output,
      native: primary.capabilities.streaming.native && fallback.capabilities.streaming.native,
    },
    cancellation: {
      request:
        primary.capabilities.cancellation.request && fallback.capabilities.cancellation.request,
      output: primary.capabilities.cancellation.output && fallback.capabilities.cancellation.output,
      buffer: primary.capabilities.cancellation.buffer && fallback.capabilities.cancellation.buffer,
      truncation:
        primary.capabilities.cancellation.truncation &&
        fallback.capabilities.cancellation.truncation,
    },
    timestamps:
      primary.capabilities.timestamps !== false && fallback.capabilities.timestamps !== false,
    metadata: {
      ...(primary.capabilities.metadata ?? {}),
      failover: {
        primary: primary.name,
        fallback: fallback.name,
      },
    },
  };
}

function failoverAudioCapabilities(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
): ProviderCapabilities["audio"] {
  const primaryAudio = primary.capabilities.audio;
  if (!primaryAudio) return undefined;
  const { output, ...otherAudioCapabilities } = primaryAudio;
  return {
    ...otherAudioCapabilities,
    ...(output !== undefined && fallback.capabilities.audio?.output !== undefined
      ? { output }
      : {}),
  };
}

function providerCapabilitySnapshotProvidersFor(provider: TextToSpeechProvider): readonly string[] {
  return [
    ...(provider.providerCapabilitySnapshotProviders ?? []),
    ...(provider.capabilities.voiceSelection === "account_snapshot"
      ? (provider.capabilities.voiceSnapshotProviders ?? [provider.name])
      : []),
    ...(provider.capabilities.modelSnapshotProviders ?? []),
    ...(provider.requiredCapabilityQueries ?? []).map((query) => query.provider),
    ...(provider.requiredTtsVoiceCapabilities ?? []).map(
      (requirement) => requirement.provider ?? provider.name,
    ),
  ];
}

function mergeRequiredCapabilityQueries(
  ...groups: (readonly ProviderCapabilityQuery[] | undefined)[]
): readonly ProviderCapabilityQuery[] {
  const queries = new Map<string, ProviderCapabilityQuery>();
  for (const group of groups) {
    for (const query of group ?? []) {
      queries.set(
        JSON.stringify([
          query.provider,
          query.feature,
          query.scope,
          query.model,
          query.voice,
          query.expectedBooleanValue,
        ]),
        query,
      );
    }
  }
  return Object.freeze([...queries.values()]);
}

function fallbackCapabilityQueries(
  queries: readonly ProviderCapabilityQuery[] | undefined,
  selectionIsKnown: boolean,
): readonly ProviderCapabilityQuery[] | undefined {
  if (selectionIsKnown || queries === undefined) return queries;
  return queries.filter((query) => query.scope === "provider" || query.scope === "account");
}

function requiredCapabilityQueriesForSelection(
  provider: TextToSpeechProvider,
  model: string,
  voice: string | undefined,
): readonly ProviderCapabilityQuery[] {
  if (provider.requiredCapabilityQueriesForModel) {
    return provider.requiredCapabilityQueriesForModel(model, voice);
  }
  return (provider.requiredCapabilityQueries ?? []).map((query) =>
    query.scope === "model" &&
    provider.capabilities.modelSnapshotProviders?.includes(query.provider)
      ? { ...query, model }
      : query,
  );
}

function mergeRequiredTtsVoiceCapabilities(
  primaryProvider: TextToSpeechProvider,
  fallbackProvider: TextToSpeechProvider | undefined,
): readonly ProviderTtsVoiceCapabilityRequirement[] {
  const requirements = new Map<string, ProviderTtsVoiceCapabilityRequirement>();
  const providers = [
    [primaryProvider, "requested"],
    ...(fallbackProvider ? ([[fallbackProvider, "mapped"]] as const) : []),
  ] as const;
  for (const [provider, defaultVoiceSource] of providers) {
    for (const requirement of provider.requiredTtsVoiceCapabilities ?? []) {
      const configuredLanguage = requirement.configuredLanguage ?? provider.configuredLanguage;
      const scopedRequirement = {
        ...requirement,
        provider: requirement.provider ?? provider.name,
        voiceSource: requirement.voiceSource ?? defaultVoiceSource,
        ...(configuredLanguage !== undefined ? { configuredLanguage } : {}),
        ...(defaultVoiceSource === "mapped" && requirement.modelSource === "selected"
          ? { modelSource: "mapped" as const }
          : {}),
      };
      requirements.set(
        JSON.stringify([
          scopedRequirement.provider,
          scopedRequirement.feature,
          scopedRequirement.expectedBooleanValue,
          scopedRequirement.voiceSource,
          scopedRequirement.modelSource,
          scopedRequirement.configuredLanguageMustBeVerified,
          scopedRequirement.configuredLanguage,
        ]),
        scopedRequirement,
      );
    }
  }
  return Object.freeze([...requirements.values()]);
}

function intersectTtsSpeedRanges(
  primary: ProviderCapabilities["ttsSpeedRanges"],
  fallback: ProviderCapabilities["ttsSpeedRanges"],
): ProviderCapabilities["ttsSpeedRanges"] {
  if (primary === undefined || fallback === undefined) return undefined;
  const fallbackByModel = new Map(fallback.map((range) => [range.model, range]));
  return Object.freeze(
    primary.flatMap((range) => {
      const fallbackRange = fallbackByModel.get(range.model);
      if (!fallbackRange) return [];
      const min = Math.max(range.min, fallbackRange.min);
      const max = Math.min(range.max, fallbackRange.max);
      return min <= max ? [Object.freeze({ model: range.model, min, max })] : [];
    }),
  );
}

function failoverCapabilitySnapshotVoices(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
): readonly ProviderCapabilitySnapshotVoice[] {
  const selections: ProviderCapabilitySnapshotVoice[] = [
    ...(primary.providerCapabilitySnapshotVoices ?? []).map((selection) => ({
      ...selection,
      side: "primary" as const,
    })),
    ...(fallback.providerCapabilitySnapshotVoices ?? []).flatMap((selection) => {
      if ((mappings ?? []).length === 0 || selection.modelSource === "mapped") {
        return [{ ...selection, side: "fallback" as const }];
      }
      const mappedModels = [
        ...new Set(
          (mappings ?? [])
            .map((mapping) => mapping.model ?? fallback.configuredModel)
            .filter((model): model is string => model !== undefined),
        ),
      ];
      if (mappedModels.length === 0) {
        return [{ ...selection, side: "fallback" as const }];
      }
      return mappedModels.map((model) => ({
        ...selection,
        model,
        modelSource: "mapped" as const,
        side: "fallback" as const,
      }));
    }),
  ];
  for (const mapping of mappings ?? []) {
    if (
      primary.capabilities.voiceSelection === "account_snapshot" &&
      mapping.requestedVoice !== undefined
    ) {
      const declaredPrimarySelections = (primary.providerCapabilitySnapshotVoices ?? []).filter(
        (selection) =>
          selection.side !== "fallback" &&
          selection.voice === mapping.requestedVoice &&
          (mapping.requestedModel === undefined ||
            selection.model === undefined ||
            selection.model === mapping.requestedModel),
      );
      if (declaredPrimarySelections.length === 0) {
        const primarySnapshotProviders =
          primary.capabilities.voiceSnapshotProviders ??
          (mapping.requestedProvider !== undefined ? [mapping.requestedProvider] : [primary.name]);
        selections.push(
          ...primarySnapshotProviders.map((provider) => ({
            provider,
            ...(mapping.requestedModel !== undefined ? { model: mapping.requestedModel } : {}),
            voice: mapping.requestedVoice!,
            modelSource: "mapped" as const,
            side: "primary" as const,
          })),
        );
      }
    }
    if (fallback.capabilities.voiceSelection === "account_snapshot") {
      const mappedModel = mapping.model ?? fallback.configuredModel;
      const declaredFallbackSelections = (fallback.providerCapabilitySnapshotVoices ?? []).filter(
        (selection) =>
          selection.voice === mapping.voice &&
          (mappedModel === undefined ||
            selection.model === undefined ||
            selection.model === mappedModel),
      );
      if (declaredFallbackSelections.length === 0) {
        const fallbackSnapshotProviders = fallback.capabilities.voiceSnapshotProviders ?? [
          fallback.name,
        ];
        selections.push(
          ...fallbackSnapshotProviders.map((provider) => ({
            provider,
            ...(mappedModel !== undefined ? { model: mappedModel } : {}),
            voice: mapping.voice,
            modelSource: "mapped" as const,
            side: "fallback" as const,
          })),
        );
      }
    }
  }
  const unique = new Map<string, ProviderCapabilitySnapshotVoice>();
  for (const selection of selections) {
    const key = JSON.stringify([
      selection.provider,
      selection.model ?? null,
      selection.voice,
      selection.side ?? null,
    ]);
    unique.set(key, Object.freeze(selection));
  }
  return Object.freeze([...unique.values()]);
}

function assertDialogueVoiceMappings(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
): void {
  if (mappings !== undefined) {
    for (const selection of (primary.providerCapabilitySnapshotVoices ?? []).filter(
      (voiceSelection) => voiceSelection.side !== "fallback",
    )) {
      const requestedModel = selection.model ?? primary.configuredModel;
      if (
        fallbackVoiceMappingsForSelection(mappings, requestedModel, selection.voice).length === 0
      ) {
        throw new TypeError(
          `TTS failover fallbackRequestVariants must include primary dialogue voice ${selection.voice} for model ${requestedModel ?? "default"}`,
        );
      }
    }
  }

  if (mappings !== undefined && primary.providerCapabilitySnapshotVoices !== undefined) {
    for (const mapping of mappings) {
      if (
        mapping.requestedVoice !== undefined &&
        !primary.providerCapabilitySnapshotVoices.some(
          (selection) =>
            selection.side !== "fallback" && selection.voice === mapping.requestedVoice,
        )
      ) {
        throw new TypeError(
          `TTS failover mapping source voice ${mapping.requestedVoice} is not registered by primary ${primary.name}`,
        );
      }
    }
  }

  const fallbackDialogueVoices =
    fallback.capabilities.ttsVoiceMappings === undefined
      ? fallback.providerCapabilitySnapshotVoices?.filter(
          (selection) => selection.side !== "fallback",
        )
      : fallback.capabilities.ttsVoiceMappings
          .filter((mapping) => mapping.requestedVoice !== undefined)
          .map((mapping) => ({
            provider: mapping.requestedProvider ?? fallback.name,
            ...(mapping.requestedModel !== undefined ? { model: mapping.requestedModel } : {}),
            voice: mapping.requestedVoice!,
          }));
  if (fallbackDialogueVoices === undefined || mappings === undefined) return;
  for (const mapping of mappings) {
    const mappedModel = mapping.model ?? fallback.configuredModel;
    if (!fallbackDialogueVoices.some((selection) => selection.voice === mapping.voice)) {
      throw new TypeError(
        `TTS failover mapping to voice ${mapping.voice} is not registered in fallback ${fallback.name}'s dialogueVoices for model ${mappedModel ?? "default"}`,
      );
    }
  }
}

function missingFallbackVoiceMappingError(
  provider: string,
  request: TtsSynthesisRequest,
  snapshotsRequired = false,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      snapshotsRequired
        ? "TTS failover with provider capability snapshots and an account-backed fallback requires fallbackRequestVariants"
        : "TTS failover request matches no declared fallback request variant",
      {
        provider,
        metadata: {
          ...(snapshotsRequired ? { snapshotsRequired: true } : {}),
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.voice !== undefined ? { voice: request.voice } : {}),
        },
      },
    ),
  );
}

function assertTtsSpeedSupported(
  provider: TextToSpeechProvider,
  request: TtsSynthesisRequest,
): void {
  if (request.speed === undefined) return;
  const model = request.model ?? provider.configuredModel;
  const compatibility = evaluateProviderCompatibility(provider, {
    kind: "tts",
    ...(model !== undefined ? { model } : {}),
    ttsSpeed: request.speed,
  });
  const issue = compatibility.issues.find(({ code }) => code === "tts_speed.unsupported");
  if (!issue) return;
  throw TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, issue.message, {
      provider: provider.name,
      metadata: {
        model,
        speed: request.speed,
        requirement: issue.requirement,
        issues: compatibility.issues,
      },
    }),
  );
}

function withProviderDefaults(
  request: TtsSynthesisRequest,
  provider: TextToSpeechProvider,
): TtsSynthesisRequest {
  return {
    ...request,
    ...(request.model === undefined && provider.configuredModel !== undefined
      ? { model: provider.configuredModel }
      : {}),
    ...(request.voice === undefined && provider.configuredVoice !== undefined
      ? { voice: provider.configuredVoice }
      : {}),
  };
}

/**
 * Projects declared variants onto the voice mappings that capability snapshots
 * and published capabilities use. An omitted `when` field matches any value.
 */
function fallbackVoiceMappingsFromVariants(
  variants: readonly TtsFailoverRequestVariant[] | undefined,
  fallback: TextToSpeechProvider,
): readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined {
  if (variants === undefined) return undefined;
  const mappings = new Map<string, Omit<ProviderTtsVoiceMapping, "provider">>();
  for (const variant of variants) {
    const voice = variant.fallback.voice ?? fallback.configuredVoice;
    // A partial projection would make snapshot preflight reject calls that
    // match only a voiceless variant, so publish no mappings in that case.
    if (voice === undefined) return undefined;
    const model = variant.fallback.model ?? fallback.configuredModel;
    const mapping = Object.freeze({
      ...(variant.when?.model !== undefined ? { requestedModel: variant.when.model } : {}),
      ...(variant.when?.voice !== undefined ? { requestedVoice: variant.when.voice } : {}),
      ...(model !== undefined ? { model } : {}),
      voice,
    });
    mappings.set(
      JSON.stringify([mapping.requestedModel, mapping.requestedVoice, mapping.model, voice]),
      mapping,
    );
  }
  return Object.freeze([...mappings.values()]);
}

function assertFallbackConfiguredModelSelections(
  fallback: TextToSpeechProvider,
  variants: readonly TtsFailoverRequestVariant[] | undefined,
): void {
  for (const variant of variants ?? []) {
    const model = variant.fallback.model ?? fallback.configuredModel;
    const voice = variant.fallback.voice ?? fallback.configuredVoice;
    if (
      model !== undefined &&
      fallback.supportsConfiguredModelSelection?.(model, voice) === false
    ) {
      throw new TypeError(
        `TTS failover fallback ${fallback.name} cannot use its configured options with mapped model ${model}`,
      );
    }
  }
}

function fallbackVoiceMappingsForSelection(
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  model: string | undefined,
  voice: string | undefined,
): readonly Omit<ProviderTtsVoiceMapping, "provider">[] {
  return (mappings ?? []).filter(
    (mapping) =>
      (mapping.requestedModel === undefined || mapping.requestedModel === model) &&
      (mapping.requestedVoice === undefined || mapping.requestedVoice === voice),
  );
}

function mapRequestWithFallbackVariants(
  request: TtsSynthesisRequest,
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
  variants: readonly TtsFailoverRequestVariant[],
  languageMatch: "exact" | "base-language",
  name: string,
): TtsSynthesisRequest {
  const selection = selectionFromRequest(request);
  const languageWasCallerSelected =
    request.selectionContext?.languageWasCallerSelected ?? request.language !== undefined;
  const languageWasExplicitlySelected =
    request.selectionContext?.languageWasExplicitlySelected ?? languageWasCallerSelected;
  const candidates = resolveFallbackSelections(
    selection,
    variants,
    true,
    languageMatch,
    effectiveProviderSelection(primary, selection),
    fallback,
    languageWasCallerSelected,
    languageWasExplicitlySelected,
  );
  const targets = new Map(
    candidates.map((candidate) => [JSON.stringify([candidate.model, candidate.voice]), candidate]),
  );
  if (targets.size !== 1) {
    throw targets.size === 0
      ? missingFallbackVoiceMappingError(name, request)
      : TvicThrowableError.from(
          validationError(
            TVIC_ERROR_CODES.providerInvalidRequest,
            "TTS failover request matches several fallback request variants with different fallback voices; supply mapFallbackRequest to choose one",
            { provider: name },
          ),
        );
  }
  const [target] = targets.values();
  const { model: _model, voice: _voice, ...unmapped } = request;
  void _model;
  void _voice;
  return {
    ...unmapped,
    ...(target!.model !== undefined ? { model: target!.model } : {}),
    ...(target!.voice !== undefined ? { voice: target!.voice } : {}),
  };
}

function estimateTtsEventBytes(event: TtsEvent): number {
  try {
    return boundedJsonByteLength(event, MAX_FAILOVER_PRE_AUDIO_EVENT_BYTES);
  } catch {
    return MAX_FAILOVER_PRE_AUDIO_EVENT_BYTES + 1;
  }
}

function boundedJsonByteLength(value: unknown, maximum: number): number {
  let bytes = 0;
  let visitedNodes = 0;
  const ancestors = new WeakSet<object>();
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= maximum;
  };
  const visitNode = (): boolean => {
    visitedNodes += 1;
    return visitedNodes <= MAX_FAILOVER_EVENT_ESTIMATE_NODES;
  };
  const addString = (value: string): boolean => {
    if (!add(2)) return false;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      let characterBytes: number;
      if (code === 0x22 || code === 0x5c) {
        characterBytes = 2;
      } else if (code < 0x20) {
        characterBytes =
          code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          characterBytes = 4;
          index += 1;
        } else {
          characterBytes = 6;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        characterBytes = 6;
      } else if (code < 0x80) {
        characterBytes = 1;
      } else if (code < 0x800) {
        characterBytes = 2;
      } else {
        characterBytes = 3;
      }
      if (!add(characterBytes)) return false;
    }
    return true;
  };
  const encode = (
    current: unknown,
    depth: number,
    inArray: boolean,
    nodeVisited = false,
  ): boolean => {
    if (!nodeVisited && !visitNode()) return false;
    if (current === null) return add(4);
    switch (typeof current) {
      case "string":
        return addString(current);
      case "boolean":
        return add(current ? 4 : 5);
      case "number":
        return add(
          Number.isFinite(current) ? (Object.is(current, -0) ? 1 : String(current).length) : 4,
        );
      case "undefined":
      case "function":
      case "symbol":
        return inArray ? add(4) : true;
      case "bigint":
        return false;
      case "object":
        break;
      default:
        return false;
    }

    if (depth >= MAX_FAILOVER_EVENT_ESTIMATE_DEPTH || ancestors.has(current)) return false;
    const value = current as object;
    const prototype = Object.getPrototypeOf(value);
    const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJson && (!("value" in toJson) || typeof toJson.value === "function")) return false;
    ancestors.add(value);
    let valid = true;
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || !add(1)) valid = false;
      for (let index = 0; valid && index < value.length; index += 1) {
        if (index > 0 && !add(1)) {
          valid = false;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          valid = visitNode() && add(4);
        } else if (!("value" in descriptor)) {
          valid = false;
        } else {
          valid = encode(descriptor.value, depth + 1, true);
        }
      }
      if (valid) valid = add(1);
    } else if (prototype === Object.prototype || prototype === null) {
      valid = add(1);
      let first = true;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (!visitNode()) {
          valid = false;
          break;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) {
          valid = false;
          break;
        }
        const propertyValue = descriptor.value;
        if (
          propertyValue === undefined ||
          typeof propertyValue === "function" ||
          typeof propertyValue === "symbol"
        ) {
          continue;
        }
        if ((!first && !add(1)) || !addString(key) || !add(1)) {
          valid = false;
          break;
        }
        first = false;
        valid = encode(propertyValue, depth + 1, false, true);
        if (!valid) break;
      }
      if (valid) valid = add(1);
    } else {
      valid = false;
    }
    ancestors.delete(value);
    return valid;
  };

  return encode(value, 0, false) ? bytes : maximum + 1;
}
