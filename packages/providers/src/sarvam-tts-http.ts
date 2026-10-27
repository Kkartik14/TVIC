import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  cancelledError,
  counterIdGenerator,
  createMediaEvent,
  TvicThrowableError,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  MediaAudioCommittedEvent,
  MediaEventId,
  ProviderCapabilities,
  TextToSpeechProvider,
  TtsEvent,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";
import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  SystemProviderClock,
  normalizeProviderError,
  providerError,
  providerEventQueueOverflow,
  providerThrowableError,
  type ProviderClock,
} from "./common.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_MODELS,
  SarvamTtsSelectionProvider,
  isSarvamTtsLanguageSupported,
  sarvamTtsLanguageAliases,
} from "./sarvam-tts-model.js";
import { decodeSarvamTtsAudioWithFormat } from "./sarvam-tts-audio.js";
import {
  SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES,
  SarvamTtsHttpAudioChunker,
} from "./sarvam-tts-http-audio.js";
import {
  parseSarvamRestResponse,
  readBoundedResponseText,
  SARVAM_TTS_HTTP_RESPONSE_MAX_FRAGMENTS,
  SarvamTtsResponseTooComplexError,
  SarvamTtsResponseTooFragmentedError,
  SarvamTtsResponseTooLargeError,
  SarvamTtsRestResponseError,
  sarvamTtsHttpResponseError,
} from "./sarvam-tts-http-response.js";
import { SarvamWavStreamDecoder } from "./sarvam-tts-wav.js";
import { SarvamTtsCompletedStream } from "./sarvam-tts-http-completed.js";
import {
  assertSarvamTtsHttpTimeout,
  createSarvamTtsHttpDeadline,
} from "./sarvam-tts-http-deadline.js";
import {
  SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS,
  SARVAM_TTS_REST_MAX_TEXT_CHARS,
  resolveSarvamTtsHttpRequest,
  sarvamTtsHeaders,
  sarvamTtsHttpStreamUrl,
  sarvamTtsRestUrl,
  toSarvamTtsBody,
} from "./sarvam-tts-http-request.js";
import type { SarvamTtsHttpProviderOptions } from "./sarvam-tts-http-options.js";
export type { SarvamTtsHttpProviderOptions } from "./sarvam-tts-http-options.js";
export {
  SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS,
  SARVAM_TTS_REST_MAX_TEXT_CHARS,
} from "./sarvam-tts-http-request.js";

const SARVAM_TTS_REST_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const SARVAM_TTS_HTTP_CANCEL_TIMEOUT_MS = 1_000;
const SARVAM_TTS_HTTP_REQUEST_TIMEOUT_MS = 600_000;
const SARVAM_TTS_HTTP_RESPONSE_IDLE_TIMEOUT_MS = 30_000;

const SARVAM_TTS_REST_CAPABILITIES = {
  streaming: { input: false, output: false, native: false },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  languages: SARVAM_TTS_LANGUAGES,
  models: SARVAM_TTS_MODELS,
  timestamps: false,
  metadata: {
    transport: "rest",
    endpoint: "/text-to-speech",
    requestTextLimit: SARVAM_TTS_REST_MAX_TEXT_CHARS,
    wireOutputCodec: "wav",
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation: "https://docs.sarvam.ai/api-reference/text-to-speech/convert",
  },
} satisfies ProviderCapabilities;

const SARVAM_TTS_HTTP_STREAM_CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  languages: SARVAM_TTS_LANGUAGES,
  models: SARVAM_TTS_MODELS,
  timestamps: false,
  metadata: {
    transport: "http-stream",
    endpoint: "/text-to-speech/stream",
    requestTextLimit: SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS,
    wireOutputCodec: "wav",
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation: "https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream",
  },
} satisfies ProviderCapabilities;

