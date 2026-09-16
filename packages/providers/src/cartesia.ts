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
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

type CartesiaMessage = Readonly<Record<string, unknown>> & {
  readonly type?: string;
  readonly data?: string;
  readonly done?: boolean;
  readonly context_id?: string;
  readonly message?: string;
  readonly error_code?: string;
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
    this.#language = options.language ?? ADAPTER_DEFAULTS.cartesia.language;
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
  #nextFlushId = 1;
  #frameCount = 0;
  #outputBytes = 0;
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
      this.#send(this.#generationRequest(request.text, false));
      this.#finishing = true;
    }
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    if (text.length === 0) {
      return;
    }
    this.#send(this.#generationRequest(text, true));
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
      this.#frameCount += frames;
      this.#outputBytes += bytes.byteLength;
      this.#chunkIds.push(eventId);
      const event = createMediaEvent({
        id: eventId,
        type: "media.audio.chunk",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence: this.#mediaSequence,
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
      this.#chunkSequences.push(this.#mediaSequence);
      this.#mediaSequence += 1;
      this.#pushEvent(event);
      return;
    }

    if (message.type === "flush_done") {
      if (!isValidFlushId(message.flush_id)) {
        this.#fail(this.#lifecycleError("Cartesia returned an invalid flush acknowledgement"));
        return;
      }
      const flushId = message.flush_id;
      const waiter = this.#flushWaiters[0];
      // Flush ids are scoped to the provider context. Cartesia currently starts
      // that sequence at zero for some API versions, while older responses start
      // at one; the ordered waiter queue is the stable correlation boundary.
      if (!waiter) {
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
      this.#pushEvent({
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
      });
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
      this.#done = true;
      if (!this.#pushEvent(this.#committedEvent())) return;
      this.#closeQueue();
      safeClose(this.#socket);
      return;
    }

    if (message.type === "error") {
      this.#fail(cartesiaProviderError(message));
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
      voice: {
        mode: "id",
        id: this.#options.voiceId,
      },
      language: this.#options.language,
      context_id: this.#contextId,
      output_format: {
        container: "raw",
        encoding: this.#request.format.encoding,
        sample_rate: this.#request.format.sampleRateHz,
      },
      add_timestamps: this.#options.timestamps,
      continue: continuation,
      ...(flush ? { flush: true } : {}),
    };
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    if (!safeSend(this.#socket, JSON.stringify(message))) {
      const error = TvicThrowableError.from(
        providerError(PROVIDER_ERROR_CODES.cartesiaTts, "Cartesia socket is not writable", {
          provider: PROVIDER_NAMES.cartesia,
          retriable: false,
        }),
      );
      this.#fail(error);
      throw error;
    }
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
  const providerCode =
    typeof message.error_code === "string" && message.error_code.length <= 128
      ? message.error_code
      : undefined;
  const disposition = classifyCartesiaError(providerCode);
  return providerError("provider.upstream_failed", "Cartesia rejected the synthesis request", {
    provider: PROVIDER_NAMES.cartesia,
    retriable: disposition.retriable,
    metadata: {
      ...(providerCode ? { providerCode } : {}),
      classification: disposition.classification,
      legacyCode: PROVIDER_ERROR_CODES.cartesiaTts,
    },
  });
}

function classifyCartesiaError(code: string | undefined): {
  readonly classification: "auth" | "invalid_request" | "rate_limited" | "upstream";
  readonly retriable: boolean;
} {
  const normalized = code?.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_") ?? "";
  if (
    /auth|api_key|credential|unauthor|forbidden|permission/.test(normalized) ||
    normalized === "invalid_token"
  ) {
    return { classification: "auth", retriable: false };
  }
  if (/rate|quota|too_many/.test(normalized)) {
    return { classification: "rate_limited", retriable: true };
  }
  if (/invalid|bad_request|model|voice|parameter|schema|request/.test(normalized)) {
    return { classification: "invalid_request", retriable: false };
  }
  return { classification: "upstream", retriable: true };
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
