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
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  timeoutError,
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
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  providerError,
  providerStreamEnded,
  safeClose,
  safeSend,
  rawDataByteLength,
  rawDataToBuffer,
  socketCloseMetadata,
  type ProviderClock,
  validationError,
} from "./common.js";

const ASSEMBLYAI_PROVIDER = PROVIDER_NAMES.assemblyaiStt;
const ASSEMBLYAI_ERROR_CODE = PROVIDER_ERROR_CODES.assemblyaiStt;
const ASSEMBLYAI_DEFAULT_URL = "wss://streaming.assemblyai.com/v3/ws";
const ASSEMBLYAI_MIN_FRAME_MS = 50;
const ASSEMBLYAI_TARGET_FRAME_MS = 100;
const ASSEMBLYAI_CLOSE_TIMEOUT_MS = 2_000;
const ASSEMBLYAI_BEGIN_TIMEOUT_MS = 10_000;
const ASSEMBLYAI_MAX_PENDING_TURNS = 64;
const ASSEMBLYAI_MAX_PENDING_TURN_BYTES = 64 * 1024;
const ASSEMBLYAI_ERROR_CONTEXT = {
  provider: ASSEMBLYAI_PROVIDER,
  providerCode: ASSEMBLYAI_ERROR_CODE,
};

const ASSEMBLYAI_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.assemblyai.models,
  turnDetection: ["stt_endpointing"],
  metadata: {
    realtimeModel: PROVIDER_CATALOG.assemblyai.defaultModel,
    partialTranscripts: true,
    formattedTurns: true,
  },
} satisfies ProviderCapabilities;

export interface AssemblyAiSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly modelId?: string;
  readonly allowUnknownModel?: boolean;
  readonly formatTurns?: boolean;
  readonly prompt?: string;
  readonly languageDetection?: boolean;
  readonly minTurnSilenceMs?: number;
  readonly maxTurnSilenceMs?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface AssemblyAiBeginMessage {
  readonly type: "Begin";
  readonly id?: unknown;
  readonly expires_at?: unknown;
}

interface AssemblyAiTurnMessage {
  readonly type: "Turn";
  readonly turn_order?: unknown;
  readonly turn_is_formatted?: unknown;
  readonly end_of_turn?: unknown;
  readonly transcript?: unknown;
  readonly utterance?: unknown;
  readonly end_of_turn_confidence?: unknown;
  readonly words?: unknown;
  readonly language_code?: unknown;
  readonly language_confidence?: unknown;
}

interface AssemblyAiSpeechStartedMessage {
  readonly type: "SpeechStarted";
  readonly timestamp?: unknown;
  readonly confidence?: unknown;
}

interface AssemblyAiTerminationMessage {
  readonly type: "Termination";
}

interface AssemblyAiErrorMessage {
  readonly type: "Error" | "error";
  readonly error?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

type AssemblyAiMessage =
  | AssemblyAiBeginMessage
  | AssemblyAiTurnMessage
  | AssemblyAiSpeechStartedMessage
  | AssemblyAiTerminationMessage
  | AssemblyAiErrorMessage;

export class AssemblyAiSttProvider implements SpeechToTextProvider {
  readonly name = ASSEMBLYAI_PROVIDER;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = ASSEMBLYAI_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #formatTurns: boolean;
  readonly #prompt: string | undefined;
  readonly #languageDetection: boolean;
  readonly #minTurnSilenceMs: number | undefined;
  readonly #maxTurnSilenceMs: number | undefined;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<AssemblyAiSttProviderOptions["webSocketFactory"]>;