export class SarvamTtsRestProvider
  extends SarvamTtsSelectionProvider<SarvamTtsHttpProviderOptions>
  implements TextToSpeechProvider
{
  readonly name = PROVIDER_NAMES.sarvamTts;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities: ProviderCapabilities;

  readonly #options: SarvamTtsHttpProviderOptions;
  readonly #modelId: string;
  readonly #language: string;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #responseIdleTimeoutMs: number;

  constructor(options: SarvamTtsHttpProviderOptions) {
    super(options);
    this.#options = this.providerOptions;
    this.#modelId = this.configuredModel;
    this.#language = this.configuredLanguage;
    this.capabilities = {
      ...SARVAM_TTS_REST_CAPABILITIES,
      languages: isSarvamTtsLanguageSupported(this.#language, this.#modelId)
        ? sarvamTtsLanguageAliases(this.#language)
        : [],
    };
    this.#clock = this.#options.clock ?? new SystemProviderClock();
    this.#fetch = this.#options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = assertSarvamTtsHttpTimeout(
      "requestTimeoutMs",
      this.#options.requestTimeoutMs ?? SARVAM_TTS_HTTP_REQUEST_TIMEOUT_MS,
    );
    this.#responseIdleTimeoutMs = assertSarvamTtsHttpTimeout(
      "responseIdleTimeoutMs",
      this.#options.responseIdleTimeoutMs ?? SARVAM_TTS_HTTP_RESPONSE_IDLE_TIMEOUT_MS,
    );
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    const resolved = resolveSarvamTtsHttpRequest(this.#options, this.#modelId, request, "rest");
    const controller = new AbortController();
    const detachAbort = linkAbortSignal(request.signal, controller);
    const deadline = createSarvamTtsHttpDeadline(
      controller,
      this.#requestTimeoutMs,
      this.#responseIdleTimeoutMs,
    );
    let responseStatusError: TvicThrowableError | undefined;
    try {
      const response = await this.#fetch(sarvamTtsRestUrl(this.#options), {
        method: "POST",
        headers: sarvamTtsHeaders(this.#options.apiKey),
        body: JSON.stringify(toSarvamTtsBody(request.text, resolved)),
        signal: controller.signal,
      });
      deadline.onResponseProgress();
      if (!response.ok) {
        responseStatusError = await sarvamTtsHttpResponseError(
          response,
          controller.signal,
          deadline.onResponseProgress,
          request.signal,
        );
        throw responseStatusError;
      }
      const body = await readBoundedResponseText(
        response,
        SARVAM_TTS_REST_RESPONSE_MAX_BYTES,
        controller.signal,
        deadline.onResponseProgress,
      );
      const parsed = parseSarvamRestResponse(body);
      let decoded: ReturnType<typeof decodeSarvamTtsAudioWithFormat>;
      try {
        decoded = decodeSarvamTtsAudioWithFormat(parsed.audio, MAX_PROVIDER_TTS_OUTPUT_BYTES, true);
      } catch {
        throw sarvamTtsProtocolError("Sarvam REST returned malformed WAV audio");
      }
      return new SarvamTtsCompletedStream(request, {
        clock: this.#clock,
        model: resolved.model,
        language: resolved.language,
        voice: resolved.voice,
        transport: "rest",
        wireFormat: decoded.wireFormat,
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
        audio: decoded.bytes,
      });
    } catch (error) {
      if (request.signal?.aborted) {
        throw sarvamTtsHttpTransportError(error, request.signal, controller.signal);
      }
      if (responseStatusError !== undefined && responseStatusError === error) {
        throw responseStatusError;
      }
      if (controller.signal.aborted) {
        throw sarvamTtsHttpTransportError(error, request.signal, controller.signal);
      }
      throw markResponseFailureOutcomeUnknown(normalizeSarvamTtsHttpError(error));
    } finally {
      deadline.dispose();
      detachAbort();
    }
  }
}

