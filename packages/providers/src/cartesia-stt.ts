import WebSocket from "ws";

import { AsyncQueue } from "@tvic/media";
import type {
  InputAudioChunk,
  ProviderCapabilities,
  ProviderEventId,
  SpeechToTextProvider,
  SttBatchTranscription,
  SttBatchTranscriptionRequest,
  SttOpenRequest,
  SttStream,
  TranscriptEvent,
} from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  TVIC_ERROR_CODES,
  TvicThrowableError,
  counterIdGenerator,
  sameAudioFormat,
} from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";
import {
  CARTESIA_STT_DEFAULT_BATCH_MODEL,
  CARTESIA_STT_DEFAULT_BATCH_URL,
  transcribeCartesiaBatch,
} from "./cartesia-stt-batch.js";
import {
  SystemProviderClock,
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  boundedProviderMetadata,
  normalizeSttConnectionError,
  normalizeSttSocketError,
  MAX_PROVIDER_FRAME_BYTES,
  openWebSocket,
  parseJsonObject,
  providerError,
  providerEventQueueOverflow,
  providerFrameTooLarge,
  providerStreamEnded,
  providerThrowableError,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  socketCloseMetadata,
  validationError,
  writeProviderFrame,
  type ProviderClock,
} from "./common.js";
import { classifiedProviderError } from "./provider-error-classifier.js";

const CARTESIA_STT_PROVIDER = PROVIDER_NAMES.cartesiaStt;
const CARTESIA_STT_ERROR_CODE = PROVIDER_ERROR_CODES.cartesiaStt;
const CARTESIA_STT_DEFAULT_MANUAL_URL = "wss://api.cartesia.ai/stt/websocket";
const CARTESIA_STT_DEFAULT_AUTO_URL = "wss://api.cartesia.ai/stt/turns/websocket";
const CARTESIA_STT_CLOSE_TIMEOUT_MS = 2_000;
const CARTESIA_STT_MAX_PENDING_FINALIZATIONS = 1_024;
const CARTESIA_STT_MAX_KEYTERMS = 100;
const CARTESIA_STT_MAX_KEYTERM_CHARS = 1_200;
const CARTESIA_STT_AUTO_MODELS = new Set(["ink-2"]);