  constructor(options: AssemblyAiSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? ASSEMBLYAI_DEFAULT_URL;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.assemblyai.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#formatTurns = options.formatTurns ?? true;
    this.#prompt = options.prompt;
    this.#languageDetection = options.languageDetection ?? false;
    this.#minTurnSilenceMs = options.minTurnSilenceMs;
    this.#maxTurnSilenceMs = options.maxTurnSilenceMs;
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
    assertSttSampleRate(PROVIDER_NAMES.assemblyaiStt, request.format.sampleRateHz, [
      PCM16_16K_MONO.sampleRateHz,
    ]);
    const model = request.model ?? this.#modelId;
    assertSupportedModel(
      PROVIDER_NAMES.assemblyaiStt,
      PROVIDER_CATALOG.assemblyai.models,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );

    const url = new URL(this.#url);
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
    url.searchParams.set("speech_model", model);
    url.searchParams.set("format_turns", String(this.#formatTurns));
    if (this.#languageDetection) {
      url.searchParams.set("language_detection", "true");
    }
    if (this.#minTurnSilenceMs !== undefined) {
      url.searchParams.set("min_turn_silence", String(this.#minTurnSilenceMs));
    }
    if (this.#maxTurnSilenceMs !== undefined) {
      url.searchParams.set("max_turn_silence", String(this.#maxTurnSilenceMs));
    }

    const terms = request.vocabulary ?? [];
    if (
      terms.length > 100 ||
      terms.some((term) => typeof term !== "string" || term.length === 0 || term.length > 50)
    ) {
      throw TvicThrowableError.from(
        validationError(
          "stt.vocabulary_invalid",
          "AssemblyAI keyterms_prompt supports at most 100 terms of 50 characters each",
        ),
      );
    }
    if (
      (request.language !== undefined &&
        (typeof request.language !== "string" || request.language.length > 64)) ||
      (this.#prompt !== undefined &&
        (typeof this.#prompt !== "string" || this.#prompt.length > 4_096)) ||
      !validSilenceOption(this.#minTurnSilenceMs) ||
      !validSilenceOption(this.#maxTurnSilenceMs) ||
      (this.#minTurnSilenceMs !== undefined &&
        this.#maxTurnSilenceMs !== undefined &&
        this.#minTurnSilenceMs > this.#maxTurnSilenceMs)
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "AssemblyAI STT turn and prompt options are invalid",
        ),
      );
    }
    if (terms.length > 0) {
      url.searchParams.set("keyterms_prompt", JSON.stringify(terms));
    }

    const prompt = buildPrompt(this.#prompt, request.language);
    if (prompt) {
      url.searchParams.set("prompt", prompt);
    }

    const socket = this.#webSocketFactory(url.toString(), {
      Authorization: this.#apiKey,
    });
    const stream = new AssemblyAiSttStream(socket, request, this.#clock, this.#formatTurns);

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      await stream.waitForBegin(request.signal);
      return stream;
    } catch (error) {
      safeClose(socket);
      await stream.close().catch(() => undefined);
      throw TvicThrowableError.from(normalizeSttConnectionError(error, ASSEMBLYAI_ERROR_CONTEXT));
    }
  }
}

export class AssemblyAiSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode = "none" as const;
  readonly timestampOrigin = "generation" as const;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #clock: ProviderClock;
  readonly #formatTurns: boolean;
  readonly #events = new AsyncQueue<TranscriptEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(ASSEMBLYAI_PROVIDER);
      this.#fail(error);
      return error;
    },
  });
  readonly #ids = counterIdGenerator<ProviderEventId>("assemblyai_stt_event");
  readonly #beginPromise: Promise<void>;
  readonly #terminationPromise: Promise<void>;
  #resolveBegin!: () => void;
  #rejectBegin!: (error: unknown) => void;
  #resolveTermination!: () => void;
  #sequence = 1;
  #closed = false;
  #closing = false;
  #begun = false;
  #terminated = false;
  #closePromise: Promise<void> | undefined;
  #lastError: unknown;
  #audioBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #finalizedTurns = new Set<number>();
  readonly #pendingUnformattedTurns = new Map<number, number>();
  #pendingUnformattedBytes = 0;
  #sessionId: string | undefined;
  #expiresAt: number | undefined;

  constructor(
    socket: WebSocket,
    request: SttOpenRequest,
    clock: ProviderClock,
    formatTurns = true,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.#formatTurns = formatTurns;
    this.events = this.#events;
    this.#beginPromise = new Promise<void>((resolve, reject) => {
      this.#resolveBegin = resolve;
      this.#rejectBegin = reject;
    });
    this.#beginPromise.catch(() => undefined);
    this.#terminationPromise = new Promise<void>((resolve) => {
      this.#resolveTermination = resolve;
    });

    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(providerFrameTooLarge(ASSEMBLYAI_PROVIDER));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) => this.#handleSocketError(error));
  }

