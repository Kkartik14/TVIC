import WebSocket from "ws";

import { AsyncQueue } from "@tvic/media";
import type {
  InputAudioChunk,
  ProviderCapabilities,
  ProviderEventId,
  SpeechToTextProvider,
  SttOpenRequest,
  SttStream,
  TranscriptEvent,
} from "@tvic/core";
import {
  cancelledError,
  PCM16_16K_MONO,
  PCM16_8K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  counterIdGenerator,
  TvicThrowableError,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeSttConnectionError,
  normalizeSttSocketError,
  openWebSocket,
  parseJsonObject,
  MAX_PROVIDER_FRAME_BYTES,
  providerFrameTooLarge,
  providerEventQueueOverflow,
  providerThrowableError,
  providerError,
  rawDataByteLength,
  rawDataToBuffer,
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  providerStreamEnded,
  safeClose,
  safeSend,
  socketCloseMetadata,
  writeProviderFrame,
  type ProviderClock,
  validationError,
} from "./common.js";

const SONIOX_PROVIDER = PROVIDER_NAMES.sonioxStt;
const SONIOX_ERROR_CODE = PROVIDER_ERROR_CODES.sonioxStt;
const SONIOX_DEFAULT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_CLOSE_TIMEOUT_MS = 2_000;
const SONIOX_KEEPALIVE_INTERVAL_MS = 5_000;
const SONIOX_MAX_TOKENS_PER_FRAME = 4_096;
const SONIOX_MAX_FINAL_TOKENS = 4_096;
const SONIOX_MAX_TRANSCRIPT_CHARS = 65_536;
const SONIOX_MESSAGE_KEYS = new Set([
  "tokens",
  "final_audio_proc_ms",
  "total_audio_proc_ms",
  "finished",
  "error_code",
  "error_type",
  "error_message",
  "more_info",
  "request_id",
]);

const SONIOX_AUDIO_FORMATS = [PCM16_8K_MONO, PCM16_16K_MONO] as const;

const SONIOX_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: SONIOX_AUDIO_FORMATS },
  models: PROVIDER_CATALOG.soniox.models,
  turnDetection: ["stt_endpointing", "manual"],
  metadata: {
    realtimeModel: PROVIDER_CATALOG.soniox.defaultModel,
    partialTranscripts: true,
    tokenFinality: true,
  },
} satisfies ProviderCapabilities;

export interface SonioxStructuredContext {
  readonly general?: readonly Readonly<{ key: string; value: string }>[];
  readonly text?: string;
  readonly terms?: readonly string[];
}

export interface SonioxSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly modelId?: string;
  readonly allowUnknownModel?: boolean;
  readonly context?: SonioxStructuredContext;
  readonly enableEndpointDetection?: boolean;
  readonly maxEndpointDelayMs?: number;
  readonly endpointSensitivity?: number;
  readonly endpointLatencyAdjustmentLevel?: number;
  readonly enableLanguageIdentification?: boolean;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface SonioxToken {
  readonly text?: unknown;
  readonly start_ms?: unknown;
  readonly end_ms?: unknown;
  readonly confidence?: unknown;
  readonly is_final?: unknown;
  readonly speaker?: unknown;
  readonly language?: unknown;
}

interface SonioxMessage {
  readonly tokens?: unknown;
  readonly final_audio_proc_ms?: unknown;
  readonly total_audio_proc_ms?: unknown;
  readonly finished?: unknown;
  readonly error_code?: unknown;
  readonly error_type?: unknown;
  readonly error_message?: unknown;
  readonly more_info?: unknown;
  readonly request_id?: unknown;
}

export class SonioxSttProvider implements SpeechToTextProvider {
  readonly name = SONIOX_PROVIDER;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = SONIOX_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #context: SonioxStructuredContext | undefined;
  readonly #enableEndpointDetection: boolean;
  readonly #maxEndpointDelayMs: number | undefined;
  readonly #endpointSensitivity: number | undefined;
  readonly #endpointLatencyAdjustmentLevel: number | undefined;
  readonly #enableLanguageIdentification: boolean;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<SonioxSttProviderOptions["webSocketFactory"]>;

