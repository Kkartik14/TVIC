import WebSocket from "ws";

import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  cancelledError,
  countUnicodeCodePoints,
  counterIdGenerator,
  createMediaEvent,
  TvicThrowableError,
} from "@tvic/core";
import type {
  CounterIdGenerator,
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

import { ADAPTER_DEFAULTS } from "./catalog.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_MODELS,
  SARVAM_TTS_VOICES,
  assertSarvamTtsLanguageExplicit,
  SarvamTtsSelectionProvider,
  isSarvamTtsV4FlashModel,
  isSarvamTtsLanguageSupported,
  sarvamTtsLanguageAliases,
  resolveSarvamTtsLanguage,
  resolveSarvamTtsVoice,
  sarvamTtsLanguageUnsupportedError,
  toSarvamTtsLanguageCode,
  type SarvamTtsVoiceLanguages,
} from "./sarvam-tts-model.js";
import { SARVAM_TTS_V4_FLASH_VOICES } from "./sarvam-tts-v4-voices.js";
import { resolveSarvamTtsTemperature } from "./sarvam-tts-temperature.js";
import { sarvamTtsCloseError, sarvamTtsProtocolError } from "./sarvam-tts-protocol.js";
import {
  assertSarvamTtsFormat,
  assertSarvamTtsInteger,
  assertSarvamTtsNumber,
  assertSarvamTtsText,
  sarvamTtsSpeedRanges,
  SARVAM_TTS_SPEED_RANGE,
  sarvamTtsValidationError,
} from "./sarvam-tts-validation.js";
import {
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  MAX_PROVIDER_TTS_PENDING_FLUSHES,
  SystemProviderClock,
  assertSupportedModel,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  providerError,
  providerEventQueueOverflow,
  providerFrameTooLarge,
  providerSendCapacity,
  providerThrowableError,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";
import { decodeSarvamTtsAudioWithFormat } from "./sarvam-tts-audio.js";
import { validateTtsTextControls } from "./tts-text-controls.js";

export { sarvamTtsCloseError, sarvamTtsProtocolError } from "./sarvam-tts-protocol.js";
const SARVAM_TTS_MAX_TEXT_CHARS = 2_500;
const SARVAM_TTS_DEFAULT_URL = "wss://api.sarvam.ai/text-to-speech/ws";
const SARVAM_TTS_KEEPALIVE_INTERVAL_MS = 30_000;
const SARVAM_TTS_MAX_REQUEST_ID_CHARS = 256;
const SARVAM_TTS_MAX_CONTENT_TYPE_CHARS = 128;
const SARVAM_TTS_AUDIO_CONTENT_TYPES = new Set(["audio/linear16", "audio/pcm", "audio/wav"]);

const SARVAM_TTS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  languages: SARVAM_TTS_LANGUAGES,
  models: SARVAM_TTS_MODELS,
  ttsSpeedRanges: sarvamTtsSpeedRanges(),
  timestamps: false,
  metadata: {
    outputAudioCodec: "linear16",
    outputSampleRateHz: 16_000,
    completionEvent: "final",
  },
} satisfies ProviderCapabilities;

export interface SarvamTtsProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly language?: string;
  /** Optional host-supplied Bulbul v4 persona-to-language allowlist (up to 128 voices). */
  readonly voiceLanguages?: SarvamTtsVoiceLanguages;
  readonly pace?: number;
  readonly temperature?: number;
  readonly minBufferSize?: number;
  readonly maxChunkLength?: number;
  readonly pronunciationDictionaryId?: string;
  readonly keepAliveIntervalMs?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface SarvamTtsStreamOptions {
  readonly clock: ProviderClock;
  readonly model: string;
  readonly language: string;
  readonly voice: string;
  readonly pace: number;
  readonly temperature?: number;
  readonly minBufferSize: number;
  readonly maxChunkLength: number;
  readonly pronunciationDictionaryId?: string;
  readonly keepAliveIntervalMs: number;
  readonly countTextUsage?: boolean;
}

interface SarvamTtsMessage extends Readonly<Record<string, unknown>> {
  readonly type?: unknown;
  readonly data?: unknown;
}

interface FlushWaiter {
  readonly id: number;
  readonly resolve: (result: TtsFlushResult) => void;
  readonly reject: (error: unknown) => void;
}

