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

import { ADAPTER_DEFAULTS, PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";
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
    this.#language = options.language ?? ADAPTER_DEFAULTS.cartesia.language;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
        }));
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertPcm16leFormat(request.format);
    const socket = await this.#connect(request.signal);
    return this.#createStream(socket, request);
  }

  async openSession(request: TtsSessionOpenRequest): Promise<TtsSession> {
    assertPcm16leFormat(request.format);
    const socket = await this.#connect(request.signal);
    return this.#createStream(socket, request);
  }

  async #connect(signal?: AbortSignal): Promise<WebSocket> {
    const socket = this.#webSocketFactory(this.#url, {
      "X-API-Key": this.#apiKey,
      "Cartesia-Version": PROVIDER_API_VERSIONS.cartesia,
    });
    try {
      await openWebSocket(socket, signal ? { signal } : {});
      return socket;
    } catch (error) {
      throw normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.cartesiaTts,
        provider: PROVIDER_NAMES.cartesia,
      });
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
      throw normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.cartesiaTts,
        provider: PROVIDER_NAMES.cartesia,
      });
    }
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
  readonly resolve: (result: TtsFlushResult) => void;
  readonly reject: (error: unknown) => void;
}

export class CartesiaTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: CartesiaStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>();
  readonly #contextId: string;
  readonly #mediaEventIds: CounterIdGenerator<MediaEventId>;
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  readonly #flushWaiters: FlushWaiter[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  #frameCount = 0;
  #closed = false;
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

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", () => this.#closeQueue());
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
    return new Promise<TtsFlushResult>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.#flushWaiters.push(waiter);
      try {
        this.#send(this.#generationRequest("", true, true));
      } catch (error) {
        this.#flushWaiters.splice(this.#flushWaiters.indexOf(waiter), 1);
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
    safeSend(this.#socket, JSON.stringify({ context_id: this.#contextId, cancel: true }));
    this.#closeQueue(this.#lifecycleError("Cartesia synthesis context was cancelled"));
    safeClose(this.#socket);
  }

  #handleMessage(body: string): void {
    const message = parseJsonObject(body) as CartesiaMessage | null;
    if (!message) {
      return;
    }

    if (message.type === "chunk" && typeof message.data === "string") {
      const bytes = new Uint8Array(Buffer.from(message.data, "base64"));
      const eventId = this.#mediaEventId("chunk");
      const frames = frameCountForPcm16le(bytes);
      this.#frameCount += frames;
      this.#chunkIds.push(eventId);
      const event: OutputAudioChunk = {
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
      };
      this.#chunkSequences.push(this.#mediaSequence);
      this.#mediaSequence += 1;
      this.#events.push(event);
      return;
    }

    if (message.type === "flush_done" && typeof message.flush_id === "number") {
      const flushId = message.flush_id;
      this.#events.push({
        type: "tts.flush.completed",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence: this.#controlSequence,
        provider: PROVIDER_NAMES.cartesia,
        timestamp: this.#options.clock.now(),
        flushId,
        acknowledgedBy: "provider",
      });
      this.#controlSequence += 1;
      this.#flushWaiters.shift()?.resolve({ id: flushId, acknowledgedBy: "provider" });
      return;
    }

    const alignment =
      message.type === "timestamps"
        ? parseAlignment(message.word_timestamps, "words")
        : message.type === "phoneme_timestamps"
          ? parseAlignment(message.phoneme_timestamps, "phonemes")
          : null;
    if (alignment) {
      this.#events.push({
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
      this.#events.push(this.#committedEvent());
      this.#closeQueue();
      safeClose(this.#socket);
      return;
    }

    if (message.type === "error") {
      this.#fail(
        providerError(
          message.error_code ?? PROVIDER_ERROR_CODES.cartesiaTts,
          message.message ?? body,
          {
            provider: PROVIDER_NAMES.cartesia,
            retriable: false,
          },
        ),
      );
    }
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
      throw providerError(PROVIDER_ERROR_CODES.cartesiaTts, "Cartesia socket is not writable", {
        provider: PROVIDER_NAMES.cartesia,
        retriable: false,
      });
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
    return {
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
    };
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
    this.#closed = true;
    this.#rejectFlushes(flushError);
    this.#events.close();
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectFlushes(error);
    this.#events.fail(error);
    safeClose(this.#socket);
  }

  #rejectFlushes(error: unknown): void {
    for (const waiter of this.#flushWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  #lifecycleError(message: string) {
    return providerError(PROVIDER_ERROR_CODES.cartesiaTts, message, {
      provider: PROVIDER_NAMES.cartesia,
      retriable: false,
    });
  }
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
    !tokens ||
    !start ||
    !end ||
    tokens.length !== start.length ||
    tokens.length !== end.length ||
    !tokens.every((value): value is string => typeof value === "string") ||
    !start.every((value): value is number => typeof value === "number") ||
    !end.every((value): value is number => typeof value === "number")
  ) {
    return null;
  }
  return {
    tokens,
    startMs: start.map((seconds) => seconds * 1000),
    endMs: end.map((seconds) => seconds * 1000),
  };
}

export function createCartesiaTtsProvider(
  options: CartesiaTtsProviderOptions,
): CartesiaTtsProvider {
  return new CartesiaTtsProvider(options);
}