  constructor(options: SonioxSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? SONIOX_DEFAULT_URL;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.soniox.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#context = options.context;
    this.#enableEndpointDetection = options.enableEndpointDetection ?? true;
    this.#maxEndpointDelayMs = options.maxEndpointDelayMs;
    this.#endpointSensitivity = options.endpointSensitivity;
    this.#endpointLatencyAdjustmentLevel = options.endpointLatencyAdjustmentLevel;
    this.#enableLanguageIdentification = options.enableLanguageIdentification ?? false;
    this.#clock = options.clock ?? new SystemProviderClock();
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
    assertSttSampleRate(PROVIDER_NAMES.sonioxStt, request.format.sampleRateHz, [8000, 16000]);
    const model = request.model ?? this.#modelId;
    assertSupportedModel(
      PROVIDER_NAMES.sonioxStt,
      PROVIDER_CATALOG.soniox.models,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );
    validateSonioxContext(this.#context, request.language, request.vocabulary);
    validateEndpointOptions(
      this.#maxEndpointDelayMs,
      this.#endpointSensitivity,
      this.#endpointLatencyAdjustmentLevel,
    );

    const socket = this.#webSocketFactory(this.#url, {});
    let stream: SonioxSttStream | undefined;
    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      stream = new SonioxSttStream(socket, request, this.#clock, {
        apiKey: this.#apiKey,
        modelId: model,
        context: mergeContext(this.#context, request.vocabulary),
        enableEndpointDetection: this.#enableEndpointDetection,
        maxEndpointDelayMs: this.#maxEndpointDelayMs,
        endpointSensitivity: this.#endpointSensitivity,
        endpointLatencyAdjustmentLevel: this.#endpointLatencyAdjustmentLevel,
        enableLanguageIdentification: this.#enableLanguageIdentification,
      });
      await stream.start(request.signal);
      return stream;
    } catch (error) {
      safeClose(socket);
      await stream?.close().catch(() => undefined);
      throw TvicThrowableError.from(
        normalizeSttConnectionError(error, {
          provider: SONIOX_PROVIDER,
          providerCode: SONIOX_ERROR_CODE,
        }),
      );
    }
  }
}

interface SonioxStreamOptions {
  readonly apiKey: string;
  readonly modelId: string;
  readonly context: SonioxStructuredContext | undefined;
  readonly enableEndpointDetection: boolean;
  readonly maxEndpointDelayMs: number | undefined;
  readonly endpointSensitivity: number | undefined;
  readonly endpointLatencyAdjustmentLevel: number | undefined;
  readonly enableLanguageIdentification: boolean;
}

