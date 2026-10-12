import WebSocket from "ws";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  createMediaEvent,
  TvicThrowableError,
} from "@tvic/core";
import type {
  AudioFormat,
  CounterIdGenerator,
  MediaAudioCommittedEvent,
  MediaEventId,
  ProviderCapabilities,
  SessionId,
  TtsEvent,
  TtsFlushResult,
  TtsSession,
  TtsSessionOpenRequest,
  TurnId,
} from "@tvic/core";
import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  providerError,
  providerEventQueueOverflow,
  providerThrowableError,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  assertSupportedModel,
  type ProviderClock,
} from "./common.js";
import {
  ELEVENLABS_DIALOGUE_MAX_CHARACTERS,
  ELEVENLABS_TTS_CHARACTER_LIMITS,
} from "./elevenlabs-http.js";
import {
  assertElevenLabsRequest,
  resolveDialogueVoices,
  toProviderPronunciationDictionaries,
  type ElevenLabsDialogueTurnOptions,
  type ElevenLabsTtsProviderOptions,
} from "./elevenlabs-options.js";
import {
  assertContextId,
  assertMultiContextFormat,
  assertText,
  boundedProviderMessage,
  decodePcm,
  parseAlignment,
  type ParsedAlignment,
} from "./elevenlabs-multi-context-helpers.js";

const ELEVENLABS_MULTI_CONTEXT_LIMIT = 5;
const ELEVENLABS_MULTI_TTS_DEFAULT_MODEL = "eleven_multilingual_v2";
const ELEVENLABS_MULTI_DIALOGUE_DEFAULT_MODEL = "eleven_v3_conversational";

const ELEVENLABS_MULTI_CONTEXT_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.elevenlabs.models,
  metadata: {
    transport: "websocket",
    multiContext: true,
    maxContexts: ELEVENLABS_MULTI_CONTEXT_LIMIT,
    protocols: ["tts", "dialogue"],
    wireOutputFormat: "pcm_16000",
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation:
      "https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input",
  },
} satisfies ProviderCapabilities;

export type ElevenLabsMultiContextProtocol = "tts" | "dialogue";

export interface ElevenLabsMultiContextProviderOptions extends Omit<
  ElevenLabsTtsProviderOptions,
  "url" | "voiceId" | "webSocketFactory" | "dialogueVoices"
