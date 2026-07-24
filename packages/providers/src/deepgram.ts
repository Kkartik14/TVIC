import WebSocket from "ws";

import { assertPcm16leFormat } from "@tvic/media";
import type {
  InputAudioChunk,
  ProviderEventId,
  ProviderCapabilities,
  SpeechToTextProvider,
  SttOpenRequest,
  SttStream,
  TranscriptEvent,
} from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_DEFAULTS,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
} from "@tvic/core";

import { AsyncQueue } from "./async-queue.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";

const DEEPGRAM_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  languages: ["en", "en-US", "hi", "hi-IN"],
  audio: { input: [PCM16_16K_MONO] },
  models: PROVIDER_DEFAULTS.deepgram.models,
  turnDetection: ["stt_endpointing", "vad"],
} satisfies ProviderCapabilities;

export interface DeepgramSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly clock?: ProviderClock;
}

interface DeepgramResult {
  readonly type?: string;
  readonly timestamp?: number;
  readonly is_final?: boolean;
  readonly speech_final?: boolean;
  readonly duration?: number;
  readonly start?: number;
  readonly channel?: {
    readonly alternatives?: readonly [
      {
        readonly transcript?: string;
        readonly confidence?: number;
        readonly languages?: readonly string[];
      },
    ];
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export class DeepgramSttProvider implements SpeechToTextProvider {
  readonly name = PROVIDER_NAMES.deepgram;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = DEEPGRAM_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #clock: ProviderClock;

  constructor(options: DeepgramSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "wss://api.deepgram.com/v1/listen";
    this.#clock = options.clock ?? new SystemProviderClock();
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    assertPcm16leFormat(request.format);
    const url = new URL(this.#url);
    url.searchParams.set("model", request.model ?? PROVIDER_DEFAULTS.deepgram.model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
    url.searchParams.set("channels", String(request.format.channels));
    url.searchParams.set("interim_results", String(request.interimResults));
    url.searchParams.set("endpointing", String(PROVIDER_DEFAULTS.deepgram.endpointingMs));
    url.searchParams.set("vad_events", String(PROVIDER_DEFAULTS.deepgram.vadEvents));
    url.searchParams.set("punctuate", String(PROVIDER_DEFAULTS.deepgram.punctuate));
    if (request.language) {
      url.searchParams.set("language", request.language);
    }
    for (const vocabulary of request.vocabulary ?? []) {
      url.searchParams.append("keyterm", vocabulary);
    }

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Token ${this.#apiKey}`,
      },
    });

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      throw normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.deepgramStt,
        provider: PROVIDER_NAMES.deepgram,
      });
    }
    return new DeepgramSttStream(socket, request, this.#clock);
  }
}

export class DeepgramSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #clock: ProviderClock;
  readonly #events = new AsyncQueue<TranscriptEvent>();
  readonly #ids = counterIdGenerator<ProviderEventId>("deepgram_event");
  #sequence = 1;
  #closed = false;

  constructor(socket: WebSocket, request: SttOpenRequest, clock: ProviderClock) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.events = this.#events;

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", () => this.#closeQueue());
    socket.on("error", (error) =>
      this.#events.fail(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.deepgramStt,
          provider: PROVIDER_NAMES.deepgram,
        }),
      ),
    );
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed) {
      return;
    }
    safeSend(this.#socket, Buffer.from(chunk.audio.data.bytes));
  }

  async commit(): Promise<void> {
    if (!this.#closed) {
      safeSend(this.#socket, JSON.stringify({ type: "Finalize" }));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // Best-effort graceful close; the transcript queue is closed regardless so the
    // call loop's drain never wedges on a half-closed socket.
    safeSend(this.#socket, JSON.stringify({ type: "CloseStream" }));
    safeClose(this.#socket);
    this.#closeQueue();
  }

  #handleMessage(body: string): void {
    const parsed = parseJsonObject(body) as DeepgramResult | null;
    if (!parsed) {
      return;
    }
    if (parsed.type === "SpeechStarted") {
      const audioOffsetMs = secondsToMs(parsed.timestamp);
      this.#events.push({
        id: this.#ids.next(),
        type: "stt.speech.started",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.deepgram,
        timestamp: this.#clock.now(),
        ...(typeof audioOffsetMs === "number" ? { audioOffsetMs } : {}),
      });
      this.#sequence += 1;
      return;
    }
    if (parsed.type !== "Results") {
      return;
    }

    const alternative = parsed.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    const timestamp = this.#clock.now();
    const audioStartMs = secondsToMs(parsed.start);
    const audioEndMs =
      typeof audioStartMs === "number" && typeof parsed.duration === "number"
        ? audioStartMs + parsed.duration * 1000
        : undefined;

    if (text) {
      this.#events.push({
        id: this.#ids.next(),
        type: parsed.is_final ? "stt.final" : "stt.partial",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.deepgram,
        text,
        ...(typeof alternative?.confidence === "number"
          ? { confidence: alternative.confidence }
          : {}),
        ...(alternative?.languages?.[0] ? { language: alternative.languages[0] } : {}),
        ...(typeof audioStartMs === "number" ? { audioStartMs } : {}),
        ...(typeof audioEndMs === "number" ? { audioEndMs } : {}),
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        metadata: { deepgram: parsed.metadata },
      });
      this.#sequence += 1;
    }

    if (parsed.speech_final) {
      this.#events.push({
        id: this.#ids.next(),
        type: "stt.endpoint",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.deepgram,
        reason: "provider",
        timestamp,
        ...(typeof audioEndMs === "number" ? { audioOffsetMs: audioEndMs } : {}),
        metadata: { deepgram: parsed.metadata },
      });
      this.#sequence += 1;
    }
  }

  #closeQueue(): void {
    this.#closed = true;
    this.#events.close();
  }
}

function secondsToMs(seconds: number | undefined): number | undefined {
  return typeof seconds === "number" ? seconds * 1000 : undefined;
}

export function createDeepgramSttProvider(
  options: DeepgramSttProviderOptions,
): DeepgramSttProvider {
  return new DeepgramSttProvider(options);
}