export class SonioxSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode = "provider" as const;
  readonly timestampOrigin = "generation" as const;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #clock: ProviderClock;
  readonly #options: SonioxStreamOptions;
  readonly #events = new AsyncQueue<TranscriptEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(SONIOX_PROVIDER);
      this.#fail(error);
      return error;
    },
  });
  readonly #ids = counterIdGenerator<ProviderEventId>("soniox_stt_event");
  readonly #finishedPromise: Promise<void>;
  readonly #keepAliveTimer: ReturnType<typeof setInterval>;
  #resolveFinished!: () => void;
  #sequence = 1;
  #closed = false;
  #closing = false;
  #finished = false;
  #started = false;
  #lastActivityAtMs = Date.now();
  #closePromise: Promise<void> | undefined;
  #finalText = "";
  #finalTokens: SonioxToken[] = [];

  constructor(
    socket: WebSocket,
    request: SttOpenRequest,
    clock: ProviderClock,
    options: SonioxStreamOptions,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.#options = options;
    this.events = this.#events;
    this.#finishedPromise = new Promise<void>((resolve) => {
      this.#resolveFinished = resolve;
    });

    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(providerFrameTooLarge(SONIOX_PROVIDER));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) => this.#handleSocketError(error));
    this.#keepAliveTimer = setInterval(
      () => this.#sendKeepAliveIfIdle(),
      SONIOX_KEEPALIVE_INTERVAL_MS,
    );
    this.#keepAliveTimer.unref?.();
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw TvicThrowableError.from(
        cancelledError("soniox.stt.begin_cancelled", "Soniox STT startup was cancelled", {
          provider: SONIOX_PROVIDER,
        }),
      );
    }
    const config: Record<string, unknown> = {
      api_key: this.#options.apiKey,
      model: this.#options.modelId,
      audio_format: "pcm_s16le",
      num_channels: this.#request.format.channels,
      sample_rate: this.#request.format.sampleRateHz,
      enable_endpoint_detection: this.#options.enableEndpointDetection,
    };
    if (this.#request.language) {
      config.language_hints = [this.#request.language];
    }
    if (this.#options.context) {
      config.context = this.#options.context;
    }
    if (this.#options.enableLanguageIdentification) {
      config.enable_language_identification = true;
    }
    if (this.#options.maxEndpointDelayMs !== undefined) {
      config.max_endpoint_delay_ms = this.#options.maxEndpointDelayMs;
    }
    if (this.#options.endpointSensitivity !== undefined) {
      config.endpoint_sensitivity = this.#options.endpointSensitivity;
    }
    if (this.#options.endpointLatencyAdjustmentLevel !== undefined) {
      config.endpoint_latency_adjustment_level = this.#options.endpointLatencyAdjustmentLevel;
    }

    try {
      writeProviderFrame(this.#socket, JSON.stringify(config), {
        code: SONIOX_ERROR_CODE,
        provider: SONIOX_PROVIDER,
        operation: "initialize",
      });
      this.#started = true;
      this.#lastActivityAtMs = Date.now();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(PROVIDER_NAMES.sonioxStt, SONIOX_ERROR_CODE);
    }
    assertSttPcm16leFormat(chunk.audio.format);
    if (chunk.audio.format.sampleRateHz !== this.#request.format.sampleRateHz) {
      throw TvicThrowableError.from(
        validationError(
          "stt.sample_rate_mismatch",
          "Soniox STT audio sample rate does not match the opened stream",
        ),
      );
    }
    if (chunk.audio.bytes.byteLength % 2 !== 0) {
      throw TvicThrowableError.from(
        validationError(
          "stt.audio_odd_byte_length",
          "Soniox STT PCM16LE audio chunks must contain complete samples",
        ),
      );
    }
    try {
      writeProviderFrame(this.#socket, Buffer.from(chunk.audio.bytes), {
        code: SONIOX_ERROR_CODE,
        provider: SONIOX_PROVIDER,
        operation: "audio",
      });
      this.#lastActivityAtMs = Date.now();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(PROVIDER_NAMES.sonioxStt, SONIOX_ERROR_CODE);
    }
    try {
      writeProviderFrame(this.#socket, JSON.stringify({ type: "finalize" }), {
        code: SONIOX_ERROR_CODE,
        provider: SONIOX_PROVIDER,
        operation: "commit",
      });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#keepAliveTimer);
    this.#flushFinalSegment();

    if (!this.#closed && !this.#finished && this.#socket.readyState === WebSocket.OPEN) {
      safeSend(this.#socket, "");
      await Promise.race([this.#finishedPromise, delay(SONIOX_CLOSE_TIMEOUT_MS)]);
    }

    this.#closed = true;
    safeClose(this.#socket);
    this.#events.close();
  }

  #handleMessage(body: string): void {
    if (this.#closed) return;
    const parsed = parseJsonObject(body) as SonioxMessage | null;
    if (!parsed) {
      this.#fail(sonioxProtocolFailure("Soniox STT returned malformed JSON"));
      return;
    }
    const unknownKeys = Object.keys(parsed).filter((key) => !SONIOX_MESSAGE_KEYS.has(key));
    if (unknownKeys.length > 0 || Object.keys(parsed).length === 0) {
      this.#fail(sonioxProtocolFailure("Soniox STT returned an unknown message"));
      return;
    }
    if (
      (parsed.error_type !== undefined && typeof parsed.error_type !== "string") ||
      (parsed.error_message !== undefined && typeof parsed.error_message !== "string")
    ) {
      this.#fail(sonioxProtocolFailure("Soniox STT returned malformed error data"));
      return;
    }
    if (typeof parsed.error_type === "string" || typeof parsed.error_message === "string") {
      this.#fail(sonioxProtocolError(parsed));
      return;
    }
    if (parsed.finished !== undefined && typeof parsed.finished !== "boolean") {
      this.#fail(sonioxProtocolFailure("Soniox STT returned malformed completion data"));
      return;
    }
    if (parsed.finished === true) {
      this.#finished = true;
      this.#resolveFinished();
      this.#flushFinalSegment();
      return;
    }

    if (parsed.tokens === undefined) {
      return;
    }
    if (!Array.isArray(parsed.tokens) || parsed.tokens.length > SONIOX_MAX_TOKENS_PER_FRAME) {
      this.#fail(sonioxProtocolFailure("Soniox STT returned malformed tokens"));
      return;
    }
    const tokens: SonioxToken[] = [];
    for (const value of parsed.tokens) {
      const token = normalizeSonioxToken(value);
      if (!token) {
        this.#fail(sonioxProtocolFailure("Soniox STT returned malformed token fields"));
        return;
      }
      tokens.push(token);
    }
    if (tokens.length === 0) return;
    const nonFinalTokens: SonioxToken[] = [];
    const finalizedTokens: SonioxToken[] = [];
    let nextFinalText = this.#finalText;
    const nextFinalTokens = [...this.#finalTokens];
    let endpointMarker: "provider" | "manual" | undefined;
    for (const token of tokens) {
      if (token.is_final === true) {
        const text = typeof token.text === "string" ? token.text : "";
        if (text === "<end>") {
          if (endpointMarker !== undefined && endpointMarker !== "provider") {
            this.#fail(sonioxProtocolFailure("Soniox STT returned conflicting endpoints"));
            return;
          }
          endpointMarker = "provider";
          continue;
        }
        if (text === "<fin>") {
          if (endpointMarker !== undefined && endpointMarker !== "manual") {
            this.#fail(sonioxProtocolFailure("Soniox STT returned conflicting endpoints"));
            return;
          }
          endpointMarker = "manual";
          continue;
        }
        finalizedTokens.push(token);
        if (
          nextFinalText.length + text.length > SONIOX_MAX_TRANSCRIPT_CHARS ||
          nextFinalTokens.length + finalizedTokens.length > SONIOX_MAX_FINAL_TOKENS
        ) {
          this.#fail(sonioxProtocolFailure("Soniox STT transcript exceeded its bound"));
          return;
        }
        nextFinalText += text;
        nextFinalTokens.push(token);
      } else {
        nonFinalTokens.push(token);
      }
    }
    this.#finalText = nextFinalText;
    this.#finalTokens = nextFinalTokens;
    if (this.#request.interimResults && !endpointMarker) {
      const partialText = `${this.#finalText}${nonFinalTokens
        .map((token) => (typeof token.text === "string" ? token.text : ""))
        .join("")}`.trim();
      if (partialText) {
        if (!this.#pushPartial(partialText, nonFinalTokens, finalizedTokens)) return;
      }
    }

    if (endpointMarker) {
      if (!this.#flushFinalSegment()) return;
      this.#pushEndpoint(endpointMarker);
    }
  }

  #pushPartial(
    text: string,
    nonFinalTokens: readonly SonioxToken[],
    finalizedTokens: readonly SonioxToken[],
  ): boolean {
    const timestamp = this.#clock.now();
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type: "stt.partial",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: SONIOX_PROVIDER,
        text,
        ...languageFromTokens(nonFinalTokens, finalizedTokens),
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        ...audioOffsetsFromTokens(nonFinalTokens, finalizedTokens),
        metadata: {
          soniox: {
            finalizedTokens,
            nonFinalTokens,
          },
        },
      })
    ) {
      return false;
    }
    this.#sequence += 1;
    return true;
  }

  #flushFinalSegment(): boolean {
    const text = this.#finalText.trim();
    if (!text) {
      this.#finalText = "";
      this.#finalTokens = [];
      return true;
    }
    const timestamp = this.#clock.now();
    const tokens = this.#finalTokens;
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type: "stt.final",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: SONIOX_PROVIDER,
        text,
        ...languageFromTokens(tokens, []),
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        ...audioOffsetsFromTokens(tokens, []),
        metadata: { soniox: { finalizedTokens: tokens } },
      })
    ) {
      return false;
    }
    this.#sequence += 1;
    this.#finalText = "";
    this.#finalTokens = [];
    return true;
  }

  #pushEndpoint(reason: "provider" | "manual"): boolean {
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type: "stt.endpoint",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: SONIOX_PROVIDER,
        reason,
        timestamp: this.#clock.now(),
      })
    ) {
      return false;
    }
    this.#sequence += 1;
    return true;
  }

  #handleSocketError(error: unknown): void {
    if (this.#closing || this.#closed) {
      return;
    }
    this.#fail(
      normalizeSttSocketError(error, {
        provider: SONIOX_PROVIDER,
        providerCode: SONIOX_ERROR_CODE,
      }),
    );
  }

  #pushEvent(event: TranscriptEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(SONIOX_PROVIDER));
    return false;
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    this.#resolveFinished();
    if (this.#closing || this.#closed || this.#finished) {
      return;
    }
    this.#fail(sonioxCloseError(code, reason));
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: SONIOX_ERROR_CODE,
      provider: SONIOX_PROVIDER,
    });
    this.#closed = true;
    clearInterval(this.#keepAliveTimer);
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #sendKeepAliveIfIdle(): void {
    if (
      !this.#started ||
      this.#closed ||
      this.#closing ||
      Date.now() - this.#lastActivityAtMs < SONIOX_KEEPALIVE_INTERVAL_MS
    ) {
      return;
    }
    try {
      writeProviderFrame(this.#socket, JSON.stringify({ type: "keepalive" }), {
        code: SONIOX_ERROR_CODE,
        provider: SONIOX_PROVIDER,
        operation: "keepalive",
      });
      this.#lastActivityAtMs = Date.now();
    } catch (error) {
      this.#fail(error);
    }
  }
}

