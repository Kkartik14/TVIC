import WebSocket from "ws";

import { assertPcm16leFormat, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
} from "@tvic/core";
import type {
  IncrementalTextToSpeechProvider,
  MediaAudioCommittedEvent,
  MediaEventId,
  OutputAudioChunk,
  ProviderCapabilities,
  TtsEvent,
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

const CARTESIA_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_DEFAULTS.cartesia.models,
} satisfies ProviderCapabilities;

export interface CartesiaTtsProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId: string;
  readonly modelId?: string;
  readonly language?: string;
  readonly clock?: ProviderClock;
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

  constructor(options: CartesiaTtsProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url =
      options.url ??
      `wss://api.cartesia.ai/tts/websocket?cartesia_version=${PROVIDER_DEFAULTS.cartesia.apiVersion}`;
    this.#voiceId = options.voiceId;
    this.#modelId = options.modelId ?? PROVIDER_DEFAULTS.cartesia.model;
    this.#language = options.language ?? PROVIDER_DEFAULTS.cartesia.language;
    this.#clock = options.clock ?? new SystemProviderClock();
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertPcm16leFormat(request.format);
    const socket = await this.#connect(request.signal);
    return new CartesiaTtsStream(socket, request, this.#streamOptions(request));
  }

  async openSession(request: TtsSessionOpenRequest): Promise<TtsSession> {
    assertPcm16leFormat(request.format);
    const socket = await this.#connect(request.signal);
    return new CartesiaTtsStream(socket, request, this.#streamOptions(request));
  }

  async #connect(signal?: AbortSignal): Promise<WebSocket> {
    const socket = new WebSocket(this.#url, {
      headers: {
        "X-API-Key": this.#apiKey,
        "Cartesia-Version": PROVIDER_DEFAULTS.cartesia.apiVersion,
      },
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
    };
  }
}

interface CartesiaStreamOptions {
  readonly voiceId: string;
  readonly modelId: string;
  readonly language: string;
  readonly clock: ProviderClock;
  readonly timestamps: boolean;
}

export class CartesiaTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: CartesiaStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>();
  readonly #contextId: string;
  readonly #chunkIds: MediaEventId[] = [];
  #sequence = 1;
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
    this.#contextId = `${String(request.sessionId)}_${String(request.turnId)}_${Date.now()}`;
    this.events = this.#events;

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", () => this.#closeQueue());
    socket.on("error", (error) =>
      this.#events.fail(
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

  async flush(): Promise<void> {
    this.#assertWritable();
    this.#send(this.#generationRequest("", true, true));
  }

  async finish(): Promise<void> {
    this.#assertWritable();
    this.#finishing = true;
    this.#send(this.#generationRequest("", false));
  }

  async cancel(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // Best-effort cancel frame; the audio queue is closed regardless so playout
    // teardown never wedges on a half-closed socket.
    safeSend(this.#socket, JSON.stringify({ context_id: this.#contextId, cancel: true }));
    safeClose(this.#socket);
    this.#closeQueue();
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
        sequence: this.#sequence,
        direction: "output",
        timestamp: this.#options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.cartesia,
        audio: {
          format: this.#request.format,
          durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
          frameCount: frames,
          data: { kind: "inline", bytes },
        },
        metadata: {
          contextId: message.context_id,
          ...(typeof message.flush_id === "number" ? { flushId: message.flush_id } : {}),
        },
      };
      this.#sequence += 1;
      this.#events.push(event);
      return;
    }

    if (message.type === "flush_done" && typeof message.flush_id === "number") {
      this.#events.push({
        type: "tts.flush.completed",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.cartesia,
        timestamp: this.#options.clock.now(),
        flushId: message.flush_id,
      });
      this.#sequence += 1;
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
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.cartesia,
        timestamp: this.#options.clock.now(),
        unit: message.type === "timestamps" ? "word" : "phoneme",
        tokens: alignment.tokens,
        startMs: alignment.startMs,
        endMs: alignment.endMs,
        ...(typeof message.flush_id === "number" ? { flushId: message.flush_id } : {}),
      });
      this.#sequence += 1;
      return;
    }

    if (message.type === "done" || message.done === true) {
      this.#events.push(this.#committedEvent());
      this.#closeQueue();
      this.#socket.close();
      return;
    }

    if (message.type === "error") {
      this.#events.fail(
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
      throw new Error("Cartesia synthesis context is closed");
    }
    if (this.#finishing) {
      throw new Error("Cartesia synthesis context is already finishing");
    }
  }

  #committedEvent(): MediaAudioCommittedEvent {
    return {
      id: this.#mediaEventId("committed"),
      type: "media.audio.committed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#sequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.cartesia,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1000,
      frameCount: this.#frameCount,
      sequenceRange: [1, Math.max(1, this.#sequence - 1)],
      chunkIds: this.#chunkIds,
      metadata: {
        contextId: this.#contextId,
      },
    };
  }

  #mediaEventId(kind: string): MediaEventId {
    return `cartesia_${kind}_${this.#sequence}_${Date.now()}` as MediaEventId;
  }

  #closeQueue(): void {
    this.#closed = true;
    this.#events.close();
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
