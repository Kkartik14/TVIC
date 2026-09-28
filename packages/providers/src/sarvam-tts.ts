import WebSocket from "ws";

import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  createMediaEvent,
  sameAudioFormat,
  validationError,
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

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
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
  providerThrowableError,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";
import { decodeSarvamTtsAudio } from "./sarvam-tts-audio.js";

export const SARVAM_TTS_LANGUAGES = Object.freeze([
  "hi-IN",
  "bn-IN",
  "ta-IN",
  "te-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "pa-IN",
  "od-IN",
  "en-IN",
] as const);

export type SarvamTtsLanguage = (typeof SARVAM_TTS_LANGUAGES)[number];

export const SARVAM_TTS_VOICES = Object.freeze([
  "shubh",
  "aditya",
  "ritu",
  "priya",
  "neha",
  "rahul",
  "pooja",
  "rohan",
  "simran",
  "kavya",
  "amit",
  "dev",
  "ishita",
  "shreya",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "roopa",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "anand",
  "tanya",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "shruti",
  "suhani",
  "mohit",
  "kavitha",
  "rehan",
  "soham",
  "rupali",
] as const);

export type SarvamTtsVoice = (typeof SARVAM_TTS_VOICES)[number];

const SARVAM_TTS_LANGUAGE_SET = new Set<string>(SARVAM_TTS_LANGUAGES);
const SARVAM_TTS_VOICE_SET = new Set<string>(SARVAM_TTS_VOICES);
const SARVAM_TTS_MAX_TEXT_CHARS = 2_500;
const SARVAM_TTS_DEFAULT_URL = "wss://api.sarvam.ai/text-to-speech/ws";
const SARVAM_TTS_KEEPALIVE_INTERVAL_MS = 30_000;
const SARVAM_TTS_MAX_REQUEST_ID_CHARS = 256;
const SARVAM_TTS_MAX_CONTENT_TYPE_CHARS = 128;

const SARVAM_TTS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  // Sarvam has no in-band cancel frame. Closing the socket stops TVIC from
  // accepting more output and is the provider's documented barge-in path.
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  languages: SARVAM_TTS_LANGUAGES,
  models: PROVIDER_CATALOG.sarvamTts.models,
  voices: SARVAM_TTS_VOICES,
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
  /** Provider pace. Sarvam v3 accepts 0.5 through 2.0. */
  readonly pace?: number;
  /** Provider temperature. Sarvam's streaming schema accepts 0.01 through 1.0. */
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
  readonly temperature: number;
  readonly minBufferSize: number;
  readonly maxChunkLength: number;
  readonly pronunciationDictionaryId?: string;
  readonly keepAliveIntervalMs: number;
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

export class SarvamTtsProvider implements IncrementalTextToSpeechProvider {
  readonly name = PROVIDER_NAMES.sarvamTts;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = SARVAM_TTS_CAPABILITIES;

  readonly #options: SarvamTtsProviderOptions;
  readonly #modelId: string;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<SarvamTtsProviderOptions["webSocketFactory"]>;

