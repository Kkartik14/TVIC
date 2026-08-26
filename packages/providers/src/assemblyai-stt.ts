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
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  counterIdGenerator,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeSttConnectionError,
  normalizeSttSocketError,
  openWebSocket,
  parseJsonObject,
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  providerError,
  providerStreamEnded,
  safeClose,
  safeSend,
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
  readonly audio_duration_seconds?: unknown;
  readonly session_duration_seconds?: unknown;
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
    if (terms.length > 100 || terms.some((term) => term.length > 50)) {
      throw validationError(
        "stt.vocabulary_invalid",
        "AssemblyAI keyterms_prompt supports at most 100 terms of 50 characters each",
        { provider: PROVIDER_NAMES.assemblyaiStt },
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
    const stream = new AssemblyAiSttStream(socket, request, this.#clock);

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      await stream.waitForBegin(request.signal);
      return stream;
    } catch (error) {
      safeClose(socket);
      throw normalizeSttConnectionError(error, {
        provider: ASSEMBLYAI_PROVIDER,
        providerCode: ASSEMBLYAI_ERROR_CODE,
      });
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
  readonly #events = new AsyncQueue<TranscriptEvent>();
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
  #sessionId: string | undefined;
  #expiresAt: number | undefined;

  constructor(socket: WebSocket, request: SttOpenRequest, clock: ProviderClock) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.events = this.#events;
    this.#beginPromise = new Promise<void>((resolve, reject) => {
      this.#resolveBegin = resolve;
      this.#rejectBegin = reject;
    });
    this.#terminationPromise = new Promise<void>((resolve) => {
      this.#resolveTermination = resolve;
    });

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) => this.#handleSocketError(error));
  }

  async waitForBegin(signal?: AbortSignal): Promise<void> {
    if (this.#begun) {
      return;
    }
    if (signal?.aborted) {
      throw new Error("AssemblyAI STT startup aborted");
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`AssemblyAI STT Begin timed out after ${ASSEMBLYAI_BEGIN_TIMEOUT_MS}ms`));
      }, ASSEMBLYAI_BEGIN_TIMEOUT_MS);
      const onAbort = (): void => {
        cleanup();
        reject(new Error("AssemblyAI STT startup aborted"));
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
    assertSttSampleRate(PROVIDER_NAMES.assemblyaiStt, chunk.audio.format.sampleRateHz, [
      PCM16_16K_MONO.sampleRateHz,
    ]);

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
    // AssemblyAI v3 has no documented per-turn finalize command. End-of-turn
    // messages are the provider's finalization signal.
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

    this.#closed = true;
    safeClose(this.#socket);
    this.#events.close();
  }

  #handleMessage(body: string): void {
    const parsed = parseJsonObject(body) as AssemblyAiMessage | null;
    if (!parsed) {
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
        return;
    }
  }

  #handleBegin(message: AssemblyAiBeginMessage): void {
    this.#begun = true;
    this.#sessionId = typeof message.id === "string" ? message.id : undefined;
    this.#expiresAt = typeof message.expires_at === "number" ? message.expires_at : undefined;
    this.#resolveBegin();
  }

  #handleSpeechStarted(message: AssemblyAiSpeechStartedMessage): void {
    this.#events.push({
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
    });
    this.#sequence += 1;
  }

  #handleTurn(message: AssemblyAiTurnMessage): void {
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
        ...(message.words !== undefined ? { words: message.words } : {}),
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
        this.#events.push({
          id: this.#ids.next(),
          type: "stt.partial",
          direction: "input",
          sessionId: this.#request.sessionId,
          sequence: this.#sequence,
          provider: ASSEMBLYAI_PROVIDER,
          text,
          ...(typeof message.language_code === "string" ? { language: message.language_code } : {}),
          startTimestamp: this.#clock.now(),
          endTimestamp: this.#clock.now(),
          metadata,
        });
        this.#sequence += 1;
      }
      return;
    }

    if (turnOrder !== undefined && this.#finalizedTurns.has(turnOrder)) {
      return;
    }
    if (turnOrder !== undefined) {
      this.#finalizedTurns.add(turnOrder);
    }
    if (text) {
      const timestamp = this.#clock.now();
      this.#events.push({
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
      });
      this.#sequence += 1;
    }
    this.#events.push({
      id: this.#ids.next(),
      type: "stt.endpoint",
      direction: "input",
      sessionId: this.#request.sessionId,
      sequence: this.#sequence,
      provider: ASSEMBLYAI_PROVIDER,
      reason: "provider",
      timestamp: this.#clock.now(),
      metadata,
    });
    this.#sequence += 1;
  }

  #handleSocketError(error: unknown): void {
    if (this.#closing || this.#closed) {
      return;
    }
    this.#fail(
      normalizeSttSocketError(error, {
        provider: ASSEMBLYAI_PROVIDER,
        providerCode: ASSEMBLYAI_ERROR_CODE,
      }),
    );
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    this.#resolveTermination();
    if (this.#closing || this.#closed) {
      return;
    }
    const normalizedCode =
      code === 1008
        ? "stt.provider.auth_failed"
        : code === 1011 || code === 3005
          ? "stt.provider.service_unavailable"
          : code === 3008
            ? "stt.provider.input_rejected"
            : code === 3009
              ? "stt.provider.rate_limited"
              : code === 410 || code === 3006 || code === 3007
                ? "stt.provider.invalid_request"
                : STT_ERROR_CODES.unexpectedEof;
    const error = providerError(
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
          wsCloseCode: code,
          ...(reason ? { wsCloseReason: reason.toString() } : {}),
          assemblyai: this.#sessionMetadata(),
        },
      },
    );
    if (!this.#begun) {
      this.#rejectBegin(error);
    }
    this.#fail(error);
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#lastError = error;
    if (!this.#begun) {
      this.#rejectBegin(error);
    }
    this.#events.fail(error);
    safeClose(this.#socket);
  }

  #sendAudioFrame(frame: Uint8Array): boolean {
    const sent = safeSend(this.#socket, Buffer.from(frame));
    if (!sent) {
      this.#fail(
        providerError(
          STT_ERROR_CODES.transportWriteFailed,
          "AssemblyAI STT socket is not writable",
          {
            provider: ASSEMBLYAI_PROVIDER,
            metadata: { providerCode: ASSEMBLYAI_ERROR_CODE, operation: "audio" },
          },
        ),
      );
    }
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
      this.#sendAudioFrame(this.#audioBuffer);
      this.#audioBuffer = new Uint8Array();
      return;
    }

    const padded = new Uint8Array(minimumBytes);
    padded.set(this.#audioBuffer);
    this.#sendAudioFrame(padded);
    this.#audioBuffer = new Uint8Array();
  }

  #sessionMetadata(): Readonly<Record<string, unknown>> {
    return {
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      ...(this.#expiresAt !== undefined ? { expiresAt: this.#expiresAt } : {}),
    };
  }
}

function buildPrompt(
  basePrompt: string | undefined,
  language: string | undefined,
): string | undefined {
  if (basePrompt && language) {
    return `Transcribe ${language}. ${basePrompt}`;
  }
  if (basePrompt) {
    return basePrompt;
  }
  return language ? `Transcribe ${language}.` : undefined;
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

function errorMessage(message: AssemblyAiErrorMessage): string {
  if (typeof message.error === "string") {
    return message.error;
  }
  if (typeof message.message === "string") {
    return message.message;
  }
  if (typeof message.code === "string") {
    return message.code;
  }
  return "AssemblyAI STT error";
}

function assemblyAiProtocolError(message: AssemblyAiErrorMessage) {
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createAssemblyAiSttProvider(
  options: AssemblyAiSttProviderOptions,
): AssemblyAiSttProvider {
  return new AssemblyAiSttProvider(options);
}