> {
  /** Selects the multiplexed endpoint. Defaults to regular TTS. */
  readonly protocol?: ElevenLabsMultiContextProtocol;
  /** Regular TTS multi-context requires the path voice ID. */
  readonly voiceId?: string;
  /** Default registered voices for dialogue contexts. */
  readonly dialogueVoices?: readonly string[];
  readonly url?: string;
  readonly dialogueUrl?: string;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

export interface ElevenLabsMultiContextOpenRequest {
  readonly contextId: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly voice?: string;
  readonly voices?: readonly string[];
  readonly model?: string;
  readonly format: AudioFormat;
  readonly speed?: number;
  readonly timestamps?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ElevenLabsMultiContextSendTextOptions {
  /** Regular TTS only. Requests generation before the normal provider schedule. */
  readonly tryTriggerGeneration?: boolean;
}

export interface ElevenLabsMultiContextSession extends TtsSession {
  readonly contextId: string;
  sendText(text: string, options?: ElevenLabsMultiContextSendTextOptions): Promise<void>;
  sendDialogueTurn(text: string, options?: ElevenLabsDialogueTurnOptions): Promise<void>;
  keepAlive(): Promise<void>;
}

export interface ElevenLabsTtsMultiContextConnection {
  readonly contexts: number;
  openContext(request: ElevenLabsMultiContextOpenRequest): Promise<ElevenLabsMultiContextSession>;
  close(): Promise<void>;
}

export class ElevenLabsMultiContextProvider {
  readonly name = PROVIDER_NAMES.elevenlabs;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities: ProviderCapabilities = ELEVENLABS_MULTI_CONTEXT_CAPABILITIES;

  readonly #options: ElevenLabsMultiContextProviderOptions;
  readonly #protocol: ElevenLabsMultiContextProtocol;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<
    ElevenLabsMultiContextProviderOptions["webSocketFactory"]
  >;

  constructor(options: ElevenLabsMultiContextProviderOptions) {
    this.#options = options;
    this.#protocol = options.protocol ?? "tts";
    this.#modelId =
      options.modelId ??
      (this.#protocol === "dialogue"
        ? ELEVENLABS_MULTI_DIALOGUE_DEFAULT_MODEL
        : ELEVENLABS_MULTI_TTS_DEFAULT_MODEL);
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

  async openConnection(signal?: AbortSignal): Promise<ElevenLabsTtsMultiContextConnection> {
    assertSupportedModel(
      PROVIDER_NAMES.elevenlabs,
      PROVIDER_CATALOG.elevenlabs.models,
      this.#modelId,
      this.#allowUnknownModel,
    );
    if (this.#protocol === "tts" && !this.#options.voiceId) {
      throw this.#error("ElevenLabs TTS multi-context requires a voiceId");
    }
    if (this.#protocol === "tts" && this.#modelId.startsWith("eleven_v3")) {
      throw this.#error("ElevenLabs v3 multi-context uses the Text-to-Dialogue endpoint");
    }
    if (this.#protocol === "dialogue" && !this.#modelId.startsWith("eleven_v3")) {
      throw this.#error("ElevenLabs dialogue multi-context requires an eleven_v3 model");
    }
    const url = this.#buildUrl();
    const socket = this.#webSocketFactory(url, { "xi-api-key": this.#options.apiKey });
    try {
      await openWebSocket(socket, signal ? { signal } : {});
      return new ElevenLabsTtsMultiContextConnectionImpl(socket, {
        clock: this.#clock,
        modelId: this.#modelId,
        options: this.#options,
        protocol: this.#protocol,
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

  #buildUrl(): string {
    const voice = this.#options.voiceId ? encodeURIComponent(this.#options.voiceId) : "";
    const base =
      this.#protocol === "dialogue"
        ? (this.#options.dialogueUrl ??
          "wss://api.elevenlabs.io/v1/text-to-dialogue/multi-stream-input")
        : (this.#options.url ??
          `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/multi-stream-input`);
    const url = new URL(base);
    url.searchParams.set("model_id", this.#modelId);
    url.searchParams.set("output_format", "pcm_16000");
    if (this.#options.language && this.#modelId !== "eleven_multilingual_v2") {
      url.searchParams.set("language_code", this.#options.language);
    }
    if (this.#options.enableLogging !== undefined) {
      url.searchParams.set("enable_logging", String(this.#options.enableLogging));
    }
    if (this.#options.applyTextNormalization !== undefined) {
      url.searchParams.set("apply_text_normalization", this.#options.applyTextNormalization);
    }
    if (this.#options.seed !== undefined) url.searchParams.set("seed", String(this.#options.seed));
    if (this.#options.autoMode !== undefined) {
      url.searchParams.set("auto_mode", String(this.#options.autoMode));
    }
    if (this.#options.inactivityTimeoutSeconds !== undefined) {
      url.searchParams.set("inactivity_timeout", String(this.#options.inactivityTimeoutSeconds));
    }
    if (this.#options.enableSsmlParsing !== undefined) {
      url.searchParams.set("enable_ssml_parsing", String(this.#options.enableSsmlParsing));
    }
    return url.toString();
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

interface ConnectionOptions {
  readonly clock: ProviderClock;
  readonly modelId: string;
  readonly options: ElevenLabsMultiContextProviderOptions;
  readonly protocol: ElevenLabsMultiContextProtocol;
}

interface MultiContextTransport {
  send(message: Readonly<Record<string, unknown>>): void;
  closeContext(contextId: string): void;
  remove(contextId: string): void;
  failAll(error: unknown): void;
}

class ElevenLabsTtsMultiContextConnectionImpl implements ElevenLabsTtsMultiContextConnection {
  readonly #socket: WebSocket;
  readonly #options: ConnectionOptions;
  readonly #contexts = new Map<string, ElevenLabsMultiContextSessionImpl>();
  #closed = false;

  constructor(socket: WebSocket, options: ConnectionOptions) {
    this.#socket = socket;
    this.#options = options;
    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.failAll(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("error", (error) => {
      this.failAll(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.elevenlabsTts,
          provider: PROVIDER_NAMES.elevenlabs,
        }),
      );
    });
    socket.on("close", () => {
      if (this.#closed) return;
      this.failAll(this.#error("ElevenLabs multi-context socket closed unexpectedly"));
    });
  }

  get contexts(): number {
    return this.#contexts.size;
  }

  async openContext(
    request: ElevenLabsMultiContextOpenRequest,
  ): Promise<ElevenLabsMultiContextSession> {
    this.#assertOpen();
    const config = this.#resolveContext(request);
    if (this.#contexts.has(config.contextId)) {
      throw this.#error(`ElevenLabs context ${config.contextId} is already open`);
    }
    if (this.#contexts.size >= ELEVENLABS_MULTI_CONTEXT_LIMIT) {
      throw this.#error("ElevenLabs multi-context connections support at most five contexts");
    }
    const context = new ElevenLabsMultiContextSessionImpl(this, config);
    this.#contexts.set(config.contextId, context);
    try {
      this.send(context.initialMessage());
      return context;
    } catch (error) {
      this.#contexts.delete(config.contextId);
      context.closeWithoutError();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket.readyState === WebSocket.OPEN) {
      safeSend(this.#socket, JSON.stringify({ close_socket: true }));
    }
    for (const context of this.#contexts.values()) context.closeWithoutError();
    this.#contexts.clear();
    safeClose(this.#socket);
  }

  send(message: Readonly<Record<string, unknown>>): void {
    this.#assertOpen();
    if (!safeSend(this.#socket, JSON.stringify(message))) {
      const error = this.#error("ElevenLabs multi-context socket is not writable");
      this.failAll(error);
      throw error;
    }
  }

  closeContext(contextId: string): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    safeSend(this.#socket, JSON.stringify({ context_id: contextId, close_context: true }));
  }

  remove(contextId: string): void {
    this.#contexts.delete(contextId);
  }

  failAll(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const context of this.#contexts.values()) context.fail(error);
    this.#contexts.clear();
    safeClose(this.#socket);
  }

  #handleMessage(body: string): void {
    if (this.#closed) return;
    const parsed = parseJsonObject(body);
    if (!parsed) {
      this.failAll(this.#error("ElevenLabs returned malformed multi-context JSON"));
      return;
    }
    const contextId = parsed.context_id ?? parsed.contextId;
    const context =
      typeof contextId === "string" && contextId.length > 0
        ? this.#contexts.get(contextId)
        : this.#contexts.size === 1
          ? this.#contexts.values().next().value
          : undefined;
    if (!context) {
      if (typeof contextId !== "string" || contextId.length === 0) {
        this.failAll(this.#error("ElevenLabs multi-context response omitted context_id"));
      } else {
        this.failAll(this.#error("ElevenLabs returned an unknown context_id"));
      }
      return;
    }
    if (typeof contextId !== "string" || contextId.length === 0) {
      // The documented response includes context_id. Some regular TTS
      // multi-context responses omit it; routing is safe only while one
      // context is active. With multiple contexts, fail closed above.
      context.handleMessage(parsed);
      return;
    }
    context.handleMessage(parsed);
  }

  #resolveContext(request: ElevenLabsMultiContextOpenRequest): ContextOptions {
    assertContextId(request.contextId);
    assertMultiContextFormat(request.format);
    const providerOptions = this.#options.options;
    const model = request.model ?? this.#options.modelId;
    assertSupportedModel(
      PROVIDER_NAMES.elevenlabs,
      PROVIDER_CATALOG.elevenlabs.models,
      model,
      providerOptions.allowUnknownModel ?? false,
    );
    if (this.#options.protocol === "tts" && model.startsWith("eleven_v3")) {
      throw this.#error("ElevenLabs v3 requires the dialogue multi-context protocol");
    }
    if (this.#options.protocol === "dialogue" && !model.startsWith("eleven_v3")) {
      throw this.#error("ElevenLabs dialogue multi-context requires an eleven_v3 model");
    }
    const primaryVoice = request.voice ?? providerOptions.voiceId ?? request.voices?.[0];
    if (!primaryVoice) throw this.#error("ElevenLabs context requires a voice id");
    if (this.#options.protocol === "tts" && primaryVoice !== providerOptions.voiceId) {
      throw this.#error("ElevenLabs TTS multi-context uses the provider voiceId for every context");
    }
    const openRequest: TtsSessionOpenRequest = {
      sessionId: request.sessionId,
      turnId: request.turnId,
      voice: primaryVoice,
      model,
      format: request.format,
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      ...(request.timestamps !== undefined ? { timestamps: request.timestamps } : {}),
    };
    assertElevenLabsRequest(
      openRequest,
      {
        ...providerOptions,
        apiKey: providerOptions.apiKey,
        voiceId: primaryVoice,
        ...(providerOptions.dialogueVoices
          ? { dialogueVoices: providerOptions.dialogueVoices }
          : {}),
      },
      this.#options.protocol,
      primaryVoice,
    );
    const voices =
      this.#options.protocol === "dialogue"
        ? resolveDialogueVoices(
            model,
            primaryVoice,
            request.voices ?? providerOptions.dialogueVoices,
          )
        : [primaryVoice];
    return {
      contextId: request.contextId,
      format: request.format,
      model,
      protocol: this.#options.protocol,
      primaryVoice,
      voices,
      sessionId: request.sessionId,
      turnId: request.turnId,
      speed: request.speed,
      timestamps: request.timestamps === true,
      clock: this.#options.clock,
      options: providerOptions,
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw this.#error("ElevenLabs multi-context connection is closed");
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

interface ContextOptions {
  readonly contextId: string;
  readonly format: AudioFormat;
  readonly model: string;
  readonly protocol: ElevenLabsMultiContextProtocol;
  readonly primaryVoice: string;
  readonly voices: readonly string[];
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly speed: number | undefined;
  readonly timestamps: boolean;
  readonly clock: ProviderClock;
  readonly options: ElevenLabsMultiContextProviderOptions;
}

class ElevenLabsMultiContextSessionImpl implements ElevenLabsMultiContextSession {
  readonly contextId: string;
  readonly events: AsyncIterable<TtsEvent>;
  readonly #transport: MultiContextTransport;
  readonly #options: ContextOptions;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs);
      this.fail(error);
      return error;
    },
  });
  readonly #mediaIds: CounterIdGenerator<MediaEventId>;
  readonly #flushIds = counterIdGenerator<string>("elevenlabs_multi_flush");
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  #frameCount = 0;
  #outputBytes = 0;
  #textLength = 0;
  #closed = false;
  #finishing = false;

  constructor(transport: MultiContextTransport, options: ContextOptions) {
    this.#transport = transport;
    this.#options = options;
    this.contextId = options.contextId;
    this.#mediaIds = counterIdGenerator<MediaEventId>(
      `elevenlabs_multi_${options.contextId}_${String(options.sessionId)}_${String(options.turnId)}`,
    );
    this.events = this.#events;
  }

  initialMessage(): Readonly<Record<string, unknown>> {
    const options = this.#options.options;
    if (this.#options.protocol === "dialogue") {
      return {
        context_id: this.contextId,
        voices: this.#options.voices,
        voice_settings: { stability: options.stability ?? 0.5 },
        ...(options.pronunciationDictionaryLocators
          ? {
              pronunciation_dictionary_locators: toProviderPronunciationDictionaries(
                options.pronunciationDictionaryLocators,
              ),
            }
          : {}),
      };
    }
    return {
      context_id: this.contextId,
      text: " ",
      voice_settings: {
        stability: options.stability ?? 0.5,
        similarity_boost: options.similarityBoost ?? 0.8,
        ...(options.useSpeakerBoost !== undefined
          ? { use_speaker_boost: options.useSpeakerBoost }
          : {}),
        ...(this.#options.speed !== undefined ? { speed: this.#options.speed } : {}),
      },
      ...(options.chunkLengthSchedule
        ? { generation_config: { chunk_length_schedule: options.chunkLengthSchedule } }
        : {}),
      ...(options.pronunciationDictionaryLocators
        ? {
            pronunciation_dictionary_locators: toProviderPronunciationDictionaries(
              options.pronunciationDictionaryLocators,
            ),
          }
        : {}),
    };
  }

  async sendText(
    text: string,
    sendOptions: ElevenLabsMultiContextSendTextOptions = {},
  ): Promise<void> {
    assertText(text);
    this.#assertWritable();
    if (this.#options.protocol === "dialogue") {
      if (sendOptions.tryTriggerGeneration) {
        throw this.#error("tryTriggerGeneration is only supported by regular ElevenLabs TTS");
      }
      await this.sendDialogueTurn(text);
      return;
    }
    if (!text && !sendOptions.tryTriggerGeneration) return;
    const maxCharacters = ELEVENLABS_TTS_CHARACTER_LIMITS[this.#options.model];
    if (maxCharacters !== undefined && this.#textLength + text.length > maxCharacters) {
      throw this.#error(
        `ElevenLabs ${this.#options.model} accepts at most ${maxCharacters} characters per context`,
      );
    }
    this.#send({
      context_id: this.contextId,
      text,
      ...(sendOptions.tryTriggerGeneration ? { try_trigger_generation: true } : {}),
    });
    this.#textLength += text.length;
  }

  async sendDialogueTurn(text: string, options: ElevenLabsDialogueTurnOptions = {}): Promise<void> {
    assertText(text);
    this.#assertWritable();
    if (this.#options.protocol !== "dialogue") {
      throw this.#error(
        "sendDialogueTurn is only supported by the dialogue multi-context endpoint",
      );
    }
    const voice = options.voiceId ?? this.#options.primaryVoice;
    if (!this.#options.voices.includes(voice)) {
      throw this.#error("ElevenLabs dialogue voice is not registered for this context");
    }
    if (!text) return;
    if (this.#textLength + text.length > ELEVENLABS_DIALOGUE_MAX_CHARACTERS) {
      throw this.#error(
        `ElevenLabs ${this.#options.model} accepts at most ${ELEVENLABS_DIALOGUE_MAX_CHARACTERS} characters per context`,
      );
    }
    this.#send({
      context_id: this.contextId,
      inputs: [
        {
          text,
          voice_id: voice,
          ...(options.newTurn ? { new_turn: true } : {}),
        },
      ],
    });
    this.#textLength += text.length;
  }

  async keepAlive(): Promise<void> {
    this.#assertWritable();
    this.#send({ context_id: this.contextId, keep_alive: true });
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    const id = this.#flushIds.next();
    this.#send(
      this.#options.protocol === "dialogue"
        ? { context_id: this.contextId, flush: true }
        : { context_id: this.contextId, text: " ", flush: true },
    );
    this.#pushEvent({
      type: "tts.flush.completed",
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      sequence: this.#controlSequence,
      provider: PROVIDER_NAMES.elevenlabs,
      timestamp: this.#options.clock.now(),
      flushId: id,
      acknowledgedBy: "transport",
    });
    this.#controlSequence += 1;
    return { id, acknowledgedBy: "transport" };
  }

  async finish(): Promise<void> {
    if (this.#closed || this.#finishing) return;
    this.#assertWritable();
    this.#finishing = true;
    if (this.#options.protocol === "tts") {
      // Multi-context TTS requires a flush before close_context. The regular
      // WebSocket endpoint uses an empty text frame; the multi-context
      // endpoint documents flush=true with a text payload.
      this.#send({ context_id: this.contextId, text: " ", flush: true });
    }
    this.#send({ context_id: this.contextId, close_context: true });
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#transport.closeContext(this.contextId);
    this.#closed = true;
    this.#events.close();
    this.#transport.remove(this.contextId);
  }

  handleMessage(message: Readonly<Record<string, unknown>>): void {
    if (this.#closed) return;
    const isFinalAudioForTurn =
      message.is_final_audio_for_turn === true || message.isFinalAudioForTurn === true;
    const isFinal = message.is_final === true || message.isFinal === true;
    if (message.error !== undefined || message.message !== undefined) {
      this.fail(this.#error(boundedProviderMessage(message.error ?? message.message)));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "audio")) {
      const audio = message.audio;
      if (audio === null && isFinal) {
        // The terminal frame may carry a null audio field.
      } else if (typeof audio !== "string") {
        this.fail(this.#error("ElevenLabs returned malformed multi-context audio"));
        return;
      } else {
        try {
          this.#pushAudio(decodePcm(audio));
        } catch (error) {
          this.fail(error);
          return;
        }
      }
    }
    const rawAlignment =
      message.alignment ?? message.normalized_alignment ?? message.normalizedAlignment;
    const alignment = parseAlignment(rawAlignment);
    if (alignment) this.#pushAlignment(alignment);
    else if (rawAlignment !== undefined && rawAlignment !== null) {
      this.fail(this.#error("ElevenLabs returned malformed multi-context alignment"));
      return;
    }
    if (isFinalAudioForTurn) this.#commit();
    if (isFinal) {
      this.#commit();
      this.#closed = true;
      this.#transport.remove(this.contextId);
      this.#events.close();
    }
  }

  closeWithoutError(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close();
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.remove(this.contextId);
    this.#events.fail(
      providerThrowableError(error, {
        code: PROVIDER_ERROR_CODES.elevenlabsTts,
        provider: PROVIDER_NAMES.elevenlabs,
      }),
    );
  }

  #pushAudio(bytes: Uint8Array): void {
    if (
      bytes.byteLength === 0 ||
      this.#chunkIds.length >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
      this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      throw providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs);
    }
    const frames = frameCountForPcm16le(bytes);
    const id = this.#mediaId("chunk");
    const event = createMediaEvent({
      id,
      type: "media.audio.chunk",
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.elevenlabs,
      audio: {
        format: this.#options.format,
        durationMs: durationMsForPcm16le(bytes, this.#options.format.sampleRateHz),
        frameCount: frames,
        bytes,
      },
      metadata: {
        elevenlabs: {
          transport: "websocket",
          protocol: this.#options.protocol,
          multiContext: true,
          contextId: this.contextId,
          model: this.#options.model,
        },
      },
    });
    if (!this.#pushEvent(event)) return;
    this.#chunkIds.push(id);
    this.#chunkSequences.push(this.#mediaSequence);
    this.#mediaSequence += 1;
    this.#frameCount += frames;
    this.#outputBytes += bytes.byteLength;
  }

  #pushAlignment(alignment: ParsedAlignment): void {
    this.#pushEvent({
      type: "tts.alignment",
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      sequence: this.#controlSequence,
      provider: PROVIDER_NAMES.elevenlabs,
      timestamp: this.#options.clock.now(),
      unit: "character",
      tokens: alignment.tokens,
      startMs: alignment.startMs,
      endMs: alignment.endMs,
    });
    this.#controlSequence += 1;
  }

  #commit(): void {
    if (this.#chunkIds.length === 0) return;
    const event: MediaAudioCommittedEvent = createMediaEvent({
      id: this.#mediaId("committed"),
      type: "media.audio.committed",
      sessionId: this.#options.sessionId,
      turnId: this.#options.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.elevenlabs,
      durationMs: (this.#frameCount / this.#options.format.sampleRateHz) * 1_000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: [...this.#chunkIds],
      metadata: {
        elevenlabs: {
          transport: "websocket",
          protocol: this.#options.protocol,
          multiContext: true,
          contextId: this.contextId,
          model: this.#options.model,
        },
      },
    });
    if (!this.#pushEvent(event)) return;
    this.#mediaSequence += 1;
    this.#chunkIds.length = 0;
    this.#chunkSequences.length = 0;
    this.#frameCount = 0;
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    this.#transport.send(message);
  }

  #assertWritable(): void {
    if (this.#closed) throw this.#error("ElevenLabs multi-context session is closed");
    if (this.#finishing) throw this.#error("ElevenLabs multi-context session is finishing");
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.fail(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabs));
    return false;
  }

  #mediaId(kind: string): MediaEventId {
    return `${this.#mediaIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
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

export function createElevenLabsMultiContextProvider(
  options: ElevenLabsMultiContextProviderOptions,
): ElevenLabsMultiContextProvider {
  return new ElevenLabsMultiContextProvider(options);
}

export function createElevenLabsTtsMultiContextProvider(
  options: Omit<ElevenLabsMultiContextProviderOptions, "protocol">,
): ElevenLabsMultiContextProvider {
  return new ElevenLabsMultiContextProvider({ ...options, protocol: "tts" });
}

export function createElevenLabsDialogueMultiContextProvider(
  options: Omit<ElevenLabsMultiContextProviderOptions, "protocol">,
): ElevenLabsMultiContextProvider {
  return new ElevenLabsMultiContextProvider({ ...options, protocol: "dialogue" });
}
