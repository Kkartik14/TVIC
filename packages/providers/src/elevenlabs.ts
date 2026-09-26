import WebSocket from "ws";

import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  createMediaEvent,
  sameAudioFormat,
  TvicThrowableError,
} from "@tvic/core";
import type {
  AudioFormat,
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

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  MAX_PROVIDER_FRAME_BYTES,
  providerFrameTooLarge,
  providerEventQueueOverflow,
  providerThrowableError,
  providerError,
  assertSupportedModel,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";
import {
  assertElevenLabsRequest,
  elevenLabsTtsProtocol,
  resolveDialogueVoices,
  toProviderPronunciationDictionaries,
  type ElevenLabsDialogueTurnOptions,
  type ElevenLabsPronunciationDictionaryLocator,
  type ElevenLabsTextNormalization,
  type ElevenLabsTtsProviderOptions,
  type ElevenLabsTtsProtocol,
  type ElevenLabsTtsSendTextOptions,
} from "./elevenlabs-options.js";

export type {
  ElevenLabsDialogueTurnOptions,
  ElevenLabsPronunciationDictionaryLocator,
  ElevenLabsTextNormalization,
  ElevenLabsTtsProviderOptions,
  ElevenLabsTtsSendTextOptions,
} from "./elevenlabs-options.js";

const ELEVENLABS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.elevenlabs.models,
} satisfies ProviderCapabilities;

const ELEVENLABS_TTS_CHARACTER_LIMITS: Readonly<Record<string, number | undefined>> = {
  eleven_v3: 5_000,
  eleven_v3_conversational: 5_000,
  eleven_multilingual_v2: 10_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
  eleven_turbo_v2_5: 40_000,
  eleven_turbo_v2: 30_000,
};

interface ElevenLabsMessage extends Readonly<Record<string, unknown>> {
  readonly audio?: string | null;
  readonly isFinal?: boolean | null;
  readonly is_final?: boolean | null;
  readonly is_final_audio_for_turn?: boolean | null;
  readonly alignment?: ElevenLabsAlignment | null;
  readonly normalizedAlignment?: ElevenLabsAlignment | null;
  readonly normalized_alignment?: ElevenLabsAlignment | null;
  readonly error?: string;
  readonly message?: string;
}

interface ElevenLabsAlignment {
  readonly chars?: readonly unknown[];
  readonly charStartTimesMs?: readonly unknown[];
  readonly charDurationsMs?: readonly unknown[];
  readonly char_start_times_ms?: readonly unknown[];
  readonly char_durations_ms?: readonly unknown[];
}

interface ElevenLabsStreamOptions {
  readonly clock: ProviderClock;
  readonly modelId?: string;
  readonly protocol?: ElevenLabsTtsProtocol;
  readonly voice?: string;
  readonly voices?: readonly string[];
  readonly maxCharacters?: number | undefined;
  readonly stability: number;
  readonly similarityBoost: number;
  readonly useSpeakerBoost?: boolean | undefined;
  readonly applyTextNormalization?: ElevenLabsTextNormalization | undefined;
  readonly chunkLengthSchedule?: readonly number[] | undefined;
  readonly pronunciationDictionaryLocators?:
    | readonly ElevenLabsPronunciationDictionaryLocator[]
    | undefined;
}

interface ResolvedElevenLabsStreamOptions {
  readonly clock: ProviderClock;
  readonly modelId: string;
  readonly protocol: ElevenLabsTtsProtocol;
  readonly voice: string;
  readonly voices: readonly string[];
  readonly maxCharacters: number | undefined;
  readonly stability: number;
  readonly similarityBoost: number;
  readonly useSpeakerBoost: boolean | undefined;
  readonly applyTextNormalization: ElevenLabsTextNormalization | undefined;
  readonly chunkLengthSchedule: readonly number[] | undefined;
  readonly pronunciationDictionaryLocators:
    | readonly ElevenLabsPronunciationDictionaryLocator[]
    | undefined;
}

export class ElevenLabsTtsProvider implements IncrementalTextToSpeechProvider {
  readonly name = PROVIDER_NAMES.elevenlabs;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = ELEVENLABS_CAPABILITIES;

  readonly #options: ElevenLabsTtsProviderOptions;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<ElevenLabsTtsProviderOptions["webSocketFactory"]>;

