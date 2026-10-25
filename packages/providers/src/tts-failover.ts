import { isDeepStrictEqual } from "node:util";

import {
  cancelledError,
  countUnicodeCodePoints,
  createProviderTtsVoiceMappings,
  MAX_PROVIDER_TTS_VOICE_MAPPINGS,
  sameAudioFormat,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  validationError,
  type NormalizedError,
  type Provider,
  type ProviderCapabilityQuery,
  type ProviderCapabilities,
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

export function createTtsFailoverProvider(
  options: TtsFailoverProviderOptions,
): TextToSpeechProvider {
  assertTtsProvider(options.primary, "primary");
  assertTtsProvider(options.fallback, "fallback");
  assertCompatibleOutputFormats(options.primary, options.fallback);
  assertCompatibleLanguages(options.primary, options.fallback, options.languageMatch ?? "exact");

  const shouldFallback = options.shouldFallback ?? defaultShouldFallback;
  const fallbackVoiceMappings = normalizeFallbackVoiceMappings(
    options.fallbackVoiceMappings,
    options.primary,
    options.fallback,
  );
  const hasRequestMapper =
    options.mapFallbackRequest !== undefined || fallbackVoiceMappings !== undefined;
  const usesRequestModelForUsage =
    options.mapFallbackRequest === undefined &&
    fallbackMappingsPreserveRequestModel(
      fallbackVoiceMappings,
      options.primary.configuredModel,
      options.fallback.configuredModel,
    );
  if (
    options.mapFallbackRequest !== undefined &&
    options.fallback.capabilities.voiceSelection === "account_snapshot" &&
    fallbackVoiceMappings === undefined
  ) {
    throw new TypeError(
      "TTS failover with an account-backed fallback must declare fallback voice mappings",
    );
  }
  if (
    options.mapFallbackRequest !== undefined &&
    options.fallback.requiredCapabilityQueriesForModel !== undefined &&
    fallbackVoiceMappings === undefined
  ) {
    throw new TypeError(
      "TTS failover with model-scoped fallback requirements must declare fallback voice mappings",
    );
  }
  if (
    options.mapFallbackRequest !== undefined &&
    (options.fallback.requiredTtsVoiceCapabilities?.length ?? 0) > 0 &&
    fallbackVoiceMappings === undefined
  ) {
    throw new TypeError(
      "TTS failover with voice-scoped fallback requirements must declare fallback voice mappings",
    );
  }
  const allowUnknownModel = hasRequestMapper
    ? options.primary.allowUnknownModel === true
    : options.primary.allowUnknownModel === true && options.fallback.allowUnknownModel === true;
  const mapFallbackRequest = options.mapFallbackRequest ?? ((request) => request);
  const name = options.name ?? `tts-failover:${options.primary.name}->${options.fallback.name}`;
  const textControlsCanSurviveFallback =
    options.mapFallbackRequest === undefined &&
    !fallbackVoiceMappings?.some(
      (mapping) => mapping.model !== undefined && mapping.model !== mapping.requestedModel,
    );
  const capabilities = failoverCapabilities(
    options.primary,
    options.fallback,
    hasRequestMapper,
    fallbackVoiceMappings,
    textControlsCanSurviveFallback,
  );
  const requiredCapabilityQueries = mergeRequiredCapabilityQueries(
    options.primary.requiredCapabilityQueries,
    options.fallback.requiredCapabilityQueries,
  );
  const requiredTtsVoiceCapabilities = mergeRequiredTtsVoiceCapabilities(
    options.primary.name,
    options.primary.requiredTtsVoiceCapabilities,
    options.fallback.name,
    options.fallback.requiredTtsVoiceCapabilities,
  );
  const requiredCapabilityQueriesForModel = (model: string, voice?: string) => {
    const mapping = fallbackVoiceMappingForSelection(
      fallbackVoiceMappings,
      model,
      voice ?? options.primary.configuredVoice,
    );
    return mergeRequiredCapabilityQueries(
      requiredCapabilityQueriesForSelection(options.primary, model, voice),
      requiredCapabilityQueriesForSelection(
        options.fallback,
        mapping?.model ?? model,
        mapping?.voice ?? voice,
      ),
    );
  };
  const supportsConfiguredModelSelection = (model: string, voice?: string) => {
    const mapping = fallbackVoiceMappingForSelection(
      fallbackVoiceMappings,
      model,
      voice ?? options.primary.configuredVoice,
    );
    return (
      options.primary.supportsConfiguredModelSelection?.(model, voice) !== false &&
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
    if (!shouldFallback(error, snapshotTtsRequest(request))) throw originalError;
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
    const requestSnapshot = snapshotTtsRequest(effectivePrimaryRequest);
    const requestForMapping = snapshotTtsRequest(effectivePrimaryRequest);
    const selectionMapping = fallbackVoiceMappingForRequest(
      fallbackVoiceMappings,
      effectivePrimaryRequest,
    );
    if (fallbackVoiceMappings !== undefined && !selectionMapping) {
      throw new TypeError("TTS failover request has no declared fallback voice mapping");
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
    }
    const fallbackRequest = snapshotTtsRequest(mappedFallbackRequest);
    assertFallbackRequestSupported(options.fallback, fallbackRequest);
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
      ...(usesRequestModelForUsage ? { usesRequestModelForUsage: true } : {}),
    },
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
    ...(canCheckProviderValue(options.primary, "language") &&
    canCheckProviderValue(options.fallback, "language")
      ? {
          supportsLanguage: (language: string, model?: string) =>
            providerSupportsValue(options.primary, "language", language, model) &&
            providerSupportsValue(options.fallback, "language", language, model),
        }
      : {}),
    ...(canCheckProviderValue(options.primary, "voice") &&
    (hasRequestMapper || canCheckProviderValue(options.fallback, "voice"))
      ? {
          supportsVoice: (voice: string, model?: string) => {
            if (!providerSupportsValue(options.primary, "voice", voice, model)) return false;
            if (fallbackVoiceMappings === undefined) {
              return (
                hasRequestMapper || providerSupportsValue(options.fallback, "voice", voice, model)
              );
            }
            const mapping = fallbackVoiceMappings.find(
              (candidate) =>
                candidate.requestedModel === model && candidate.requestedVoice === voice,
            );
            if (!mapping) return fallbackVoiceMappings.length === 0;
            return providerSupportsValue(
              options.fallback,
              "voice",
              mapping.voice,
              mapping.model ?? model,
            );
          },
        }
      : {}),
    async synthesize(request): Promise<TtsStream> {
      request = validateTtsTextControls(requestValidator, request);
      let primaryStream: TtsStream;
      try {
        primaryStream = await synthesizeWithAbort(options.primary, request);
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
  primaryProvider: string,
  primary: readonly ProviderTtsVoiceCapabilityRequirement[] | undefined,
  fallbackProvider: string,
  fallback: readonly ProviderTtsVoiceCapabilityRequirement[] | undefined,
): readonly ProviderTtsVoiceCapabilityRequirement[] {
  const requirements = new Map<string, ProviderTtsVoiceCapabilityRequirement>();
  for (const [group, defaultProvider, defaultVoiceSource] of [
    [primary, primaryProvider, "requested"],
    [fallback, fallbackProvider, "mapped"],
  ] as const) {
    for (const requirement of group ?? []) {
      const scopedRequirement = {
        ...requirement,
        provider: requirement.provider ?? defaultProvider,
        voiceSource: requirement.voiceSource ?? defaultVoiceSource,
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
  const exactMatch = primaryLanguage.toLowerCase() === fallbackLanguage.toLowerCase();
  const baseLanguageMatch =
    languageMatch === "base-language" &&
    languageSubtag(primaryLanguage) === languageSubtag(fallbackLanguage);
  if (!exactMatch && !baseLanguageMatch) {
    throw new TypeError(
      `TTS failover providers must use compatible configured languages (${primary.name}: ${primaryLanguage} -> ${fallback.name}: ${fallbackLanguage})`,
    );
  }
}

function languageSubtag(language: string): string {
  return language.split("-", 1)[0]?.toLowerCase() ?? "";
}

function snapshotTtsRequest(request: TtsSynthesisRequest): TtsSynthesisRequest {
  const providerCapabilitySnapshots =
    request.providerCapabilitySnapshots === undefined
      ? undefined
      : snapshotProviderCapabilitySnapshots(request.providerCapabilitySnapshots);
  return {
    ...request,
    format: { ...request.format },
    ...(providerCapabilitySnapshots !== undefined ? { providerCapabilitySnapshots } : {}),
    ...(request.metadata !== undefined ? { metadata: snapshotMetadata(request.metadata) } : {}),
  };
}

function snapshotProviderCapabilitySnapshots(
  snapshots: NonNullable<TtsSynthesisRequest["providerCapabilitySnapshots"]>,
): NonNullable<TtsSynthesisRequest["providerCapabilitySnapshots"]> {
  try {
    return structuredClone(snapshots);
  } catch (error) {
    throw new TypeError("TTS failover capability snapshots must be structured-cloneable", {
      cause: error,
    });
  }
}

function assertMappedRequest(original: TtsSynthesisRequest, mapped: TtsSynthesisRequest): void {
  if (
    mapped.sessionId !== original.sessionId ||
    mapped.turnId !== original.turnId ||
    !sameAudioFormat(mapped.format, original.format) ||
    mapped.signal !== original.signal ||
    mapped.text !== original.text ||
    mapped.stream !== original.stream ||
    mapped.speed !== original.speed ||
    mapped.timestamps !== original.timestamps ||
    mapped.providerCapabilityEvaluationTimeMs !== original.providerCapabilityEvaluationTimeMs ||
    !isDeepStrictEqual(mapped.providerCapabilitySnapshots, original.providerCapabilitySnapshots) ||
    !isDeepStrictEqual(mapped.textControls, original.textControls) ||
    mapped.usageReporter !== original.usageReporter ||
    !isDeepStrictEqual(mapped.metadata, original.metadata)
  ) {
    throw new TypeError(
      "TTS failover request mapping may change only provider-specific fields such as model or voice",
    );
  }
}

function snapshotMetadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError("TTS failover metadata must be structured-cloneable", { cause: error });
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
  hasRequestMapper: boolean,
  fallbackVoiceMappings: readonly Omit<ProviderTtsVoiceMapping, "provider">[] | undefined,
  textControlsCanSurviveFallback: boolean,
): ProviderCapabilities {
  const models = hasRequestMapper
    ? providerValueCatalog(primary, "model")
    : intersectProviderCatalogs(primary, fallback, "model");
  const languages = intersectProviderCatalogs(primary, fallback, "language");
  const voices = hasRequestMapper
    ? providerValueCatalog(primary, "voice")
    : intersectProviderCatalogs(primary, fallback, "voice");
  const voiceSnapshotProviders = [primary, fallback]
    .flatMap((provider) =>
      provider.capabilities.voiceSelection === "account_snapshot"
        ? (provider.capabilities.voiceSnapshotProviders ?? [provider.name])
        : [],
    )
    .filter((providerName, index, values) => values.indexOf(providerName) === index);
  const modelSnapshotProviders = [
    ...(primary.capabilities.modelSnapshotProviders ?? []),
    ...(fallback.capabilities.modelSnapshotProviders ?? []),
  ].filter((providerName, index, values) => values.indexOf(providerName) === index);
  const ttsTextControls = textControlsCanSurviveFallback
    ? intersectTtsTextControlCapabilities(
        primary.capabilities.ttsTextControls,
        fallback.capabilities.ttsTextControls,
      )
    : undefined;
  const {
    models: _primaryModels,
    languages: _primaryLanguages,
    voices: _primaryVoices,
    ttsTextControls: _primaryTextControls,
    voiceSelection: _primaryVoiceSelection,
    voiceSnapshotProviders: _primaryVoiceSnapshotProviders,
    modelSnapshotProviders: _primaryModelSnapshotProviders,
    ...primaryCapabilities
  } = primary.capabilities;
  void _primaryModels;
  void _primaryLanguages;
  void _primaryVoices;
  void _primaryTextControls;
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
    ...(voiceSnapshotProviders.length > 0
      ? { voiceSelection: "account_snapshot" as const, voiceSnapshotProviders }
      : {}),
    ...(modelSnapshotProviders.length > 0 ? { modelSnapshotProviders } : {}),
    ...(hasRequestMapper
      ? {
          ttsVoiceMappings: Object.freeze(
            (fallbackVoiceMappings ?? []).map((mapping) =>
              Object.freeze({
                ...mapping,
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

function intersectTtsTextControlCapabilities(
  primary: ProviderCapabilities["ttsTextControls"],
  fallback: ProviderCapabilities["ttsTextControls"],
): ProviderCapabilities["ttsTextControls"] {
  if (primary === undefined || fallback === undefined) return undefined;
  const fallbackByModel = new Map(fallback.map((entry) => [entry.model, entry.controls]));
  return Object.freeze(
    primary.flatMap((entry) => {
      const fallbackControls = fallbackByModel.get(entry.model);
      if (fallbackControls === undefined) return [];
      const controls = entry.controls.filter((control) => fallbackControls.includes(control));
      return controls.length > 0
        ? [Object.freeze({ model: entry.model, controls: Object.freeze(controls) })]
        : [];
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
    mappings.map((mapping) => ({ ...mapping, provider: fallback.name })),
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
): boolean {
  if (kind === "voice" && provider.capabilities.voiceSelection === "account_snapshot") {
    return true;
  }
  if (kind === "language") {
    return (
      provider.supportsLanguage?.call(provider, value, model) ??
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

  const voice = request.voice ?? fallback.configuredVoice;
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
