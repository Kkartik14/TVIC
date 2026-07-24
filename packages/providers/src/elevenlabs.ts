import WebSocket from "ws";

import { durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
  sameAudioFormat,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  IncrementalTextToSpeechProvider,
  MediaAudioCommittedEvent,
  MediaEventId,
  OutputAudioChunk,
  ProviderCapabilities,
  TtsEvent,
  TtsFlushResult,
  TtsSession,
  TtsSessionOpenRequest,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";

import { AsyncQueue } from "./async-queue.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  providerError,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";

const ELEVENLABS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_DEFAULTS.elevenlabs.models,
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
      throw normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.elevenlabsTts,
        provider: PROVIDER_NAMES.elevenlabs,
      });
    }
  }

  #url(request: TtsSessionOpenRequest): string {
    const voice = encodeURIComponent(request.voice ?? this.#options.voiceId);
    const base =
      this.#options.url ?? `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input`;
    const url = new URL(base);
    url.searchParams.set(
      "model_id",
      request.model ?? this.#options.modelId ?? PROVIDER_DEFAULTS.elevenlabs.model,
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
  readonly #events = new AsyncQueue<TtsEvent>();
  readonly #mediaIds: CounterIdGenerator<MediaEventId>;
  readonly #flushIds = counterIdGenerator<string>("elevenlabs_flush");
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  #frameCount = 0;
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

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", () => this.#closeQueue());
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
    this.#events.push({
      type: "tts.flush.completed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
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
      this.#pushAudio(message.audio);
    }
    const alignment = parseAlignment(message.normalizedAlignment ?? message.alignment);
    if (alignment) {
      this.#events.push({
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
      });
      this.#controlSequence += 1;
    } else if (message.alignment || message.normalizedAlignment) {
      this.#fail(this.#error("ElevenLabs returned malformed alignment data"));
      return;
    }

    if (message.isFinal === true || message.is_final === true) {
      this.#events.push(this.#committedEvent());
      this.#closeQueue();
      safeClose(this.#socket);
    }
  }

  #pushAudio(encoded: string): void {
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    const frames = frameCountForPcm16le(bytes);
    const id = this.#mediaEventId("chunk");
    this.#frameCount += frames;
    this.#chunkIds.push(id);
    this.#chunkSequences.push(this.#mediaSequence);
    const event: OutputAudioChunk = {
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
        data: { kind: "inline", bytes },
      },
    };
    this.#mediaSequence += 1;
    this.#events.push(event);
  }

  #committedEvent(): MediaAudioCommittedEvent {
    return {
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
    };
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    if (!safeSend(this.#socket, JSON.stringify(message))) {
      throw this.#error("ElevenLabs socket is not writable");
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

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#events.fail(error);
    safeClose(this.#socket);
  }

  #error(message: string) {
    return providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    });
  }
}

function assertElevenLabsFormat(request: TtsSessionOpenRequest): void {
  if (!sameAudioFormat(request.format, PCM16_16K_MONO)) {
    throw providerError(
      PROVIDER_ERROR_CODES.elevenlabsTts,
      "ElevenLabs adapter requires 16kHz PCM16 mono output",
      { provider: PROVIDER_NAMES.elevenlabs, retriable: false },
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
    !start.every((value): value is number => typeof value === "number") ||
    !duration.every((value): value is number => typeof value === "number")
  ) {
    return null;
  }
  return {
    tokens,
    startMs: start,
    endMs: start.map((value, index) => value + duration[index]!),
  };
}

export function createElevenLabsTtsProvider(
  options: ElevenLabsTtsProviderOptions,
): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider(options);
}