function normalizeSonioxToken(value: unknown): SonioxToken | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const token = value as Record<string, unknown>;
  if (typeof token.text !== "string" || token.text.length > 4_096) {
    return null;
  }
  if (typeof token.is_final !== "boolean") {
    return null;
  }
  if (
    (token.start_ms !== undefined &&
      (typeof token.start_ms !== "number" ||
        !Number.isFinite(token.start_ms) ||
        token.start_ms < 0)) ||
    (token.end_ms !== undefined &&
      (typeof token.end_ms !== "number" || !Number.isFinite(token.end_ms) || token.end_ms < 0)) ||
    (typeof token.start_ms === "number" &&
      typeof token.end_ms === "number" &&
      token.end_ms < token.start_ms) ||
    (token.confidence !== undefined &&
      (typeof token.confidence !== "number" ||
        !Number.isFinite(token.confidence) ||
        token.confidence < 0 ||
        token.confidence > 1)) ||
    (token.speaker !== undefined &&
      (typeof token.speaker !== "string" || token.speaker.length > 128)) ||
    (token.language !== undefined &&
      (typeof token.language !== "string" || token.language.length > 32))
  ) {
    return null;
  }
  return {
    text: token.text,
    start_ms: token.start_ms,
    end_ms: token.end_ms,
    confidence: token.confidence,
    is_final: token.is_final,
    speaker: token.speaker,
    language: token.language,
  };
}