  async waitForBegin(signal?: AbortSignal): Promise<void> {
    if (this.#begun) {
      return;
    }
    if (signal?.aborted) {
      throw assemblyAiBeginCancelled();
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(assemblyAiBeginTimeout());
      }, ASSEMBLYAI_BEGIN_TIMEOUT_MS);
      const onAbort = (): void => {
        cleanup();
        reject(assemblyAiBeginCancelled());
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#beginPromise.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(PROVIDER_NAMES.assemblyaiStt, ASSEMBLYAI_ERROR_CODE);
    }
    assertSttPcm16leFormat(chunk.audio.format);
    if (chunk.audio.format.sampleRateHz !== this.#request.format.sampleRateHz) {
      throw TvicThrowableError.from(
        validationError(
          "stt.sample_rate_mismatch",
          "AssemblyAI STT audio sample rate does not match the opened stream",
        ),
      );
    }
    if (chunk.audio.bytes.byteLength % 2 !== 0) {
      throw TvicThrowableError.from(
        validationError(
          "stt.audio_odd_byte_length",
          "AssemblyAI STT PCM16LE audio chunks must contain complete samples",
        ),
      );
    }

    this.#audioBuffer = appendBytes(this.#audioBuffer, chunk.audio.bytes);
    const frameBytes = bytesForMs(PCM16_16K_MONO.sampleRateHz, ASSEMBLYAI_TARGET_FRAME_MS);
    while (this.#audioBuffer.byteLength >= frameBytes) {
      const frame = this.#audioBuffer.subarray(0, frameBytes);
      if (!this.#sendAudioFrame(frame)) {
        throw (
          this.#lastError ??
          providerStreamEnded(PROVIDER_NAMES.assemblyaiStt, ASSEMBLYAI_ERROR_CODE)
        );
      }
      this.#audioBuffer = this.#audioBuffer.slice(frameBytes);
    }
  }

  async commit(): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(PROVIDER_NAMES.assemblyaiStt, ASSEMBLYAI_ERROR_CODE);
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
    this.#flushAudioBuffer();

