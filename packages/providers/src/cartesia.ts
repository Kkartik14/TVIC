import WebSocket from "ws";

import {
  AsyncQueue,
  assertPcm16leFormat,
  durationMsForPcm16le,
  frameCountForPcm16le,
} from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  validationError,
  unknownErrorMessage,
  TvicThrowableError,
  createMediaEvent,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  AudioFormat,
  IncrementalTextToSpeechProvider,
  MediaAudioCommittedEvent,
  MediaEventId,
  ProviderCapabilities,
  TtsEvent,
  TtsFlushResult,
  TtsSession,
  TtsSessionOpenRequest,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  providerEventQueueOverflow,
  providerThrowableError,
  providerError,
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  MAX_PROVIDER_TTS_PENDING_FLUSHES,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  assertSupportedModel,
  type ProviderClock,
} from "./common.js";
import { classifiedProviderError } from "./provider-error-classifier.js";
import {
  assertCartesiaOptions,
  assertCartesiaSpeed,
  cartesiaGenerationConfig,
  type CartesiaGenerationConfig,
} from "./cartesia-options.js";

export type { CartesiaGenerationConfig } from "./cartesia-options.js";

export const MAX_CARTESIA_INPUT_UTF16_CODE_UNITS = 1_048_576;
export const MAX_CARTESIA_INPUT_UTF8_BYTES = 4_194_304;

const CARTESIA_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  // Cartesia's cancel frame prevents queued generation but documented in-flight
  // output continues, so this is request cancellation rather than output cancellation.
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.cartesia.models,
} satisfies ProviderCapabilities;

export interface CartesiaTtsProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId: string;
  readonly modelId?: string;
  /** Allows an explicitly configured compatible endpoint/model outside the dated catalog. */
  readonly allowUnknownModel?: boolean;
  readonly language?: string;
  /** Cartesia locale is mutually exclusive with language. */
  readonly locale?: string;
  readonly accent?: string;
  readonly normalization?: string;
  readonly generationConfig?: CartesiaGenerationConfig;
  readonly pronunciationDictId?: string;
  /** Cartesia server-side continuation buffering; 0 keeps latency under TVIC control. */
  readonly maxBufferDelayMs?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

type CartesiaMessage = Readonly<Record<string, unknown>> & {
  readonly type?: string;
  readonly data?: string;
  readonly done?: boolean;
  readonly context_id?: string;
  readonly message?: string;
  readonly title?: string;
  readonly error_code?: string;
  readonly status_code?: unknown;
  readonly flush_id?: number;
  readonly word_timestamps?: CartesiaAlignment;
  readonly phoneme_timestamps?: CartesiaAlignment;
};

interface CartesiaAlignment {
  readonly words?: readonly unknown[];
  readonly phonemes?: readonly unknown[];
  readonly start?: readonly unknown[];
  readonly end?: readonly unknown[];
}

export class CartesiaTtsProvider implements IncrementalTextToSpeechProvider {
  readonly name = PROVIDER_NAMES.cartesia;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = CARTESIA_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #voiceId: string;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #language: string;
  readonly #locale: string | undefined;
  readonly #accent: string | undefined;
  readonly #normalization: string | undefined;
  readonly #generationConfig: CartesiaGenerationConfig | undefined;
  readonly #pronunciationDictId: string | undefined;
  readonly #maxBufferDelayMs: number;
  readonly #clock: ProviderClock;
  readonly #contextIds = counterIdGenerator<string>("cartesia_context");
  readonly #webSocketFactory: NonNullable<CartesiaTtsProviderOptions["webSocketFactory"]>;