function validateSonioxContext(
  context: SonioxStructuredContext | undefined,
  language: string | undefined,
  vocabulary: readonly string[] | undefined,
): void {
  const terms = [...(context?.terms ?? []), ...(vocabulary ?? [])];
  if (
    (language !== undefined && (language.length === 0 || language.length > 64)) ||
    terms.length > 256 ||
    terms.some((term) => typeof term !== "string" || term.length === 0 || term.length > 128) ||
    (context?.text !== undefined && context.text.length > 16_384) ||
    (context?.general?.length ?? 0) > 256 ||
    (context?.general ?? []).some(
      (entry) =>
        typeof entry.key !== "string" ||
        typeof entry.value !== "string" ||
        entry.key.length === 0 ||
        entry.key.length > 128 ||
        entry.value.length > 1_024,
    )
  ) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "Soniox STT context and language options are out of bounds",
      ),
    );
  }
}

function mergeContext(
  context: SonioxStructuredContext | undefined,
  vocabulary: readonly string[] | undefined,
): SonioxStructuredContext | undefined {
  const terms = [...(context?.terms ?? []), ...(vocabulary ?? [])];
  if (!context && terms.length === 0) {
    return undefined;
  }
  return {
    ...context,
    ...(terms.length > 0 ? { terms: [...new Set(terms)] } : {}),
  };
}

function validateEndpointOptions(
  maxEndpointDelayMs: number | undefined,
  endpointSensitivity: number | undefined,
  endpointLatencyAdjustmentLevel: number | undefined,
): void {
  if (
    maxEndpointDelayMs !== undefined &&
    (!Number.isInteger(maxEndpointDelayMs) || maxEndpointDelayMs < 500 || maxEndpointDelayMs > 3000)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "stt.soniox.max_endpoint_delay_invalid",
        "Soniox maxEndpointDelayMs must be an integer between 500 and 3000",
      ),
    );
  }
  if (
    endpointSensitivity !== undefined &&
    (!Number.isFinite(endpointSensitivity) || endpointSensitivity < -1 || endpointSensitivity > 1)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "stt.soniox.endpoint_sensitivity_invalid",
        "Soniox endpointSensitivity must be between -1 and 1",
      ),
    );
  }
  if (
    endpointLatencyAdjustmentLevel !== undefined &&
    (!Number.isInteger(endpointLatencyAdjustmentLevel) ||
      endpointLatencyAdjustmentLevel < 0 ||
      endpointLatencyAdjustmentLevel > 3)
  ) {
    throw TvicThrowableError.from(
      validationError(
        "stt.soniox.endpoint_latency_adjustment_invalid",
        "Soniox endpointLatencyAdjustmentLevel must be an integer between 0 and 3",
      ),
    );
  }
}

