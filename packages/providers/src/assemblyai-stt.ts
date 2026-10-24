import WebSocket from "ws";

import { AsyncQueue } from "@tvic/media";
import type {
  InputAudioChunk,
  ProviderCapabilities,
  ProviderEventId,
  ProviderUsageOperation,
  SpeechToTextProvider,
  SttLanguagePolicy,
  SttTurnTakingProfile,
  SttBatchTranscription,
  SttBatchTranscriptionRequest,
  SttOpenRequest,
  SttStream,
  TranscriptEvent,
} from "@tvic/core";
import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  counterIdGenerator,
  countUnicodeCodePoints,
  TvicThrowableError,
} from "@tvic/core";

import {
  ASSEMBLYAI_PRE_RECORDED_MODELS,
  ASSEMBLYAI_REALTIME_MODELS,
  ASSEMBLYAI_SYNC_MODELS,
  PROVIDER_CATALOG,
} from "./catalog.js";
import {
  transcribeAssemblyAiPreRecorded,
  transcribeAssemblyAiSync,
  transcribeAssemblyAiSyncLive,
  warmAssemblyAiSync,
  type AssemblyAiHttpSttOptions,
  type AssemblyAiPreRecordedSttRequest,
  type AssemblyAiPreRecordedSttResult,
  type AssemblyAiSyncLiveSttRequest,
  type AssemblyAiSyncSttRequest,
  type AssemblyAiSyncSttResult,
} from "./assemblyai-http-stt.js";
export type {
  AssemblyAiPreRecordedModel,
  AssemblyAiPreRecordedSttRequest,
  AssemblyAiPreRecordedSttResult,
  AssemblyAiPiiSubstitution,
  AssemblyAiRedactedAudioQuality,
  AssemblyAiRedactPiiAudioOptions,
  AssemblyAiSpeakerOptions,
  AssemblyAiSyncModel,
  AssemblyAiSyncLiveSttRequest,
  AssemblyAiSyncSttRequest,
  AssemblyAiSyncSttResult,
  AssemblyAiTranscriptUtterance,
  AssemblyAiTranscriptWord,
} from "./assemblyai-http-stt.js";
import {
  SystemProviderClock,
  normalizeSttConnectionError,
  redactSttConnectionUrl,
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
  providerStreamEnded,
  safeClose,
  safeSend,
  writeProviderAudioFrame,
  rawDataByteLength,
  rawDataToBuffer,
  type ProviderClock,
  providerError,
  validationError,
} from "./common.js";

import {
  ASSEMBLYAI_BEGIN_TIMEOUT_MS,
  ASSEMBLYAI_CLOSE_TIMEOUT_MS,
  ASSEMBLYAI_DEFAULT_URL,
  ASSEMBLYAI_ERROR_CODE,
  ASSEMBLYAI_ERROR_CONTEXT,
  ASSEMBLYAI_MAX_PENDING_TURN_BYTES,
  ASSEMBLYAI_MAX_PENDING_TURNS,
  ASSEMBLYAI_MIN_FRAME_MS,
  ASSEMBLYAI_PROVIDER,
  ASSEMBLYAI_TARGET_FRAME_MS,
  appendBytes,
  assemblyAiBeginCancelled,
  assemblyAiBeginTimeout,
  assemblyAiCloseError,
  assemblyAiProtocolError,
  assemblyAiProtocolFailure,
  boundedAssemblyWords,
  assemblyAiLanguageCode,
  bytesForMs,
  delay,
  validSilenceOption,
  type AssemblyAiBeginMessage,
  type AssemblyAiMessage,
  type AssemblyAiSpeechStartedMessage,
  type AssemblyAiTurnMessage,
} from "./assemblyai-stt-protocol.js";
import { assertSupportedLanguagePolicy, requestLanguagePolicy } from "./stt-language-policy.js";

