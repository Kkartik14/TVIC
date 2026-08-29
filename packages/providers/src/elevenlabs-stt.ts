import WebSocket from "ws";

import { AsyncQueue, bytesToBase64 } from "@tvic/media";
import type {
  AudioFormat,
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
  PCM16_8K_MONO,
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
  providerError,
  assertSttPcm16leFormat,
  assertSupportedModel,
  safeClose,
  socketCloseMetadata,
  providerStreamEnded,
  writeProviderFrame,
  type ProviderClock,
} from "./common.js";

const ELEVENLABS_AUDIO_FORMATS = [
  PCM16_8K_MONO,
  PCM16_16K_MONO,
  { encoding: "pcm_s16le", sampleRateHz: 22050, channels: 1 },
  { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
  { encoding: "pcm_s16le", sampleRateHz: 44100, channels: 1 },
  { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 },
] as const satisfies readonly AudioFormat[];

const ELEVENLABS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { input: ELEVENLABS_AUDIO_FORMATS },
  models: PROVIDER_CATALOG.elevenlabsStt.models,
  turnDetection: ["vad", "manual"],
  metadata: {
    realtimeModel: "scribe_v2_realtime",
    partialTranscripts: true,
  },
} satisfies ProviderCapabilities;

export type ElevenLabsSttCommitStrategy = "manual" | "vad";

export interface ElevenLabsSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly allowUnknownModel?: boolean;
  readonly modelId?: string;
  readonly commitStrategy?: ElevenLabsSttCommitStrategy;
  readonly includeTimestamps?: boolean;
  readonly includeLanguageDetection?: boolean;
  readonly vadThreshold?: number;
  readonly vadSilenceThresholdSecs?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface ElevenLabsMessage {
  readonly message_type?: string;
  readonly text?: unknown;
  readonly error?: unknown;
  readonly language_code?: unknown;
  readonly words?: unknown;
  readonly [key: string]: unknown;
}

export class ElevenLabsSttProvider implements SpeechToTextProvider {
  readonly name = PROVIDER_NAMES.elevenlabsStt;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = ELEVENLABS_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #allowUnknownModel: boolean;
  readonly #modelId: string;
  readonly #commitStrategy: ElevenLabsSttCommitStrategy;
  readonly #includeTimestamps: boolean;
  readonly #includeLanguageDetection: boolean;
  readonly #vadThreshold: number | undefined;
  readonly #vadSilenceThresholdSecs: number | undefined;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<ElevenLabsSttProviderOptions["webSocketFactory"]>;

  constructor(options: ElevenLabsSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.elevenlabsStt.defaultModel;
    this.#commitStrategy = options.commitStrategy ?? "manual";
    this.#includeTimestamps = options.includeTimestamps ?? false;
    this.#includeLanguageDetection = options.includeLanguageDetection ?? false;
    this.#vadThreshold = options.vadThreshold;
    this.#vadSilenceThresholdSecs = options.vadSilenceThresholdSecs;
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
    const model = request.model ?? this.#modelId;
    assertSupportedModel(
      PROVIDER_NAMES.elevenlabsStt,
      PROVIDER_CATALOG.elevenlabsStt.models,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );
    const url = new URL(this.#url);
    url.searchParams.set("model_id", model);
    url.searchParams.set("audio_format", `pcm_${request.format.sampleRateHz}`);
    url.searchParams.set("commit_strategy", this.#commitStrategy);
    if (request.language) {
      url.searchParams.set("language_code", request.language);
    }
    if (this.#vadThreshold !== undefined) {
      url.searchParams.set("vad_threshold", String(this.#vadThreshold));
    }
    if (this.#vadSilenceThresholdSecs !== undefined) {
      url.searchParams.set("vad_silence_threshold_secs", String(this.#vadSilenceThresholdSecs));
    }
    if (this.#includeTimestamps) {
      url.searchParams.set("include_timestamps", "true");
    }
    if (this.#includeLanguageDetection) {
      url.searchParams.set("include_language_detection", "true");
    }
    for (const vocabulary of request.vocabulary ?? []) {
      url.searchParams.append("keyterms", vocabulary);
    }

    const socket = this.#webSocketFactory(url.toString(), {
      "xi-api-key": this.#apiKey,
    });

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      throw normalizeSttConnectionError(error, {
        provider: PROVIDER_NAMES.elevenlabsStt,
        providerCode: PROVIDER_ERROR_CODES.elevenlabsStt,
      });
    }

    return new ElevenLabsSttStream(socket, request, this.#clock, this.#commitStrategy);
  }
}

export class ElevenLabsSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode = "provider" as const;
  readonly timestampOrigin = "generation" as const;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #clock: ProviderClock;
  readonly #commitStrategy: ElevenLabsSttCommitStrategy;
  readonly #events = new AsyncQueue<TranscriptEvent>();
  readonly #ids = counterIdGenerator<ProviderEventId>("elevenlabs_stt_event");
  #sequence = 1;
  #closed = false;
  #lastFinalText: string | undefined;
  #committed = false;

  constructor(
    socket: WebSocket,
    request: SttOpenRequest,
    clock: ProviderClock,
    commitStrategy: ElevenLabsSttCommitStrategy = "manual",
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.#commitStrategy = commitStrategy;
    this.events = this.#events;

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", (code: number, reason: Buffer) => this.#handleClose(code, reason));
    socket.on("error", (error) => {
      this.#fail(
        normalizeSttSocketError(error, {
          provider: PROVIDER_NAMES.elevenlabsStt,
          providerCode: PROVIDER_ERROR_CODES.elevenlabsStt,
        }),
      );
    });
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed) {
      throw providerStreamEnded(PROVIDER_NAMES.elevenlabsStt, PROVIDER_ERROR_CODES.elevenlabsStt);
    }
    try {
      writeProviderFrame(
        this.#socket,
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: bytesToBase64(chunk.audio.bytes),
          sample_rate: chunk.audio.format.sampleRateHz,
        }),
        {
          code: PROVIDER_ERROR_CODES.elevenlabsStt,
          provider: PROVIDER_NAMES.elevenlabsStt,
          operation: "audio",
        },
      );
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async commit(): Promise<void> {
    if (this.#closed) {
      throw providerStreamEnded(PROVIDER_NAMES.elevenlabsStt, PROVIDER_ERROR_CODES.elevenlabsStt);
    }
    try {
      writeProviderFrame(
        this.#socket,
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: this.#request.format.sampleRateHz,
        }),
        {
          code: PROVIDER_ERROR_CODES.elevenlabsStt,
          provider: PROVIDER_NAMES.elevenlabsStt,
          operation: "commit",
        },
      );
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
    safeClose(this.#socket);
    this.#closeQueue();
  }

  #handleMessage(body: string): void {
    const parsed = parseJsonObject(body) as ElevenLabsMessage | null;
    if (!parsed) {
      return;
    }

    if (isElevenLabsError(parsed)) {
      this.#fail(elevenLabsProtocolError(parsed));
      return;
    }

    switch (parsed.message_type) {
      case "partial_transcript":
        this.#pushSegment(parsed, "stt.partial");
        return;
      case "final_transcript":
      case "final_transcript_with_timestamps":
        this.#pushSegment(parsed, "stt.final");
        return;
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        this.#handleCommitted(parsed);
        return;
      default:
        return;
    }
  }

