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
  TvicThrowableError,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { isElevenLabsBatchModel, transcribeElevenLabsBatch } from "./elevenlabs-batch-stt.js";
import type {
  ElevenLabsBatchSttRequest,
  ElevenLabsBatchSttResult,
  ElevenLabsEntityDetection,
} from "./elevenlabs-batch-stt.js";
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
  writeProviderFrame,
  validationError,
  type ProviderClock,
} from "./common.js";
import {
  assertElevenLabsRealtimeOptions,
  assertElevenLabsSttFormat,
  assertElevenLabsSttModel,
  boundedElevenLabsEntities,
  boundedElevenLabsWords,
  closeElevenLabsSocket,
  elevenLabsCloseError,
  elevenLabsProtocolError,
  isElevenLabsError,
  type ElevenLabsMessage,
  type ElevenLabsSttCommitStrategy,
  type PendingElevenLabsCommit,
} from "./elevenlabs-stt-protocol.js";
export { elevenLabsCloseError, elevenLabsProtocolError } from "./elevenlabs-stt-protocol.js";

const ELEVENLABS_AUDIO_FORMATS = [
  PCM16_8K_MONO,
  PCM16_16K_MONO,
  { encoding: "pcm_s16le", sampleRateHz: 22050, channels: 1 },
  { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
  { encoding: "pcm_s16le", sampleRateHz: 44100, channels: 1 },
  { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 },
] as const satisfies readonly AudioFormat[];
const ELEVENLABS_SAMPLE_RATES = ELEVENLABS_AUDIO_FORMATS.map(({ sampleRateHz }) => sampleRateHz);
const MAX_ELEVENLABS_PENDING_COMMITS = 64;

const ELEVENLABS_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http", "websocket"],
  audio: { input: ELEVENLABS_AUDIO_FORMATS },
  models: PROVIDER_CATALOG.elevenlabsStt.models,
  turnDetection: ["vad", "manual"],
  metadata: {
    realtimeModel: "scribe_v2_realtime",
    realtimeModels: ["scribe_v2_realtime"],
    batchModels: ["scribe_v2", "scribe_v2_medical"],
    batchTranscription: true,
    partialTranscripts: true,
  },
} satisfies ProviderCapabilities;

export type { ElevenLabsSttCommitStrategy } from "./elevenlabs-stt-protocol.js";
export type {
  ElevenLabsBatchSttRequest,
  ElevenLabsBatchSttResult,
  ElevenLabsBatchTimestampGranularity,
  ElevenLabsEntityDetection,
} from "./elevenlabs-batch-stt.js";

export interface ElevenLabsSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly batchUrl?: string;
  readonly allowUnknownModel?: boolean;
  readonly modelId?: string;
  readonly commitStrategy?: ElevenLabsSttCommitStrategy;
  readonly includeTimestamps?: boolean;
  readonly includeLanguageDetection?: boolean;
  readonly vadThreshold?: number;
  readonly vadSilenceThresholdSecs?: number;
  readonly secondaryLanguages?: readonly string[];
  readonly minSpeechDurationMs?: number;
  readonly minSilenceDurationMs?: number;
  readonly noVerbatim?: boolean;
  /** Detect bounded entity records on committed realtime transcript segments. */
  readonly entityDetection?: ElevenLabsEntityDetection;
  readonly filterBackgroundAudio?: boolean;
  readonly enableLogging?: boolean;
  /** Context sent with the first audio frame; useful after reconnects. */
  readonly previousText?: string;
  readonly clock?: ProviderClock;
  readonly fetchImpl?: typeof fetch;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