export class SarvamTtsHttpStreamProvider
  extends SarvamTtsSelectionProvider<SarvamTtsHttpProviderOptions>
  implements TextToSpeechProvider
{
  readonly name = PROVIDER_NAMES.sarvamTts;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities: ProviderCapabilities;

  readonly #options: SarvamTtsHttpProviderOptions;
  readonly #modelId: string;
  readonly #language: string;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #responseIdleTimeoutMs: number;

  constructor(options: SarvamTtsHttpProviderOptions) {
    super(options);
    this.#options = this.providerOptions;
    this.#modelId = this.configuredModel;
    this.#language = this.configuredLanguage;
    this.capabilities = {
      ...SARVAM_TTS_HTTP_STREAM_CAPABILITIES,
      languages: isSarvamTtsLanguageSupported(this.#language, this.#modelId)
        ? sarvamTtsLanguageAliases(this.#language)
        : [],
    };
    this.#clock = this.#options.clock ?? new SystemProviderClock();
    this.#fetch = this.#options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = assertSarvamTtsHttpTimeout(
      "requestTimeoutMs",
      this.#options.requestTimeoutMs ?? SARVAM_TTS_HTTP_REQUEST_TIMEOUT_MS,
    );
    this.#responseIdleTimeoutMs = assertSarvamTtsHttpTimeout(
      "responseIdleTimeoutMs",
      this.#options.responseIdleTimeoutMs ?? SARVAM_TTS_HTTP_RESPONSE_IDLE_TIMEOUT_MS,
    );
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    const resolved = resolveSarvamTtsHttpRequest(
      this.#options,
      this.#modelId,
      request,
      "http-stream",
    );
    const controller = new AbortController();
    const detachAbort = linkAbortSignal(request.signal, controller);
    const deadline = createSarvamTtsHttpDeadline(
      controller,
      this.#requestTimeoutMs,
      this.#responseIdleTimeoutMs,
    );
    let responseStatusError: TvicThrowableError | undefined;
    try {
      const response = await this.#fetch(sarvamTtsHttpStreamUrl(this.#options), {
        method: "POST",
        headers: {
          ...sarvamTtsHeaders(this.#options.apiKey),
          Accept: "audio/wav",
        },
        body: JSON.stringify(toSarvamTtsBody(request.text, resolved)),
        signal: controller.signal,
      });
      deadline.onResponseProgress();
      if (controller.signal.aborted) {
        throw new DOMException("Sarvam TTS request was aborted", "AbortError");
      }
      if (!response.ok) {
        responseStatusError = await sarvamTtsHttpResponseError(
          response,
          controller.signal,
          deadline.onResponseProgress,
          request.signal,
        );
        throw responseStatusError;
      }
      if (!response.body) {
        throw sarvamTtsProtocolError("Sarvam HTTP stream returned no response body");
      }
      const stream = new SarvamTtsHttpStream(response.body, request, {
        clock: this.#clock,
        model: resolved.model,
        language: resolved.language,
        voice: resolved.voice,
        transport: "http-stream",
        wireFormat: "wav",
        controller,
        detachAbort,
        onResponseProgress: deadline.onResponseProgress,
        clearDeadline: deadline.dispose,
        getTimeoutError: deadline.timeoutError,
      });
      stream.start();
      return stream;
    } catch (error) {
      if (request.signal?.aborted) {
        const normalized = sarvamTtsHttpTransportError(error, request.signal, controller.signal);
        deadline.dispose();
        detachAbort();
        if (!controller.signal.aborted) controller.abort(normalized);
        throw normalized;
      }
      if (responseStatusError !== undefined && responseStatusError === error) {
        deadline.dispose();
        detachAbort();
        if (!controller.signal.aborted) controller.abort(responseStatusError);
        throw responseStatusError;
      }
      const normalized = controller.signal.aborted
        ? sarvamTtsHttpTransportError(error, request.signal, controller.signal)
        : markResponseFailureOutcomeUnknown(normalizeSarvamTtsHttpError(error));
      deadline.dispose();
      detachAbort();
      if (!controller.signal.aborted) controller.abort(normalized);
      throw normalized;
    }
  }
}