function languageFromTokens(...groups: readonly (readonly SonioxToken[])[]): {
  readonly language?: string;
} {
  for (const group of groups) {
    for (const token of group) {
      if (typeof token.language === "string" && token.language) {
        return { language: token.language };
      }
    }
  }
  return {};
}

function audioOffsetsFromTokens(...groups: readonly (readonly SonioxToken[])[]): {
  readonly audioStartMs?: number;
  readonly audioEndMs?: number;
} {
  const tokens = groups.flat();
  const starts = tokens
    .map((token) => token.start_ms)
    .filter((value): value is number => typeof value === "number");
  const ends = tokens
    .map((token) => token.end_ms)
    .filter((value): value is number => typeof value === "number");
  return {
    ...(starts.length > 0 ? { audioStartMs: Math.min(...starts) } : {}),
    ...(ends.length > 0 ? { audioEndMs: Math.max(...ends) } : {}),
  };
}

function sonioxProtocolFailure(message: string) {
  return providerError(STT_ERROR_CODES.protocolError, message, {
    provider: SONIOX_PROVIDER,
    retriable: false,
  });
}
function errorMessage(message: SonioxMessage): string {
  if (typeof message.error_message === "string") {
    return boundedErrorMessage(message.error_message);
  }
  if (typeof message.error_type === "string") {
    return boundedErrorMessage(message.error_type);
  }
  return "Soniox STT error";
}

const boundedErrorMessage = (value: string): string =>
  value.length <= 1_024 ? value : value.slice(0, 1_021) + "...";

export function sonioxCloseError(code = 1006, reason?: Buffer) {
  const normalizedCode =
    code === 1006 ? STT_ERROR_CODES.unexpectedEof : STT_ERROR_CODES.protocolError;
  return providerError(
    normalizedCode,
    normalizedCode === STT_ERROR_CODES.unexpectedEof
      ? "Soniox STT socket closed unexpectedly"
      : `Soniox STT socket closed with code ${code}`,
    {
      provider: SONIOX_PROVIDER,
      retriable: normalizedCode === STT_ERROR_CODES.unexpectedEof,
      metadata: socketCloseMetadata(code, reason),
    },
  );
}

export function sonioxProtocolError(message: SonioxMessage) {
  const type =
    typeof message.error_type === "string" ? message.error_type.toLowerCase() : undefined;
  const code =
    type === "unauthenticated" || type === "authentication_error"
      ? "stt.provider.auth_failed"
      : type === "budget_exceeded" || type?.includes("balance") === true
        ? "stt.provider.quota_exceeded"
        : type === "limit_exceeded"
          ? "stt.provider.rate_limited"
          : type === "request_timeout"
            ? "stt.provider.service_unavailable"
            : type === "internal_error"
              ? "stt.provider.internal"
              : type === "service_unavailable"
                ? "stt.provider.service_unavailable"
                : type === "max_duration_reached"
                  ? "stt.provider.session_expired"
                  : type === "invalid_request" || type === "model_not_available"
                    ? "stt.provider.invalid_request"
                    : "stt.provider.protocol_error";
  return providerError(code, errorMessage(message), {
    provider: SONIOX_PROVIDER,
    retriable: code === "stt.provider.service_unavailable" || code === "stt.provider.internal",
    metadata: {
      soniox: {
        ...(typeof message.error_code === "number" ? { errorCode: message.error_code } : {}),
        ...(typeof message.error_type === "string" ? { errorType: message.error_type } : {}),
        ...(typeof message.more_info === "string" ? { moreInfo: message.more_info } : {}),
        ...(typeof message.request_id === "string" ? { requestId: message.request_id } : {}),
      },
    },
  });
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createSonioxSttProvider(options: SonioxSttProviderOptions): SonioxSttProvider {
  return new SonioxSttProvider(options);
}