    if (!this.#closed && !this.#terminated && this.#socket.readyState === WebSocket.OPEN) {
      safeSend(this.#socket, JSON.stringify({ type: "Terminate" }));
      await Promise.race([this.#terminationPromise, delay(ASSEMBLYAI_CLOSE_TIMEOUT_MS)]);
    }

    if (!this.#closed && this.#pendingUnformattedTurns.size > 0) {
      this.#fail(assemblyAiProtocolFailure("AssemblyAI closed before formatted turns arrived"));
      return;
    }
    this.#closed = true;
    safeClose(this.#socket);
    this.#events.close();
  }

  #handleMessage(body: string): void {
    if (this.#closed) return;
    const parsed = parseJsonObject(body) as AssemblyAiMessage | null;
    if (!parsed) {
      this.#fail(assemblyAiProtocolFailure("AssemblyAI STT returned malformed JSON"));
      return;
    }

    switch (parsed.type) {
      case "Begin":
        this.#handleBegin(parsed);
        return;
      case "SpeechStarted":
        this.#handleSpeechStarted(parsed);
        return;
      case "Turn":
        this.#handleTurn(parsed);
        return;
      case "Termination":
        this.#terminated = true;
        this.#resolveTermination();
        return;
      case "Error":
      case "error":
        this.#fail(assemblyAiProtocolError(parsed));
        return;
      default:
        this.#fail(assemblyAiProtocolFailure("AssemblyAI STT returned an unknown message type"));
        return;
    }
  }

  #handleBegin(message: AssemblyAiBeginMessage): void {
    if (this.#begun) {
      this.#fail(assemblyAiProtocolFailure("AssemblyAI STT returned duplicate Begin"));
      return;
    }
    this.#begun = true;
    this.#sessionId = typeof message.id === "string" ? message.id : undefined;
    this.#expiresAt = typeof message.expires_at === "number" ? message.expires_at : undefined;
    this.#resolveBegin();
  }

  #handleSpeechStarted(message: AssemblyAiSpeechStartedMessage): void {
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type: "stt.speech.started",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: ASSEMBLYAI_PROVIDER,
        timestamp: this.#clock.now(),
        metadata: {
          assemblyai: {
            ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
            ...(typeof message.confidence === "number" ? { confidence: message.confidence } : {}),
            ...this.#sessionMetadata(),
          },
        },
      })
    ) {
      return;
    }
    this.#sequence += 1;
  }

  #handleTurn(message: AssemblyAiTurnMessage): void {
    if (
      (message.end_of_turn !== undefined && typeof message.end_of_turn !== "boolean") ||
      (message.turn_is_formatted !== undefined && typeof message.turn_is_formatted !== "boolean") ||
      (message.transcript !== undefined &&
        (typeof message.transcript !== "string" || message.transcript.length > 16_384)) ||
      (message.utterance !== undefined &&
        (typeof message.utterance !== "string" || message.utterance.length > 16_384)) ||
      (message.turn_order !== undefined &&
        (typeof message.turn_order !== "number" ||
          !Number.isSafeInteger(message.turn_order) ||
          message.turn_order < 0))
    ) {
      this.#fail(assemblyAiProtocolFailure("AssemblyAI STT returned malformed Turn data"));
      return;
    }
    const words = boundedAssemblyWords(message.words);
    if (words === null) {
      this.#fail(assemblyAiProtocolFailure("AssemblyAI STT returned malformed words"));
      return;
    }
    const text = typeof message.transcript === "string" ? message.transcript.trim() : "";
    const endOfTurn = message.end_of_turn === true;
    const turnOrder = typeof message.turn_order === "number" ? message.turn_order : undefined;
    const metadata = {
      assemblyai: {
        ...(turnOrder !== undefined ? { turnOrder } : {}),
        ...(typeof message.turn_is_formatted === "boolean"
          ? { turnIsFormatted: message.turn_is_formatted }
          : {}),
        ...(typeof message.utterance === "string" ? { utterance: message.utterance } : {}),
        ...(typeof message.end_of_turn_confidence === "number"
          ? { endOfTurnConfidence: message.end_of_turn_confidence }
          : {}),
        ...(words !== undefined ? { words } : {}),
        ...(typeof message.language_code === "string"
          ? { languageCode: message.language_code }
          : {}),
        ...(typeof message.language_confidence === "number"
          ? { languageConfidence: message.language_confidence }
          : {}),
        ...this.#sessionMetadata(),
      },
    };

    if (!endOfTurn) {
      if (text && this.#request.interimResults) {
        if (
          !this.#pushEvent({
            id: this.#ids.next(),
            type: "stt.partial",
            direction: "input",
            sessionId: this.#request.sessionId,
            sequence: this.#sequence,
            provider: ASSEMBLYAI_PROVIDER,
            text,
            ...(typeof message.language_code === "string"
              ? { language: message.language_code }
              : {}),
            startTimestamp: this.#clock.now(),
            endTimestamp: this.#clock.now(),
            metadata,
          })
        ) {
          return;
        }
        this.#sequence += 1;
      }
      return;
    }

    if (turnOrder !== undefined && this.#finalizedTurns.has(turnOrder)) {
      return;
    }
    if (this.#formatTurns && message.turn_is_formatted === false) {
      if (turnOrder === undefined) {
        this.#fail(assemblyAiProtocolFailure("AssemblyAI formatted turns require turn_order"));
        return;
      }
      if (this.#pendingUnformattedTurns.has(turnOrder)) {
        return;
      }
      const transcriptBytes = Buffer.byteLength(text, "utf8");
      if (
        this.#pendingUnformattedTurns.size >= ASSEMBLYAI_MAX_PENDING_TURNS ||
        this.#pendingUnformattedBytes + transcriptBytes > ASSEMBLYAI_MAX_PENDING_TURN_BYTES
      ) {
        this.#fail(
          assemblyAiProtocolFailure("AssemblyAI pending formatted turns exceeded its bound"),
        );
        return;
      }
      this.#pendingUnformattedTurns.set(turnOrder, transcriptBytes);
      this.#pendingUnformattedBytes += transcriptBytes;
      return;
    }
    const pendingBytes =
      this.#formatTurns && message.turn_is_formatted === true && turnOrder !== undefined
        ? this.#pendingUnformattedTurns.get(turnOrder)
        : undefined;
    if (text) {
      const timestamp = this.#clock.now();
      if (
        !this.#pushEvent({
          id: this.#ids.next(),
          type: "stt.final",
          direction: "input",
          sessionId: this.#request.sessionId,
          sequence: this.#sequence,
          provider: ASSEMBLYAI_PROVIDER,
          text,
          ...(typeof message.language_code === "string" ? { language: message.language_code } : {}),
          startTimestamp: timestamp,
          endTimestamp: timestamp,
          metadata,
        })
      ) {
        return;
      }
      this.#sequence += 1;
    }
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type: "stt.endpoint",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: ASSEMBLYAI_PROVIDER,
        reason: "provider",
        timestamp: this.#clock.now(),
        metadata,
      })
    ) {
      return;
    }
    this.#sequence += 1;
    if (turnOrder !== undefined) {
      this.#finalizedTurns.add(turnOrder);
    }
    if (pendingBytes !== undefined && turnOrder !== undefined) {
      this.#pendingUnformattedTurns.delete(turnOrder);
      this.#pendingUnformattedBytes -= pendingBytes;
    }
  }

  #handleSocketError(error: unknown): void {
    if (this.#closing || this.#closed) return;
    this.#fail(normalizeSttSocketError(error, ASSEMBLYAI_ERROR_CONTEXT));
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    this.#resolveTermination();
    if (this.#closing || this.#closed) return;
    if (this.#pendingUnformattedTurns.size > 0) {
      this.#fail(assemblyAiProtocolFailure("AssemblyAI closed before formatted turns arrived"));
      return;
    }
    if (this.#terminated) {
      this.#closed = true;
      this.#events.close();
      return;
    }
    this.#fail(assemblyAiCloseError(code, reason, this.#sessionMetadata()));
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: ASSEMBLYAI_ERROR_CODE,
      provider: ASSEMBLYAI_PROVIDER,
    });
    this.#closed = true;
    this.#lastError = throwable;
    if (!this.#begun) {
      this.#rejectBegin(throwable);
    }
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #pushEvent(event: TranscriptEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(ASSEMBLYAI_PROVIDER));
    return false;
  }

  #sendAudioFrame(frame: Uint8Array): boolean {
    const sent = safeSend(this.#socket, Buffer.from(frame));
    if (!sent) this.#fail(assemblyAiWriteFailure());
    return sent;
  }

  #flushAudioBuffer(): void {
    const frameBytes = bytesForMs(PCM16_16K_MONO.sampleRateHz, ASSEMBLYAI_TARGET_FRAME_MS);
    while (this.#audioBuffer.byteLength >= frameBytes && !this.#closed) {
      const frame = this.#audioBuffer.subarray(0, frameBytes);
      if (!this.#sendAudioFrame(frame)) {
        return;
      }
      this.#audioBuffer = this.#audioBuffer.slice(frameBytes);
    }
    if (this.#audioBuffer.byteLength === 0 || this.#closed) {
      return;
    }

    const minimumBytes = bytesForMs(PCM16_16K_MONO.sampleRateHz, ASSEMBLYAI_MIN_FRAME_MS);
    if (this.#audioBuffer.byteLength >= minimumBytes) {
      if (this.#sendAudioFrame(this.#audioBuffer)) {
        this.#audioBuffer = new Uint8Array();
      }
      return;
    }

    const padded = new Uint8Array(minimumBytes);
    padded.set(this.#audioBuffer);
    if (this.#sendAudioFrame(padded)) {
      this.#audioBuffer = new Uint8Array();
    }
  }

  #sessionMetadata(): Readonly<Record<string, unknown>> {
    return {
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      ...(this.#expiresAt === undefined ? {} : { expiresAt: this.#expiresAt }),
    };
  }
}