export class ElevenLabsSttProvider implements SpeechToTextProvider {
  readonly name = PROVIDER_NAMES.elevenlabsStt;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = ELEVENLABS_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #batchUrl: string;
  readonly #allowUnknownModel: boolean;
  readonly #modelId: string;
  readonly #commitStrategy: ElevenLabsSttCommitStrategy;
  readonly #includeTimestamps: boolean;
  readonly #includeLanguageDetection: boolean;
  readonly #vadThreshold: number | undefined;
  readonly #vadSilenceThresholdSecs: number | undefined;
  readonly #secondaryLanguages: readonly string[] | undefined;
  readonly #minSpeechDurationMs: number | undefined;
  readonly #minSilenceDurationMs: number | undefined;
  readonly #noVerbatim: boolean | undefined;
  readonly #entityDetection: ElevenLabsEntityDetection | undefined;
  readonly #filterBackgroundAudio: boolean | undefined;
  readonly #enableLogging: boolean | undefined;
  readonly #previousText: string | undefined;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;
  readonly #webSocketFactory: NonNullable<ElevenLabsSttProviderOptions["webSocketFactory"]>;

  constructor(options: ElevenLabsSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
    this.#batchUrl = options.batchUrl ?? "https://api.elevenlabs.io/v1/speech-to-text";
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.elevenlabsStt.defaultModel;
    this.#commitStrategy = options.commitStrategy ?? "manual";
    this.#includeTimestamps = options.includeTimestamps ?? false;
    this.#includeLanguageDetection = options.includeLanguageDetection ?? false;
    this.#vadThreshold = options.vadThreshold;
    this.#vadSilenceThresholdSecs = options.vadSilenceThresholdSecs;
    this.#secondaryLanguages = options.secondaryLanguages;
    this.#minSpeechDurationMs = options.minSpeechDurationMs;
    this.#minSilenceDurationMs = options.minSilenceDurationMs;
    this.#noVerbatim = options.noVerbatim;
    this.#entityDetection = options.entityDetection;
    this.#filterBackgroundAudio = options.filterBackgroundAudio;
    this.#enableLogging = options.enableLogging;
    this.#previousText = options.previousText;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#fetch = options.fetchImpl ?? fetch;
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
          maxPayload: MAX_PROVIDER_FRAME_BYTES,
        }));
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    assertElevenLabsSttFormat(request.format);
    assertSttSampleRate(
      PROVIDER_NAMES.elevenlabsStt,
      request.format.sampleRateHz,
      ELEVENLABS_SAMPLE_RATES,
    );
    const model = request.model ?? this.#modelId;
    assertElevenLabsSttModel(model);
    assertSupportedModel(
      PROVIDER_NAMES.elevenlabsStt,
      PROVIDER_CATALOG.elevenlabsStt.models,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );
    if (isElevenLabsBatchModel(model)) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          `ElevenLabs model ${model} uses batch transcription; call transcribe() instead of open()`,
          {
            provider: PROVIDER_NAMES.elevenlabsStt,
            metadata: { model, transport: "http" },
          },
        ),
      );
    }
    if (this.#filterBackgroundAudio === true && this.#includeTimestamps) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "ElevenLabs filterBackgroundAudio cannot be combined with includeTimestamps",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
    assertElevenLabsRealtimeOptions({
      commitStrategy: this.#commitStrategy,
      secondaryLanguages: this.#secondaryLanguages,
      noVerbatim: this.#noVerbatim,
      entityDetection: this.#entityDetection,
      filterBackgroundAudio: this.#filterBackgroundAudio,
      enableLogging: this.#enableLogging,
      previousText: this.#previousText,
    });
    for (const [name, value] of [
      ["minSpeechDurationMs", this.#minSpeechDurationMs],
      ["minSilenceDurationMs", this.#minSilenceDurationMs],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 50 || value > 2_000)) {
        throw TvicThrowableError.from(
          validationError(
            "provider.invalid_request",
            `ElevenLabs ${name} must be an integer from 50 to 2000`,
            { provider: PROVIDER_NAMES.elevenlabsStt },
          ),
        );
      }
    }
    if (
      this.#vadThreshold !== undefined &&
      (!Number.isFinite(this.#vadThreshold) || this.#vadThreshold < 0.1 || this.#vadThreshold > 0.9)
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "ElevenLabs vadThreshold must be between 0.1 and 0.9",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
    if (
      this.#vadSilenceThresholdSecs !== undefined &&
      (!Number.isFinite(this.#vadSilenceThresholdSecs) ||
        this.#vadSilenceThresholdSecs < 0.3 ||
        this.#vadSilenceThresholdSecs > 3)
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "ElevenLabs vadSilenceThresholdSecs must be between 0.3 and 3",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
    if (
      request.language !== undefined &&
      (typeof request.language !== "string" ||
        request.language.length === 0 ||
        request.language.length > 64 ||
        /[\u0000-\u001f\u007f]/u.test(request.language))
    ) {
      throw TvicThrowableError.from(
        validationError("stt.language_invalid", "ElevenLabs language code is invalid", {
          provider: PROVIDER_NAMES.elevenlabsStt,
        }),
      );
    }
    const keyterms = request.vocabulary ?? [];
    if (
      !Array.isArray(keyterms) ||
      keyterms.length > 50 ||
      keyterms.some((term) => typeof term !== "string" || term.length === 0 || term.length > 20)
    ) {
      throw TvicThrowableError.from(
        validationError(
          "stt.vocabulary_invalid",
          "ElevenLabs realtime STT supports at most 50 non-empty keyterms of 20 characters each",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
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
    for (const language of this.#secondaryLanguages ?? []) {
      url.searchParams.append("secondary_languages", language);
    }
    if (this.#minSpeechDurationMs !== undefined) {
      url.searchParams.set("min_speech_duration_ms", String(this.#minSpeechDurationMs));
    }
    if (this.#minSilenceDurationMs !== undefined) {
      url.searchParams.set("min_silence_duration_ms", String(this.#minSilenceDurationMs));
    }
    if (this.#includeTimestamps) {
      url.searchParams.set("include_timestamps", "true");
    }
    if (this.#includeLanguageDetection) {
      url.searchParams.set("include_language_detection", "true");
    }
    if (this.#noVerbatim !== undefined) {
      url.searchParams.set("no_verbatim", String(this.#noVerbatim));
    }
    if (this.#filterBackgroundAudio !== undefined) {
      url.searchParams.set("filter_background_audio", String(this.#filterBackgroundAudio));
    }
    if (this.#enableLogging !== undefined) {
      url.searchParams.set("enable_logging", String(this.#enableLogging));
    }
    for (const vocabulary of keyterms) {
      url.searchParams.append("keyterms", vocabulary);
    }
    if (typeof this.#entityDetection === "string") {
      url.searchParams.append("entity_detection", this.#entityDetection);
    } else {
      for (const entity of this.#entityDetection ?? []) {
        url.searchParams.append("entity_detection", entity);
      }
    }

    const socket = this.#webSocketFactory(url.toString(), {
      "xi-api-key": this.#apiKey,
    });

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      throw TvicThrowableError.from(
        normalizeSttConnectionError(error, {
          provider: PROVIDER_NAMES.elevenlabsStt,
          providerCode: PROVIDER_ERROR_CODES.elevenlabsStt,
        }),
      );
    }

    return new ElevenLabsSttStream(
      socket,
      request,
      this.#clock,
      this.#commitStrategy,
      this.#includeTimestamps,
      this.#includeLanguageDetection,
      this.#previousText,
      this.#entityDetection !== undefined,
    );
  }

  async transcribe(request: ElevenLabsBatchSttRequest): Promise<ElevenLabsBatchSttResult> {
    return transcribeElevenLabsBatch(
      {
        apiKey: this.#apiKey,
        url: this.#batchUrl,
        fetchImpl: this.#fetch,
      },
      request,
      this.#modelId,
      this.#allowUnknownModel,
    );
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
  readonly #awaitsTimestampedCommit: boolean;
  readonly #awaitsEntityEvent: boolean;
  readonly #previousText: string | undefined;
  readonly #events = new AsyncQueue<TranscriptEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.elevenlabsStt);
      this.#fail(error);
      return error;
    },
  });
  readonly #ids = counterIdGenerator<ProviderEventId>("elevenlabs_stt_event");
  #sequence = 1;
  #closed = false;
  #lastFinalText: string | undefined;
  #committed = false;
  readonly #pendingCommits: PendingElevenLabsCommit[] = [];
  #sentFirstAudio = false;

  constructor(
    socket: WebSocket,
    request: SttOpenRequest,
    clock: ProviderClock,
    commitStrategy: ElevenLabsSttCommitStrategy = "manual",
    includeTimestamps = false,
    includeLanguageDetection = false,
    previousText?: string,
    awaitsEntityEvent = false,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.#commitStrategy = commitStrategy;
    this.#awaitsTimestampedCommit = includeTimestamps || includeLanguageDetection;
    this.#awaitsEntityEvent = awaitsEntityEvent;
    this.#previousText = previousText;
    this.events = this.#events;

    socket.on("message", (data) => {
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(providerFrameTooLarge(PROVIDER_NAMES.elevenlabsStt));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
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
    assertSttPcm16leFormat(chunk.audio.format);
    if (chunk.audio.format.sampleRateHz !== this.#request.format.sampleRateHz) {
      throw TvicThrowableError.from(
        validationError(
          "stt.sample_rate_mismatch",
          "ElevenLabs STT audio sample rate does not match the opened stream",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
    if (chunk.audio.bytes.byteLength % 2 !== 0) {
      throw TvicThrowableError.from(
        validationError(
          "stt.audio_odd_byte_length",
          "ElevenLabs STT PCM16LE audio chunks must contain complete samples",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
    try {
      const frame: Record<string, unknown> = {
        message_type: "input_audio_chunk",
        audio_base_64: bytesToBase64(chunk.audio.bytes),
        sample_rate: chunk.audio.format.sampleRateHz,
      };
      if (!this.#sentFirstAudio && this.#previousText !== undefined) {
        frame.previous_text = this.#previousText;
      }
      writeProviderFrame(this.#socket, JSON.stringify(frame), {
        code: PROVIDER_ERROR_CODES.elevenlabsStt,
        provider: PROVIDER_NAMES.elevenlabsStt,
        operation: "audio",
      });
      this.#sentFirstAudio = true;
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
    closeElevenLabsSocket(this.#socket);
    this.#closeQueue();
  }

  #handleMessage(body: string): void {
    if (this.#closed) return;
    const parsed = parseJsonObject(body) as ElevenLabsMessage | null;
    if (!parsed) {
      this.#fail(
        providerError(STT_ERROR_CODES.protocolError, "ElevenLabs STT returned malformed JSON", {
          provider: PROVIDER_NAMES.elevenlabsStt,
          retriable: false,
        }),
      );
      return;
    }

    if (isElevenLabsError(parsed)) {
      this.#fail(elevenLabsProtocolError(parsed));
      return;
    }

    if (typeof parsed.message_type !== "string") {
      this.#fail(
        providerError(STT_ERROR_CODES.protocolError, "ElevenLabs STT returned an unknown message", {
          provider: PROVIDER_NAMES.elevenlabsStt,
          retriable: false,
        }),
      );
      return;
    }

    switch (parsed.message_type) {
      case "session_started":
      case "warning":
        return;
      case "committed_transcript_entities":
        this.#handleEntities(parsed);
        return;
      case "partial_transcript":
        if (!this.#request.interimResults) return;
        this.#pushSegment(parsed, "stt.partial");
        return;
      case "final_transcript":
      case "final_transcript_with_timestamps":
        this.#pushSegment(parsed, "stt.final");
        return;
      case "committed_transcript":
        if (this.#awaitsTimestampedCommit || this.#awaitsEntityEvent) {
          const text = this.#transcriptText(parsed);
          if (text === undefined) return;
          if (this.#pendingCommits.length >= MAX_ELEVENLABS_PENDING_COMMITS) {
            this.#fail(
              providerError(
                STT_ERROR_CODES.protocolError,
                "ElevenLabs STT returned too many committed transcripts awaiting metadata",
                { provider: PROVIDER_NAMES.elevenlabsStt, retriable: false },
              ),
            );
            return;
          }
          this.#pendingCommits.push({ committed: parsed, text });
          return;
        }
        this.#handleCommitted(parsed);
        return;
      case "committed_transcript_with_timestamps":
        if (this.#awaitsTimestampedCommit || this.#awaitsEntityEvent) {
          this.#handleTimestamped(parsed);
        } else {
          this.#handleCommitted(parsed);
        }
        return;
      default:
        this.#fail(
          providerError(
            STT_ERROR_CODES.protocolError,
            "ElevenLabs STT returned an unknown message type",
            { provider: PROVIDER_NAMES.elevenlabsStt, retriable: false },
          ),
        );
        return;
    }
  }

  #pushSegment(
    message: ElevenLabsMessage,
    type: "stt.partial" | "stt.final",
    entities?: readonly Readonly<Record<string, unknown>>[],
  ): boolean {
    const text = this.#transcriptText(message);
    if (text === undefined) return false;
    if (!text) {
      return true;
    }
    if (type === "stt.final" && text === this.#lastFinalText) {
      return true;
    }

    if (
      message.language_code !== undefined &&
      message.language_code !== null &&
      (typeof message.language_code !== "string" || message.language_code.length > 64)
    ) {
      this.#fail(
        providerError(
          STT_ERROR_CODES.protocolError,
          "ElevenLabs STT returned malformed language data",
          {
            provider: PROVIDER_NAMES.elevenlabsStt,
            retriable: false,
          },
        ),
      );
      return false;
    }

    const timestamp = this.#clock.now();
    const words = boundedElevenLabsWords(message.words);
    if (words === null) {
      this.#fail(
        providerError(STT_ERROR_CODES.protocolError, "ElevenLabs STT returned malformed words", {
          provider: PROVIDER_NAMES.elevenlabsStt,
          retriable: false,
        }),
      );
      return false;
    }
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type,
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.elevenlabsStt,
        text,
        ...(typeof message.language_code === "string" && message.language_code.length <= 64
          ? { language: message.language_code }
          : {}),
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        ...(message.words !== undefined || message.message_type !== undefined
          ? {
              metadata: {
                elevenlabs: {
                  messageType: message.message_type,
                  ...(words !== undefined ? { words } : {}),
                  ...(entities !== undefined ? { entities } : {}),
                },
              },
            }
          : {}),
      })
    ) {
      return false;
    }
    this.#sequence += 1;
    if (type === "stt.final") {
      this.#lastFinalText = text;
      this.#committed = false;
    }
    return true;
  }

  #handleCommitted(
    message: ElevenLabsMessage,
    entities?: readonly Readonly<Record<string, unknown>>[],
  ): void {
    const text = this.#transcriptText(message);
    if (text === undefined) return;
    if (text && text !== this.#lastFinalText) {
      if (!this.#pushSegment(message, "stt.final", entities)) return;
    }
    if (this.#committed) {
      return;
    }
    if (
      !this.#pushEvent({
        id: this.#ids.next(),
        type: "stt.endpoint",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.elevenlabsStt,
        reason: this.#commitStrategy === "vad" ? "silence" : "manual",
        timestamp: this.#clock.now(),
      })
    ) {
      return;
    }
    this.#sequence += 1;
    this.#committed = true;
    this.#lastFinalText = undefined;
  }

  #handleTimestamped(message: ElevenLabsMessage): void {
    const text = this.#transcriptText(message);
    if (text === undefined) return;
    const pending = this.#pendingCommits.find((entry) => entry.text === text);
    if (!pending) {
      this.#fail(
        providerError(
          STT_ERROR_CODES.protocolError,
          "ElevenLabs STT returned timestamped data without a committed transcript",
          { provider: PROVIDER_NAMES.elevenlabsStt, retriable: false },
        ),
      );
      return;
    }
    pending.timestamped = message;
    this.#tryEmitPending(pending);
  }

  #handleEntities(message: ElevenLabsMessage): void {
    if (!this.#awaitsEntityEvent) return;
    const text = this.#transcriptText(message);
    if (text === undefined) return;
    const entities = boundedElevenLabsEntities(message.entities);
    if (entities === null || entities === undefined) {
      this.#fail(
        providerError(STT_ERROR_CODES.protocolError, "ElevenLabs STT returned malformed entities", {
          provider: PROVIDER_NAMES.elevenlabsStt,
          retriable: false,
        }),
      );
      return;
    }
    const pending = this.#pendingCommits.find((entry) => entry.text === text);
    if (!pending) {
      this.#fail(
        providerError(
          STT_ERROR_CODES.protocolError,
          "ElevenLabs STT returned entities without a committed transcript",
          { provider: PROVIDER_NAMES.elevenlabsStt, retriable: false },
        ),
      );
      return;
    }
    pending.entities = entities;
    this.#tryEmitPending(pending);
  }

  #tryEmitPending(pending: PendingElevenLabsCommit): void {
    if (this.#awaitsTimestampedCommit && pending.timestamped === undefined) return;
    if (this.#awaitsEntityEvent && pending.entities === undefined) return;
    const index = this.#pendingCommits.indexOf(pending);
    if (index < 0) return;
    this.#pendingCommits.splice(index, 1);
    this.#handleCommitted(pending.timestamped ?? pending.committed, pending.entities);
  }

  #transcriptText(message: ElevenLabsMessage): string | undefined {
    if (typeof message.text !== "string") {
      this.#fail(
        providerError(STT_ERROR_CODES.protocolError, "ElevenLabs STT returned malformed text", {
          provider: PROVIDER_NAMES.elevenlabsStt,
          retriable: false,
        }),
      );
      return undefined;
    }
    const text = message.text.trim();
    if (text.length > 16_384) {
      this.#fail(
        providerError(
          STT_ERROR_CODES.protocolError,
          "ElevenLabs STT transcript exceeded its bound",
          {
            provider: PROVIDER_NAMES.elevenlabsStt,
            retriable: false,
          },
        ),
      );
      return undefined;
    }
    return text;
  }

  #closeQueue(): void {
    this.#closed = true;
    this.#events.close();
  }

  #pushEvent(event: TranscriptEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.elevenlabsStt));
    return false;
  }

  #handleClose(code = 1006, reason?: Buffer): void {
    if (this.#closed) {
      this.#closeQueue();
      return;
    }
    if (code === 1000) {
      if (this.#pendingCommits.length > 0) {
        this.#fail(
          providerError(
            STT_ERROR_CODES.protocolError,
            "ElevenLabs STT closed before its committed transcript metadata",
            { provider: PROVIDER_NAMES.elevenlabsStt, retriable: false },
          ),
        );
        return;
      }
      this.#closeQueue();
      return;
    }
    this.#fail(elevenLabsCloseError(code, reason));
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.elevenlabsStt,
      provider: PROVIDER_NAMES.elevenlabsStt,
    });
    this.#closed = true;
    this.#events.fail(throwable);
    closeElevenLabsSocket(this.#socket);
  }
}

export function createElevenLabsSttProvider(
  options: ElevenLabsSttProviderOptions,
): ElevenLabsSttProvider {
  return new ElevenLabsSttProvider(options);
}
