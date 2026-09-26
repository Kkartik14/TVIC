import {
  sameAudioFormat,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  type NormalizedError,
  type ProviderCapabilities,
  type TextToSpeechProvider,
  type TtsEvent,
  type TtsStream,
  type TtsSynthesisRequest,
} from "@tvic/core";

/** The point at which the primary TTS provider became unavailable. */
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
  /** The provider used for the normal request path. */
  readonly primary: TextToSpeechProvider;
  /** The provider used only after the failover policy accepts the error. */
  readonly fallback: TextToSpeechProvider;
  /**
   * Maps the primary request to the fallback provider's model and voice. The
   * session, turn, signal, and output format must remain unchanged.
   */
  readonly mapFallbackRequest?: (
    request: TtsSynthesisRequest,
    error: NormalizedError,
  ) => TtsSynthesisRequest;
  /**
   * Defaults to operational provider/network/timeout failures. Validation,
   * authentication, protocol, identity, and cancellation errors do not fail
   * over because retrying them on another provider usually hides a bug.
   */
  readonly shouldFallback?: (error: NormalizedError, request: TtsSynthesisRequest) => boolean;
  /** Best-effort observability hook; observer failures never block fallback. */
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

/**
 * Builds an explicit TTS failover provider for host-owned routing.
 *
 * Failover is attempted when the primary request fails before a stream is
 * returned, or when its stream fails before any audio chunk is emitted. Once
 * audio has been delivered, the original failure is propagated instead of
 * replaying the whole response and risking duplicated speech.
 */
export function createTtsFailoverProvider(
  options: TtsFailoverProviderOptions,
): TextToSpeechProvider {
  assertTtsProvider(options.primary, "primary");
  assertTtsProvider(options.fallback, "fallback");
  assertCompatibleOutputFormats(options.primary, options.fallback);

  const shouldFallback = options.shouldFallback ?? defaultShouldFallback;
  const mapFallbackRequest = options.mapFallbackRequest ?? ((request) => request);

  const startFallback = async (
    originalError: unknown,
    request: TtsSynthesisRequest,
    phase: TtsFailoverPhase,
  ): Promise<TtsStream> => {
    const error = TvicThrowableError.from(originalError).error;
    if (request.signal?.aborted || !shouldFallback(error, request)) {
      throw originalError;
    }

    const fallbackRequest = mapFallbackRequest(request, error);
    assertMappedRequest(request, fallbackRequest);
    notifyFallback(options.onFallback, {
      phase,
      primary: options.primary,
      fallback: options.fallback,
      request,
      fallbackRequest,
      error,
    });
    return options.fallback.synthesize(fallbackRequest);
  };

  return {
    name: options.name ?? `tts-failover:${options.primary.name}->${options.fallback.name}`,
    kind: "tts",
    version: "0.1.0",
    capabilities: failoverCapabilities(options.primary, options.fallback),
    async synthesize(request): Promise<TtsStream> {
      let primaryStream: TtsStream;
      try {
        primaryStream = await options.primary.synthesize(request);
      } catch (error) {
        return startFallback(error, request, "synthesize");
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
  ) => Promise<TtsStream>,
): TtsStream {
  let activeStream = primaryStream;
  let activeIterator: AsyncIterator<TtsEvent> | undefined;
  let usingFallback = false;
  let sawAudio = false;
  let cancelled = false;
  let completed = false;
  let cancelPromise: Promise<void> | undefined;

  const events = (async function* (): AsyncIterable<TtsEvent> {
    try {
      activeIterator = activeStream.events[Symbol.asyncIterator]();
      while (!cancelled) {
        let step: IteratorResult<TtsEvent>;
        try {
          step = await activeIterator.next();
        } catch (error) {
          if (usingFallback || sawAudio || cancelled) throw error;

          await closeIterator(activeIterator);
          await activeStream.cancel().catch(() => undefined);
          const fallbackStream = await startFallback(error, request, "stream");
          if (cancelled) {
            await fallbackStream.cancel().catch(() => undefined);
            throw error;
          }
          usingFallback = true;
          activeStream = fallbackStream;
          activeIterator = activeStream.events[Symbol.asyncIterator]();
          continue;
        }

        if (step.done) {
          completed = true;
          return;
        }
        if (step.value.type === "media.audio.chunk") sawAudio = true;
        yield step.value;
      }
    } finally {
      if (!completed && !cancelled) {
        await activeStream.cancel().catch(() => undefined);
      }
      await closeIterator(activeIterator);
    }
  })();

  return {
    events,
    async cancel(): Promise<void> {
      if (!cancelPromise) {
        cancelPromise = (async () => {
          cancelled = true;
          await activeStream.cancel().catch(() => undefined);
          await closeIterator(activeIterator);
        })();
      }
      await cancelPromise;
    },
  };
}

async function closeIterator(iterator: AsyncIterator<TtsEvent> | undefined): Promise<void> {
  try {
    await iterator?.return?.();
  } catch {
    // The provider failure remains the authoritative error.
  }
}

function defaultShouldFallback(error: NormalizedError): boolean {
  if (NON_OPERATIONAL_PROVIDER_ERRORS.has(error.code)) return false;
  return (
    error.retriable ||
    error.category === "provider" ||
    error.category === "network" ||
    error.category === "timeout" ||
    error.category === "rate_limit"
  );
}

function notifyFallback(
  observer: TtsFailoverProviderOptions["onFallback"],
  context: TtsFailoverContext,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(context)).catch(() => undefined);
  } catch {
    // Fallback observability is deliberately non-blocking.
  }
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

function assertMappedRequest(original: TtsSynthesisRequest, mapped: TtsSynthesisRequest): void {
  if (
    mapped.sessionId !== original.sessionId ||
    mapped.turnId !== original.turnId ||
    !sameAudioFormat(mapped.format, original.format) ||
    mapped.signal !== original.signal
  ) {
    throw new TypeError(
      "TTS failover request mapping may change only provider-specific fields such as model or voice",
    );
  }
}

function failoverCapabilities(
  primary: TextToSpeechProvider,
  fallback: TextToSpeechProvider,
): ProviderCapabilities {
  return {
    ...primary.capabilities,
    metadata: {
      ...(primary.capabilities.metadata ?? {}),
      failover: {
        primary: primary.name,
        fallback: fallback.name,
      },
    },
  };
}