export class SarvamTtsHttpStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #events = new AsyncQueue<TtsEvent>({
    maxBuffered:
      Math.ceil(MAX_PROVIDER_TTS_OUTPUT_BYTES / SARVAM_TTS_HTTP_AUDIO_EVENT_CHUNK_BYTES) + 1,
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
      this.#fail(error);
      return error;
    },
  });
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #request: TtsSynthesisRequest;
  readonly #options: SarvamTtsHttpStreamOptions;
  readonly #mediaEventIds: CounterIdGenerator<MediaEventId>;
  readonly #decoder = new SarvamWavStreamDecoder();
  readonly #audioChunker = new SarvamTtsHttpAudioChunker();
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  #mediaSequence = 1;
  #closed = false;
  #cancelled = false;
  #cancelPromise: Promise<void> | undefined;
  #readerCancelPromise: Promise<void> | undefined;
  #readerReleased = false;
  #outputBytes = 0;
  #outputChunks = 0;
  #frameCount = 0;
  #responseFragments = 0;
  readonly #onControllerAbort = (): void => {
    const timeoutError = this.#options.getTimeoutError?.();
    if (timeoutError && this.#options.controller.signal.reason === timeoutError) {
      this.#fail(timeoutError);
    } else {
      void this.cancel();
    }
  };

  constructor(
    body: ReadableStream<Uint8Array>,
    request: TtsSynthesisRequest,
    options: SarvamTtsHttpStreamOptions,
  ) {
    this.#reader = body.getReader();
    this.#request = request;
    this.#options = options;
    this.#mediaEventIds = counterIdGenerator<MediaEventId>(
      `sarvam_tts_http_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    this.events = this.#events;
  }

  start(): void {
    const { signal } = this.#options.controller;
    if (signal.aborted) {
      const timeoutError = this.#options.getTimeoutError?.();
      if (timeoutError && signal.reason === timeoutError) this.#fail(timeoutError);
      else void this.cancel();
      return;
    }
    signal.addEventListener("abort", this.#onControllerAbort, { once: true });
    void this.#pump();
  }

  cancel(): Promise<void> {
    if (this.#cancelPromise) return this.#cancelPromise;
    if (this.#closed) return Promise.resolve();
    this.#cancelled = true;
    this.#removeControllerAbortListener();
    if (!this.#options.controller.signal.aborted) this.#options.controller.abort();
    this.#cancelPromise = this.#cancelReader().then(() => this.#close());
    return this.#cancelPromise;
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#closed) {
        const result = await this.#reader.read();
        this.#options.onResponseProgress?.();
        if (this.#closeIfCancelled()) return;
        if (result.done) break;
        this.#responseFragments += 1;
        if (this.#responseFragments > SARVAM_TTS_HTTP_RESPONSE_MAX_FRAGMENTS) {
          this.#fail(sarvamTtsProtocolError("Sarvam HTTP stream exceeded the fragment limit"));
          return;
        }
        let decodedAudio: readonly Uint8Array[];
        try {
          decodedAudio = this.#decoder.push(result.value);
        } catch (error) {
          this.#fail(sarvamTtsProtocolError(errorMessage(error)));
          return;
        }
        for (const audio of decodedAudio) {
          if (this.#closeIfCancelled()) return;
          this.#pushAudio(audio);
        }
        if (this.#decoder.isComplete) {
          void this.#cancelReader();
          break;
        }
      }
      if (this.#closeIfCancelled()) return;
      try {
        this.#decoder.finish();
      } catch (error) {
        this.#fail(sarvamTtsProtocolError(errorMessage(error)));
        return;
      }
      if (this.#closeIfCancelled()) return;
      this.#flushAudio();
      if (this.#closeIfCancelled()) return;
      this.#pushCommittedEvent();
      this.#close();
    } catch (error) {
      if (this.#cancelled || this.#options.controller.signal.aborted) {
        this.#close();
        return;
      }
      this.#fail(error);
    } finally {
      if (this.#closed) this.#releaseReaderLock();
    }
  }

  #closeIfCancelled(): boolean {
    if (this.#closed) return true;
    if (this.#cancelled || this.#options.controller.signal.aborted) {
      this.#close();
      return true;
    }
    return false;
  }

  #cancelReader(): Promise<void> {
    if (this.#readerCancelPromise) return this.#readerCancelPromise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellation: Promise<void>;
    try {
      cancellation = Promise.resolve(this.#reader.cancel()).catch(() => undefined);
    } catch {
      cancellation = Promise.resolve();
    }
    this.#readerCancelPromise = Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SARVAM_TTS_HTTP_CANCEL_TIMEOUT_MS);
      }),
    ]).then(() => {
      if (timer) clearTimeout(timer);
      this.#releaseReaderLock();
    });
    return this.#readerCancelPromise;
  }

  #removeControllerAbortListener(): void {
    this.#options.controller.signal.removeEventListener("abort", this.#onControllerAbort);
  }

  #releaseReaderLock(): void {
    if (this.#readerReleased) return;
    try {
      this.#reader.releaseLock();
      this.#readerReleased = true;
    } catch {
      return;
    }
  }

  #pushAudio(bytes: Uint8Array): void {
    for (const chunk of this.#audioChunker.push(bytes)) {
      this.#emitAudioChunk(chunk);
      if (this.#closed) return;
    }
  }

  #flushAudio(): void {
    for (const chunk of this.#audioChunker.finish()) this.#emitAudioChunk(chunk);
  }

  #emitAudioChunk(bytes: Uint8Array): void {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength % 2 !== 0 ||
      this.#outputChunks >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
      this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      throw providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
    }

    const eventId = this.#mediaEventId("chunk");
    const frames = frameCountForPcm16le(bytes);
    const event = createMediaEvent({
      id: eventId,
      type: "media.audio.chunk",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.sarvamTts,
      audio: {
        format: this.#request.format,
        durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
        frameCount: frames,
        bytes,
      },
      metadata: {
        sarvam: {
          transport: this.#options.transport,
          wireFormat: this.#options.wireFormat,
          model: this.#options.model,
          language: this.#options.language,
          voice: this.#options.voice,
        },
      },
    });
    if (!this.#pushEvent(event)) return;
    this.#chunkIds.push(eventId);
    this.#chunkSequences.push(this.#mediaSequence);
    this.#mediaSequence += 1;
    this.#frameCount += frames;
    this.#outputBytes += bytes.byteLength;
    this.#outputChunks += 1;
  }

  #pushCommittedEvent(): void {
    const committed: MediaAudioCommittedEvent = createMediaEvent({
      id: this.#mediaEventId("committed"),
      type: "media.audio.committed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.sarvamTts,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1_000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: [...this.#chunkIds],
      metadata: {
        sarvam: {
          transport: this.#options.transport,
          wireFormat: this.#options.wireFormat,
          model: this.#options.model,
          language: this.#options.language,
          voice: this.#options.voice,
        },
      },
    });
    if (this.#pushEvent(committed)) this.#mediaSequence += 1;
  }

  #mediaEventId(kind: string): MediaEventId {
    return `${this.#mediaEventIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts));
    return false;
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeControllerAbortListener();
    this.#options.clearDeadline?.();
    this.#options.detachAbort();
    this.#releaseReaderLock();
    this.#events.close();
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const throwable = markSarvamTtsHttpOutcomeUnknown(
      providerThrowableError(error, {
        code: PROVIDER_ERROR_CODES.sarvamTts,
        provider: PROVIDER_NAMES.sarvamTts,
      }),
    );
    this.#closed = true;
    this.#removeControllerAbortListener();
    this.#options.clearDeadline?.();
    this.#options.detachAbort();
    this.#options.controller.abort(throwable);
    void this.#cancelReader();
    this.#releaseReaderLock();
    this.#events.fail(throwable);
  }
}

