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
  sameAudioFormat,
  TvicThrowableError,
} from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeSttConnectionError,
  normalizeSttSocketError,
  providerEventQueueOverflow,
  providerThrowableError,
  openWebSocket,
  parseJsonObject,
  providerError,
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  providerStreamEnded,
  MAX_PROVIDER_FRAME_BYTES,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
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

// These envelopes are part of Deepgram's streaming protocol but do not carry
// a TVIC transcript event. Keep them explicit so a newly introduced provider
// envelope cannot silently stall the session.
const DEEPGRAM_NON_TRANSCRIPT_TYPES = new Set(["Metadata", "UtteranceEnd", "KeepAlive"]);

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
  readonly channel?: { readonly alternatives?: readonly DeepgramAlternative[] };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface DeepgramAlternative {
  readonly transcript?: string;
  readonly confidence?: number;
  readonly languages?: readonly string[];
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
          maxPayload: MAX_PROVIDER_FRAME_BYTES,
        }));
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    assertSttPcm16leFormat(request.format);
    assertSttSampleRate(PROVIDER_NAMES.deepgram, request.format.sampleRateHz, [
      PCM16_16K_MONO.sampleRateHz,
    ]);
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

    let socket: WebSocket | undefined;
    try {
      socket = this.#webSocketFactory(url.toString(), {
        Authorization: `Token ${this.#apiKey}`,
      });
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      if (socket) safeClose(socket);
      throw TvicThrowableError.from(
        normalizeSttConnectionError(error, {
          provider: PROVIDER_NAMES.deepgram,
          providerCode: PROVIDER_ERROR_CODES.deepgramStt,
        }),
      );
    }
    if (!socket) {
      throw TvicThrowableError.from(
        normalizeSttConnectionError(new Error("Deepgram socket factory returned no socket"), {
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
  readonly #events = new AsyncQueue<TranscriptEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.deepgram);
      this.#fail(error);
      return error;
    },
  });
  readonly #ids = counterIdGenerator<ProviderEventId>("deepgram_event");
  readonly #keepAliveTimer: ReturnType<typeof setInterval>;
  #sequence = 1;
  #closed = false;
  #closing = false;
  #hasSentAudio = false;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;

  constructor(socket: WebSocket, request: SttOpenRequest, clock: ProviderClock) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.events = this.#events;

    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(
          providerError(STT_ERROR_CODES.protocolError, "Deepgram frame exceeded the size limit", {
            provider: PROVIDER_NAMES.deepgram,
            retriable: false,
          }),
        );
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
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
    if (!sameAudioFormat(chunk.audio.format, this.#request.format)) {
      throw TvicThrowableError.from(
        providerError(
          "stt.audio_format_invalid",
          "Deepgram audio chunk format does not match the opened stream",
          { provider: PROVIDER_NAMES.deepgram, retriable: false },
        ),
      );
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
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closing = true;
    this.#stopKeepAlive();
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });
    try {
      writeProviderFrame(this.#socket, JSON.stringify({ type: "CloseStream" }), {
        code: PROVIDER_ERROR_CODES.deepgramStt,
        provider: PROVIDER_NAMES.deepgram,
        operation: "close",
      });
    } catch (error) {
      this.#fail(error);
      return this.#closePromise;
    }
    // Deepgram may emit a final Results envelope after CloseStream. Give it a
    // bounded drain window before forcing socket teardown so close cannot wedge.
    this.#closeTimer = setTimeout(() => {
      safeClose(this.#socket);
      this.#closeQueue();
    }, DEEPGRAM_CLOSE_DRAIN_TIMEOUT_MS);
    this.#closeTimer.unref?.();
    return this.#closePromise;
  }

  #handleMessage(body: string): void {
    const parsed = parseJsonObject(body) as DeepgramResult | null;
    if (!parsed) {
      this.#fail(
        providerError(STT_ERROR_CODES.protocolError, "Deepgram returned malformed JSON", {
          provider: PROVIDER_NAMES.deepgram,
          retriable: false,
        }),
      );
      return;
    }
    const validation = validateDeepgramResult(parsed);
    if (validation) {
      this.#fail(validation);
      return;
    }
    const messageType = parsed.type;
    if (typeof messageType !== "string") {
      return;
    }
    if (messageType === "Error" || messageType === "error") {
      this.#fail(deepgramProtocolError(parsed, this.#hasSentAudio));
      return;
    }
    if (messageType === "SpeechStarted") {
      const audioOffsetMs = secondsToMs(parsed.timestamp);
      this.#pushEvent({
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
    if (messageType !== "Results" && !DEEPGRAM_NON_TRANSCRIPT_TYPES.has(messageType)) {
      this.#fail(
        providerError(
          STT_ERROR_CODES.protocolError,
          "Deepgram returned an unexpected message type",
          {
            provider: PROVIDER_NAMES.deepgram,
            retriable: false,
            metadata: { messageType },
          },
        ),
      );
      return;
    }
    if (messageType !== "Results") {
      return;
    }

    const alternative = parsed.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    const timestamp = this.#clock.now();
    const audioStartMs = secondsToMs(parsed.start);
    const audioDurationMs = secondsToMs(parsed.duration);
    const audioEndMs =
      typeof audioStartMs === "number" && typeof audioDurationMs === "number"
        ? audioStartMs + audioDurationMs
        : undefined;

    if (text) {
      this.#pushEvent({
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
      this.#pushEvent({
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
    if (this.#closed) {
      this.#resolveClose?.();
      return;
    }
    this.#closed = true;
    this.#closing = false;
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    this.#stopKeepAlive();
    this.#events.close();
    this.#resolveClose?.();
    this.#resolveClose = undefined;
  }

  #pushEvent(event: TranscriptEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.deepgram));
    return false;
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    if (this.#closed || this.#closing) {
      this.#closeQueue();
      return;
    }
    this.#fail(deepgramCloseError(code, reason));
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
    this.#closing = false;
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    this.#stopKeepAlive();
    this.#events.fail(throwable);
    safeClose(this.#socket);
    this.#resolveClose?.();
    this.#resolveClose = undefined;
  }

  #stopKeepAlive(): void {
    clearInterval(this.#keepAliveTimer);
  }
}