  constructor(options: SarvamTtsProviderOptions) {
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.sarvamTts.defaultModel;
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
    assertSarvamTtsText(request.text);
    const stream = await this.#open(request);
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

  async #open(request: TtsSessionOpenRequest): Promise<SarvamTtsStream> {
    assertSarvamTtsFormat(request);
    if (request.timestamps === true) {
      throw sarvamTtsValidationError("Sarvam Bulbul v3 does not provide alignment timestamps");
    }

    const model = request.model ?? this.#modelId;
    assertSupportedModel(PROVIDER_NAMES.sarvamTts, PROVIDER_CATALOG.sarvamTts.models, model);

    const voice = request.voice ?? this.#options.voiceId ?? ADAPTER_DEFAULTS.sarvamTts.voice;
    assertSarvamTtsVoice(voice);
    const language = this.#options.language ?? ADAPTER_DEFAULTS.sarvamTts.language;
    assertSarvamTtsLanguage(language);

    const pace = request.speed ?? this.#options.pace ?? ADAPTER_DEFAULTS.sarvamTts.pace;
    assertSarvamTtsNumber("pace", pace, 0.5, 2.0);
    const temperature = this.#options.temperature ?? ADAPTER_DEFAULTS.sarvamTts.temperature;
    assertSarvamTtsNumber("temperature", temperature, 0.01, 1.0);
    const minBufferSize = this.#options.minBufferSize ?? ADAPTER_DEFAULTS.sarvamTts.minBufferSize;
    assertSarvamTtsInteger("minBufferSize", minBufferSize, 30, 200);
    const maxChunkLength =
      this.#options.maxChunkLength ?? ADAPTER_DEFAULTS.sarvamTts.maxChunkLength;
    assertSarvamTtsInteger("maxChunkLength", maxChunkLength, 50, 500);
    const keepAliveIntervalMs =
      this.#options.keepAliveIntervalMs ?? SARVAM_TTS_KEEPALIVE_INTERVAL_MS;
    assertSarvamTtsInteger("keepAliveIntervalMs", keepAliveIntervalMs, 1_000, 60_000);

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
        language,
        voice,
        pace,
        temperature,
        minBufferSize,
        maxChunkLength,
        ...(this.#options.pronunciationDictionaryId
          ? { pronunciationDictionaryId: this.#options.pronunciationDictionaryId }
          : {}),
        keepAliveIntervalMs,
      });
    } catch (error) {
      if (socket) safeClose(socket);
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.sarvamTts,
          provider: PROVIDER_NAMES.sarvamTts,
        }),
      );
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
  readonly #finishWaiters: Array<{
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
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
  #completed = false;
  #cancelled = false;
  #keepAliveTimer: ReturnType<typeof setInterval> | undefined;

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
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.sarvamTts,
          provider: PROVIDER_NAMES.sarvamTts,
        }),
      ),
    );

    this.#send(this.#configMessage());
    this.#startKeepAlive();
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    assertSarvamTtsText(text);
    if (text.length === 0) return;
    if (text.length > SARVAM_TTS_MAX_TEXT_CHARS) {
      throw sarvamTtsValidationError(
        `Sarvam Bulbul v3 text chunks must be at most ${SARVAM_TTS_MAX_TEXT_CHARS} characters`,
      );
    }
    this.#send({ type: "text", data: { text } });
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    return this.#enqueueFlush();
  }

  async finish(): Promise<void> {
    if (this.#closed || this.#finishing) return;
    this.#assertWritable();
    this.#finishing = true;

    if (this.#flushWaiters.length === 0) {
      await this.#enqueueFlush();
    }
    if (this.#completed) return;
    await new Promise<void>((resolve, reject) => {
      this.#finishWaiters.push({ resolve, reject });
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
    this.#rejectFinishWaiters(error);
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
        temperature: this.#options.temperature,
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
      this.#fail(this.#lifecycleError("Sarvam TTS returned malformed JSON"));
      return;
    }

    const data = asRecord(message.data);
    if (message.type === "audio") {
      if (!data || typeof data.content_type !== "string") {
        this.#fail(this.#lifecycleError("Sarvam TTS returned audio without content_type"));
        return;
      }
      if (
        data.content_type.length === 0 ||
        data.content_type.length > SARVAM_TTS_MAX_CONTENT_TYPE_CHARS
      ) {
        this.#fail(this.#lifecycleError("Sarvam TTS returned an invalid audio content_type"));
        return;
      }
      if (typeof data.audio !== "string") {
        this.#fail(this.#lifecycleError("Sarvam TTS returned audio without base64 data"));
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = decodeSarvamTtsAudio(data.audio);
      } catch {
        this.#fail(this.#lifecycleError("Sarvam TTS returned malformed linear16 audio"));
        return;
      }
      this.#pushAudio(
        bytes,
        data.content_type,
        typeof data.request_id === "string"
          ? boundedString(data.request_id, SARVAM_TTS_MAX_REQUEST_ID_CHARS)
          : undefined,
      );
      return;
    }

    if (message.type === "event") {
      if (typeof data?.event_type !== "string" || data.event_type !== "final") {
        this.#fail(this.#lifecycleError("Sarvam TTS returned an unknown event"));
        return;
      }
      this.#handleFinalEvent();
      return;
    }

    if (message.type === "error") {
      if (!data || typeof data.message !== "string" || data.message.length === 0) {
        this.#fail(this.#lifecycleError("Sarvam TTS returned a malformed provider error"));
        return;
      }
      const vendorCode =
        typeof data.code === "number" && Number.isSafeInteger(data.code)
          ? String(data.code)
          : typeof data.code === "string"
            ? boundedString(data.code, 128)
            : undefined;
      this.#fail(sarvamTtsProtocolError(vendorCode, boundedString(data.message, 1_024)));
      return;
    }

    this.#fail(this.#lifecycleError("Sarvam TTS returned an unexpected message type"));
  }

  #handleFinalEvent(): void {
    const waiter = this.#flushWaiters[0];
    if (!waiter) {
      this.#fail(this.#lifecycleError("Sarvam TTS returned an uncorrelated final event"));
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
      this.#resolveFinishWaiters();
    }
  }

  #pushAudio(bytes: Uint8Array, contentType: string, requestId: string | undefined): void {
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
    if (pushed) this.#mediaSequence += 1;
    return pushed;
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    if (safeSend(this.#socket, JSON.stringify(message))) return;
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
        // #send already fails the stream and closes the socket.
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
    this.#fail(sarvamTtsCloseError(code, reason));
  }

  #closeQueue(): void {
    if (this.#closed) return;
    this.#closed = true;
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

  #resolveFinishWaiters(): void {
    for (const waiter of this.#finishWaiters.splice(0)) waiter.resolve();
  }

  #rejectFinishWaiters(error: unknown): void {
    for (const waiter of this.#finishWaiters.splice(0)) waiter.reject(error);
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    this.#closed = true;
    this.#clearKeepAlive();
    this.#rejectFlushes(throwable);
    this.#rejectFinishWaiters(throwable);
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #lifecycleError(message: string): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.sarvamTts, message, {
        provider: PROVIDER_NAMES.sarvamTts,
        retriable: false,
      }),
    );
  }
}