  #pushSegment(message: ElevenLabsMessage, type: "stt.partial" | "stt.final"): void {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) {
      return;
    }
    if (type === "stt.final" && text === this.#lastFinalText) {
      return;
    }

    const timestamp = this.#clock.now();
    this.#events.push({
      id: this.#ids.next(),
      type,
      direction: "input",
      sessionId: this.#request.sessionId,
      sequence: this.#sequence,
      provider: PROVIDER_NAMES.elevenlabsStt,
      text,
      ...(typeof message.language_code === "string" ? { language: message.language_code } : {}),
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      ...(message.words !== undefined || message.message_type !== undefined
        ? {
            metadata: {
              elevenlabs: {
                messageType: message.message_type,
                ...(message.words !== undefined ? { words: message.words } : {}),
              },
            },
          }
        : {}),
    });
    this.#sequence += 1;
    if (type === "stt.final") {
      this.#lastFinalText = text;
      this.#committed = false;
    }
  }

  #handleCommitted(message: ElevenLabsMessage): void {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (text && text !== this.#lastFinalText) {
      this.#pushSegment(message, "stt.final");
    }
    if (this.#committed) {
      return;
    }
    this.#events.push({
      id: this.#ids.next(),
      type: "stt.endpoint",
      direction: "input",
      sessionId: this.#request.sessionId,
      sequence: this.#sequence,
      provider: PROVIDER_NAMES.elevenlabsStt,
      reason: this.#commitStrategy === "vad" ? "silence" : "manual",
      timestamp: this.#clock.now(),
    });
    this.#sequence += 1;
    this.#committed = true;
    this.#lastFinalText = undefined;
  }

  #closeQueue(): void {
    this.#closed = true;
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
          ? "ElevenLabs STT socket closed unexpectedly"
          : `ElevenLabs STT socket closed with code ${code}`,
        {
          provider: PROVIDER_NAMES.elevenlabsStt,
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
    this.#closed = true;
    this.#events.fail(error);
    safeClose(this.#socket);
  }
}

function isElevenLabsError(message: ElevenLabsMessage): boolean {
  return (
    message.error !== undefined ||
    message.message_type === "error" ||
    message.message_type === "auth_error" ||
    message.message_type === "quota_exceeded" ||
    message.message_type === "transcriber_error" ||
    message.message_type === "input_error" ||
    message.message_type === "invalid_request" ||
    message.message_type === "rate_limited" ||
    message.message_type === "commit_throttled" ||
    message.message_type === "unaccepted_terms" ||
    message.message_type === "queue_overflow" ||
    message.message_type === "resource_exhausted" ||
    message.message_type === "session_time_limit_exceeded" ||
    message.message_type === "chunk_size_exceeded" ||
    message.message_type === "insufficient_audio_activity"
  );
}

function elevenLabsProtocolError(message: ElevenLabsMessage) {
  const type = typeof message.message_type === "string" ? message.message_type : "error";
  const code =
    type === "auth_error"
      ? "stt.provider.auth_failed"
      : type === "quota_exceeded"
        ? "stt.provider.quota_exceeded"
        : type === "rate_limited" || type === "commit_throttled"
          ? "stt.provider.rate_limited"
          : type === "input_error" ||
              type === "chunk_size_exceeded" ||
              type === "insufficient_audio_activity"
            ? "stt.provider.input_rejected"
            : type === "session_time_limit_exceeded"
              ? "stt.provider.session_expired"
              : type === "invalid_request" || type === "unaccepted_terms"
                ? "stt.provider.invalid_request"
                : "stt.provider.protocol_error";
  return providerError(
    code,
    typeof message.error === "string" ? message.error : `ElevenLabs STT ${type}`,
    {
      provider: PROVIDER_NAMES.elevenlabsStt,
      retriable: false,
      metadata: { providerCode: type },
    },
  );
}

export function createElevenLabsSttProvider(
  options: ElevenLabsSttProviderOptions,
): ElevenLabsSttProvider {
  return new ElevenLabsSttProvider(options);
}
