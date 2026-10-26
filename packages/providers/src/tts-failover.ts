import { isDeepStrictEqual } from "node:util";

import {
  cancelledError,
  countUnicodeCodePoints,
  createProviderCapabilitySnapshots,
  createProviderTtsVoiceMappings,
  evaluateProviderCompatibility,
  isNormalizedError,
  isTvicError,
  MAX_PROVIDER_TTS_VOICE_MAPPINGS,
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
  type TtsStream,
  type TtsSynthesisRequest,
  type TtsUsageReporter,
} from "@tvic/core";
import { validateTtsTextControls } from "./tts-text-controls.js";

export type TtsFailoverPhase = "synthesize" | "stream";

export interface TtsFailoverContext {
  readonly phase: TtsFailoverPhase;
  readonly primary: TextToSpeechProvider;
  readonly fallback: TextToSpeechProvider;
  readonly request: TtsSynthesisRequest;
  readonly fallbackRequest: TtsSynthesisRequest;
  readonly error: NormalizedError;
}

export type TtsFailoverVoiceMapping = Omit<ProviderTtsVoiceMapping, "provider">;

export interface TtsFailoverProviderOptions {
  readonly primary: TextToSpeechProvider;
  readonly fallback: TextToSpeechProvider;
  readonly mapFallbackRequest?: (
    request: TtsSynthesisRequest,
    error: NormalizedError,
  ) => TtsSynthesisRequest;
  readonly fallbackVoiceMappings?: readonly TtsFailoverVoiceMapping[];
  readonly languageMatch?: "exact" | "base-language";
  readonly shouldFallback?: (error: NormalizedError, request: TtsSynthesisRequest) => boolean;
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

/**
 * Creates a failover wrapper. Request metadata must be structured-cloneable;
 * the wrapper validates and copies it before invoking the primary provider.
 */
export function createTtsFailoverProvider(
  options: TtsFailoverProviderOptions,
): TextToSpeechProvider {
  assertTtsProvider(options.primary, "primary");
  assertTtsProvider(options.fallback, "fallback");
  assertCompatibleOutputFormats(options.primary, options.fallback);
  const languageMatch = options.languageMatch ?? "exact";
  assertCompatibleLanguages(options.primary, options.fallback, languageMatch);

  const fallbackVoiceMappings = normalizeFallbackVoiceMappings(
    options.fallbackVoiceMappings,
    options.primary,
    options.fallback,
  );
  assertDialogueVoiceMappings(options.primary, options.fallback, fallbackVoiceMappings);
  const hasRequestMapper =
    options.mapFallbackRequest !== undefined || fallbackVoiceMappings !== undefined;
  const usesRequestModelForUsage =
    options.mapFallbackRequest === undefined &&
    fallbackMappingsPreserveRequestModel(
      fallbackVoiceMappings,
      options.primary.configuredModel,
      options.fallback.configuredModel,
    );
  const allowUnknownModel = hasRequestMapper
    ? options.primary.allowUnknownModel === true
    : options.primary.allowUnknownModel === true && options.fallback.allowUnknownModel === true;
  const mapFallbackRequest = options.mapFallbackRequest ?? ((request) => request);
  const name = options.name ?? `tts-failover:${options.primary.name}->${options.fallback.name}`;
  const capabilities = failoverCapabilities(
    options.primary,
    options.fallback,
    fallbackVoiceMappings,
    options.mapFallbackRequest === undefined || fallbackVoiceMappings !== undefined,
    usesRequestModelForUsage,
    hasRequestMapper,
  );
  const requiredCapabilityQueries = mergeRequiredCapabilityQueries(
    options.primary.requiredCapabilityQueries,
    fallbackCapabilityQueries(
      options.fallback.requiredCapabilityQueries,
      options.mapFallbackRequest === undefined || fallbackVoiceMappings !== undefined,
    ),
  );
  const requiredTtsVoiceCapabilities = mergeRequiredTtsVoiceCapabilities(
    options.primary,
    options.mapFallbackRequest === undefined || fallbackVoiceMappings !== undefined
      ? options.fallback
      : undefined,
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
    const mapping = fallbackVoiceMappingForSelection(
      fallbackVoiceMappings,
      model,
      voice ?? options.primary.configuredVoice,
    );
    const fallbackQueries = requiredCapabilityQueriesForSelection(
      options.fallback,
      mapping?.model ?? model,
      mapping?.voice ?? voice,
    );
    return mergeRequiredCapabilityQueries(
      requiredCapabilityQueriesForSelection(options.primary, model, voice),
      fallbackCapabilityQueries(
        fallbackQueries,
        options.mapFallbackRequest === undefined || mapping !== undefined,
      ),
    );
  };
  const supportsConfiguredModelSelection = (model: string, voice?: string) => {
    const mapping = fallbackVoiceMappingForSelection(
      fallbackVoiceMappings,
      model,
      voice ?? options.primary.configuredVoice,
    );
    if (options.primary.supportsConfiguredModelSelection?.(model, voice) === false) return false;
    if (options.mapFallbackRequest !== undefined && mapping === undefined) return true;
    return (
      options.fallback.supportsConfiguredModelSelection?.(
        mapping?.model ?? model,
        mapping?.voice ?? voice,
      ) !== false
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
    if (options.shouldFallback === undefined) {
      if (!defaultShouldFallback(error)) throw originalError;
    } else if (!options.shouldFallback(error, snapshotTtsRequest(request))) {
      throw originalError;
    }
    if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
      throw requestCancelledError();
    }

    const effectivePrimaryRequest = withProviderDefaults(request, options.primary);
    if (
      requiresDeclaredTtsVoiceMappingForCapabilitySnapshots &&
      request.providerCapabilitySnapshots !== undefined
    ) {
      throw withPrimaryErrorCause(
        missingFallbackVoiceMappingError(name, effectivePrimaryRequest, true),
        originalError,
        options.primary.name,
      );
    }
    const requestSnapshot = snapshotTtsRequest(effectivePrimaryRequest);
    const requestForMapping = snapshotTtsRequest(effectivePrimaryRequest, true);
    let fallbackRequest: TtsSynthesisRequest;
    try {
      const selectionMapping = fallbackVoiceMappingForRequest(
        fallbackVoiceMappings,
        effectivePrimaryRequest,
      );
      if (fallbackVoiceMappings !== undefined && !selectionMapping) {
        throw missingFallbackVoiceMappingError(name, effectivePrimaryRequest);
      }
      const mappedFallbackRequest =
        options.mapFallbackRequest !== undefined
          ? mapFallbackRequest(requestForMapping, error)
          : selectionMapping
            ? {
                ...requestForMapping,
                ...(selectionMapping.model !== undefined ? { model: selectionMapping.model } : {}),
                voice: selectionMapping.voice,
              }
            : mapFallbackRequest(requestForMapping, error);
      assertMappedRequest(requestSnapshot, mappedFallbackRequest);
      if (selectionMapping) {
        assertDeclaredFallbackSelection(
          mappedFallbackRequest,
          selectionMapping,
          options.fallback,
          effectivePrimaryRequest,
        );
      } else if (options.mapFallbackRequest === undefined) {
        assertUnmappedFallbackSelection(requestSnapshot, mappedFallbackRequest);
      }
      fallbackRequest = snapshotTtsRequest({
        ...mappedFallbackRequest,
        ...(requestSnapshot.providerCapabilitySnapshots !== undefined
          ? { providerCapabilitySnapshots: requestSnapshot.providerCapabilitySnapshots }
          : {}),
      });
      assertFallbackRequestSupported(options.fallback, fallbackRequest);
    } catch (error) {
      if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
        throw requestCancelledError();
      }
      const normalized = TvicThrowableError.from(error).error;
      if (
        normalized.category === "provider" ||
        normalized.category === "cancelled" ||
        ((isTvicError(error) || isNormalizedError(error)) && normalized.category !== "validation")
      ) {
        throw error;
      }
      throw fallbackValidationError(
        error,
        originalError,
        options.fallback.name,
        options.primary.name,
      );
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
    let fallbackStream: TtsStream;
    try {
      fallbackStream = await synthesizeWithAbort(options.fallback, providerRequest);
    } catch (error) {
      if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
        throw requestCancelledError();
      }
      throw withPrimaryErrorCause(error, originalError, options.primary.name);
    }
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
      ...(usesRequestModelForUsage ? { usesRequestModelForUsage: true } : {}),
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
    ...(options.primary.languageWasExplicitlyConfigured !== undefined
      ? { languageWasExplicitlyConfigured: options.primary.languageWasExplicitlyConfigured }
      : {}),
    ...(canCheckProviderValue(options.primary, "language")
      ? {
          supportsLanguage: (language: string, model?: string, voice?: string) => {
            if (
              !providerSupportsValue(
                options.primary,
                "language",
                language,
                model,
                voice ?? options.primary.configuredVoice,
              )
            ) {
              return false;
            }
            const mapping = fallbackVoiceMappingForSelection(
              fallbackVoiceMappings,
              model ?? options.primary.configuredModel,
              voice ?? options.primary.configuredVoice,
            );
            const fallbackLanguage = options.fallback.configuredLanguage ?? language;
            if (options.fallback.configuredLanguage !== undefined) {
              if (!languagesCompatible(language, fallbackLanguage, languageMatch)) return false;
              if (options.mapFallbackRequest !== undefined && mapping === undefined) {
                return fallbackVoiceMappings === undefined;
              }
              if (!canCheckProviderValue(options.fallback, "language")) return true;
            } else if (options.mapFallbackRequest !== undefined && mapping === undefined) {
              return true;
            } else if (!canCheckProviderValue(options.fallback, "language")) {
              return false;
            }
            return providerSupportsValue(
              options.fallback,
              "language",
              fallbackLanguage,
              mapping?.model ?? model,
              mapping?.voice ?? voice,
            );
          },
        }
      : {}),
    ...(canCheckProviderValue(options.primary, "voice") &&
    (hasRequestMapper || canCheckProviderValue(options.fallback, "voice"))
      ? {
          supportsVoice: (voice: string, model?: string) => {
            const selectedModel = model ?? options.primary.configuredModel;
            if (!providerSupportsValue(options.primary, "voice", voice, selectedModel))
              return false;
            const mapping = fallbackVoiceMappings?.find(
              (candidate) =>
                candidate.requestedModel === selectedModel && candidate.requestedVoice === voice,
            );
            if (options.mapFallbackRequest !== undefined && mapping === undefined) {
              return fallbackVoiceMappings === undefined;
            }
            if (fallbackVoiceMappings === undefined)
              return providerSupportsValue(options.fallback, "voice", voice, selectedModel);
            if (!mapping) return fallbackVoiceMappings.length === 0;
            return providerSupportsValue(
              options.fallback,
              "voice",
              mapping.voice,
              mapping.model ?? selectedModel,
            );
          },
        }
      : {}),
    async synthesize(request): Promise<TtsStream> {
      request = snapshotTtsRequest(request);
      request = validateTtsTextControls(requestValidator, request);
      if (request.providerCapabilitySnapshots !== undefined) {
        request = {
          ...request,
          providerCapabilitySnapshots: createProviderCapabilitySnapshots(
            request.providerCapabilitySnapshots,
          ),
        };
      }
      const effectivePrimaryRequest = withProviderDefaults(request, options.primary);
      assertTtsSpeedSupported(options.primary, effectivePrimaryRequest);
      const speedMapping = fallbackVoiceMappingForRequest(
        fallbackVoiceMappings,
        effectivePrimaryRequest,
      );
      if (fallbackVoiceMappings !== undefined && speedMapping === undefined) {
        throw missingFallbackVoiceMappingError(name, effectivePrimaryRequest);
      }
      if (
        options.mapFallbackRequest === undefined &&
        (fallbackVoiceMappings === undefined || speedMapping !== undefined)
      ) {
        assertTtsSpeedSupported(options.fallback, {
          ...effectivePrimaryRequest,
          ...(speedMapping?.model !== undefined
            ? { model: speedMapping.model }
            : speedMapping?.requestedModel !== undefined
              ? { model: speedMapping.requestedModel }
              : {}),
          ...(speedMapping !== undefined ? { voice: speedMapping.voice } : {}),
        });
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
  if (!languagesCompatible(primaryLanguage, fallbackLanguage, languageMatch)) {
    throw new TypeError(
      `TTS failover providers must use compatible configured languages (${primary.name}: ${primaryLanguage} -> ${fallback.name}: ${fallbackLanguage})`,
    );
  }
}

function languagesCompatible(
  primaryLanguage: string,
  fallbackLanguage: string,
  languageMatch: "exact" | "base-language",
): boolean {
  return (
    primaryLanguage.toLowerCase() === fallbackLanguage.toLowerCase() ||
    (languageMatch === "base-language" &&
      languageSubtag(primaryLanguage) === languageSubtag(fallbackLanguage))
  );
}

function languageSubtag(language: string): string {
  return language.split("-", 1)[0]?.toLowerCase() ?? "";
}

function snapshotTtsRequest(
  request: TtsSynthesisRequest,
  cloneCapabilitySnapshots = false,
): TtsSynthesisRequest {
  const providerCapabilitySnapshots = request.providerCapabilitySnapshots;
  return {
    ...request,
    format: { ...request.format },
    ...(providerCapabilitySnapshots !== undefined
      ? {
          providerCapabilitySnapshots: cloneCapabilitySnapshots
            ? structuredClone(providerCapabilitySnapshots)
            : providerCapabilitySnapshots,
        }
      : {}),
    ...(request.metadata !== undefined ? { metadata: snapshotMetadata(request.metadata) } : {}),
  };
}

function assertMappedRequest(original: TtsSynthesisRequest, mapped: TtsSynthesisRequest): void {
  const changed: string[] = [];
  if (mapped.sessionId !== original.sessionId) changed.push("sessionId");
  if (mapped.turnId !== original.turnId) changed.push("turnId");
  if (!sameAudioFormat(mapped.format, original.format)) changed.push("format");
  if (mapped.signal !== original.signal) changed.push("signal");
  if (mapped.text !== original.text) changed.push("text");
  if (mapped.stream !== original.stream) changed.push("stream");
  if (mapped.speed !== original.speed) changed.push("speed");
  if (mapped.timestamps !== original.timestamps) changed.push("timestamps");
  if (mapped.providerCapabilityEvaluationTimeMs !== original.providerCapabilityEvaluationTimeMs) {
    changed.push("providerCapabilityEvaluationTimeMs");
  }
  if (
    !isDeepStrictEqual(mapped.providerCapabilitySnapshots, original.providerCapabilitySnapshots)
  ) {
    changed.push("providerCapabilitySnapshots");
  }
  if (!isDeepStrictEqual(mapped.textControls ?? [], original.textControls ?? [])) {
    changed.push("textControls");
  }
  if (mapped.usageReporter !== original.usageReporter) changed.push("usageReporter");
  if (!isDeepStrictEqual(mapped.metadata, original.metadata)) changed.push("metadata");
  if (changed.length > 0) {
    throw new TypeError(
      `TTS failover request mapping changed protected fields: ${changed.join(", ")}; only provider-specific fields such as model or voice may change`,
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

function missingFallbackVoiceMappingError(
  provider: string,
  request: TtsSynthesisRequest,
  snapshotsRequired = false,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      snapshotsRequired
        ? "TTS failover with provider capability snapshots and an account-backed fallback requires fallbackVoiceMappings"
        : "TTS failover request has no declared fallback voice mapping",
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
                  : mapping.requestedModel !== undefined
                    ? { model: mapping.requestedModel }
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

function normalizeFallbackVoiceMappings(
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
): readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined {
  if (mappings === undefined) return undefined;
  if (mappings.length > MAX_PROVIDER_TTS_VOICE_MAPPINGS) {
    throw new TypeError(
      `TTS voice mappings must contain at most ${MAX_PROVIDER_TTS_VOICE_MAPPINGS} entries`,
    );
  }
  if (mappings.length === 0) {
    throw new TypeError("TTS failover fallback voice mappings cannot be empty");
  }
  const normalized = createProviderTtsVoiceMappings(
    mappings.map((mapping) => ({
      ...mapping,
      requestedProvider: primary.name,
      provider: fallback.name,
    })),
  );
  const selectorsResolved = createProviderTtsVoiceMappings(
    normalized.map(({ provider, ...mapping }) => {
      const requestedModel = mapping.requestedModel ?? primary.configuredModel;
      const requestedVoice = mapping.requestedVoice ?? primary.configuredVoice;
      return {
        ...mapping,
        ...(requestedModel !== undefined ? { requestedModel } : {}),
        ...(requestedVoice !== undefined ? { requestedVoice } : {}),
        provider,
      };
    }),
  );
  for (const mapping of selectorsResolved) {
    const requestModel = mapping.requestedModel ?? primary.configuredModel;
    if (
      mapping.requestedVoice !== undefined &&
      !providerSupportsValue(primary, "voice", mapping.requestedVoice, requestModel)
    ) {
      throw new TypeError(
        `TTS failover primary ${primary.name} does not support mapped request voice ${mapping.requestedVoice}`,
      );
    }
    const model = mapping.model ?? mapping.requestedModel ?? fallback.configuredModel;
    if (
      model !== undefined &&
      fallback.supportsConfiguredModelSelection?.(model, mapping.voice) === false
    ) {
      throw new TypeError(
        `TTS failover fallback ${fallback.name} cannot use its configured options with mapped model ${model}`,
      );
    }
    if (
      model !== undefined &&
      providerValueCatalog(fallback, "model") &&
      !providerValueCatalog(fallback, "model")?.includes(model) &&
      fallback.allowUnknownModel !== true
    ) {
      throw new TypeError(
        `TTS failover fallback ${fallback.name} does not support mapped model ${model}`,
      );
    }
    if (!providerSupportsValue(fallback, "voice", mapping.voice, model)) {
      throw new TypeError(
        `TTS failover fallback ${fallback.name} does not support mapped voice ${mapping.voice}`,
      );
    }
  }
  return Object.freeze(
    selectorsResolved.map(({ provider, ...mapping }) => {
      void provider;
      return mapping;
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
            .map((mapping) => mapping.model ?? mapping.requestedModel ?? fallback.configuredModel)
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
      const mappedModel = mapping.model ?? mapping.requestedModel ?? fallback.configuredModel;
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
        !mappings.some(
          (mapping) =>
            mapping.requestedModel === requestedModel && mapping.requestedVoice === selection.voice,
        )
      ) {
        throw new TypeError(
          `TTS failover fallbackVoiceMappings must include primary dialogue voice ${selection.voice} for model ${requestedModel ?? "default"}`,
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
    const mappedModel = mapping.model ?? mapping.requestedModel ?? fallback.configuredModel;
    if (!fallbackDialogueVoices.some((selection) => selection.voice === mapping.voice)) {
      throw new TypeError(
        `TTS failover mapping to voice ${mapping.voice} is not registered in fallback ${fallback.name}'s dialogueVoices for model ${mappedModel ?? "default"}`,
      );
    }
  }
}

function fallbackMappingsPreserveRequestModel(
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  primaryModel: string | undefined,
  fallbackModel: string | undefined,
): boolean {
  if (mappings === undefined) return true;
  return mappings.every((mapping) => {
    const requestedModel = mapping.requestedModel ?? primaryModel;
    const mappedModel = mapping.model ?? requestedModel ?? fallbackModel;
    return requestedModel === undefined
      ? mappedModel === undefined
      : mappedModel === requestedModel;
  });
}

function fallbackVoiceMappingForRequest(
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  request: TtsSynthesisRequest,
): Omit<ProviderTtsVoiceMapping, "provider"> | undefined {
  return fallbackVoiceMappingForSelection(mappings, request.model, request.voice);
}

function fallbackVoiceMappingForSelection(
  mappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  model: string | undefined,
  voice: string | undefined,
): Omit<ProviderTtsVoiceMapping, "provider"> | undefined {
  return mappings?.find(
    (mapping) => mapping.requestedModel === model && mapping.requestedVoice === voice,
  );
}

function assertDeclaredFallbackSelection(
  request: TtsSynthesisRequest,
  mapping: Omit<ProviderTtsVoiceMapping, "provider">,
  fallback: TextToSpeechProvider,
  source: TtsSynthesisRequest,
): void {
  const expectedModel = mapping.model ?? source.model ?? fallback.configuredModel;
  const actualModel = request.model ?? fallback.configuredModel;
  if (actualModel !== expectedModel || request.voice !== mapping.voice) {
    throw new TypeError("TTS failover request does not match its declared fallback voice mapping");
  }
}

function assertUnmappedFallbackSelection(
  original: TtsSynthesisRequest,
  mapped: TtsSynthesisRequest,
): void {
  if (mapped.model !== original.model || mapped.voice !== original.voice) {
    throw new TypeError(
      "TTS failover request mapping may change model or voice only with a declared fallback voice mapping",
    );
  }
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

type ProviderValueKind = "language" | "model" | "voice";

function providerValueCatalog(
  provider: TextToSpeechProvider,
  kind: ProviderValueKind,
): readonly string[] | undefined {
  if (kind === "language") return provider.capabilities.languages;
  if (kind === "model") {
    return (
      provider.capabilities.models ??
      (provider.configuredModel !== undefined ? [provider.configuredModel] : undefined)
    );
  }
  return (
    provider.capabilities.voices ??
    (provider.configuredVoice !== undefined ? [provider.configuredVoice] : undefined)
  );
}

function intersectProviderCatalogs(
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

function canCheckProviderValue(
  provider: TextToSpeechProvider,
  kind: "language" | "voice",
): boolean {
  if (kind === "language") {
    return (
      typeof provider.supportsLanguage === "function" ||
      (provider.capabilities.languages?.length ?? 0) > 0
    );
  }
  return (
    typeof provider.supportsVoice === "function" ||
    (provider.capabilities.voices?.length ?? 0) > 0 ||
    provider.configuredVoice !== undefined
  );
}

function providerSupportsValue(
  provider: TextToSpeechProvider,
  kind: "language" | "voice",
  value: string,
  model?: string,
  voice?: string,
): boolean {
  if (kind === "voice" && provider.capabilities.voiceSelection === "account_snapshot") {
    return true;
  }
  if (kind === "language") {
    return (
      provider.supportsLanguage?.call(provider, value, model, voice) ??
      provider.capabilities.languages?.includes(value) ??
      false
    );
  }
  return (
    provider.supportsVoice?.call(provider, value, model) ??
    provider.capabilities.voices?.includes(value) ??
    provider.configuredVoice === value
  );
}

function assertFallbackRequestSupported(
  fallback: TextToSpeechProvider,
  request: TtsSynthesisRequest,
): void {
  assertTtsSpeedSupported(fallback, request);
  validateTtsTextControls(fallback, request);
  const model = request.model ?? fallback.configuredModel;
  const voice = request.voice ?? fallback.configuredVoice;
  if (
    fallback.languageWasExplicitlyConfigured === true &&
    fallback.configuredLanguage !== undefined &&
    fallback.supportsLanguage?.(fallback.configuredLanguage, model, voice) === false
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        `TTS failover fallback ${fallback.name} does not support configured language ${fallback.configuredLanguage} for the mapped selection`,
        { provider: fallback.name, metadata: { model, voice } },
      ),
    );
  }
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

  const models = providerValueCatalog(fallback, "model");
  if (
    model !== undefined &&
    models &&
    !models.includes(model) &&
    fallback.allowUnknownModel !== true
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerModelUnsupported,
        `TTS failover fallback ${fallback.name} does not support model ${model}`,
        { provider: fallback.name, metadata: { model } },
      ),
    );
  }

  if (
    voice === undefined ||
    (fallback.supportsVoice === undefined &&
      fallback.capabilities.voices === undefined &&
      fallback.configuredVoice === undefined)
  ) {
    return;
  }
  const supportsVoice = providerSupportsValue(fallback, "voice", voice, model);
  if (!supportsVoice) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerVoiceUnsupported,
        `TTS failover fallback ${fallback.name} does not support voice ${voice}`,
        { provider: fallback.name, metadata: { model, voice } },
      ),
    );
  }
}

function fallbackValidationError(
  error: unknown,
  primaryError: unknown,
  fallbackProvider: string,
  primaryProvider: string,
): TvicThrowableError {
  const fallbackError = TvicThrowableError.from(error).error;
  const primaryMetadata = summarizePrimaryFailure(primaryError, primaryProvider);
  if (fallbackError.category === "validation") {
    return new TvicThrowableError({
      ...fallbackError,
      ...(fallbackError.cause === undefined ? { cause: primaryError } : {}),
      metadata: { ...fallbackError.metadata, ...primaryMetadata },
    });
  }
  return TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `TTS failover fallback ${fallbackProvider} rejected the mapped request: ${fallbackError.message}`,
      {
        provider: fallbackProvider,
        ...(fallbackError.cause === undefined
          ? { cause: primaryError }
          : { cause: fallbackError.cause }),
        metadata: { fallbackErrorCode: fallbackError.code, ...primaryMetadata },
      },
    ),
  );
}

function withPrimaryErrorCause(
  error: unknown,
  primaryError: unknown,
  primaryProvider: string,
): TvicThrowableError {
  const fallbackError = TvicThrowableError.from(error).error;
  if (fallbackError.category === "cancelled") {
    return TvicThrowableError.from(error);
  }
  return new TvicThrowableError({
    ...fallbackError,
    ...(fallbackError.category !== "provider" && fallbackError.cause === undefined
      ? { cause: primaryError }
      : {}),
    metadata: {
      ...fallbackError.metadata,
      ...summarizePrimaryFailure(primaryError, primaryProvider),
    },
  });
}

function summarizePrimaryFailure(
  error: unknown,
  provider: string,
): Readonly<Record<string, unknown>> {
  const primaryError = TvicThrowableError.from(error).error;
  return {
    primaryProvider: primaryError.provider ?? provider,
    primaryCode: primaryError.code,
  };
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
