import { isDeepStrictEqual } from "node:util";

import {
  cancelledError,
  countUnicodeCodePoints,
  sameAudioFormat,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  type NormalizedError,
  type ProviderCapabilities,
  type TextToSpeechProvider,
  type TtsEvent,
  type TtsProviderSelection,
  type TtsStream,
  type TtsSynthesisRequest,
  type TtsUsageReporter,
} from "@tvic/core";
import {
  assertFallbackRequestSupported,
  assertMappedRequestMatchesVariant,
  canCheckProviderValue,
  intersectProviderCatalogs,
  normalizeFallbackRequestVariants,
  providerSupportsTtsVoiceOverride,
  providerSupportsValue,
  providerValueCatalog,
  resolveFallbackSelections,
  selectionFromRequest,
  supportsTtsFailoverSelection,
  type TtsFailoverRequestVariant,
} from "./tts-failover-selection.js";

export type { TtsFailoverRequestVariant } from "./tts-failover-selection.js";

export type TtsFailoverPhase = "synthesize" | "stream";

export interface TtsFailoverContext {
  readonly phase: TtsFailoverPhase;
  readonly primary: TextToSpeechProvider;
  readonly fallback: TextToSpeechProvider;
  readonly request: TtsSynthesisRequest;
  readonly fallbackRequest: TtsSynthesisRequest;
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

export function createTtsFailoverProvider(
  options: TtsFailoverProviderOptions,
): TextToSpeechProvider {
  assertTtsProvider(options.primary, "primary");
  assertTtsProvider(options.fallback, "fallback");
  assertCompatibleOutputFormats(options.primary, options.fallback);
  assertCompatibleLanguages(options.primary, options.fallback, options.languageMatch ?? "exact");

  const shouldFallback = options.shouldFallback ?? defaultShouldFallback;
  const hasRequestMapper = options.mapFallbackRequest !== undefined;
  const fallbackRequestVariants = normalizeFallbackRequestVariants(
    options.fallbackRequestVariants,
    hasRequestMapper,
  );
  const preservesRequestModel =
    !hasRequestMapper ||
    fallbackRequestVariants?.every((variant) => variant.fallback.model === undefined) === true;
  const allowUnknownModel = hasRequestMapper
    ? options.primary.allowUnknownModel === true
    : options.primary.allowUnknownModel === true && options.fallback.allowUnknownModel === true;
  const mapFallbackRequest = options.mapFallbackRequest ?? ((request) => request);

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
    if (!shouldFallback(error, request)) throw originalError;
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
    const fallbackSelections = resolveFallbackSelections(
      selectionFromRequest(effectivePrimaryRequest),
      fallbackRequestVariants,
      hasRequestMapper,
    );
    if (fallbackSelections.length === 0) {
      throw new TypeError(
        "TTS failover mapping requires a declared fallback request variant for this selection",
      );
    }
    const fallbackRequest = mapFallbackRequest(requestForMapping, error);
    assertMappedRequest(requestSnapshot, fallbackRequest);
    assertMappedRequestMatchesVariant(fallbackRequest, fallbackSelections, options.fallback);
    assertFallbackRequestSupported(options.fallback, fallbackRequest);
    if (request.signal?.aborted || fallbackCancellationSignal?.aborted) {
      throw requestCancelledError();
    }
    notifyFallback(options.onFallback, {
      phase,
      primary: options.primary,
      fallback: options.fallback,
      request,
      fallbackRequest,
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
    name: options.name ?? `tts-failover:${options.primary.name}->${options.fallback.name}`,
    kind: "tts",
    version: "0.1.0",
    usageAccounting: {
      reportsTextCharacters: true,
      ...(preservesRequestModel ? { usesRequestModelForUsage: true } : {}),
    },
    capabilities: failoverCapabilities(options.primary, options.fallback, hasRequestMapper),
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
    requiresTtsLanguageForModel: (model?: string) =>
      options.primary.requiresTtsLanguageForModel?.(model) === true ||
      resolveFallbackSelections(
        { ...(model !== undefined ? { model } : {}) },
        fallbackRequestVariants,
        hasRequestMapper,
      ).some(
        (selection) =>
          options.fallback.requiresTtsLanguageForModel?.(
            selection.model ?? options.fallback.configuredModel,
          ) === true &&
          selection.language === undefined &&
          options.fallback.configuredLanguage === undefined,
      ),
    requiresTtsVoiceForModel: (model?: string) =>
      options.primary.requiresTtsVoiceForModel?.(model) === true ||
      resolveFallbackSelections(
        { ...(model !== undefined ? { model } : {}) },
        fallbackRequestVariants,
        hasRequestMapper,
      ).some(
        (selection) =>
          options.fallback.requiresTtsVoiceForModel?.(
            selection.model ?? options.fallback.configuredModel,
          ) === true &&
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
    ...(canCheckProviderValue(options.primary, "voice") &&
    (hasRequestMapper || canCheckProviderValue(options.fallback, "voice"))
      ? {
          supportsVoice: (voice: string, model?: string) =>
            providerSupportsValue(options.primary, "voice", voice, model) &&
            (hasRequestMapper || providerSupportsValue(options.fallback, "voice", voice, model)),
        }
      : {}),
    supportsTtsVoiceOverride: (voice: string, model?: string, language?: string) => {
      if (!providerSupportsTtsVoiceOverride(options.primary, voice, model, language)) return false;
      const fallbackSelections = resolveFallbackSelections(
        {
          voice,
          ...(model !== undefined ? { model } : {}),
          ...(language !== undefined ? { language } : {}),
        },
        fallbackRequestVariants,
        hasRequestMapper,
      );
      return (
        fallbackSelections.length > 0 &&
        fallbackSelections.every((selection) => {
          const fallbackVoice = selection.voice ?? options.fallback.configuredVoice;
          if (fallbackVoice === undefined) return false;
          return providerSupportsTtsVoiceOverride(
            options.fallback,
            fallbackVoice,
            selection.model ?? options.fallback.configuredModel,
            selection.language,
          );
        })
      );
    },
    supportsTtsSelection: (selection: TtsProviderSelection) =>
      supportsTtsFailoverSelection(
        options.primary,
        options.fallback,
        selection,
        fallbackRequestVariants,
        hasRequestMapper,
      ),
    async synthesize(request): Promise<TtsStream> {
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
  const childUsageReporter: TtsUsageReporter | undefined = usageReporter
    ? {
        report: (observation) => usageReporter.report(observation),
        beginOperation: (input) => usageReporter.beginOperation(input),
        reportTextCharacters: () => undefined,
      }
    : undefined;
  const providerRequest = childUsageReporter
    ? { ...request, usageReporter: childUsageReporter }
    : request;
  const synthesis = Promise.resolve().then(() => {
    usageReporter?.reportTextCharacters(countUnicodeCodePoints(request.text));
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
  return {
    ...request,
    format: { ...request.format },
    ...(request.metadata !== undefined ? { metadata: snapshotMetadata(request.metadata) } : {}),
  };
}

function assertMappedRequest(original: TtsSynthesisRequest, mapped: TtsSynthesisRequest): void {
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
): ProviderCapabilities {
  const models = hasRequestMapper
    ? providerValueCatalog(primary, "model")
    : intersectProviderCatalogs(primary, fallback, "model");
  const languages = intersectProviderCatalogs(primary, fallback, "language");
  const voices = hasRequestMapper
    ? providerValueCatalog(primary, "voice")
    : intersectProviderCatalogs(primary, fallback, "voice");
  const {
    models: _primaryModels,
    languages: _primaryLanguages,
    voices: _primaryVoices,
    ...primaryCapabilities
  } = primary.capabilities;
  void _primaryModels;
  void _primaryLanguages;
  void _primaryVoices;
  const audio = failoverAudioCapabilities(primary, fallback);

  return {
    ...primaryCapabilities,
    ...(audio !== undefined ? { audio } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(languages !== undefined ? { languages } : {}),
    ...(voices !== undefined ? { voices } : {}),
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

function estimateTtsEventBytes(event: TtsEvent): number {
  try {
    return boundedJsonByteLength(event, MAX_FAILOVER_PRE_AUDIO_EVENT_BYTES);
  } catch {
    return MAX_FAILOVER_PRE_AUDIO_EVENT_BYTES + 1;
  }
}

function boundedJsonByteLength(value: unknown, maximum: number): number {
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= maximum;
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
  const encode = (current: unknown, depth: number, inArray: boolean): boolean => {
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
          valid = add(4);
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
        valid = encode(propertyValue, depth + 1, false);
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