function secondsToMs(seconds: number | undefined): number | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function validateDeepgramResult(message: DeepgramResult): ReturnType<typeof providerError> | null {
  if (typeof message.type !== "string") {
    return providerError(
      STT_ERROR_CODES.protocolError,
      "Deepgram response omitted its message type",
      {
        provider: PROVIDER_NAMES.deepgram,
        retriable: false,
      },
    );
  }
  if (
    message.metadata !== undefined &&
    (message.metadata === null ||
      typeof message.metadata !== "object" ||
      Array.isArray(message.metadata))
  ) {
    return providerError(STT_ERROR_CODES.protocolError, "Deepgram returned invalid metadata", {
      provider: PROVIDER_NAMES.deepgram,
      retriable: false,
    });
  }
  for (const value of [message.timestamp, message.start, message.duration]) {
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        secondsToMs(value) === undefined)
    ) {
      return providerError(
        STT_ERROR_CODES.protocolError,
        "Deepgram returned an invalid timestamp",
        {
          provider: PROVIDER_NAMES.deepgram,
          retriable: false,
        },
      );
    }
  }
  if (message.type !== "Results") {
    return null;
  }
  const channel = message.channel;
  const alternative = channel?.alternatives?.[0];
  if (
    !channel ||
    !Array.isArray(channel.alternatives) ||
    (alternative !== undefined &&
      (alternative === null || typeof alternative !== "object" || Array.isArray(alternative)))
  ) {
    return providerError(
      STT_ERROR_CODES.protocolError,
      "Deepgram returned malformed Results data",
      {
        provider: PROVIDER_NAMES.deepgram,
        retriable: false,
      },
    );
  }
  if (alternative) {
    if (alternative.transcript !== undefined && typeof alternative.transcript !== "string") {
      return providerError(
        STT_ERROR_CODES.protocolError,
        "Deepgram returned an invalid transcript",
        {
          provider: PROVIDER_NAMES.deepgram,
          retriable: false,
        },
      );
    }
    if (
      alternative.confidence !== undefined &&
      (typeof alternative.confidence !== "number" ||
        !Number.isFinite(alternative.confidence) ||
        alternative.confidence < 0 ||
        alternative.confidence > 1)
    ) {
      return providerError(STT_ERROR_CODES.protocolError, "Deepgram returned invalid confidence", {
        provider: PROVIDER_NAMES.deepgram,
        retriable: false,
      });
    }
    if (
      alternative.languages !== undefined &&
      (!Array.isArray(alternative.languages) ||
        alternative.languages.some((language) => typeof language !== "string"))
    ) {
      return providerError(STT_ERROR_CODES.protocolError, "Deepgram returned invalid languages", {
        provider: PROVIDER_NAMES.deepgram,
        retriable: false,
      });
    }
  }
  for (const value of [message.is_final, message.speech_final]) {
    if (value !== undefined && typeof value !== "boolean") {
      return providerError(
        STT_ERROR_CODES.protocolError,
        "Deepgram returned an invalid finality flag",
        {
          provider: PROVIDER_NAMES.deepgram,
          retriable: false,
        },
      );
    }
  }
  if (message.start !== undefined && message.duration !== undefined) {
    const startMs = secondsToMs(message.start);
    const durationMs = secondsToMs(message.duration);
    if (
      startMs === undefined ||
      durationMs === undefined ||
      !Number.isFinite(startMs + durationMs)
    ) {
      return providerError(
        STT_ERROR_CODES.protocolError,
        "Deepgram returned an invalid audio range",
        {
          provider: PROVIDER_NAMES.deepgram,
          retriable: false,
        },
      );
    }
  }
  return null;
}