const CARTESIA_STT_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  batch: { input: true, output: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http", "websocket"],
  audio: { input: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.cartesiaStt.models,
  batchModels: PROVIDER_CATALOG.cartesiaStt.batchModels,
  turnDetection: ["provider", "manual"],
  metadata: {
    realtimeModels: ["ink-2", "ink-preview", "ink-whisper-2025-06-04"],
    autoTurnModels: ["ink-2"],
    batchModels: [CARTESIA_STT_DEFAULT_BATCH_MODEL],
    partialTranscripts: true,
    manualFinalize: true,
  },
} satisfies ProviderCapabilities;

export type CartesiaSttMode = "manual" | "auto";

export interface CartesiaSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly batchUrl?: string;
  readonly modelId?: string;
  readonly batchModelId?: string;
  readonly allowUnknownModel?: boolean;
  /** `manual` uses `/stt/websocket`; `auto` uses Ink's native turn detector. */
  readonly mode?: CartesiaSttMode;
  /** Used when a session request does not provide a language. Ink 2 can auto-detect. */
  readonly language?: string;
  readonly turnStartThreshold?: number;
  readonly turnEagerEndThreshold?: number;
  readonly turnEndThreshold?: number;
  readonly turnEndTimeoutMs?: number;
  readonly clock?: ProviderClock;
  readonly fetchImpl?: typeof fetch;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface CartesiaSttMessage {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly transcript?: unknown;
  readonly is_final?: unknown;
  readonly language?: unknown;
  readonly duration?: unknown;
  readonly words?: unknown;
  readonly request_id?: unknown;
  readonly turn_id?: unknown;
  readonly error_code?: unknown;
  readonly status_code?: unknown;
  readonly title?: unknown;
  readonly message?: unknown;
}

interface CartesiaSttStreamOptions {
  readonly mode: CartesiaSttMode;
  readonly model: string;
  readonly clock: ProviderClock;
}

export class CartesiaSttProvider implements SpeechToTextProvider {
  readonly name = CARTESIA_STT_PROVIDER;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = CARTESIA_STT_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #batchUrl: string;
  readonly #modelId: string;
  readonly #batchModelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #mode: CartesiaSttMode;
  readonly #language: string | undefined;
  readonly #turnStartThreshold: number | undefined;
  readonly #turnEagerEndThreshold: number | undefined;
  readonly #turnEndThreshold: number | undefined;
  readonly #turnEndTimeoutMs: number | undefined;
  readonly #clock: ProviderClock;
  readonly #fetch: NonNullable<CartesiaSttProviderOptions["fetchImpl"]>;
  readonly #webSocketFactory: NonNullable<CartesiaSttProviderOptions["webSocketFactory"]>;

  constructor(options: CartesiaSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#mode = options.mode ?? ADAPTER_DEFAULTS.cartesiaStt.mode;
    assertCartesiaSttMode(this.#mode);
    this.#url =
      options.url ??
      (this.#mode === "auto" ? CARTESIA_STT_DEFAULT_AUTO_URL : CARTESIA_STT_DEFAULT_MANUAL_URL);
    this.#batchUrl = options.batchUrl ?? CARTESIA_STT_DEFAULT_BATCH_URL;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.cartesiaStt.defaultModel;
    this.#batchModelId =
      options.batchModelId ??
      PROVIDER_CATALOG.cartesiaStt.batchModels?.[0] ??
      CARTESIA_STT_DEFAULT_BATCH_MODEL;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#language = options.language;
    this.#turnStartThreshold = options.turnStartThreshold;
    this.#turnEagerEndThreshold = options.turnEagerEndThreshold;
    this.#turnEndThreshold = options.turnEndThreshold;
    this.#turnEndTimeoutMs = options.turnEndTimeoutMs;
    assertCartesiaTurnOptions(
      this.#turnStartThreshold,
      this.#turnEagerEndThreshold,
      this.#turnEndThreshold,
      this.#turnEndTimeoutMs,
    );
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
    assertSttSampleRate(CARTESIA_STT_PROVIDER, request.format.sampleRateHz, [16000]);
    const model = request.model ?? this.#modelId;
    const allowUnknownModel = request.allowUnknownModel ?? this.#allowUnknownModel;
    assertSupportedModel(
      CARTESIA_STT_PROVIDER,
      PROVIDER_CATALOG.cartesiaStt.models,
      model,
      allowUnknownModel,
    );
    if (this.#mode === "auto" && !allowUnknownModel && !CARTESIA_STT_AUTO_MODELS.has(model)) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerModelUnsupported,
          `${CARTESIA_STT_PROVIDER} auto turn detection does not support model ${model}`,
          {
            provider: CARTESIA_STT_PROVIDER,
            metadata: { model, supportedModels: [...CARTESIA_STT_AUTO_MODELS] },
          },
        ),
      );
    }
    validateKeyterms(request.vocabulary);

    const url = new URL(this.#url);
    url.searchParams.set("model", model);
    url.searchParams.set("encoding", "pcm_s16le");
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
    url.searchParams.set("cartesia_version", PROVIDER_API_VERSIONS.cartesiaStt);
    const language = request.language ?? this.#language;
    if (language) {
      url.searchParams.set("language", language);
    }
    for (const keyterm of request.vocabulary ?? []) {
      url.searchParams.append("keyterm", keyterm);
    }
    if (this.#mode === "auto") {
      setOptionalQuery(url, "turn_start_threshold", this.#turnStartThreshold);
      setOptionalQuery(url, "turn_eager_end_threshold", this.#turnEagerEndThreshold);
      setOptionalQuery(url, "turn_end_threshold", this.#turnEndThreshold);
      setOptionalQuery(url, "turn_end_timeout_ms", this.#turnEndTimeoutMs);
    }

    let socket: WebSocket | undefined;
    try {
      socket = this.#webSocketFactory(url.toString(), {
        "X-API-Key": this.#apiKey,
        "Cartesia-Version": PROVIDER_API_VERSIONS.cartesiaStt,
      });
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      return new CartesiaSttStream(socket, request, {
        mode: this.#mode,
        model,
        clock: this.#clock,
      });
    } catch (error) {
      if (socket) safeClose(socket);
      throw TvicThrowableError.from(
        normalizeSttConnectionError(error, {
          provider: CARTESIA_STT_PROVIDER,
          providerCode: CARTESIA_STT_ERROR_CODE,
        }),
      );
    }
  }

  async transcribe(request: SttBatchTranscriptionRequest): Promise<SttBatchTranscription> {
    return transcribeCartesiaBatch(request, {
      apiKey: this.#apiKey,
      batchUrl: this.#batchUrl,
      batchModelId: this.#batchModelId,
      allowUnknownModel: this.#allowUnknownModel,
      fetchImpl: this.#fetch,
    });
  }
}

export class CartesiaSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode: "provider" | "none";
  readonly timestampOrigin = "generation" as const;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #mode: CartesiaSttMode;
  readonly #model: string;
  readonly #clock: ProviderClock;
  readonly #events = new AsyncQueue<TranscriptEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(CARTESIA_STT_PROVIDER);
      this.#fail(error);
      return error;
    },
  });
  readonly #ids = counterIdGenerator<ProviderEventId>("cartesia_stt_event");
  #sequence = 1;
  #closed = false;
  #closing = false;
  #pendingFinalizations = 0;
  #autoTurnActive = false;
  #autoEagerEnded = false;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;
  #rejectClose: ((error: unknown) => void) | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(socket: WebSocket, request: SttOpenRequest, options: CartesiaSttStreamOptions) {
    this.#socket = socket;
    this.#request = request;
    this.#mode = options.mode;
    this.#model = options.model;
    this.#clock = options.clock;
    this.commitMode = this.#mode === "manual" ? "provider" : "none";
    this.events = this.#events;

    socket.on("message", (data) => {
      if (this.#closed) return;
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(providerFrameTooLarge(CARTESIA_STT_PROVIDER));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) => {
      this.#fail(
        normalizeSttSocketError(error, {
          provider: CARTESIA_STT_PROVIDER,
          providerCode: CARTESIA_STT_ERROR_CODE,
        }),
      );
    });
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(CARTESIA_STT_PROVIDER, CARTESIA_STT_ERROR_CODE);
    }
    if (!sameAudioFormat(chunk.audio.format, this.#request.format)) {
      const error = TvicThrowableError.from(
        providerError(
          "stt.audio_format_invalid",
          "Cartesia STT audio chunk format does not match the opened stream",
          { provider: CARTESIA_STT_PROVIDER, retriable: false },
        ),
      );
      this.#fail(error);
      throw error;
    }
    try {
      writeProviderFrame(this.#socket, Buffer.from(chunk.audio.bytes), {
        code: CARTESIA_STT_ERROR_CODE,
        provider: CARTESIA_STT_PROVIDER,
        operation: "audio",
      });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(CARTESIA_STT_PROVIDER, CARTESIA_STT_ERROR_CODE);
    }
    if (this.#mode === "auto") return;
    if (this.#pendingFinalizations >= CARTESIA_STT_MAX_PENDING_FINALIZATIONS) {
      const error = this.#sessionBufferOverflowError();
      this.#fail(error);
      throw error;
    }
    this.#pendingFinalizations += 1;
    try {
      // Cartesia's manual realtime endpoint uses the plain-text finalize command.
      writeProviderFrame(this.#socket, "finalize", {
        code: CARTESIA_STT_ERROR_CODE,
        provider: CARTESIA_STT_PROVIDER,
        operation: "commit",
      });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return Promise.resolve();

    this.#closing = true;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });

    if (this.#socket.readyState !== WebSocket.OPEN) {
      this.#closeQueue();
      return this.#closePromise;
    }

    const command = this.#mode === "auto" ? JSON.stringify({ type: "close" }) : "close";
    if (!safeSend(this.#socket, command)) {
      safeClose(this.#socket);
      this.#closeQueue();
      return this.#closePromise;
    }
    this.#closeTimer = setTimeout(() => {
      this.#fail(this.#closeTimeoutError());
    }, CARTESIA_STT_CLOSE_TIMEOUT_MS);
    this.#closeTimer.unref?.();
    return this.#closePromise;
  }

  #handleMessage(body: string): void {
    const parsed = parseJsonObject(body) as CartesiaSttMessage | null;
    if (!parsed || typeof parsed.type !== "string") {
      this.#fail(this.#protocolError("Cartesia STT returned malformed JSON"));
      return;
    }
    if (parsed.type === "error") {
      this.#fail(cartesiaSttProviderError(parsed));
      return;
    }
    if (parsed.type === "connected") {
      return;
    }
    if (parsed.type === "done") {
      this.#handleDone();
      return;
    }
    if (this.#mode === "manual") {
      this.#handleManualMessage(parsed);
    } else {
      this.#handleAutoMessage(parsed);
    }
  }

  #handleManualMessage(message: CartesiaSttMessage): void {
    switch (message.type) {
      case "transcript":
        this.#handleManualTranscript(message);
        return;
      case "flush_done":
        this.#handleFlushDone();
        return;
      default:
        this.#fail(
          this.#protocolError(`Cartesia STT returned unexpected message type ${message.type}`),
        );
    }
  }

  #handleManualTranscript(message: CartesiaSttMessage): void {
    if (typeof message.is_final !== "boolean" || typeof message.text !== "string") {
      this.#fail(this.#protocolError("Cartesia STT returned malformed transcript data"));
      return;
    }
    const timestamp = this.#clock.now();
    if (message.text.trim() && (message.is_final || this.#request.interimResults)) {
      this.#pushSegment(message.text, message.is_final, timestamp, message);
    }
  }

  #handleFlushDone(): void {
    if (this.#pendingFinalizations <= 0) {
      this.#fail(
        this.#protocolError("Cartesia STT returned an uncorrelated flush acknowledgement"),
      );
      return;
    }
    this.#pendingFinalizations -= 1;
    this.#pushEndpoint("manual");
  }

  #handleAutoMessage(message: CartesiaSttMessage): void {
    switch (message.type) {
      case "turn.start":
        if (this.#autoTurnActive) {
          this.#fail(
            this.#protocolError("Cartesia STT started a turn before ending the previous turn"),
          );
          return;
        }
        this.#autoTurnActive = true;
        this.#autoEagerEnded = false;
        const metadata = this.#metadata(message);
        this.#pushEvent({
          id: this.#ids.next(),
          type: "stt.speech.started",
          direction: "input",
          sessionId: this.#request.sessionId,
          sequence: this.#sequence,
          provider: CARTESIA_STT_PROVIDER,
          timestamp: this.#clock.now(),
          ...(metadata ? { metadata } : {}),
        });
        this.#sequence += 1;
        return;
      case "turn.update":
        this.#handleAutoTranscript(message, false);
        return;
      case "turn.eager_end":
        this.#autoEagerEnded = true;
        this.#handleAutoTranscript(message, false);
        return;
      case "turn.resume":
        if (!this.#autoTurnActive || !this.#autoEagerEnded) {
          this.#fail(this.#protocolError("Cartesia STT resumed a turn without an eager end"));
          return;
        }
        this.#autoEagerEnded = false;
        return;
      case "turn.end":
        this.#handleAutoTranscript(message, true);
        if (!this.#autoTurnActive) return;
        this.#autoTurnActive = false;
        this.#autoEagerEnded = false;
        this.#pushEndpoint("provider");
        return;
      default:
        this.#fail(
          this.#protocolError(`Cartesia STT returned unexpected message type ${message.type}`),
        );
    }
  }

  #handleAutoTranscript(message: CartesiaSttMessage, final: boolean): void {
    const text = transcriptText(message);
    if (!this.#autoTurnActive || text === undefined) {
      this.#fail(this.#protocolError("Cartesia STT returned a transcript outside an active turn"));
      return;
    }
    if (text.trim() && (this.#request.interimResults || final)) {
      this.#pushSegment(text, final, this.#clock.now(), message);
    }
  }

  #handleDone(): void {
    if (this.#mode === "manual" && this.#pendingFinalizations > 0) {
      this.#fail(this.#protocolError("Cartesia STT closed before acknowledging every finalize"));
      return;
    }
    if (this.#mode === "auto" && this.#autoTurnActive && !this.#closing) {
      this.#fail(this.#protocolError("Cartesia STT closed before ending the active turn"));
      return;
    }
    this.#autoTurnActive = false;
    this.#autoEagerEnded = false;
    this.#closeQueue();
  }

  #pushSegment(
    text: string,
    final: boolean,
    timestamp: ReturnType<ProviderClock["now"]>,
    message: CartesiaSttMessage,
  ): void {
    const metadata = this.#metadata(message);
    this.#pushEvent({
      id: this.#ids.next(),
      type: final ? "stt.final" : "stt.partial",
      direction: "input",
      sessionId: this.#request.sessionId,
      sequence: this.#sequence,
      provider: CARTESIA_STT_PROVIDER,
      text,
      ...(typeof message.language === "string" ? { language: message.language } : {}),
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      ...(metadata ? { metadata } : {}),
    });
    this.#sequence += 1;
  }

  #pushEndpoint(reason: "manual" | "provider"): void {
    const metadata = this.#metadata({ type: "endpoint" });
    this.#pushEvent({
      id: this.#ids.next(),
      type: "stt.endpoint",
      direction: "input",
      sessionId: this.#request.sessionId,
      sequence: this.#sequence,
      provider: CARTESIA_STT_PROVIDER,
      reason,
      timestamp: this.#clock.now(),
      ...(metadata ? { metadata } : {}),
    });
    this.#sequence += 1;
  }

  #metadata(message: CartesiaSttMessage): Readonly<Record<string, unknown>> | undefined {
    const details: Record<string, unknown> = {
      model: this.#model,
      mode: this.#mode,
      ...(stringField(message.request_id) ? { requestId: stringField(message.request_id) } : {}),
      ...(stringField(message.turn_id) ? { turnId: stringField(message.turn_id) } : {}),
      ...(stringField(message.language) ? { language: stringField(message.language) } : {}),
      ...(finiteNonNegative(message.duration) !== undefined
        ? { durationMs: finiteNonNegative(message.duration)! * 1_000 }
        : {}),
      ...(message.words !== undefined ? { words: message.words } : {}),
    };
    return boundedProviderMetadata({ cartesia: details });
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
    this.#events.close();
    closeCartesiaSocket(this.#socket);
    const resolveClose = this.#resolveClose;
    this.#resolveClose = undefined;
    this.#rejectClose = undefined;
    resolveClose?.();
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    if (this.#closed || this.#closing) {
      this.#closeQueue();
      return;
    }
    if (code === 1000) {
      this.#closeQueue();
      return;
    }
    this.#fail(
      providerError(STT_ERROR_CODES.serviceUnavailable, "Cartesia STT socket closed unexpectedly", {
        provider: CARTESIA_STT_PROVIDER,
        retriable: code === 1001 || code === 1006 || code === 1011,
        metadata: socketCloseMetadata(code, reason),
      }),
    );
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const throwable = providerThrowableError(error, {
      code: CARTESIA_STT_ERROR_CODE,
      provider: CARTESIA_STT_PROVIDER,
    });
    this.#closed = true;
    this.#closing = false;
    if (this.#closeTimer) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    this.#events.fail(throwable);
    const rejectClose = this.#rejectClose;
    this.#resolveClose = undefined;
    this.#rejectClose = undefined;
    rejectClose?.(throwable);
    closeCartesiaSocket(this.#socket);
  }

  #pushEvent(event: TranscriptEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(CARTESIA_STT_PROVIDER));
    return false;
  }

  #protocolError(message: string): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(STT_ERROR_CODES.protocolError, message, {
        provider: CARTESIA_STT_PROVIDER,
        retriable: false,
      }),
    );
  }

  #sessionBufferOverflowError(): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(
        STT_ERROR_CODES.sessionBufferOverflow,
        "Cartesia STT has too many pending finalize commands",
        {
          provider: CARTESIA_STT_PROVIDER,
          retriable: false,
        },
      ),
    );
  }

  #closeTimeoutError(): TvicThrowableError {
    return TvicThrowableError.from(
      providerError(
        STT_ERROR_CODES.closeTimeout,
        `Cartesia STT close did not complete within ${CARTESIA_STT_CLOSE_TIMEOUT_MS}ms`,
        {
          provider: CARTESIA_STT_PROVIDER,
          retriable: false,
        },
      ),
    );
  }
}