function boundedAssemblyWords(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4_096) return null;
  const words: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const word = entry as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    if (word.text !== undefined) {
      if (typeof word.text !== "string" || word.text.length > 256) return null;
      normalized.text = word.text;
    }
    for (const key of ["speaker", "speaker_label", "channel"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "string" || word[key].length > 128) return null;
        normalized[key] = word[key];
      }
    }
    for (const key of ["start", "end", "confidence"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "number" || !Number.isFinite(word[key])) return null;
        normalized[key] = word[key];
      }
    }
    words.push(normalized);
  }
  return words;
}

function buildPrompt(
  basePrompt: string | undefined,
  language: string | undefined,
): string | undefined {
  return basePrompt && language
    ? `Transcribe ${language}. ${basePrompt}`
    : (basePrompt ?? (language ? `Transcribe ${language}.` : undefined));
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function bytesForMs(sampleRateHz: number, durationMs: number): number {
  return Math.round((sampleRateHz * durationMs * 2) / 1000);
}

const validSilenceOption = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= 60_000);

function errorMessage(message: AssemblyAiErrorMessage): string {
  const candidate = [message.error, message.message].find(
    (value): value is string => typeof value === "string",
  );
  return candidate !== undefined
    ? boundedErrorMessage(candidate)
    : typeof message.code === "string"
      ? message.code
      : "AssemblyAI STT error";
}

