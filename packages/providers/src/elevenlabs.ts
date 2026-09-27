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

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  providerFrameTooLarge,
  providerEventQueueOverflow,
  providerThrowableError,
  providerError,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";

const ELEVENLABS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.elevenlabs.models,
} satisfies ProviderCapabilities;

export interface ElevenLabsTtsProviderOptions {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId?: string;
  readonly language?: string;
  readonly url?: string;
  readonly stability?: number;
  readonly similarityBoost?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface ElevenLabsMessage extends Readonly<Record<string, unknown>> {
  readonly audio?: string;
  readonly isFinal?: boolean;
  readonly is_final?: boolean;
  readonly alignment?: ElevenLabsAlignment;
  readonly normalizedAlignment?: ElevenLabsAlignment;
  readonly error?: string;
  readonly message?: string;
}

interface ElevenLabsAlignment {
  readonly chars?: readonly unknown[];
  readonly charStartTimesMs?: readonly unknown[];
  readonly charDurationsMs?: readonly unknown[];
}

interface ElevenLabsStreamOptions {
  readonly clock: ProviderClock;
  readonly stability: number;
  readonly similarityBoost: number;
}

export class ElevenLabsTtsProvider implements IncrementalTextToSpeechProvider {
  readonly name = PROVIDER_NAMES.elevenlabs;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = ELEVENLABS_CAPABILITIES;

  readonly #options: ElevenLabsTtsProviderOptions;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<ElevenLabsTtsProviderOptions["webSocketFactory"]>;

  constructor(options: ElevenLabsTtsProviderOptions) {
    this.#options = options;
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

  openSession(request: TtsSessionOpenRequest): Promise<TtsSession> {
    return this.#open(request);
  }

  async #open(request: TtsSessionOpenRequest): Promise<ElevenLabsTtsStream> {
    assertElevenLabsFormat(request);
    const socket = this.#webSocketFactory(this.#url(request), {
      "xi-api-key": this.#options.apiKey,
    });
    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      return new ElevenLabsTtsStream(socket, request, {
        clock: this.#clock,
        stability: this.#options.stability ?? 0.5,
        similarityBoost: this.#options.similarityBoost ?? 0.8,
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

  #url(request: TtsSessionOpenRequest): string {
    const voice = encodeURIComponent(request.voice ?? this.#options.voiceId);
    const base =
      this.#options.url ?? `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input`;
    const url = new URL(base);
    url.searchParams.set(
      "model_id",
      request.model ?? this.#options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel,
    );
    url.searchParams.set("output_format", "pcm_16000");
    if (request.timestamps) {
      url.searchParams.set("sync_alignment", "true");
    }
    if (this.#options.language) {
      url.searchParams.set("language_code", this.#options.language);
    }
    return url.toString();
  }
}

export class ElevenLabsTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: ElevenLabsStreamOptions;
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
  #outputChunks = 0;
  #closed = false;
  #finishing = false;

  constructor(socket: WebSocket, request: TtsSessionOpenRequest, options: ElevenLabsStreamOptions) {
    this.#socket = socket;
    this.#request = request;
    this.#options = options;
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
      if (this.#closed) {
        return;
      }
      this.#fail(
        providerError(
          TVIC_ERROR_CODES.ttsTransportUnexpectedEof,
          "ElevenLabs TTS socket closed before the provider completed synthesis",
          { provider: PROVIDER_NAMES.elevenlabs, retriable: true },
        ),
      );
    });
    socket.on("error", (error) =>
      this.#fail(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.elevenlabsTts,
          provider: PROVIDER_NAMES.elevenlabs,
        }),
      ),
    );

    this.#send({
      text: " ",
      voice_settings: {
        stability: options.stability,
        similarity_boost: options.similarityBoost,
        ...(request.speed !== undefined ? { speed: request.speed } : {}),
      },
    });
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    if (text) {
      this.#send({ text });
    }
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    const id = this.#flushIds.next();
    this.#send({ text: " ", flush: true });
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
    this.#send({ text: "" });
  }

  async cancel(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closeQueue();
    safeClose(this.#socket);
  }

  #handleMessage(body: string): void {
    if (this.#closed) {
      return;
    }
    const parsed = parseJsonObject(body);
    if (!parsed) {
      this.#fail(this.#error("ElevenLabs returned malformed JSON"));
      return;
    }
    const message = parsed as ElevenLabsMessage;
    if (message.error || (message.message && !message.audio)) {
      this.#fail(this.#error(message.error ?? message.message ?? "ElevenLabs synthesis failed"));
      return;
    }

    if (typeof message.audio === "string" && message.audio.length > 0) {
      if (!this.#pushAudio(message.audio)) {
        return;
      }
    }
    const alignment = parseAlignment(message.normalizedAlignment ?? message.alignment);
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
    } else if (message.alignment || message.normalizedAlignment) {
      this.#fail(this.#error("ElevenLabs returned malformed alignment data"));
      return;
    }

    if (message.isFinal === true || message.is_final === true) {
      if (!this.#pushEvent(this.#committedEvent())) {
        return;
      }
      this.#closeQueue();
      safeClose(this.#socket);
    }
  }

  #pushAudio(encoded: string): boolean {
    let bytes: Uint8Array;
    try {
      bytes = decodeElevenLabsAudio(encoded);
    } catch {
      this.#fail(this.#error("ElevenLabs returned malformed PCM audio"));
      return false;
    }
    if (
      this.#outputChunks >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
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
    if (!this.#pushEvent(event)) {
      return false;
    }
    this.#frameCount += frames;
    this.#outputBytes += bytes.byteLength;
    this.#outputChunks += 1;
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
    safeClose(this.#socket);
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
  if (!sameAudioFormat(request.format, PCM16_16K_MONO)) {
    throw TvicThrowableError.from(
      providerError(
        PROVIDER_ERROR_CODES.elevenlabsTts,
        "ElevenLabs adapter requires 16kHz PCM16 mono output",
        { provider: PROVIDER_NAMES.elevenlabs, retriable: false },
      ),
    );
  }
}

function parseAlignment(alignment: ElevenLabsAlignment | undefined): {
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
} | null {
  const tokens = alignment?.chars;
  const start = alignment?.charStartTimesMs;
  const duration = alignment?.charDurationsMs;
  if (
    !tokens ||
    !start ||
    !duration ||
    tokens.length !== start.length ||
    tokens.length !== duration.length ||
    !tokens.every((value): value is string => typeof value === "string") ||
    tokens.length > 4096 ||
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
  if (!endMs.every(Number.isFinite)) {
    return null;
  }
  return {
    tokens,
    startMs: start,
    endMs,
  };
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

export function createElevenLabsTtsProvider(
  options: ElevenLabsTtsProviderOptions,
): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider(options);
}