export class SarvamTtsProvider
  extends SarvamTtsSelectionProvider<SarvamTtsProviderOptions>
  implements IncrementalTextToSpeechProvider
{
  readonly name = PROVIDER_NAMES.sarvamTts;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly usageAccounting = {
    reportsTextCharacters: true,
    usesRequestModelForUsage: true,
  } as const;
  readonly capabilities: ProviderCapabilities;

  readonly #options: SarvamTtsProviderOptions;
  readonly #modelId: string;
  readonly #language: string;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<SarvamTtsProviderOptions["webSocketFactory"]>;

  constructor(options: SarvamTtsProviderOptions) {
    super(options);
    this.#options = this.providerOptions;
    this.#modelId = this.configuredModel;
    this.#language = this.configuredLanguage;
    this.capabilities = {
      ...SARVAM_TTS_CAPABILITIES,
      languages: isSarvamTtsLanguageSupported(this.#language, this.#modelId)
        ? sarvamTtsLanguageAliases(this.#language)
        : [],
      voices: isSarvamTtsV4FlashModel(this.#modelId)
        ? SARVAM_TTS_V4_FLASH_VOICES
        : SARVAM_TTS_VOICES,
    };
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
          maxPayload: MAX_PROVIDER_FRAME_BYTES,
        }));
  }

  maxTtsTextCharacters(): number {
    return SARVAM_TTS_MAX_TEXT_CHARS;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertSarvamTtsText(request.text);
    const stream = await this.#open(request, request.text);
    try {
      await stream.sendText(request.text);
      await stream.finish();
      return stream;
    } catch (error) {
      await stream.cancel();
      throw error;
    }
  }

  openSession(request: TtsSessionOpenRequest): Promise<SarvamTtsStream> {
    return this.#open(request);
  }

  async #open(request: TtsSessionOpenRequest, synthesisText?: string): Promise<SarvamTtsStream> {
    request = validateTtsTextControls(this, request);
    assertSarvamTtsFormat(request.format);
    if (request.timestamps === true) {
      throw sarvamTtsValidationError("Sarvam Bulbul does not provide alignment timestamps");
    }

    const model = request.model ?? this.#modelId;
    assertSupportedModel(PROVIDER_NAMES.sarvamTts, SARVAM_TTS_MODELS, model);
    const selectedLanguage = request.language || this.#options.language;
    assertSarvamTtsLanguageExplicit(model, selectedLanguage);

    const voice = resolveSarvamTtsVoice(model, request.voice ?? this.#options.voiceId);
    const language = resolveSarvamTtsLanguage(selectedLanguage ?? this.#language, model);
    if (isSarvamTtsV4FlashModel(model) && !this.supportsTtsLanguage(language, model, voice)) {
      throw sarvamTtsLanguageUnsupportedError(language, model, voice);
    }

    const pace = request.speed ?? this.#options.pace ?? ADAPTER_DEFAULTS.sarvamTts.pace;
    assertSarvamTtsNumber("pace", pace, SARVAM_TTS_SPEED_RANGE.min, SARVAM_TTS_SPEED_RANGE.max);
    const temperature = resolveSarvamTtsTemperature(model, this.#options.temperature);
    const minBufferSize = this.#options.minBufferSize ?? ADAPTER_DEFAULTS.sarvamTts.minBufferSize;
    assertSarvamTtsInteger("minBufferSize", minBufferSize, 30, 200);
    const maxChunkLength =
      this.#options.maxChunkLength ?? ADAPTER_DEFAULTS.sarvamTts.maxChunkLength;
    assertSarvamTtsInteger("maxChunkLength", maxChunkLength, 50, 500);
    const keepAliveIntervalMs =
      this.#options.keepAliveIntervalMs ?? SARVAM_TTS_KEEPALIVE_INTERVAL_MS;
    assertSarvamTtsInteger("keepAliveIntervalMs", keepAliveIntervalMs, 1_000, 60_000);
    if (synthesisText !== undefined) {
      request.usageReporter?.reportTextCharacters(countUnicodeCodePoints(synthesisText));
    }

    let socket: WebSocket | undefined;
    try {
      const url = new URL(this.#options.url ?? SARVAM_TTS_DEFAULT_URL);
      url.searchParams.set("model", model);
      url.searchParams.set("send_completion_event", "true");
      socket = this.#webSocketFactory(url.toString(), {
        "api-subscription-key": this.#options.apiKey,
      });
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      return new SarvamTtsStream(socket, request, {
        clock: this.#clock,
        model,
        language: toSarvamTtsLanguageCode(language),
        voice,
        pace,
        ...(temperature !== undefined ? { temperature } : {}),
        minBufferSize,
        maxChunkLength,
        ...(this.#options.pronunciationDictionaryId
          ? { pronunciationDictionaryId: this.#options.pronunciationDictionaryId }
          : {}),
        keepAliveIntervalMs,
        countTextUsage: synthesisText === undefined,
      });
    } catch (error) {
      if (socket) safeClose(socket);
      throw TvicThrowableError.from(normalizeSarvamTtsConnectionError(error));
    }
  }
}

export class SarvamTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: SarvamTtsStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
      this.#fail(error);
      return error;
    },
  });
  readonly #mediaEventIds: CounterIdGenerator<MediaEventId>;
  readonly #flushWaiters: FlushWaiter[] = [];
  #finishWaiter:
    | {
        readonly resolve: () => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  readonly #currentChunkIds: MediaEventId[] = [];
  readonly #currentChunkSequences: number[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  #nextFlushId = 1;
  #currentFrameCount = 0;
  #totalOutputBytes = 0;
  #totalOutputChunks = 0;
  #closed = false;
  #finishing = false;
  #finishPromise: Promise<void> | undefined;
  #completed = false;
  #cancelled = false;
  #requestSubmitted = false;
  #keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  readonly #onRequestAbort = (): void => {
    this.#fail(
      cancelledError("provider.connection_cancelled", "Sarvam TTS request was cancelled", {
        provider: PROVIDER_NAMES.sarvamTts,
      }),
    );
  };

  constructor(socket: WebSocket, request: TtsSessionOpenRequest, options: SarvamTtsStreamOptions) {
    this.#socket = socket;
    this.#request = request;
    this.#options = options;
    this.#mediaEventIds = counterIdGenerator<MediaEventId>(
      `sarvam_tts_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    this.events = this.#events;

    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(providerFrameTooLarge(PROVIDER_NAMES.sarvamTts));
        return;
      }
      try {
        this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
      } catch (error) {
        this.#fail(error);
      }
    });
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) =>
      this.#fail(
        this.#outcomeError(
          normalizeProviderError(error, {
            code: PROVIDER_ERROR_CODES.sarvamTts,
            provider: PROVIDER_NAMES.sarvamTts,
          }),
        ),
      ),
    );

    if (request.signal?.aborted) {
      this.#onRequestAbort();
      return;
    }
    request.signal?.addEventListener("abort", this.#onRequestAbort, { once: true });

    this.#send(this.#configMessage());
    this.#startKeepAlive();
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    assertSarvamTtsText(text);
    if (text.length === 0) return;
    if (text.length > SARVAM_TTS_MAX_TEXT_CHARS) {
      throw sarvamTtsValidationError(
        `Sarvam Bulbul text chunks must be at most ${SARVAM_TTS_MAX_TEXT_CHARS} characters`,
      );
    }
    if (this.#options.countTextUsage !== false) {
      this.#request.usageReporter?.reportTextCharacters(countUnicodeCodePoints(text));
    }
    this.#send({ type: "text", data: { text } }, true);
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    return this.#enqueueFlush();
  }

  finish(): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    if (this.#closed) return Promise.resolve();
    try {
      this.#assertWritable();
    } catch (error) {
      return Promise.reject(error);
    }

    let resolveFinish!: () => void;
    let rejectFinish!: (error: unknown) => void;
    const finishPromise = new Promise<void>((resolve, reject) => {
      resolveFinish = resolve;
      rejectFinish = reject;
    });
    this.#finishPromise = finishPromise;
    this.#finishing = true;
    void this.#finishAndWait().then(resolveFinish, rejectFinish);
    return finishPromise;
  }

  async #finishAndWait(): Promise<void> {
    if (this.#flushWaiters.length === 0) {
      await this.#enqueueFlush();
    }
    if (this.#completed) return;
    await new Promise<void>((resolve, reject) => {
      this.#finishWaiter = { resolve, reject };
    });
  }

  async keepAlive(): Promise<void> {
    this.#assertWritable();
    this.#send({ type: "ping" });
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#cancelled = true;
    const error = this.#lifecycleError("Sarvam TTS synthesis was cancelled");
    this.#rejectFlushes(error);
    this.#rejectFinishWaiter(error);
    this.#closeQueue();
    safeClose(this.#socket);
  }

  #configMessage(): Readonly<Record<string, unknown>> {
    return {
      type: "config",
      data: {
        model: this.#options.model,
        language_code: this.#options.language,
        speaker: this.#options.voice,
        pace: this.#options.pace,
        ...(this.#options.temperature !== undefined
          ? { temperature: this.#options.temperature }
          : {}),
        speech_sample_rate: "16000",
        output_audio_codec: "linear16",
        min_buffer_size: this.#options.minBufferSize,
        max_chunk_length: this.#options.maxChunkLength,
        ...(this.#options.pronunciationDictionaryId
          ? { dict_id: this.#options.pronunciationDictionaryId }
          : {}),
      },
    };
  }

  #enqueueFlush(): Promise<TtsFlushResult> {
    if (this.#flushWaiters.length >= MAX_PROVIDER_TTS_PENDING_FLUSHES) {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
      this.#fail(error);
      return Promise.reject(error);
    }

    const id = this.#nextFlushId;
    this.#nextFlushId += 1;
    return new Promise<TtsFlushResult>((resolve, reject) => {
      const waiter: FlushWaiter = { id, resolve, reject };
      this.#flushWaiters.push(waiter);
      try {
        this.#send({ type: "flush" });
      } catch (error) {
        const index = this.#flushWaiters.indexOf(waiter);
        if (index >= 0) this.#flushWaiters.splice(index, 1);
        reject(error);
      }
    });
  }

  #handleMessage(body: string): void {
    if (this.#closed) return;
    const message = parseJsonObject(body) as SarvamTtsMessage | null;
    if (!message || typeof message.type !== "string") {
      this.#fail(this.#protocolError("Sarvam TTS returned malformed JSON"));
      return;
    }

    const data = asRecord(message.data);
    if (message.type === "audio") {
      if (!data || typeof data.content_type !== "string") {
        this.#fail(this.#protocolError("Sarvam TTS returned audio without content_type"));
        return;
      }
      if (
        data.content_type.length === 0 ||
        data.content_type.length > SARVAM_TTS_MAX_CONTENT_TYPE_CHARS
      ) {
        this.#fail(this.#protocolError("Sarvam TTS returned an invalid audio content_type"));
        return;
      }
      const mediaType = data.content_type.split(";", 1)[0]?.trim().toLowerCase();
      if (!mediaType || !SARVAM_TTS_AUDIO_CONTENT_TYPES.has(mediaType)) {
        this.#fail(this.#protocolError("Sarvam TTS returned an unsupported audio content_type"));
        return;
      }
      if (typeof data.audio !== "string") {
        this.#fail(this.#protocolError("Sarvam TTS returned audio without base64 data"));
        return;
      }
      let decoded: ReturnType<typeof decodeSarvamTtsAudioWithFormat>;
      try {
        decoded = decodeSarvamTtsAudioWithFormat(data.audio, undefined, mediaType === "audio/wav");
      } catch (error) {
        const detail =
          error instanceof Error ? boundedString(error.message, 128) : "invalid payload";
        this.#fail(this.#protocolError(`Sarvam TTS returned malformed audio: ${detail}`));
        return;
      }
      this.#pushAudio(
        decoded.bytes,
        data.content_type,
        typeof data.request_id === "string"
          ? boundedString(data.request_id, SARVAM_TTS_MAX_REQUEST_ID_CHARS)
          : undefined,
        decoded.wireFormat,
      );
      return;
    }

    if (message.type === "event") {
      if (typeof data?.event_type !== "string" || data.event_type !== "final") {
        this.#fail(this.#protocolError("Sarvam TTS returned an unknown event"));
        return;
      }
      this.#handleFinalEvent();
      return;
    }

    if (message.type === "error") {
      if (!data || typeof data.message !== "string" || data.message.length === 0) {
        this.#fail(this.#protocolError("Sarvam TTS returned a malformed provider error"));
        return;
      }
      const vendorCode =
        typeof data.code === "number" && Number.isSafeInteger(data.code)
          ? String(data.code)
          : typeof data.code === "string"
            ? boundedString(data.code, 128)
            : undefined;
      this.#fail(
        sarvamTtsProtocolError(
          vendorCode,
          boundedString(data.message, 1_024),
          this.#totalOutputChunks > 0,
          this.#requestSubmitted,
        ),
      );
      return;
    }

    this.#fail(this.#protocolError("Sarvam TTS returned an unexpected message type"));
  }

  #handleFinalEvent(): void {
    const waiter = this.#flushWaiters[0];
    if (!waiter) {
      this.#fail(this.#protocolError("Sarvam TTS returned an uncorrelated final event"));
      return;
    }

    if (!this.#pushCommittedEvent()) return;
    if (
      !this.#pushEvent({
        type: "tts.flush.completed",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence: this.#controlSequence,
        provider: PROVIDER_NAMES.sarvamTts,
        timestamp: this.#options.clock.now(),
        flushId: waiter.id,
        acknowledgedBy: "provider",
      })
    ) {
      return;
    }
    this.#flushWaiters.shift();
    this.#controlSequence += 1;
    waiter.resolve({ id: waiter.id, acknowledgedBy: "provider" });

    if (this.#finishing && this.#flushWaiters.length === 0) {
      this.#completed = true;
      this.#closeQueue();
      safeClose(this.#socket);
      this.#resolveFinishWaiter();
    }
  }

  #pushAudio(
    bytes: Uint8Array,
    contentType: string,
    requestId: string | undefined,
    wireFormat: "linear16" | "wav",
  ): void {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength % 2 !== 0 ||
      this.#totalOutputChunks >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
      this.#totalOutputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts));
      return;
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
          contentType,
          wireFormat,
          ...(requestId ? { requestId } : {}),
          model: this.#options.model,
          language: this.#options.language,
          voice: this.#options.voice,
        },
      },
    });
    if (!this.#pushEvent(event)) return;
    this.#mediaSequence += 1;
    this.#currentFrameCount += frames;
    this.#totalOutputBytes += bytes.byteLength;
    this.#totalOutputChunks += 1;
    this.#currentChunkIds.push(eventId);
    this.#currentChunkSequences.push(this.#mediaSequence - 1);
  }

  #pushCommittedEvent(): boolean {
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
      durationMs: (this.#currentFrameCount / this.#request.format.sampleRateHz) * 1_000,
      frameCount: this.#currentFrameCount,
      sequenceRange: [this.#currentChunkSequences[0] ?? 0, this.#currentChunkSequences.at(-1) ?? 0],
      chunkIds: [...this.#currentChunkIds],
      metadata: { model: this.#options.model, voice: this.#options.voice },
    });
    const pushed = this.#pushEvent(committed);
    this.#currentFrameCount = 0;
    this.#currentChunkIds.length = 0;
    this.#currentChunkSequences.length = 0;
    if (pushed) this.#mediaSequence = 1;
    return pushed;
  }

  #send(message: Readonly<Record<string, unknown>>, synthesisSubmission = false): void {
    const serialized = JSON.stringify(message);
    if (
      synthesisSubmission &&
      this.#socket.readyState === WebSocket.OPEN &&
      providerSendCapacity(this.#socket, serialized) === "open"
    ) {
      this.#requestSubmitted = true;
    }
    if (safeSend(this.#socket, serialized)) return;
    const error = this.#lifecycleError("Sarvam TTS socket is not writable");
    this.#fail(error);
    throw error;
  }

  #startKeepAlive(): void {
    this.#keepAliveTimer = setInterval(() => {
      if (this.#closed) return;
      try {
        this.#send({ type: "ping" });
      } catch {
        return;
      }
    }, this.#options.keepAliveIntervalMs);
    this.#keepAliveTimer.unref?.();
  }

  #clearKeepAlive(): void {
    if (this.#keepAliveTimer !== undefined) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = undefined;
    }
  }

  #assertWritable(): void {
    if (this.#closed) {
      throw this.#lifecycleError("Sarvam TTS synthesis context is closed");
    }
    if (this.#finishing) {
      throw this.#lifecycleError("Sarvam TTS synthesis context is already finishing");
    }
  }

  #mediaEventId(kind: string): MediaEventId {
    return `${this.#mediaEventIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    if (this.#closed) return;
    if (this.#completed || this.#cancelled) {
      this.#closeQueue();
      return;
    }
    this.#fail(
      sarvamTtsCloseError(code, reason, this.#totalOutputChunks > 0, this.#requestSubmitted),
    );
  }

  #closeQueue(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#request.signal?.removeEventListener("abort", this.#onRequestAbort);
    this.#clearKeepAlive();
    this.#events.close();
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts));
    return false;
  }

  #rejectFlushes(error: unknown): void {
    for (const waiter of this.#flushWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  #resolveFinishWaiter(): void {
    const waiter = this.#finishWaiter;
    this.#finishWaiter = undefined;
    waiter?.resolve();
  }

  #rejectFinishWaiter(error: unknown): void {
    const waiter = this.#finishWaiter;
    this.#finishWaiter = undefined;
    waiter?.reject(error);
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const throwable = this.#outcomeError(
      providerThrowableError(error, {
        code: PROVIDER_ERROR_CODES.sarvamTts,
        provider: PROVIDER_NAMES.sarvamTts,
      }),
    );
    this.#closed = true;
    this.#request.signal?.removeEventListener("abort", this.#onRequestAbort);
    this.#clearKeepAlive();
    this.#rejectFlushes(throwable);
    this.#rejectFinishWaiter(throwable);
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #lifecycleError(message: string): TvicThrowableError {
    return this.#outcomeError(
      providerError(PROVIDER_ERROR_CODES.sarvamTts, message, {
        provider: PROVIDER_NAMES.sarvamTts,
        retriable: false,
      }),
    );
  }

  #protocolError(message: string): TvicThrowableError {
    return this.#outcomeError(
      providerError(TVIC_ERROR_CODES.providerProtocolInvalid, message, {
        provider: PROVIDER_NAMES.sarvamTts,
        retriable: false,
      }),
    );
  }

  #outcomeError(error: unknown): TvicThrowableError {
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    if (!this.#requestSubmitted) return throwable;

    const normalized = throwable.error;
    const knownRejection =
      normalized.category === "cancelled" ||
      normalized.category === "interrupted" ||
      (this.#totalOutputChunks === 0 &&
        (normalized.code === TVIC_ERROR_CODES.providerAuthFailed ||
          normalized.code === TVIC_ERROR_CODES.providerQuotaExceeded ||
          normalized.code === TVIC_ERROR_CODES.providerRateLimited ||
          normalized.code === TVIC_ERROR_CODES.providerInvalidRequest));
    return knownRejection
      ? throwable
      : TvicThrowableError.from({
          ...normalized,
          retriable: false,
          metadata: { ...(normalized.metadata ?? {}), outcomeUnknown: true },
        });
  }
}

export function normalizeSarvamTtsConnectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const statusText = /^Unexpected server response:\s*(\d{3})\s*$/.exec(message)?.[1];
  const status = statusText === undefined ? undefined : Number(statusText);
  const code =
    status === 401 || status === 403
      ? TVIC_ERROR_CODES.providerAuthFailed
      : status === 402
        ? TVIC_ERROR_CODES.providerQuotaExceeded
        : status === 429
          ? TVIC_ERROR_CODES.providerRateLimited
          : status === 400 || status === 422
            ? TVIC_ERROR_CODES.providerInvalidRequest
            : status === 408 || status === 409 || (status !== undefined && status >= 500)
              ? TVIC_ERROR_CODES.providerUpstreamFailed
              : undefined;
  if (code) {
    return providerError(code, message, {
      provider: PROVIDER_NAMES.sarvamTts,
      retriable:
        code === TVIC_ERROR_CODES.providerRateLimited ||
        code === TVIC_ERROR_CODES.providerUpstreamFailed,
      metadata: { httpStatus: status },
      cause: error,
    });
  }
  return normalizeProviderError(error, {
    code: PROVIDER_ERROR_CODES.sarvamTts,
    provider: PROVIDER_NAMES.sarvamTts,
  });
}

function boundedString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function createSarvamTtsProvider(options: SarvamTtsProviderOptions): SarvamTtsProvider {
  return new SarvamTtsProvider(options);
}
