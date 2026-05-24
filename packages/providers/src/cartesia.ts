import WebSocket from "ws";

import { assertPcm16leFormat, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
} from "@tvic/core";
import type {
  MediaAudioCommittedEvent,
  MediaEventId,
  OutputAudioChunk,
  ProviderCapabilities,
  TextToSpeechProvider,
  TtsEvent,
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
  streaming: true,
  interruption: true,
  audioFormats: [PCM16_16K_MONO],
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
};

export class CartesiaTtsProvider implements TextToSpeechProvider {
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
    const socket = new WebSocket(this.#url, {
      headers: {
        "X-API-Key": this.#apiKey,
        "Cartesia-Version": PROVIDER_DEFAULTS.cartesia.apiVersion,
      },
    });
    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      throw normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.cartesiaTts,
        provider: PROVIDER_NAMES.cartesia,
      });
    }
    return new CartesiaTtsStream(socket, request, {
      voiceId: request.voice ?? this.#voiceId,
      modelId: request.model ?? this.#modelId,
      language: this.#language,
      clock: this.#clock,
    });
  }
}

interface CartesiaStreamOptions {
  readonly voiceId: string;
  readonly modelId: string;
  readonly language: string;
  readonly clock: ProviderClock;
}

export class CartesiaTtsStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSynthesisRequest;
  readonly #options: CartesiaStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>();
  readonly #contextId: string;
  readonly #chunkIds: MediaEventId[] = [];
  #sequence = 1;
  #frameCount = 0;
  #closed = false;

  constructor(socket: WebSocket, request: TtsSynthesisRequest, options: CartesiaStreamOptions) {
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

    safeSend(this.#socket, JSON.stringify(this.#generationRequest(false)));
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
        },
      };
      this.#sequence += 1;
      this.#events.push(event);
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

  #generationRequest(continuation: boolean): Readonly<Record<string, unknown>> {
    return {
      model_id: this.#options.modelId,
      transcript: this.#request.text,
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
      add_timestamps: false,
      continue: continuation,
    };
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

export function createCartesiaTtsProvider(
  options: CartesiaTtsProviderOptions,
): CartesiaTtsProvider {
  return new CartesiaTtsProvider(options);
}