  constructor(options: CartesiaTtsProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url =
      options.url ??
      `wss://api.cartesia.ai/tts/websocket?cartesia_version=${PROVIDER_API_VERSIONS.cartesia}`;
    this.#voiceId = options.voiceId;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.cartesia.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    if (options.language !== undefined && options.locale !== undefined) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          "Cartesia accepts either language or locale, not both",
          { provider: PROVIDER_NAMES.cartesia },
        ),
      );
    }
    this.#language =
      options.locale !== undefined ? "" : (options.language ?? ADAPTER_DEFAULTS.cartesia.language);
    this.#locale = options.locale;
    this.#accent = options.accent;
    this.#normalization = options.normalization;
    this.#generationConfig = options.generationConfig;
    this.#pronunciationDictId = options.pronunciationDictId;
    this.#maxBufferDelayMs = options.maxBufferDelayMs ?? 0;
    assertCartesiaOptions(this.#generationConfig, this.#maxBufferDelayMs);
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
          maxPayload: MAX_PROVIDER_FRAME_BYTES,
        }));
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertCartesiaFormat(request.format);
    assertCartesiaSpeed(request.speed);
    assertSupportedModel(
      PROVIDER_NAMES.cartesia,
      PROVIDER_CATALOG.cartesia.models,
      request.model ?? this.#modelId,
      this.#allowUnknownModel,
    );
    const socket = await this.#connect(request.signal);
    return this.#createStream(socket, request);
  }

  async openSession(request: TtsSessionOpenRequest): Promise<TtsSession> {
    assertCartesiaFormat(request.format);
    assertCartesiaSpeed(request.speed);
    assertSupportedModel(
      PROVIDER_NAMES.cartesia,
      PROVIDER_CATALOG.cartesia.models,
      request.model ?? this.#modelId,
      this.#allowUnknownModel,
    );
    const socket = await this.#connect(request.signal);
    return this.#createStream(socket, request);
  }

  async #connect(signal?: AbortSignal): Promise<WebSocket> {
    let socket: WebSocket | undefined;
    try {
      socket = this.#webSocketFactory(this.#url, {
        "X-API-Key": this.#apiKey,
        "Cartesia-Version": PROVIDER_API_VERSIONS.cartesia,
      });
      await openWebSocket(socket, signal ? { signal } : {});
      return socket;
    } catch (error) {
      if (socket) safeClose(socket);
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.cartesiaTts,
          provider: PROVIDER_NAMES.cartesia,
        }),
      );
    }
  }

  #streamOptions(request: TtsSessionOpenRequest): CartesiaStreamOptions {
    return {
      voiceId: request.voice ?? this.#voiceId,
      modelId: request.model ?? this.#modelId,
      language: this.#language,
      ...(this.#locale !== undefined ? { locale: this.#locale } : {}),
      ...(this.#accent !== undefined ? { accent: this.#accent } : {}),
      ...(this.#normalization !== undefined ? { normalization: this.#normalization } : {}),
      ...(this.#generationConfig !== undefined ? { generationConfig: this.#generationConfig } : {}),
      ...(this.#pronunciationDictId !== undefined
        ? { pronunciationDictId: this.#pronunciationDictId }
        : {}),
      maxBufferDelayMs: this.#maxBufferDelayMs,
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      clock: this.#clock,
      timestamps: request.timestamps ?? false,
      contextId: `${this.#contextIds.next()}_${safeContextComponent(this.#clock.now())}`,
    };
  }

  #createStream(
    socket: WebSocket,
    request: TtsSessionOpenRequest | TtsSynthesisRequest,
  ): CartesiaTtsStream {
    try {
      return new CartesiaTtsStream(socket, request, this.#streamOptions(request));
    } catch (error) {
      safeClose(socket);
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.cartesiaTts,
          provider: PROVIDER_NAMES.cartesia,
        }),
      );
    }
  }
}

function assertCartesiaFormat(format: AudioFormat): void {
  try {
    assertPcm16leFormat(format);
    if (format.sampleRateHz !== PCM16_16K_MONO.sampleRateHz) {
      throw new Error(
        `Cartesia adapter output requires ${PCM16_16K_MONO.sampleRateHz}Hz audio, received ${format.sampleRateHz}Hz`,
      );
    }
  } catch (error) {
    throw TvicThrowableError.from(
      validationError("cartesia.audio_format_invalid", unknownErrorMessage(error), {
        provider: PROVIDER_NAMES.cartesia,
        metadata: { format },
      }),
    );
  }
}

function safeContextComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