interface SarvamTtsHttpStreamOptions {
  readonly clock: ProviderClock;
  readonly model: string;
  readonly language: string;
  readonly voice: string;
  readonly transport: "http-stream";
  readonly wireFormat: "wav";
  readonly controller: AbortController;
  readonly detachAbort: () => void;
  readonly onResponseProgress?: () => void;
  readonly clearDeadline?: () => void;
  readonly getTimeoutError?: () => TvicThrowableError | undefined;
}

function sarvamTtsHttpTransportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  controllerSignal: AbortSignal,
): TvicThrowableError {
  if (callerSignal?.aborted) {
    return TvicThrowableError.from(
      cancelledError("provider.connection_cancelled", "Sarvam TTS request was cancelled", {
        provider: PROVIDER_NAMES.sarvamTts,
      }),
    );
  }
  if (controllerSignal.aborted && controllerSignal.reason instanceof TvicThrowableError) {
    return controllerSignal.reason;
  }
  return markSarvamTtsHttpOutcomeUnknown(
    normalizeProviderError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    }),
  );
}

function markResponseFailureOutcomeUnknown(error: TvicThrowableError): TvicThrowableError {
  return typeof error.metadata?.httpStatus === "number"
    ? error
    : markSarvamTtsHttpOutcomeUnknown(error);
}

function markSarvamTtsHttpOutcomeUnknown(error: unknown): TvicThrowableError {
  const normalized = TvicThrowableError.from(error).error;
  if (normalized.metadata?.outcomeUnknown === true && normalized.retriable === false) {
    return TvicThrowableError.from(normalized);
  }
  return TvicThrowableError.from({
    ...normalized,
    retriable: false,
    metadata: { ...(normalized.metadata ?? {}), outcomeUnknown: true },
  });
}

function normalizeSarvamTtsHttpError(error: unknown): TvicThrowableError {
  if (error instanceof TvicThrowableError) return error;
  if (
    error instanceof SarvamTtsResponseTooLargeError ||
    error instanceof SarvamTtsResponseTooFragmentedError ||
    error instanceof SarvamTtsResponseTooComplexError ||
    error instanceof SarvamTtsRestResponseError
  ) {
    return sarvamTtsProtocolError(error.message);
  }
  return TvicThrowableError.from(
    normalizeProviderError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    }),
  );
}

function sarvamTtsProtocolError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(TVIC_ERROR_CODES.providerProtocolInvalid, message, {
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function createSarvamTtsRestProvider(
  options: SarvamTtsHttpProviderOptions,
): SarvamTtsRestProvider {
  return new SarvamTtsRestProvider(options);
}

export function createSarvamTtsHttpStreamProvider(
  options: SarvamTtsHttpProviderOptions,
): SarvamTtsHttpStreamProvider {
  return new SarvamTtsHttpStreamProvider(options);
}