  constructor(options: ElevenLabsTtsProviderOptions) {
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
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
    assertElevenLabsText(request.text);
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

  openSession(request: TtsSessionOpenRequest): Promise<ElevenLabsTtsStream> {
    return this.#open(request);
  }

  async #open(request: TtsSessionOpenRequest): Promise<ElevenLabsTtsStream> {
    assertElevenLabsFormat(request);
    const model = request.model ?? this.#modelId;
    assertElevenLabsModel(model);
    assertSupportedModel(
      PROVIDER_NAMES.elevenlabs,
      PROVIDER_CATALOG.elevenlabs.models,
      model,
      this.#allowUnknownModel,
    );
    const voice = request.voice ?? this.#options.voiceId;
    const protocol = elevenLabsTtsProtocol(model);
    assertElevenLabsRequest(request, this.#options, protocol, voice);
    const voices =
      protocol === "dialogue"
        ? resolveDialogueVoices(model, voice, this.#options.dialogueVoices)
        : [voice];
    const socket = this.#webSocketFactory(this.#url(request, model, protocol, voice), {
      "xi-api-key": this.#options.apiKey,
    });
    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      return new ElevenLabsTtsStream(socket, request, {
        clock: this.#clock,
        modelId: model,
        protocol,
        voice,
        voices,
        maxCharacters: ELEVENLABS_TTS_CHARACTER_LIMITS[model],
        stability: this.#options.stability ?? 0.5,
        similarityBoost: this.#options.similarityBoost ?? 0.8,
        useSpeakerBoost: this.#options.useSpeakerBoost,
        applyTextNormalization: this.#options.applyTextNormalization,
        chunkLengthSchedule: this.#options.chunkLengthSchedule,
        pronunciationDictionaryLocators: this.#options.pronunciationDictionaryLocators,
      });
    } catch (error) {
      safeClose(socket);
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.elevenlabsTts,
          provider: PROVIDER_NAMES.elevenlabs,
        }),
      );
    }
  }

  #url(
    request: TtsSessionOpenRequest,
    model: string,
    protocol: ElevenLabsTtsProtocol,
    voiceId: string,
  ): string {
    const voice = encodeURIComponent(voiceId);
    const base =
      this.#options.url ??
      (protocol === "dialogue"
        ? "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input"
        : `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input`);
    const url = new URL(base);
    url.searchParams.set("model_id", model);
    url.searchParams.set("output_format", "pcm_16000");
    if (request.timestamps) {
      url.searchParams.set("sync_alignment", "true");
    }
    if (this.#options.language) {
      if (model !== "eleven_multilingual_v2") {
        url.searchParams.set("language_code", this.#options.language);
      }
    }
    if (this.#options.enableLogging !== undefined) {
      url.searchParams.set("enable_logging", String(this.#options.enableLogging));
    }
    if (this.#options.applyTextNormalization !== undefined) {
      url.searchParams.set("apply_text_normalization", this.#options.applyTextNormalization);
    }
    if (this.#options.seed !== undefined) {
      url.searchParams.set("seed", String(this.#options.seed));
    }
    if (protocol === "tts") {
      if (this.#options.autoMode !== undefined) {
        url.searchParams.set("auto_mode", String(this.#options.autoMode));
      }
      if (this.#options.inactivityTimeoutSeconds !== undefined) {
        url.searchParams.set("inactivity_timeout", String(this.#options.inactivityTimeoutSeconds));
      }
      if (this.#options.enableSsmlParsing !== undefined) {
        url.searchParams.set("enable_ssml_parsing", String(this.#options.enableSsmlParsing));
      }
    }
    return url.toString();
  }
}

export class ElevenLabsTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: ResolvedElevenLabsStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs);
      this.#fail(error);
      return error;
    },
  });
  readonly #mediaIds: CounterIdGenerator<MediaEventId>;
  readonly #flushIds = counterIdGenerator<string>("elevenlabs_flush");
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  #frameCount = 0;
  #outputBytes = 0;
  #textLength = 0;
  #closed = false;
  #finishing = false;
  #completed = false;
  #cancelled = false;

  constructor(socket: WebSocket, request: TtsSessionOpenRequest, options: ElevenLabsStreamOptions) {
    this.#socket = socket;
    this.#request = request;
    const modelId = options.modelId ?? request.model ?? PROVIDER_CATALOG.elevenlabs.defaultModel;
    this.#options = {
      clock: options.clock,
      modelId,
      protocol: options.protocol ?? "tts",
      voice: options.voice ?? request.voice ?? "",
      voices: options.voices ?? [options.voice ?? request.voice ?? ""],
      maxCharacters: options.maxCharacters ?? ELEVENLABS_TTS_CHARACTER_LIMITS[modelId],
      stability: options.stability,
      similarityBoost: options.similarityBoost,
      useSpeakerBoost: options.useSpeakerBoost,
      applyTextNormalization: options.applyTextNormalization,
      chunkLengthSchedule: options.chunkLengthSchedule,
      pronunciationDictionaryLocators: options.pronunciationDictionaryLocators,
    };
    this.#mediaIds = counterIdGenerator<MediaEventId>(
      `elevenlabs_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    this.events = this.#events;

    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(providerFrameTooLarge(PROVIDER_NAMES.elevenlabs));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("close", () => {
      if (this.#closed) return;
      if (this.#completed || this.#cancelled) {
        this.#closeQueue();
        return;
      }
      this.#fail(this.#error("ElevenLabs socket closed before isFinal"));
    });
    socket.on("error", (error) =>
      this.#fail(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.elevenlabsTts,
          provider: PROVIDER_NAMES.elevenlabs,
        }),
      ),
    );

    const voiceSettings = {
      stability: options.stability,
      ...(options.protocol === "tts"
        ? {
            similarity_boost: options.similarityBoost,
            ...(options.useSpeakerBoost !== undefined
              ? { use_speaker_boost: options.useSpeakerBoost }
              : {}),
            ...(request.speed !== undefined ? { speed: request.speed } : {}),
          }
        : {}),
    };
    this.#send(
      options.protocol === "dialogue"
        ? {
            voices: this.#options.voices,
            voice_settings: voiceSettings,
            ...(this.#options.pronunciationDictionaryLocators
              ? {
                  pronunciation_dictionary_locators: toProviderPronunciationDictionaries(
                    this.#options.pronunciationDictionaryLocators,
                  ),
                }
              : {}),
          }
        : {
            text: " ",
            voice_settings: voiceSettings,
            ...(this.#options.chunkLengthSchedule
              ? { generation_config: { chunk_length_schedule: this.#options.chunkLengthSchedule } }
              : {}),
            ...(this.#options.pronunciationDictionaryLocators
              ? {
                  pronunciation_dictionary_locators: toProviderPronunciationDictionaries(
                    this.#options.pronunciationDictionaryLocators,
                  ),
                }
              : {}),
          },
    );
  }

  async sendText(text: string, options: ElevenLabsTtsSendTextOptions = {}): Promise<void> {
    assertElevenLabsText(text);
    this.#assertWritable();
    if (!text && !options.tryTriggerGeneration) return;
    if (this.#options.protocol === "dialogue") {
      if (options.tryTriggerGeneration) {
        throw this.#error("tryTriggerGeneration is only supported by regular ElevenLabs TTS");
      }
      await this.sendDialogueTurn(text);
      return;
    }
    this.#sendText(text, {
      ...(options.tryTriggerGeneration ? { try_trigger_generation: true } : {}),
    });
  }

  /** Sends one incremental line in a Text-to-Dialogue session. */
  async sendDialogueTurn(text: string, options: ElevenLabsDialogueTurnOptions = {}): Promise<void> {
    assertElevenLabsText(text);
    this.#assertWritable();
    if (this.#options.protocol !== "dialogue") {
      throw this.#error("sendDialogueTurn is only supported by ElevenLabs v3 dialogue models");
    }
    const voice = options.voiceId ?? this.#options.voice;
    if (!this.#options.voices.includes(voice)) {
      throw this.#error("ElevenLabs dialogue voice is not registered for this session");
    }
    if (!text) return;
    this.#sendText(text, {
      voice_id: voice,
      ...(options.newTurn ? { new_turn: true } : {}),
    });
  }

  /** Resets the provider receive timeout without causing a generation. */
  async keepAlive(): Promise<void> {
    this.#assertWritable();
    if (this.#options.protocol !== "dialogue") {
      throw this.#error("keepAlive is only supported by ElevenLabs Text-to-Dialogue");
    }
    this.#send({ keep_alive: true });
  }

  #sendText(text: string, extra: Readonly<Record<string, unknown>> = {}): void {
    if (!text && Object.keys(extra).length === 0) return;
    if (
      this.#options.maxCharacters !== undefined &&
      this.#textLength + text.length > this.#options.maxCharacters
    ) {
      throw this.#error(
        `ElevenLabs ${this.#options.modelId} accepts at most ${this.#options.maxCharacters} characters per session`,
      );
    }
    this.#send(
      this.#options.protocol === "dialogue"
        ? {
            inputs: [
              { text, voice_id: extra.voice_id, ...(extra.new_turn ? { new_turn: true } : {}) },
            ],
          }
        : { text, ...extra },
    );
    this.#textLength += text.length;
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    const id = this.#flushIds.next();
    this.#send(
      this.#options.protocol === "dialogue" ? { flush: true } : { text: " ", flush: true },
    );
    if (
      !this.#pushEvent({
        type: "tts.flush.completed",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence: this.#controlSequence,
        provider: PROVIDER_NAMES.elevenlabs,
        timestamp: this.#options.clock.now(),
        flushId: id,
        acknowledgedBy: "transport",
      })
    ) {
      throw TvicThrowableError.from(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs));
    }
    this.#controlSequence += 1;
    return { id, acknowledgedBy: "transport" };
  }

  async finish(): Promise<void> {
    if (this.#finishing || this.#closed) {
      return;
    }
    this.#assertWritable();
    this.#finishing = true;
    this.#send(this.#options.protocol === "dialogue" ? { close_socket: true } : { text: "" });
  }

  async cancel(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#cancelled = true;
    this.#closeQueue();
    closeElevenLabsSocket(this.#socket);
  }

  #handleMessage(body: string): void {
    if (this.#closed) return;
    const parsed = parseJsonObject(body);
    if (!parsed) {
      this.#fail(this.#error("ElevenLabs returned malformed JSON"));
      return;
    }
    const message = parsed as ElevenLabsMessage;
    const unknownKeys = Object.keys(message).filter((key) => !ELEVENLABS_MESSAGE_KEYS.has(key));
    if (unknownKeys.length > 0) {
      this.#fail(this.#error("ElevenLabs returned an unknown message type"));
      return;
    }
    if (
      (message.error !== undefined && typeof message.error !== "string") ||
      (message.message !== undefined && typeof message.message !== "string")
    ) {
      this.#fail(this.#error("ElevenLabs returned a malformed provider error"));
      return;
    }
    if (message.error !== undefined || message.message !== undefined) {
      this.#fail(
        this.#error(
          boundedProviderMessage(message.error ?? message.message ?? "ElevenLabs synthesis failed"),
        ),
      );
      return;
    }
    if (
      (message.isFinal !== undefined &&
        message.isFinal !== null &&
        typeof message.isFinal !== "boolean") ||
      (message.is_final !== undefined &&
        message.is_final !== null &&
        typeof message.is_final !== "boolean") ||
      (message.is_final_audio_for_turn !== undefined &&
        message.is_final_audio_for_turn !== null &&
        typeof message.is_final_audio_for_turn !== "boolean") ||
      (message.isFinal !== undefined &&
        message.isFinal !== null &&
        message.is_final !== undefined &&
        message.is_final !== null &&
        message.isFinal !== message.is_final)
    ) {
      this.#fail(this.#error("ElevenLabs returned a malformed finality marker"));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "audio")) {
      const isFinal =
        message.isFinal === true ||
        message.is_final === true ||
        message.is_final_audio_for_turn === true;
      if (message.audio === null && isFinal) {
        // ElevenLabs uses a null audio field on its terminal isFinal frame.
      } else if (typeof message.audio !== "string") {
        this.#fail(this.#error("ElevenLabs returned malformed audio data"));
        return;
      } else {
        let bytes: Uint8Array;
        try {
          bytes = decodeElevenLabsAudio(message.audio);
        } catch {
          this.#fail(this.#error("ElevenLabs returned malformed PCM audio"));
          return;
        }
        if (!this.#pushAudio(bytes)) return;
      }
    }
    const hasAlignment =
      (message.alignment !== undefined && message.alignment !== null) ||
      (message.normalizedAlignment !== undefined && message.normalizedAlignment !== null) ||
      (message.normalized_alignment !== undefined && message.normalized_alignment !== null);
    const alignment = parseAlignment(
      message.normalizedAlignment ?? message.normalized_alignment ?? message.alignment ?? undefined,
    );
    if (alignment) {
      if (
        !this.#pushEvent({
          type: "tts.alignment",
          sessionId: this.#request.sessionId,
          turnId: this.#request.turnId,
          sequence: this.#controlSequence,
          provider: PROVIDER_NAMES.elevenlabs,
          timestamp: this.#options.clock.now(),
          unit: "character",
          tokens: alignment.tokens,
          startMs: alignment.startMs,
          endMs: alignment.endMs,
        })
      ) {
        return;
      }
      this.#controlSequence += 1;
    } else if (hasAlignment) {
      this.#fail(this.#error("ElevenLabs returned malformed alignment data"));
      return;
    }

    if (message.isFinal === true || message.is_final === true) {
      if (!this.#pushEvent(this.#committedEvent())) return;
      this.#completed = true;
      this.#closeQueue();
      closeElevenLabsSocket(this.#socket);
    }
  }

  #pushAudio(bytes: Uint8Array): boolean {
    if (
      this.#chunkIds.length >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
      this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs));
      return false;
    }
    const frames = frameCountForPcm16le(bytes);
    const id = this.#mediaEventId("chunk");
    const event = createMediaEvent({
      id,
      type: "media.audio.chunk",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.elevenlabs,
      audio: {
        format: this.#request.format,
        durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
        frameCount: frames,
        bytes,
      },
    });
    if (!this.#pushEvent(event)) return false;
    this.#frameCount += frames;
    this.#outputBytes += bytes.byteLength;
    this.#chunkIds.push(id);
    this.#chunkSequences.push(this.#mediaSequence);
    this.#mediaSequence += 1;
    return true;
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
      provider: PROVIDER_NAMES.elevenlabs,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: this.#chunkIds,
    });
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    if (!safeSend(this.#socket, JSON.stringify(message))) {
      const error = this.#error("ElevenLabs socket is not writable");
      this.#fail(error);
      throw error;
    }
  }

  #assertWritable(): void {
    if (this.#closed) {
      throw this.#error("ElevenLabs synthesis session is closed");
    }
    if (this.#finishing) {
      throw this.#error("ElevenLabs synthesis session is already finishing");
    }
  }

  #mediaEventId(kind: string): MediaEventId {
    return `${this.#mediaIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #closeQueue(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#events.close();
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs));
    return false;
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.elevenlabsTts,
      provider: PROVIDER_NAMES.elevenlabs,
    });
    this.#closed = true;
    this.#events.fail(throwable);
    closeElevenLabsSocket(this.#socket);
  }

  #error(message: string): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
      }),
    );
  }
}

function assertElevenLabsFormat(request: TtsSessionOpenRequest): void {
  if (!isAudioFormat(request.format) || !sameAudioFormat(request.format, PCM16_16K_MONO)) {
    throw TvicThrowableError.from(
      providerError(
        PROVIDER_ERROR_CODES.elevenlabsTts,
        "ElevenLabs adapter requires 16kHz PCM16 mono output",
        { provider: PROVIDER_NAMES.elevenlabs, retriable: false },
      ),
    );
  }
}

function assertElevenLabsText(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, "ElevenLabs text must be a string", {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
      }),
    );
  }
}

function assertElevenLabsModel(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw TvicThrowableError.from(
      providerError(PROVIDER_ERROR_CODES.elevenlabsTts, "ElevenLabs model id is invalid", {
        provider: PROVIDER_NAMES.elevenlabs,
        retriable: false,
      }),
    );
  }
}

function isAudioFormat(value: unknown): value is AudioFormat {
  if (typeof value !== "object" || value === null) return false;
  const format = value as Record<string, unknown>;
  return (
    typeof format.encoding === "string" &&
    typeof format.sampleRateHz === "number" &&
    typeof format.channels === "number"
  );
}

function parseAlignment(alignment: ElevenLabsAlignment | undefined): {
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
} | null {
  const tokens = alignment?.chars;
  const start = alignment?.charStartTimesMs ?? alignment?.char_start_times_ms;
  const duration = alignment?.charDurationsMs ?? alignment?.char_durations_ms;
  if (
    !Array.isArray(tokens) ||
    !Array.isArray(start) ||
    !Array.isArray(duration) ||
    tokens.length !== start.length ||
    tokens.length !== duration.length ||
    tokens.length > 4096 ||
    !tokens.every((value): value is string => typeof value === "string") ||
    !tokens.every((value) => value.length <= 256) ||
    !start.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) ||
    !duration.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  ) {
    return null;
  }
  const endMs = start.map((value, index) => value + duration[index]!);
  if (!endMs.every((value) => Number.isFinite(value) && value >= 0)) return null;
  return {
    tokens,
    startMs: start,
    endMs,
  };
}

const ELEVENLABS_MESSAGE_KEYS = new Set([
  "audio",
  "isFinal",
  "is_final",
  "is_final_audio_for_turn",
  "alignment",
  "normalizedAlignment",
  "normalized_alignment",
  "error",
  "message",
]);

function boundedProviderMessage(value: string): string {
  return value.length <= 1024 ? value : value.slice(0, 1021) + "...";
}

function decodeElevenLabsAudio(value: string): Uint8Array {
  if (
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("invalid base64");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  const canonical = Buffer.from(bytes).toString("base64");
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || canonical !== value) {
    throw new Error("invalid pcm16le");
  }
  return bytes;
}

function closeElevenLabsSocket(socket: WebSocket): void {
  safeClose(socket);
  if (socket.readyState === WebSocket.CLOSED || typeof socket.terminate !== "function") return;
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 250);
  timer.unref?.();
}

export function createElevenLabsTtsProvider(
  options: ElevenLabsTtsProviderOptions,
): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider(options);
}