const ASSEMBLYAI_LANGUAGE_POLICY_MODELS = new Set(["universal-3-6-pro", "universal-3-5-pro"]);
const ASSEMBLYAI_TURN_PROFILE_MODELS = new Set(["universal-3-6-pro"]);
const ASSEMBLYAI_MAX_LANGUAGE_HINTS = 10;
export { assemblyAiCloseError, assemblyAiProtocolError };

const ASSEMBLYAI_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http", "websocket"],
  audio: { input: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.assemblyai.models,
  turnDetection: ["stt_endpointing"],
  metadata: {
    realtimeModel: PROVIDER_CATALOG.assemblyai.defaultModel,
    realtimeModels: ASSEMBLYAI_REALTIME_MODELS,
    preRecordedModels: ASSEMBLYAI_PRE_RECORDED_MODELS,
    syncModels: ASSEMBLYAI_SYNC_MODELS,
    preRecordedTranscription: true,
    syncTranscription: true,
    syncLiveTranscription: true,
    partialTranscripts: true,
    formattedTurns: true,
    speakerDiarization: true,
    multichannelTranscription: true,
    piiRedaction: true,
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
  readonly speakerLabels?: boolean;
  readonly maxSpeakers?: number;
  readonly speakerLabelsRevisionIntervalMs?: number;
  readonly minTurnSilenceMs?: number;
  readonly maxTurnSilenceMs?: number;
  readonly clock?: ProviderClock;
  readonly preRecordedUrl?: string;
  readonly uploadUrl?: string;
  readonly syncUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

const ASSEMBLYAI_AGENT_CONTEXT_MODELS = new Set(["universal-3-5-pro", "universal-3-6-pro"]);

export class AssemblyAiSttProvider implements SpeechToTextProvider {
  readonly name = ASSEMBLYAI_PROVIDER;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly usageAccounting = { reportsAudioWrites: true } as const;
  readonly capabilities = ASSEMBLYAI_CAPABILITIES;

  supportsSttLanguagePolicy(policy: SttLanguagePolicy, model = this.#modelId): boolean {
    if (!ASSEMBLYAI_LANGUAGE_POLICY_MODELS.has(model)) return false;
    if (policy.mode === "auto") return true;
    if (policy.mode === "fixed")
      return assemblyAiLanguageCode(model, policy.language) !== undefined;
    return (
      policy.languages.length > 0 &&
      policy.languages.length <= ASSEMBLYAI_MAX_LANGUAGE_HINTS &&
      policy.languages.every((language) => assemblyAiLanguageCode(model, language) !== undefined)
    );
  }

  supportsSttTurnTakingProfile(profile: SttTurnTakingProfile, model = this.#modelId): boolean {
    return (
      ASSEMBLYAI_TURN_PROFILE_MODELS.has(model) &&
      (profile === "latency" || profile === "balanced" || profile === "accuracy")
    );
  }

  supportsSttVocabulary(vocabulary: readonly string[], model = this.#modelId): boolean {
    return (
      ASSEMBLYAI_REALTIME_MODELS.includes(model as (typeof ASSEMBLYAI_REALTIME_MODELS)[number]) &&
      vocabulary.length <= 100 &&
      vocabulary.every((term) => typeof term === "string" && term.length > 0 && term.length <= 50)
    );
  }

  supportsSttAgentContext(model = this.#modelId): boolean {
    return ASSEMBLYAI_AGENT_CONTEXT_MODELS.has(model);
  }

  readonly #apiKey: string;
  readonly #url: string;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #formatTurns: boolean;
  readonly #prompt: string | undefined;
  readonly #languageDetection: boolean;
  readonly #speakerLabels: boolean;
  readonly #maxSpeakers: number | undefined;
  readonly #speakerLabelsRevisionIntervalMs: number | undefined;
  readonly #minTurnSilenceMs: number | undefined;
  readonly #maxTurnSilenceMs: number | undefined;
  readonly #clock: ProviderClock;
  readonly #preRecordedUrl: string;
  readonly #uploadUrl: string;
  readonly #syncUrl: string;
  readonly #fetch: typeof fetch;
  readonly #webSocketFactory: NonNullable<AssemblyAiSttProviderOptions["webSocketFactory"]>;

  constructor(options: AssemblyAiSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? ASSEMBLYAI_DEFAULT_URL;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.assemblyai.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#formatTurns = options.formatTurns ?? true;
    this.#prompt = options.prompt;
    this.#languageDetection = options.languageDetection ?? false;
    this.#speakerLabels = options.speakerLabels ?? false;
    this.#maxSpeakers = options.maxSpeakers;
    this.#speakerLabelsRevisionIntervalMs = options.speakerLabelsRevisionIntervalMs;
    this.#minTurnSilenceMs = options.minTurnSilenceMs;
    this.#maxTurnSilenceMs = options.maxTurnSilenceMs;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#preRecordedUrl = (
      options.preRecordedUrl ?? "https://api.assemblyai.com/v2/transcript"
    ).replace(/\/+$/u, "");
    this.#uploadUrl = (options.uploadUrl ?? "https://api.assemblyai.com/v2/upload").replace(
      /\/+$/u,
      "",
    );
    this.#syncUrl = (options.syncUrl ?? "https://sync.assemblyai.com/v1/transcribe").replace(
      /\/+$/u,
      "",
    );
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
    assertSttPcm16leFormat(request.format);
    assertSttSampleRate(PROVIDER_NAMES.assemblyaiStt, request.format.sampleRateHz, [
      PCM16_16K_MONO.sampleRateHz,
    ]);
    const model = request.model ?? this.#modelId;
    assertSupportedModel(
      PROVIDER_NAMES.assemblyaiStt,
      ASSEMBLYAI_REALTIME_MODELS,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );
    const languagePolicy = requestLanguagePolicy(request, PROVIDER_NAMES.assemblyaiStt);
    if (
      request.turnTakingProfile !== undefined &&
      !this.supportsSttTurnTakingProfile(request.turnTakingProfile, model)
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          `AssemblyAI turn profiles require universal-3-6-pro; model ${model} does not support them`,
          { provider: PROVIDER_NAMES.assemblyaiStt },
        ),
      );
    }
    assertSupportedLanguagePolicy(
      PROVIDER_NAMES.assemblyaiStt,
      languagePolicy,
      model,
      (policy, selectedModel) => this.supportsSttLanguagePolicy(policy, selectedModel),
    );
    const languageCodes =
      languagePolicy?.mode === "fixed"
        ? [assemblyAiLanguageCode(model, languagePolicy.language)]
        : languagePolicy?.mode === "hints"
          ? languagePolicy.languages.map((language) => assemblyAiLanguageCode(model, language))
          : undefined;
    if (model === "universal-3-6-pro" && this.#formatTurns === false) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "AssemblyAI universal-3-6-pro always returns formatted turns",
          { provider: PROVIDER_NAMES.assemblyaiStt },
        ),
      );
    }
    if (model === "universal-streaming-english" && this.#languageDetection) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "AssemblyAI language detection requires a multilingual streaming model",
          { provider: PROVIDER_NAMES.assemblyaiStt },
        ),
      );
    }
    if (
      (this.#maxSpeakers !== undefined || this.#speakerLabelsRevisionIntervalMs !== undefined) &&
      !this.#speakerLabels
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "AssemblyAI speaker limits require speakerLabels=true",
          { provider: PROVIDER_NAMES.assemblyaiStt },
        ),
      );
    }
    if (
      (this.#maxSpeakers !== undefined &&
        (!Number.isSafeInteger(this.#maxSpeakers) ||
          this.#maxSpeakers < 1 ||
          this.#maxSpeakers > 10)) ||
      (this.#speakerLabelsRevisionIntervalMs !== undefined &&
        (!Number.isSafeInteger(this.#speakerLabelsRevisionIntervalMs) ||
          (this.#speakerLabelsRevisionIntervalMs !== 0 &&
            this.#speakerLabelsRevisionIntervalMs < 120_000) ||
          this.#speakerLabelsRevisionIntervalMs > 86_400_000))
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "AssemblyAI speaker diarization options are invalid",
          { provider: PROVIDER_NAMES.assemblyaiStt },
        ),
      );
    }

    const url = new URL(this.#url);
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
    url.searchParams.set("speech_model", model);
    if (request.turnTakingProfile !== undefined) {
      url.searchParams.set("mode", assemblyAiTurnProfileMode(request.turnTakingProfile));
    }
    if (model !== "universal-3-6-pro") {
      url.searchParams.set("format_turns", String(this.#formatTurns));
    }
    if (this.#languageDetection) {
      url.searchParams.set("language_detection", "true");
    }
    if (this.#speakerLabels) {
      url.searchParams.set("speaker_labels", "true");
    }
    if (this.#maxSpeakers !== undefined) {
      url.searchParams.set("max_speakers", String(this.#maxSpeakers));
    }
    if (this.#speakerLabelsRevisionIntervalMs !== undefined) {
      url.searchParams.set(
        "speaker_labels_revision_interval_ms",
        String(this.#speakerLabelsRevisionIntervalMs),
      );
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

    if (languageCodes !== undefined) {
      url.searchParams.set("language_codes", JSON.stringify(languageCodes));
    }
    if (this.#prompt) {
      url.searchParams.set("prompt", this.#prompt);
    }

    let socket: WebSocket | undefined;
    let stream: AssemblyAiSttStream | undefined;
    try {
      socket = this.#webSocketFactory(url.toString(), {
        Authorization: this.#apiKey,
      });
      stream = new AssemblyAiSttStream(socket, request, this.#clock, this.#formatTurns, model);
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
      await stream.waitForBegin(request.signal);
      return stream;
    } catch (error) {
      if (socket) safeClose(socket);
      await stream?.close().catch(() => undefined);
      throw TvicThrowableError.from(
        redactSttConnectionUrl(normalizeSttConnectionError(error, ASSEMBLYAI_ERROR_CONTEXT)),
      );
    }
  }

  async transcribe(
    request: AssemblyAiPreRecordedSttRequest,
  ): Promise<AssemblyAiPreRecordedSttResult>;
  async transcribe(request: SttBatchTranscriptionRequest): Promise<SttBatchTranscription>;
  async transcribe(
    request: AssemblyAiPreRecordedSttRequest | SttBatchTranscriptionRequest,
  ): Promise<AssemblyAiPreRecordedSttResult | SttBatchTranscription> {
    return transcribeAssemblyAiPreRecorded(
      this.#httpOptions(),
      request as AssemblyAiPreRecordedSttRequest,
    );
  }

  async transcribeSync(request: AssemblyAiSyncSttRequest): Promise<AssemblyAiSyncSttResult> {
    return transcribeAssemblyAiSync(this.#httpOptions(), request);
  }

  async transcribeSyncLive(
    request: AssemblyAiSyncLiveSttRequest,
  ): Promise<AssemblyAiSyncSttResult> {
    return transcribeAssemblyAiSyncLive(this.#httpOptions(), request);
  }

  async warmSync(model?: string, signal?: AbortSignal): Promise<void> {
    return warmAssemblyAiSync(this.#httpOptions(), model, signal);
  }

  #httpOptions(): AssemblyAiHttpSttOptions {
    return {
      apiKey: this.#apiKey,
      preRecordedUrl: this.#preRecordedUrl,
      uploadUrl: this.#uploadUrl,
      syncUrl: this.#syncUrl,
      fetchImpl: this.#fetch,
      allowUnknownModel: this.#allowUnknownModel,
    };
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
  readonly #model: string;
  readonly #providerAudioDurationUsage: ProviderUsageOperation | undefined;
  readonly #providerSessionDurationUsage: ProviderUsageOperation | undefined;
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
  #audioDurationFinalized = false;
  #sessionDurationFinalized = false;
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
    model = request.model ?? PROVIDER_CATALOG.assemblyai.defaultModel,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.#formatTurns = formatTurns;
    this.#model = model;
    this.#providerAudioDurationUsage = request.usageReporter?.beginOperation({
      field: "providerAudioMs",
      unit: "milliseconds",
      aggregation: "observations",
      model,
      modelSource: request.model ? "request" : "configured",
    });
    this.#providerSessionDurationUsage = request.usageReporter?.beginOperation({
      field: "providerSessionMs",
      unit: "milliseconds",
      aggregation: "observations",
      model,
      modelSource: request.model ? "request" : "configured",
    });
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
      this.#audioBuffer = this.#audioBuffer.slice(frameBytes);
      await this.#sendAudioFrame(frame);
    }
  }

  async updateAgentContext(context: string): Promise<void> {
    if (!ASSEMBLYAI_AGENT_CONTEXT_MODELS.has(this.#model)) {
      throw TvicThrowableError.from(
        validationError(
          STT_ERROR_CODES.invalidRequest,
          "AssemblyAI agent context requires a Universal-3 Pro realtime model",
          { provider: ASSEMBLYAI_PROVIDER, metadata: { model: this.#model } },
        ),
      );
    }
    if (typeof context !== "string" || countUnicodeCodePoints(context) > 1_750) {
      throw TvicThrowableError.from(
        validationError(
          STT_ERROR_CODES.invalidRequest,
          "AssemblyAI agent context must not exceed 1750 characters",
          { provider: ASSEMBLYAI_PROVIDER },
        ),
      );
    }
    if (this.#closed || this.#closing || this.#socket.readyState !== WebSocket.OPEN) {
      throw TvicThrowableError.from(
        providerError(
          STT_ERROR_CODES.contextUpdateFailed,
          "AssemblyAI agent context update could not be accepted by the local transport",
          { provider: ASSEMBLYAI_PROVIDER, retriable: true },
        ),
      );
    }

    await new Promise<void>((resolve, reject) => {
      try {
        this.#socket.send(
          JSON.stringify({ type: "UpdateConfiguration", agent_context: context }),
          (error) => {
            if (error) {
              reject(
                providerError(
                  STT_ERROR_CODES.contextUpdateFailed,
                  "AssemblyAI agent context update could not be accepted by the local transport",
                  { provider: ASSEMBLYAI_PROVIDER, retriable: true },
                ),
              );
              return;
            }
            resolve();
          },
        );
      } catch {
        reject(
          providerError(
            STT_ERROR_CODES.contextUpdateFailed,
            "AssemblyAI agent context update could not be accepted by the local transport",
            { provider: ASSEMBLYAI_PROVIDER, retriable: true },
          ),
        );
      }
    });
  }

  async commit(): Promise<void> {
    if (this.#closed || this.#closing) {
      throw providerStreamEnded(PROVIDER_NAMES.assemblyaiStt, ASSEMBLYAI_ERROR_CODE);
    }
    await this.#flushAudioBuffer();
    if (this.#closed || this.#lastError !== undefined) {
      throw (
        this.#lastError ?? providerStreamEnded(PROVIDER_NAMES.assemblyaiStt, ASSEMBLYAI_ERROR_CODE)
      );
    }
    if (!safeSend(this.#socket, JSON.stringify({ type: "ForceEndpoint" }))) {
      throw (
        this.#lastError ?? providerStreamEnded(PROVIDER_NAMES.assemblyaiStt, ASSEMBLYAI_ERROR_CODE)
      );
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
    void this.#flushAudioBuffer().catch((error: unknown) => this.#fail(error));

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
        this.#reportTerminationUsage(parsed);
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
          message.turn_order < 0)) ||
      (message.speaker_label !== undefined &&
        (typeof message.speaker_label !== "string" || message.speaker_label.length > 128)) ||
      (message.speaker_confidence !== undefined &&
        (typeof message.speaker_confidence !== "number" ||
          !Number.isFinite(message.speaker_confidence) ||
          message.speaker_confidence < 0 ||
          message.speaker_confidence > 1))
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
        ...(typeof message.speaker_label === "string"
          ? { speakerLabel: message.speaker_label }
          : {}),
        ...(typeof message.speaker_confidence === "number"
          ? { speakerConfidence: message.speaker_confidence }
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

  async #sendAudioFrame(frame: Uint8Array): Promise<void> {
    const usageWrite = this.#request.usageReporter?.beginAudioWrite({
      byteLength: frame.byteLength,
      format: this.#request.format,
    });
    try {
      await writeProviderAudioFrame(this.#socket, Buffer.from(frame), {
        code: ASSEMBLYAI_ERROR_CODE,
        provider: PROVIDER_NAMES.assemblyaiStt,
      });
      usageWrite?.succeeded();
    } catch (error) {
      usageWrite?.failed();
      this.#fail(error);
      throw error;
    }
  }

  #flushAudioBuffer(): Promise<void> {
    const frameBytes = bytesForMs(PCM16_16K_MONO.sampleRateHz, ASSEMBLYAI_TARGET_FRAME_MS);
    const writes: Promise<void>[] = [];
    while (this.#audioBuffer.byteLength >= frameBytes && !this.#closed) {
      const frame = this.#audioBuffer.subarray(0, frameBytes);
      writes.push(this.#sendAudioFrame(frame));
      this.#audioBuffer = this.#audioBuffer.slice(frameBytes);
    }
    if (this.#audioBuffer.byteLength === 0 || this.#closed) {
      return Promise.all(writes).then(() => undefined);
    }

    const minimumBytes = bytesForMs(PCM16_16K_MONO.sampleRateHz, ASSEMBLYAI_MIN_FRAME_MS);
    if (this.#audioBuffer.byteLength >= minimumBytes) {
      writes.push(this.#sendAudioFrame(this.#audioBuffer));
      this.#audioBuffer = new Uint8Array();
      return Promise.all(writes).then(() => undefined);
    }

    const padded = new Uint8Array(minimumBytes);
    padded.set(this.#audioBuffer);
    writes.push(this.#sendAudioFrame(padded));
    this.#audioBuffer = new Uint8Array();
    return Promise.all(writes).then(() => undefined);
  }

  #reportTerminationUsage(message: Extract<AssemblyAiMessage, { type: "Termination" }>): void {
    this.#reportDuration(message.audio_duration_seconds, "audio");
    this.#reportDuration(message.session_duration_seconds, "session");
  }

  #reportDuration(seconds: unknown, scope: "audio" | "session"): void {
    const finalized =
      scope === "audio" ? this.#audioDurationFinalized : this.#sessionDurationFinalized;
    if (finalized) return;
    if (scope === "audio") this.#audioDurationFinalized = true;
    else this.#sessionDurationFinalized = true;
    const operation =
      scope === "audio" ? this.#providerAudioDurationUsage : this.#providerSessionDurationUsage;

    if (seconds === undefined) {
      operation?.notReported("absent");
    } else if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      operation?.notReported("invalid");
    } else {
      const value = seconds * 1_000;
      if (Number.isFinite(value)) operation?.report(value);
      else operation?.notReported("invalid");
    }
    operation?.finish();
  }

  #sessionMetadata(): Readonly<Record<string, unknown>> {
    return {
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      ...(this.#expiresAt === undefined ? {} : { expiresAt: this.#expiresAt }),
    };
  }
}

export function createAssemblyAiSttProvider(
  options: AssemblyAiSttProviderOptions,
): AssemblyAiSttProvider {
  return new AssemblyAiSttProvider(options);
}

function assemblyAiTurnProfileMode(profile: SttTurnTakingProfile): string {
  switch (profile) {
    case "latency":
      return "min_latency";
    case "balanced":
      return "balanced";
    case "accuracy":
      return "max_accuracy";
  }
}