const boundedErrorMessage = (value: string): string =>
  value.length <= 1_024 ? value : value.slice(0, 1_021) + "...";

export function assemblyAiCloseError(
  code = 1006,
  reason?: Buffer,
  sessionMetadata: Readonly<Record<string, unknown>> = {},
) {
  const normalizedCode =
    code === 1006
      ? STT_ERROR_CODES.unexpectedEof
      : code === 1008
        ? "stt.provider.auth_failed"
        : code === 1011 || code === 3005
          ? "stt.provider.service_unavailable"
          : code === 3008
            ? "stt.provider.input_rejected"
            : code === 3009
              ? "stt.provider.rate_limited"
              : code === 410 || code === 3006 || code === 3007
                ? "stt.provider.invalid_request"
                : STT_ERROR_CODES.protocolError;
  return providerError(
    normalizedCode,
    normalizedCode === STT_ERROR_CODES.unexpectedEof
      ? "AssemblyAI STT socket closed unexpectedly"
      : `AssemblyAI STT socket closed with code ${code}`,
    {
      provider: ASSEMBLYAI_PROVIDER,
      retriable:
        normalizedCode === STT_ERROR_CODES.unexpectedEof ||
        normalizedCode === "stt.provider.service_unavailable",
      metadata: {
        ...socketCloseMetadata(code, reason),
        assemblyai: sessionMetadata,
      },
    },
  );
}

export function assemblyAiProtocolError(message: AssemblyAiErrorMessage) {
  const providerCode =
    typeof message.code === "number" || typeof message.code === "string" ? message.code : undefined;
  const codeValue = typeof providerCode === "string" ? providerCode.toLowerCase() : "";
  const code =
    providerCode === 1008 || codeValue.includes("auth")
      ? "stt.provider.auth_failed"
      : providerCode === 1011 || providerCode === 3005
        ? "stt.provider.service_unavailable"
        : providerCode === 3008 || codeValue.includes("audio")
          ? "stt.provider.input_rejected"
          : providerCode === 3009 || codeValue.includes("rate") || codeValue.includes("limit")
            ? "stt.provider.rate_limited"
            : providerCode === 410 || providerCode === 3006 || providerCode === 3007
              ? "stt.provider.invalid_request"
              : "stt.provider.protocol_error";
  return providerError(code, errorMessage(message), {
    provider: ASSEMBLYAI_PROVIDER,
    retriable: code === "stt.provider.service_unavailable",
    metadata: { providerCode, assemblyai: message },
  });
}

function assemblyAiProtocolFailure(message: string) {
  return providerError(STT_ERROR_CODES.protocolError, message, {
    provider: ASSEMBLYAI_PROVIDER,
    retriable: false,
  });
}

function assemblyAiWriteFailure() {
  return providerError(
    STT_ERROR_CODES.transportWriteFailed,
    "AssemblyAI STT socket is not writable",
    {
      provider: ASSEMBLYAI_PROVIDER,
      metadata: { providerCode: ASSEMBLYAI_ERROR_CODE, operation: "audio" },
    },
  );
}

function assemblyAiBeginCancelled(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("assemblyai.stt.begin_cancelled", "AssemblyAI STT startup was cancelled", {
      provider: ASSEMBLYAI_PROVIDER,
    }),
  );
}

function assemblyAiBeginTimeout(): TvicThrowableError {
  return TvicThrowableError.from(
    timeoutError(
      "assemblyai.stt.begin_timeout",
      `AssemblyAI STT Begin timed out after ${ASSEMBLYAI_BEGIN_TIMEOUT_MS}ms`,
      { provider: ASSEMBLYAI_PROVIDER },
    ),
  );
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createAssemblyAiSttProvider(
  options: AssemblyAiSttProviderOptions,
): AssemblyAiSttProvider {
  return new AssemblyAiSttProvider(options);
}
