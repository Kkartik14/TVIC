import WebSocket from "ws";

import { AsyncQueue } from "@tvic/media";
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
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  counterIdGenerator,
  TvicThrowableError,
} from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeSttConnectionError,
  normalizeSttSocketError,
  providerThrowableError,
  openWebSocket,
  parseJsonObject,
  providerError,
  assertSttPcm16leFormat,
  assertSupportedModel,
  providerStreamEnded,
  safeClose,
  safeSend,
  socketCloseMetadata,
  writeProviderFrame,
  type ProviderClock,
} from "./common.js";

const DEEPGRAM_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  languages: ["en", "en-US", "hi", "hi-IN"],
  audio: { input: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.deepgram.models,
  turnDetection: ["stt_endpointing", "vad"],
} satisfies ProviderCapabilities;

export interface DeepgramSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly allowUnknownModel?: boolean;
  readonly clock?: ProviderClock;
  readonly endpointingMs?: number;
  readonly vadEvents?: boolean;
  readonly punctuate?: boolean;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface DeepgramResult {
  readonly type?: string;
  readonly err_code?: string;
  readonly err_msg?: string;
  readonly message?: string;
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
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;
  readonly #endpointingMs: number;
  readonly #vadEvents: boolean;
  readonly #punctuate: boolean;
  readonly #webSocketFactory: NonNullable<DeepgramSttProviderOptions["webSocketFactory"]>;

  constructor(options: DeepgramSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "wss://api.deepgram.com/v1/listen";
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#endpointingMs = options.endpointingMs ?? ADAPTER_DEFAULTS.deepgram.endpointingMs;
    this.#vadEvents = options.vadEvents ?? ADAPTER_DEFAULTS.deepgram.vadEvents;
    this.#punctuate = options.punctuate ?? ADAPTER_DEFAULTS.deepgram.punctuate;
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
        }));
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    assertSttPcm16leFormat(request.format);
    const model = request.model ?? PROVIDER_CATALOG.deepgram.defaultModel;
    assertSupportedModel(
      PROVIDER_NAMES.deepgram,
      PROVIDER_CATALOG.deepgram.models,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );
    const url = new URL(this.#url);
    url.searchParams.set("model", model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
    url.searchParams.set("channels", String(request.format.channels));
    url.searchParams.set("interim_results", String(request.interimResults));
    url.searchParams.set("endpointing", String(this.#endpointingMs));
    url.searchParams.set("vad_events", String(this.#vadEvents));
    url.searchParams.set("punctuate", String(this.#punctuate));
    if (request.language) {
      url.searchParams.set("language", request.language);
    }
    for (const vocabulary of request.vocabulary ?? []) {
      url.searchParams.append("keyterm", vocabulary);
    }

    const socket = this.#webSocketFactory(url.toString(), {
      Authorization: `Token ${this.#apiKey}`,
    });

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      throw TvicThrowableError.from(
        normalizeSttConnectionError(error, {
          provider: PROVIDER_NAMES.deepgram,
          providerCode: PROVIDER_ERROR_CODES.deepgramStt,
        }),
      );
    }
    return new DeepgramSttStream(socket, request, this.#clock);
  }
}

export class DeepgramSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode = "provider" as const;
  readonly timestampOrigin = "generation" as const;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #clock: ProviderClock;
  readonly #events = new AsyncQueue<TranscriptEvent>();
  readonly #ids = counterIdGenerator<ProviderEventId>("deepgram_event");
  readonly #keepAliveTimer: ReturnType<typeof setInterval>;
  #sequence = 1;
  #closed = false;
  #hasSentAudio = false;

  constructor(socket: WebSocket, request: SttOpenRequest, clock: ProviderClock) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.events = this.#events;

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) => {
      this.#fail(
        normalizeSttSocketError(error, {
          provider: PROVIDER_NAMES.deepgram,
          providerCode: PROVIDER_ERROR_CODES.deepgramStt,
        }),
      );
    });
    this.#keepAliveTimer = setInterval(() => {
      if (!this.#closed) {
        try {
          writeProviderFrame(this.#socket, JSON.stringify({ type: "KeepAlive" }), {
            code: PROVIDER_ERROR_CODES.deepgramStt,
            provider: PROVIDER_NAMES.deepgram,
            operation: "keepalive",
          });
        } catch (error) {
          this.#fail(error);
        }
      }
    }, DEEPGRAM_KEEPALIVE_INTERVAL_MS);
    this.#keepAliveTimer.unref?.();
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed) {
      throw providerStreamEnded(PROVIDER_NAMES.deepgram, PROVIDER_ERROR_CODES.deepgramStt);
    }
    try {
      writeProviderFrame(this.#socket, Buffer.from(chunk.audio.bytes), {
        code: PROVIDER_ERROR_CODES.deepgramStt,
        provider: PROVIDER_NAMES.deepgram,
        operation: "audio",
      });
      this.#hasSentAudio = true;
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (this.#closed) {
      throw providerStreamEnded(PROVIDER_NAMES.deepgram, PROVIDER_ERROR_CODES.deepgramStt);
    }
    try {
      writeProviderFrame(this.#socket, JSON.stringify({ type: "Finalize" }), {
        code: PROVIDER_ERROR_CODES.deepgramStt,
        provider: PROVIDER_NAMES.deepgram,
        operation: "commit",
      });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stopKeepAlive();
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
    if (parsed.type === "Error" || parsed.type === "error") {
      this.#fail(deepgramProtocolError(parsed, this.#hasSentAudio));
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
        ...(parsed.metadata ? { metadata: { deepgram: parsed.metadata } } : {}),
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
        ...(parsed.metadata ? { metadata: { deepgram: parsed.metadata } } : {}),
      });
      this.#sequence += 1;
    }
  }

  #closeQueue(): void {
    this.#closed = true;
    this.#stopKeepAlive();
    this.#events.close();
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    if (this.#closed) {
      this.#closeQueue();
      return;
    }
    const normalizedCode =
      code === 1006 ? STT_ERROR_CODES.unexpectedEof : STT_ERROR_CODES.protocolError;
    this.#fail(
      providerError(
        normalizedCode,
        normalizedCode === STT_ERROR_CODES.unexpectedEof
          ? "Deepgram STT socket closed unexpectedly"
          : `Deepgram STT socket closed with code ${code}`,
        {
          provider: PROVIDER_NAMES.deepgram,
          retriable: normalizedCode === STT_ERROR_CODES.unexpectedEof,
          metadata: socketCloseMetadata(code, reason),
        },
      ),
    );
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.deepgramStt,
      provider: PROVIDER_NAMES.deepgram,
    });
    this.#closed = true;
    this.#stopKeepAlive();
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #stopKeepAlive(): void {
    clearInterval(this.#keepAliveTimer);
  }
}

function secondsToMs(seconds: number | undefined): number | undefined {
  return typeof seconds === "number" ? seconds * 1000 : undefined;
}

const DEEPGRAM_KEEPALIVE_INTERVAL_MS = 5_000;

function deepgramProtocolError(message: DeepgramResult, hasSentAudio: boolean) {
  const vendorCode = message.err_code;
  const normalizedCode =
    vendorCode === "DATA-0000"
      ? "stt.provider.input_rejected"
      : vendorCode === "NET-0000"
        ? "stt.provider.internal"
        : vendorCode === "NET-0001" || (vendorCode === "NET-0002" && hasSentAudio)
          ? "stt.provider.service_unavailable"
          : "stt.provider.protocol_error";
  return providerError(normalizedCode, message.err_msg ?? message.message ?? "Deepgram STT error", {
    provider: PROVIDER_NAMES.deepgram,
    retriable:
      normalizedCode === "stt.provider.service_unavailable" ||
      normalizedCode === "stt.provider.internal",
    metadata: { providerCode: vendorCode },
  });
}

export function createDeepgramSttProvider(
  options: DeepgramSttProviderOptions,
): DeepgramSttProvider {
  return new DeepgramSttProvider(options);
}