export function sarvamTtsCloseError(code = 1006, reason?: Buffer) {
  const retriable = code === 1001 || code === 1006 || code === 1011;
  return providerError(
    retriable ? TVIC_ERROR_CODES.providerUpstreamFailed : TVIC_ERROR_CODES.providerProtocolInvalid,
    "Sarvam TTS socket closed before generation completed",
    {
      provider: PROVIDER_NAMES.sarvamTts,
      retriable,
      metadata: {
        wsCloseCode: code,
        ...(reason && reason.length > 0 ? { wsCloseReason: reason.toString("utf8") } : {}),
      },
    },
  );
}

function assertSarvamTtsFormat(request: TtsSessionOpenRequest): void {
  if (!sameAudioFormat(request.format, PCM16_16K_MONO)) {
    throw sarvamTtsValidationError("Sarvam TTS requires 16kHz PCM16 mono output", {
      format: request.format,
    });
  }
}

function assertSarvamTtsText(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw sarvamTtsValidationError("Sarvam TTS text must be a string");
  }
}

function assertSarvamTtsVoice(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SARVAM_TTS_VOICE_SET.has(value)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerVoiceUnsupported,
        "Sarvam Bulbul v3 voice is invalid",
        {
          provider: PROVIDER_NAMES.sarvamTts,
          metadata: {
            voice: typeof value === "string" ? value : undefined,
            supportedVoices: SARVAM_TTS_VOICES,
          },
        },
      ),
    );
  }
}

function assertSarvamTtsLanguage(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SARVAM_TTS_LANGUAGE_SET.has(value)) {
    throw sarvamTtsValidationError("Sarvam Bulbul v3 language is invalid", {
      language: typeof value === "string" ? value : undefined,
      supportedLanguages: SARVAM_TTS_LANGUAGES,
    });
  }
}

function assertSarvamTtsNumber(
  name: string,
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw sarvamTtsValidationError(`Sarvam Bulbul v3 ${name} must be between ${min} and ${max}`, {
      [name]: value,
    });
  }
}

function assertSarvamTtsInteger(
  name: string,
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw sarvamTtsValidationError(
      `Sarvam TTS ${name} must be an integer between ${min} and ${max}`,
      {
        [name]: value,
      },
    );
  }
}

function sarvamTtsValidationError(
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): TvicThrowableError {
  const options =
    metadata === undefined
      ? { provider: PROVIDER_NAMES.sarvamTts }
      : { provider: PROVIDER_NAMES.sarvamTts, metadata };
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, options),
  );
}

export function sarvamTtsProtocolError(vendorCode: string | undefined, message: string) {
  const value = (vendorCode ? `${vendorCode} ${message}` : message).toLowerCase();
  const code = /auth|key|credential|forbidden|permission/.test(value)
    ? TVIC_ERROR_CODES.providerAuthFailed
    : /quota|balance|rate|limit|too_many/.test(value)
      ? TVIC_ERROR_CODES.providerRateLimited
      : /model|voice|invalid|request|parameter|schema|text|language/.test(value)
        ? TVIC_ERROR_CODES.providerInvalidRequest
        : TVIC_ERROR_CODES.providerUpstreamFailed;
  return providerError(code, message, {
    provider: PROVIDER_NAMES.sarvamTts,
    retriable:
      code === TVIC_ERROR_CODES.providerRateLimited ||
      code === TVIC_ERROR_CODES.providerUpstreamFailed,
    metadata: { ...(vendorCode ? { providerCode: vendorCode } : {}) },
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
