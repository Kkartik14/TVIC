import WebSocket from "ws";

import {
  AsyncQueue,
  assertPcm16leFormat,
  durationMsForPcm16le,
  frameCountForPcm16le,
} from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_CAPABILITY_FEATURES,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  validationError,
  unknownErrorMessage,
  TvicThrowableError,
  createMediaEvent,
  countUnicodeCodePoints,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  AudioFormat,
  IncrementalTextToSpeechProvider,
  MediaAudioCommittedEvent,
  MediaEventId,
  ProviderCapabilities,
  ProviderTtsVoiceCapabilityRequirement,
  TtsEvent,
  TtsFlushResult,
  TtsSession,
  TtsSessionOpenRequest,
  TtsStream,
  TtsSynthesisRequest,
  TtsTextControl,
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
import {
  assertCartesiaOptions,
  assertCartesiaSpeed,
  assertCartesiaSpeedVoiceCapability,
  assertCartesiaTtsSettings,
  cartesiaHasLanguageMappingForModel,
  cartesiaRequestLanguage,
  cartesiaTtsLanguageSupported,
  cartesiaGenerationConfig,
  cartesiaTtsSpeedRanges,
  type CartesiaGenerationConfig,
} from "./cartesia-options.js";
import {
  cartesiaProviderError,
  decodeCartesiaAudio,
  isValidFlushId,
  parseAlignment,
} from "./cartesia-protocol.js";
import type { CartesiaMessage } from "./cartesia-protocol.js";
import {
  renderCartesiaText,
  splitCartesiaTextAtControlBoundary,
} from "./cartesia-text-controls.js";
import { validateTtsTextControls } from "./tts-text-controls.js";

export type { CartesiaGenerationConfig } from "./cartesia-options.js";
export { cartesiaProviderError } from "./cartesia-protocol.js";

export const MAX_CARTESIA_INPUT_UTF16_CODE_UNITS = 1_048_576;
export const MAX_CARTESIA_INPUT_UTF8_BYTES = 4_194_304;

function cartesiaInputLimitError(): TvicThrowableError {
  return TvicThrowableError.from(
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
}

function assertCartesiaInputWithinCodeUnitLimit(text: string, currentCodeUnits = 0): void {
  if (currentCodeUnits + text.length <= MAX_CARTESIA_INPUT_UTF16_CODE_UNITS) return;
  throw cartesiaInputLimitError();
}

function toCartesiaWellFormedText(text: string): string {
  const parts: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      parts.push(text.slice(segmentStart, index), "\ufffd");
      segmentStart = index + 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      parts.push(text.slice(segmentStart, index), "\ufffd");
      segmentStart = index + 1;
    }
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(segmentStart));
  return parts.join("");
}

const CARTESIA_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.cartesia.models,
  voiceSelection: "account_snapshot",
  ttsTextControls: PROVIDER_CATALOG.cartesia.models.map((model) => ({
    model,
    controls: ["spell", "pause"],
  })),
  ttsSpeedRanges: cartesiaTtsSpeedRanges(),
} satisfies ProviderCapabilities;

export interface CartesiaTtsProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId: string;
  readonly modelId?: string;
  readonly allowUnknownModel?: boolean;
  readonly language?: string;
  readonly locale?: string;
  readonly accent?: string;
  readonly normalization?: string;
  readonly generationConfig?: CartesiaGenerationConfig;
  readonly pronunciationDictId?: string;
  readonly maxBufferDelayMs?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

export class CartesiaTtsProvider implements IncrementalTextToSpeechProvider {
  readonly name = PROVIDER_NAMES.cartesia;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = CARTESIA_CAPABILITIES;
  readonly supportsConfiguredModelSelection: (model: string) => boolean;
  readonly requiredTtsVoiceCapabilities:
    | readonly ProviderTtsVoiceCapabilityRequirement[]
    | undefined;
  readonly usageAccounting = {
    reportsTextCharacters: true,
    usesRequestModelForUsage: true,
  } as const;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #voiceId: string;
  readonly #modelId: string;
  readonly #configuredModelSource: "configured" | "not_reported";
  readonly #allowUnknownModel: boolean;
  readonly #languageWasExplicitlyConfigured: boolean;
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
    this.#configuredModelSource = options.modelId === undefined ? "not_reported" : "configured";
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
    this.#languageWasExplicitlyConfigured =
      options.language !== undefined || options.locale !== undefined;
    this.#accent = options.accent;
    this.#normalization = options.normalization;
    this.#generationConfig = options.generationConfig;
    this.#pronunciationDictId = options.pronunciationDictId;
    this.#maxBufferDelayMs = options.maxBufferDelayMs ?? 0;
    assertCartesiaOptions(this.#generationConfig, this.#maxBufferDelayMs);
    assertCartesiaTtsSettings(this.#modelId, this.#normalization, this.#pronunciationDictId);
    this.supportsConfiguredModelSelection = (model) => {
      try {
        assertCartesiaTtsSettings(model, this.#normalization, this.#pronunciationDictId);
        return true;
      } catch {
        return false;
      }
    };
    if (this.#languageWasExplicitlyConfigured) {
      cartesiaRequestLanguage(this.#locale ?? this.#language, this.#modelId, this.#locale);
    }
    this.requiredTtsVoiceCapabilities =
      this.#generationConfig?.speed === undefined
        ? undefined
        : Object.freeze([
            Object.freeze({
              provider: PROVIDER_NAMES.cartesia,
              feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceIsPro,
              expectedBooleanValue: false,
            }),
          ]);
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
          maxPayload: MAX_PROVIDER_FRAME_BYTES,
        }));
  }