export function cartesiaSttProviderError(message: CartesiaSttMessage) {
  const input: {
    providerCode?: unknown;
    providerType?: unknown;
    status?: number;
    message?: unknown;
  } = {};
  if (message.error_code !== undefined) input.providerCode = message.error_code;
  if (message.type !== undefined) input.providerType = message.type;
  const status = integerStatus(message.status_code);
  if (status !== undefined) input.status = status;
  if (message.message !== undefined || message.title !== undefined) {
    input.message = message.message ?? message.title;
  }
  return classifiedProviderError(CARTESIA_STT_PROVIDER, "Cartesia rejected the STT request", input);
}

function assertCartesiaSttMode(value: string): asserts value is CartesiaSttMode {
  if (value === "manual" || value === "auto") return;
  throw TvicThrowableError.from(
    validationError(
      TVIC_ERROR_CODES.providerInvalidRequest,
      `Cartesia STT mode must be manual or auto, received ${value}`,
      { provider: CARTESIA_STT_PROVIDER },
    ),
  );
}

function assertCartesiaTurnOptions(
  start: number | undefined,
  eagerEnd: number | undefined,
  end: number | undefined,
  timeoutMs: number | undefined,
): void {
  const effectiveStart = start ?? 0.8;
  const effectiveEagerEnd = eagerEnd ?? 0.6;
  const effectiveEnd = end ?? 0.3;
  if (
    !thresholdInRange(effectiveStart, 0.5, 0.9) ||
    !thresholdInRange(effectiveEagerEnd, 0.3, 0.8) ||
    !thresholdInRange(effectiveEnd, 0.05, 0.5) ||
    !(effectiveStart > effectiveEagerEnd && effectiveEagerEnd > effectiveEnd)
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia STT turn thresholds must be in range and strictly start > eager_end > end",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 640 || timeoutMs > 11_200)
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        "Cartesia STT turn end timeout must be an integer between 640 and 11200 milliseconds",
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
}

function thresholdInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateKeyterms(terms: readonly string[] | undefined): void {
  if (!terms) return;
  const totalChars = terms.reduce((total, term) => total + term.length, 0);
  if (
    terms.length > CARTESIA_STT_MAX_KEYTERMS ||
    totalChars > CARTESIA_STT_MAX_KEYTERM_CHARS ||
    terms.some((term) => typeof term !== "string" || term.length === 0)
  ) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerInvalidRequest,
        `Cartesia STT accepts at most ${CARTESIA_STT_MAX_KEYTERMS} keyterms and ${CARTESIA_STT_MAX_KEYTERM_CHARS} total characters`,
        { provider: CARTESIA_STT_PROVIDER },
      ),
    );
  }
}

function setOptionalQuery(url: URL, key: string, value: number | undefined): void {
  if (value !== undefined) url.searchParams.set(key, String(value));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 4_096 ? value : undefined;
}

function transcriptText(message: CartesiaSttMessage): string | undefined {
  const value = message.transcript ?? message.text;
  return typeof value === "string" ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integerStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function createCartesiaSttProvider(
  options: CartesiaSttProviderOptions,
): CartesiaSttProvider {
  return new CartesiaSttProvider(options);
}

function closeCartesiaSocket(socket: WebSocket): void {
  safeClose(socket);
  const terminate = (socket as WebSocket & { terminate?: () => void }).terminate;
  if (typeof terminate === "function" && socket.readyState !== WebSocket.CLOSED) {
    terminate.call(socket);
  }
}