const DEEPGRAM_KEEPALIVE_INTERVAL_MS = 5_000;
const DEEPGRAM_CLOSE_DRAIN_TIMEOUT_MS = 250;

export function deepgramCloseError(code = 1006, reason?: Buffer) {
  const normalizedCode =
    code === 1006 ? STT_ERROR_CODES.unexpectedEof : STT_ERROR_CODES.protocolError;
  return providerError(
    normalizedCode,
    normalizedCode === STT_ERROR_CODES.unexpectedEof
      ? "Deepgram STT socket closed unexpectedly"
      : `Deepgram STT socket closed with code ${code}`,
    {
      provider: PROVIDER_NAMES.deepgram,
      retriable: normalizedCode === STT_ERROR_CODES.unexpectedEof,
      metadata: socketCloseMetadata(code, reason),
    },
  );
}

export function deepgramProtocolError(message: DeepgramResult, hasSentAudio: boolean) {
  const vendorCode = message.err_code;
  const normalizedCode =
    vendorCode === "DATA-0000"
      ? "stt.provider.input_rejected"
      : vendorCode === "NET-0000"
        ? "stt.provider.internal"
        : vendorCode === "NET-0001" || (vendorCode === "NET-0002" && hasSentAudio)
          ? "stt.provider.service_unavailable"
          : "stt.provider.protocol_error";
  return providerError(normalizedCode, "Deepgram rejected the STT request", {
    provider: PROVIDER_NAMES.deepgram,
    retriable:
      normalizedCode === "stt.provider.service_unavailable" ||
      normalizedCode === "stt.provider.internal",
    metadata: {
      ...(vendorCode ? { providerCode: vendorCode } : {}),
      ...(message.err_msg || message.message ? { providerMessagePresent: true } : {}),
    },
  });
}

export function createDeepgramSttProvider(
  options: DeepgramSttProviderOptions,
): DeepgramSttProvider {
  return new DeepgramSttProvider(options);
}