  get configuredModel(): string {
    return this.#modelId;
  }

  get configuredModelSource(): "configured" | "not_reported" {
    return this.#configuredModelSource;
  }

  get allowUnknownModel(): boolean {
    return this.#allowUnknownModel;
  }

  get configuredVoice(): string {
    return this.#voiceId;
  }

  get configuredLanguage(): string {
    return this.#locale ?? this.#language;
  }

  get languageWasExplicitlyConfigured(): boolean {
    return this.#languageWasExplicitlyConfigured;
  }

  supportsLanguage(language: string, model = this.#modelId): boolean {
    return cartesiaTtsLanguageSupported(language, model, this.#locale);
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertCartesiaInputWithinCodeUnitLimit(request.text);
    const safeRequest = this.#validateRequest(request);
    let serializedText: string;
    try {
      serializedText = renderCartesiaText(
        toCartesiaWellFormedText(safeRequest.text),
        safeRequest.textControls ?? [],
        MAX_CARTESIA_INPUT_UTF8_BYTES,
      );
    } catch (error) {
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.cartesiaTts,
          provider: PROVIDER_NAMES.cartesia,
        }),
      );
    }
    assertCartesiaInputWithinCodeUnitLimit(serializedText);
    const socket = await this.#connect(safeRequest.signal);
    return this.#createStream(socket, safeRequest, serializedText);
  }

  async openSession(request: TtsSessionOpenRequest): Promise<TtsSession> {
    const safeRequest = this.#validateRequest(request);
    const socket = await this.#connect(safeRequest.signal);
    return this.#createStream(socket, safeRequest);
  }

  #validateRequest<T extends TtsSessionOpenRequest>(request: T): T {
    const safeRequest = validateTtsTextControls(this, request);
    assertCartesiaFormat(request.format);
    assertCartesiaSpeed(request.speed);
    const modelId = request.model ?? this.#modelId;
    assertCartesiaTtsSettings(modelId, this.#normalization, this.#pronunciationDictId);
    assertSupportedModel(
      PROVIDER_NAMES.cartesia,
      PROVIDER_CATALOG.cartesia.models,
      modelId,
      this.#allowUnknownModel,
    );
    if (this.#languageWasExplicitlyConfigured) {
      cartesiaRequestLanguage(this.configuredLanguage, modelId, this.#locale);
    }
    assertCartesiaSpeedVoiceCapability(
      request.providerCapabilitySnapshots,
      request.voice ?? this.#voiceId,
      request.speed ?? this.#generationConfig?.speed,
      request.providerCapabilityEvaluationTimeMs,
    );
    return safeRequest;
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
    const modelId = request.model ?? this.#modelId;
    const language = cartesiaHasLanguageMappingForModel(modelId)
      ? cartesiaRequestLanguage(this.configuredLanguage, modelId, this.#locale)
      : {
          language: this.#language,
          ...(this.#locale !== undefined ? { locale: this.#locale } : {}),
        };
    return {
      voiceId: request.voice ?? this.#voiceId,
      modelId,
      language: language.language,
      ...(language.locale !== undefined ? { locale: language.locale } : {}),
      ...(this.#accent !== undefined ? { accent: this.#accent } : {}),
      ...(this.#normalization !== undefined ? { normalization: this.#normalization } : {}),
      ...(this.#generationConfig !== undefined ? { generationConfig: this.#generationConfig } : {}),
      ...(this.#pronunciationDictId !== undefined
        ? { pronunciationDictId: this.#pronunciationDictId }
        : {}),
      maxBufferDelayMs: this.#maxBufferDelayMs,
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      textControls: request.textControls ?? [],
      clock: this.#clock,
      timestamps: request.timestamps ?? false,
      contextId: `${this.#contextIds.next()}_${safeContextComponent(this.#clock.now())}`,
    };
  }

  #createStream(
    socket: WebSocket,
    request: TtsSessionOpenRequest | TtsSynthesisRequest,
    initialTranscript?: string,
  ): CartesiaTtsStream {
    try {
      return new CartesiaTtsStream(
        socket,
        request,
        this.#streamOptions(request),
        initialTranscript,
      );
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
  readonly textControls?: readonly TtsTextControl[];
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
  readonly #textControls: readonly TtsTextControl[];
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
  #nextFlushId = 0;
  #expectedFlushId = 0;
  #providerFlushBase: number | undefined;
  #frameCount = 0;
  #outputBytes = 0;
  #inputUtf16CodeUnits = 0;
  #inputUtf8Bytes = 0;
  #acceptedSourceUtf16CodeUnits = 0;
  #pendingText = "";
  #closed = false;
  #done = false;
  #cancelled = false;
  #finishing = false;
  #failure: TvicThrowableError | undefined;

  constructor(
    socket: WebSocket,
    request: TtsSessionOpenRequest | TtsSynthesisRequest,
    options: CartesiaStreamOptions,
    initialTranscript?: string,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#options = options;
    this.#textControls = options.textControls ?? [];
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
    socket.on("error", (error) => {
      const normalized = normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.cartesiaTts,
        provider: PROVIDER_NAMES.cartesia,
      });
      this.#fail(this.#markOutcomeUnknown(normalized));
    });

    if ("text" in request) {
      const serialized =
        initialTranscript ??
        renderCartesiaText(
          toCartesiaWellFormedText(request.text),
          this.#textControls,
          MAX_CARTESIA_INPUT_UTF8_BYTES,
        );
      this.#sendTranscript(serialized, this.#generationRequest(serialized, false));
      this.#finishing = true;
    }
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    if (text.length === 0) {
      return;
    }
    assertCartesiaInputWithinCodeUnitLimit(text, this.#acceptedSourceUtf16CodeUnits);
    this.#acceptedSourceUtf16CodeUnits += text.length;
    this.#appendText(text);
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    if (this.#flushWaiters.length >= MAX_PROVIDER_TTS_PENDING_FLUSHES) {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.cartesia);
      this.#fail(error);
      return Promise.reject(error);
    }
    this.#sendReadyPendingText(true);
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
    if (this.#failure) {
      throw this.#failure;
    }
    if (this.#finishing || this.#closed) {
      return;
    }
    this.#assertWritable();
    this.#sendPendingText(true);
    this.#finishing = true;
    this.#send(this.#generationRequest("", false));
  }

  async cancel(): Promise<void> {
    if (this.#closed) {
      return;
    }
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

    if (message.type === "error") {
      const error = cartesiaProviderError(message);
      const outcomeUnknown =
        this.#inputUtf8Bytes > 0 &&
        error.retriable &&
        error.code !== TVIC_ERROR_CODES.providerRateLimited;
      this.#fail(
        outcomeUnknown
          ? {
              ...error,
              retriable: false,
              metadata: { ...(error.metadata ?? {}), outcomeUnknown: true },
            }
          : error,
      );
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
      if (!waiter) {
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
      const error = this.#markOutcomeUnknown(
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
      const error = cartesiaInputLimitError();
      this.#fail(error);
      throw error;
    }
    this.#send(message);
    this.#inputUtf16CodeUnits += utf16CodeUnits;
    this.#inputUtf8Bytes += utf8Bytes;
    this.#request.usageReporter?.reportTextCharacters(countUnicodeCodePoints(text));
  }

  #appendText(text: string): void {
    this.#pendingText += text;
    const split = splitCartesiaTextAtControlBoundary(this.#pendingText, this.#textControls);
    this.#pendingText = split.pending;
    if (split.ready.length > 0) {
      this.#sendSerializedText(split.ready, true);
    }
  }

  #sendPendingText(continuation: boolean): void {
    if (this.#pendingText.length === 0) return;
    const text = this.#pendingText;
    this.#pendingText = "";
    this.#sendSerializedText(text, continuation);
  }

  #sendReadyPendingText(continuation: boolean): void {
    const split = splitCartesiaTextAtControlBoundary(this.#pendingText, this.#textControls);
    const pendingIsControlPrefix = this.#textControls.some(
      (control) =>
        split.pending.length < control.match.length && control.match.startsWith(split.pending),
    );
    this.#pendingText = pendingIsControlPrefix ? split.pending : "";
    this.#sendSerializedText(
      pendingIsControlPrefix ? split.ready : split.ready + split.pending,
      continuation,
    );
  }

  #sendSerializedText(text: string, continuation: boolean): void {
    let serialized: string;
    try {
      serialized = renderCartesiaText(
        toCartesiaWellFormedText(text),
        this.#textControls,
        MAX_CARTESIA_INPUT_UTF8_BYTES,
      );
    } catch {
      const error = cartesiaInputLimitError();
      this.#fail(error);
      throw error;
    }
    if (serialized.length === 0) return;
    this.#sendTranscript(serialized, this.#generationRequest(serialized, continuation));
  }

  #assertWritable(): void {
    if (this.#failure) {
      throw this.#failure;
    }
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
    this.#failure = throwable;
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
      this.#markOutcomeUnknown(
        providerError(PROVIDER_ERROR_CODES.cartesiaTts, message, {
          provider: PROVIDER_NAMES.cartesia,
          retriable: false,
        }),
      ),
    );
  }

  #markOutcomeUnknown(error: unknown): unknown {
    if (this.#inputUtf8Bytes === 0) return error;
    const normalized = TvicThrowableError.from(error).error;
    return {
      ...normalized,
      retriable: false,
      metadata: { ...(normalized.metadata ?? {}), outcomeUnknown: true },
    };
  }
}

export function createCartesiaTtsProvider(
  options: CartesiaTtsProviderOptions,
): CartesiaTtsProvider {
  return new CartesiaTtsProvider(options);
}