interface CartesiaStreamOptions {
  readonly voiceId: string;
  readonly modelId: string;
  readonly language: string;
  readonly locale?: string;
  readonly accent?: string;
  readonly normalization?: string;
  readonly generationConfig?: CartesiaGenerationConfig;
  readonly pronunciationDictId?: string;
  readonly maxBufferDelayMs?: number;
  readonly speed?: number;
  readonly clock: ProviderClock;
  readonly timestamps: boolean;
  readonly contextId: string;
}

interface FlushWaiter {
  readonly id: number;
  readonly resolve: (result: TtsFlushResult) => void;
  readonly reject: (error: unknown) => void;
}

export class CartesiaTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: CartesiaStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.cartesia);
      this.#fail(error);
      return error;
    },
  });
  readonly #contextId: string;
  readonly #mediaEventIds: CounterIdGenerator<MediaEventId>;
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  readonly #flushWaiters: FlushWaiter[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  // Cartesia deployments have returned both zero- and one-based flush ledgers.
  // Negotiate the base from the first acknowledgement, then require a strict
  // monotonic sequence so skipped or replayed acknowledgements still fail closed.
  #nextFlushId = 0;
  #expectedFlushId = 0;
  #providerFlushBase: number | undefined;
  #frameCount = 0;
  #outputBytes = 0;
  #inputUtf16CodeUnits = 0;
  #inputUtf8Bytes = 0;
  #closed = false;
  #done = false;
  #cancelled = false;
  #finishing = false;

  constructor(
    socket: WebSocket,
    request: TtsSessionOpenRequest | TtsSynthesisRequest,
    options: CartesiaStreamOptions,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#options = options;
    this.#contextId = options.contextId;
    this.#mediaEventIds = counterIdGenerator<MediaEventId>(`${this.#contextId}_media`);
    this.events = this.#events;

    socket.on("message", (data) => {
      if (this.#closed) {
        return;
      }
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(this.#lifecycleError("Cartesia frame exceeded the size limit"));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("close", () => {
      if (this.#closed) {
        return;
      }
      if (this.#done || this.#cancelled) {
        this.#closeQueue();
        return;
      }
      this.#fail(this.#lifecycleError("Cartesia socket closed before generation completed"));
    });
    socket.on("error", (error) =>
      this.#fail(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.cartesiaTts,
          provider: PROVIDER_NAMES.cartesia,
        }),
      ),
    );

    if ("text" in request) {
      this.#sendTranscript(request.text, this.#generationRequest(request.text, false));
      this.#finishing = true;
    }
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    if (text.length === 0) {
      return;
    }
    this.#sendTranscript(text, this.#generationRequest(text, true));
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    if (this.#flushWaiters.length >= MAX_PROVIDER_TTS_PENDING_FLUSHES) {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.cartesia);
      this.#fail(error);
      return Promise.reject(error);
    }
    return new Promise<TtsFlushResult>((resolve, reject) => {
      const waiter = { id: this.#nextFlushId, resolve, reject };
      this.#nextFlushId += 1;
      this.#flushWaiters.push(waiter);
      try {
        this.#send(this.#generationRequest("", true, true));
      } catch (error) {
        const index = this.#flushWaiters.indexOf(waiter);
        if (index >= 0) {
          this.#flushWaiters.splice(index, 1);
        }
        reject(error);
      }
    });
  }

  async finish(): Promise<void> {
    if (this.#finishing || this.#closed) {
      return;
    }
    this.#assertWritable();
    this.#finishing = true;
    this.#send(this.#generationRequest("", false));
  }

  async cancel(): Promise<void> {
    if (this.#closed) {
      return;
    }
    // Best-effort cancel frame; the audio queue is closed regardless so playout
    // teardown never wedges on a half-closed socket.
    this.#cancelled = true;
    safeSend(this.#socket, JSON.stringify({ context_id: this.#contextId, cancel: true }));
    this.#closeQueue(this.#lifecycleError("Cartesia synthesis context was cancelled"));
    safeClose(this.#socket);
  }

  #handleMessage(body: string): void {
    const message = parseJsonObject(body) as CartesiaMessage | null;
    if (!message) {
      this.#fail(this.#lifecycleError("Cartesia returned malformed JSON"));
      return;
    }

    // Cartesia rate-limit and other provider error frames may also carry
    // `done: true`. Classify the provider error before interpreting the done
    // marker, otherwise a rejected generation is published as an empty
    // successful completion.
    if (message.type === "error") {
      this.#fail(cartesiaProviderError(message));
      return;
    }

    const hasContextualResponse =
      message.type === "chunk" ||
      message.type === "flush_done" ||
      message.type === "timestamps" ||
      message.type === "phoneme_timestamps" ||
      message.type === "done" ||
      message.done === true;
    if (hasContextualResponse && message.context_id !== this.#contextId) {
      this.#fail(this.#lifecycleError("Cartesia response context does not match the stream"));
      return;
    }

    if (message.type === "chunk") {
      if (typeof message.data !== "string") {
        this.#fail(this.#lifecycleError("Cartesia returned a chunk without audio data"));
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = decodeCartesiaAudio(message.data);
      } catch {
        this.#fail(this.#lifecycleError("Cartesia returned malformed PCM audio"));
        return;
      }
      if (
        this.#chunkIds.length >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
        this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
      ) {
        this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.cartesia));
        return;
      }
      const eventId = this.#mediaEventId("chunk");
      const frames = frameCountForPcm16le(bytes);
      const sequence = this.#mediaSequence;
      const event = createMediaEvent({
        id: eventId,
        type: "media.audio.chunk",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence,
        direction: "output",
        timestamp: this.#options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.cartesia,
        audio: {
          format: this.#request.format,
          durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
          frameCount: frames,
          bytes,
        },
        metadata: {
          contextId: message.context_id,
          ...(typeof message.flush_id === "number" ? { flushId: message.flush_id } : {}),
        },
      });
      if (!this.#pushEvent(event)) return;
      this.#frameCount += frames;
      this.#outputBytes += bytes.byteLength;
      this.#chunkIds.push(eventId);
      this.#chunkSequences.push(sequence);
      this.#mediaSequence += 1;
      return;
    }

    if (message.type === "flush_done") {
      if (!isValidFlushId(message.flush_id)) {
        this.#fail(this.#lifecycleError("Cartesia returned an invalid flush acknowledgement"));
        return;
      }
      const flushId = message.flush_id;
      const waiter = this.#flushWaiters[0];
      if (this.#providerFlushBase === undefined) {
        if (flushId !== 0 && flushId !== 1) {
          this.#fail(
            this.#lifecycleError("Cartesia returned an uncorrelated flush acknowledgement"),
          );
          return;
        }
        this.#providerFlushBase = flushId;
      }
      const expectedProviderFlushId = this.#providerFlushBase + this.#expectedFlushId;
      if (flushId !== expectedProviderFlushId) {
        this.#fail(this.#lifecycleError("Cartesia returned an uncorrelated flush acknowledgement"));
        return;
      }
      // The provider also emits a final implicit flush acknowledgement for a
      // `continue: false` message. It is a provider completion marker, not a
      // second caller-owned flush boundary, so consume it without publishing a
      // duplicate TVIC flush event.
      if (!waiter) {
        // Cartesia can emit an in-order boundary for a transcript submitted
        // with `continue: true` before the explicit empty `flush` boundary.
        // It can also emit the final boundary for `continue: false` before
        // `done`. These provider-owned boundaries do not correspond to a
        // caller-owned flush promise, but they still advance the provider
        // ledger. Ignore them only when they are exactly the next expected
        // ID; skipped, replayed, and out-of-order IDs remain fatal.
        if (flushId === expectedProviderFlushId) {
          this.#expectedFlushId += 1;
          return;
        }
        this.#fail(this.#lifecycleError("Cartesia returned an uncorrelated flush acknowledgement"));
        return;
      }
      if (
        !this.#pushEvent({
          type: "tts.flush.completed",
          sessionId: this.#request.sessionId,
          turnId: this.#request.turnId,
          sequence: this.#controlSequence,
          provider: PROVIDER_NAMES.cartesia,
          timestamp: this.#options.clock.now(),
          flushId,
          acknowledgedBy: "provider",
        })
      ) {
        return;
      }
      this.#controlSequence += 1;
      this.#expectedFlushId += 1;
      this.#flushWaiters.shift();
      waiter.resolve({ id: flushId, acknowledgedBy: "provider" });
      return;
    }

    const alignment =
      message.type === "timestamps"
        ? parseAlignment(message.word_timestamps, "words")
        : message.type === "phoneme_timestamps"
          ? parseAlignment(message.phoneme_timestamps, "phonemes")
          : null;
    if (alignment) {
      if (
        !this.#pushEvent({
          type: "tts.alignment",
          sessionId: this.#request.sessionId,
          turnId: this.#request.turnId,
          sequence: this.#controlSequence,
          provider: PROVIDER_NAMES.cartesia,
          timestamp: this.#options.clock.now(),
          unit: message.type === "timestamps" ? "word" : "phoneme",
          tokens: alignment.tokens,
          startMs: alignment.startMs,
          endMs: alignment.endMs,
          ...(typeof message.flush_id === "number" ? { flushId: message.flush_id } : {}),
        })
      ) {
        return;
      }
      this.#controlSequence += 1;
      return;
    }

    if (message.type === "timestamps" || message.type === "phoneme_timestamps") {
      this.#fail(this.#lifecycleError(`Cartesia returned malformed ${message.type} data`));
      return;
    }

    if (message.type === "done" || message.done === true) {
      if (this.#flushWaiters.length > 0) {
        this.#fail(this.#lifecycleError("Cartesia completed before acknowledging every flush"));
        return;
      }
      if (!this.#pushEvent(this.#committedEvent())) return;
      this.#done = true;
      this.#closeQueue();
      safeClose(this.#socket);
      return;
    }

    this.#fail(this.#lifecycleError("Cartesia returned an unexpected message type"));
  }

  #generationRequest(
    transcript: string,
    continuation: boolean,
    flush = false,
  ): Readonly<Record<string, unknown>> {
    return {
      model_id: this.#options.modelId,
      transcript,
      // Cartesia expects a plain voice ID.
      voice: this.#options.voiceId,
      ...(this.#options.locale !== undefined
        ? { locale: this.#options.locale }
        : { language: this.#options.language }),
      context_id: this.#contextId,
      output_format: {
        container: "raw",
        encoding: this.#request.format.encoding,
        sample_rate: this.#request.format.sampleRateHz,
      },
      add_timestamps: this.#options.timestamps,
      continue: continuation,
      ...(this.#options.accent ? { accent: this.#options.accent } : {}),
      ...(this.#options.normalization ? { normalization: this.#options.normalization } : {}),
      ...(this.#options.pronunciationDictId
        ? { pronunciation_dict_id: this.#options.pronunciationDictId }
        : {}),
      ...cartesiaGenerationConfig(this.#options.generationConfig, this.#options.speed),
      max_buffer_delay_ms: this.#options.maxBufferDelayMs ?? 0,
      ...(flush ? { flush: true } : {}),
    };
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    if (!safeSend(this.#socket, JSON.stringify(message))) {
      const error = TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerTransportWriteFailed,
          "Cartesia socket is not writable",
          {
            provider: PROVIDER_NAMES.cartesia,
            retriable: false,
            metadata: { operation: "send" },
          },
        ),
      );
      this.#fail(error);
      throw error;
    }
  }

  #sendTranscript(text: string, message: Readonly<Record<string, unknown>>): void {
    const utf16CodeUnits = text.length;
    const utf8Bytes = Buffer.byteLength(text, "utf8");
    if (
      this.#inputUtf16CodeUnits + utf16CodeUnits > MAX_CARTESIA_INPUT_UTF16_CODE_UNITS ||
      this.#inputUtf8Bytes + utf8Bytes > MAX_CARTESIA_INPUT_UTF8_BYTES
    ) {
      const error = TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerInputRejected,
          "Cartesia cumulative transcript input exceeded its bounded session limit",
          {
            provider: PROVIDER_NAMES.cartesia,
            retriable: false,
            metadata: {
              maxUtf16CodeUnits: MAX_CARTESIA_INPUT_UTF16_CODE_UNITS,
              maxUtf8Bytes: MAX_CARTESIA_INPUT_UTF8_BYTES,
            },
          },
        ),
      );
      this.#fail(error);
      throw error;
    }
    this.#send(message);
    this.#inputUtf16CodeUnits += utf16CodeUnits;
    this.#inputUtf8Bytes += utf8Bytes;
  }

  #assertWritable(): void {
    if (this.#closed) {
      throw this.#lifecycleError("Cartesia synthesis context is closed");
    }
    if (this.#finishing) {
      throw this.#lifecycleError("Cartesia synthesis context is already finishing");
    }
  }

  #committedEvent(): MediaAudioCommittedEvent {
    return createMediaEvent({
      id: this.#mediaEventId("committed"),
      type: "media.audio.committed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.cartesia,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: this.#chunkIds,
      metadata: {
        contextId: this.#contextId,
      },
    });
  }

  #mediaEventId(kind: string): MediaEventId {
    return `${this.#mediaEventIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #closeQueue(
    flushError = this.#lifecycleError(
      "Cartesia synthesis context closed before flush acknowledgement",
    ),
  ): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(flushError, {
      code: PROVIDER_ERROR_CODES.cartesiaTts,
      provider: PROVIDER_NAMES.cartesia,
    });
    this.#closed = true;
    this.#rejectFlushes(throwable);
    this.#events.close();
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.cartesiaTts,
      provider: PROVIDER_NAMES.cartesia,
    });
    this.#closed = true;
    this.#rejectFlushes(throwable);
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.cartesia));
    return false;
  }

  #rejectFlushes(error: unknown): void {
    for (const waiter of this.#flushWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  #lifecycleError(message: string): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.cartesiaTts, message, {
        provider: PROVIDER_NAMES.cartesia,
        retriable: false,
      }),
    );
  }
}

export function cartesiaProviderError(message: CartesiaMessage) {
  const input: {
    providerCode?: unknown;
    providerType?: unknown;
    status?: number;
    message?: unknown;
  } = {};
  const providerCode =
    typeof message.error_code === "string" && message.error_code.length <= 128
      ? message.error_code
      : undefined;
  if (providerCode !== undefined) input.providerCode = providerCode;
  if (message.type !== undefined) input.providerType = message.type;
  const status = integerStatus(message.status_code);
  if (status !== undefined) input.status = status;
  if (message.message !== undefined || message.title !== undefined) {
    input.message = message.message ?? message.title;
  }
  return classifiedProviderError(
    PROVIDER_NAMES.cartesia,
    "Cartesia rejected the synthesis request",
    input,
  );
}

function integerStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseAlignment(
  alignment: CartesiaAlignment | undefined,
  tokenField: "words" | "phonemes",
): {
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
} | null {
  const tokens = alignment?.[tokenField];
  const start = alignment?.start;
  const end = alignment?.end;
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(start) ||
    !Array.isArray(end) ||
    tokens.length > 4096 ||
    tokens.length !== start.length ||
    tokens.length !== end.length ||
    !tokens.every((value): value is string => typeof value === "string") ||
    !start.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) ||
    !end.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) ||
    !start.every((value, index) => {
      const endValue = end[index];
      return typeof endValue === "number" && endValue >= value;
    })
  ) {
    return null;
  }
  const startMs = start.map((seconds) => seconds * 1000);
  const endMs = end.map((seconds) => seconds * 1000);
  if (!startMs.every(Number.isFinite) || !endMs.every(Number.isFinite)) {
    return null;
  }
  return {
    tokens,
    startMs,
    endMs,
  };
}

function isValidFlushId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeCartesiaAudio(value: string): Uint8Array {
  if (value.length > 1_398_104) {
    throw new Error("audio payload exceeds the size limit");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  const canonical = Buffer.from(bytes).toString("base64");
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || canonical !== value) {
    throw new Error("invalid pcm16le");
  }
  return bytes;
}

export function createCartesiaTtsProvider(
  options: CartesiaTtsProviderOptions,
): CartesiaTtsProvider {
  return new CartesiaTtsProvider(options);
}
