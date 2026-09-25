import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  cancelledError,
  counterIdGenerator,
  createMediaEvent,
  sameAudioFormat,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  MediaAudioCommittedEvent,
  MediaEventId,
  ProviderCapabilities,
  TextToSpeechProvider,
  TtsEvent,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";
import { AsyncQueue, durationMsForPcm16le, frameCountForPcm16le } from "@tvic/media";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
import {
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  SystemProviderClock,
  assertSupportedModel,
  normalizeProviderError,
  parseJsonObject,
  providerError,
  providerEventQueueOverflow,
  providerThrowableError,
  type ProviderClock,
} from "./common.js";
import {
  SARVAM_TTS_LANGUAGES,
  SARVAM_TTS_VOICES,
  type SarvamTtsLanguage,
  type SarvamTtsVoice,
} from "./sarvam-tts.js";
import { decodeSarvamTtsAudio } from "./sarvam-tts-audio.js";
import { SarvamWavStreamDecoder } from "./sarvam-tts-wav.js";

/** Sarvam REST accepts 2,500 characters for Bulbul v3. */
export const SARVAM_TTS_REST_MAX_TEXT_CHARS = 2_500;
/** Sarvam HTTP streaming accepts 3,500 characters per request. */
export const SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS = 3_500;

const SARVAM_TTS_REST_DEFAULT_URL = "https://api.sarvam.ai/text-to-speech";
const SARVAM_TTS_HTTP_STREAM_DEFAULT_URL = "https://api.sarvam.ai/text-to-speech/stream";
const SARVAM_TTS_HTTP_ERROR_BODY_MAX_BYTES = 64 * 1024;
const SARVAM_TTS_REST_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const SARVAM_TTS_MAX_REQUEST_ID_CHARS = 256;

const SARVAM_TTS_REST_CAPABILITIES = {
  streaming: { input: false, output: false, native: false },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  languages: SARVAM_TTS_LANGUAGES,
  models: PROVIDER_CATALOG.sarvamTts.models,
  voices: SARVAM_TTS_VOICES,
  metadata: {
    transport: "rest",
    endpoint: "/text-to-speech",
    requestTextLimit: SARVAM_TTS_REST_MAX_TEXT_CHARS,
    wireOutputCodec: "wav",
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation: "https://docs.sarvam.ai/api-reference/text-to-speech/convert",
  },
} satisfies ProviderCapabilities;

const SARVAM_TTS_HTTP_STREAM_CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  languages: SARVAM_TTS_LANGUAGES,
  models: PROVIDER_CATALOG.sarvamTts.models,
  voices: SARVAM_TTS_VOICES,
  metadata: {
    transport: "http-stream",
    endpoint: "/text-to-speech/stream",
    requestTextLimit: SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS,
    wireOutputCodec: "wav",
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation: "https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream",
  },
} satisfies ProviderCapabilities;

export interface SarvamTtsHttpProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly language?: string;
  /** Provider pace. Sarvam Bulbul v3 accepts 0.5 through 2.0. */
  readonly pace?: number;
  /** Provider temperature. Sarvam Bulbul v3 accepts 0.01 through 1.0. */
  readonly temperature?: number;
  readonly pronunciationDictionaryId?: string;
  readonly clock?: ProviderClock;
  /** Injectable fetch makes protocol and failure tests hermetic. */
  readonly fetchImpl?: typeof fetch;
}

interface SarvamTtsHttpRequestOptions {
  readonly model: string;
  readonly language: SarvamTtsLanguage;
  readonly voice: SarvamTtsVoice;
  readonly pace: number;
  readonly temperature: number;
  readonly pronunciationDictionaryId?: string;
  readonly transport: "rest" | "http-stream";
}

interface SarvamRestResponse {
  readonly request_id?: unknown;
  readonly audios?: unknown;
}

export class SarvamTtsRestProvider implements TextToSpeechProvider {
  readonly name = PROVIDER_NAMES.sarvamTts;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = SARVAM_TTS_REST_CAPABILITIES;

  readonly #options: SarvamTtsHttpProviderOptions;
  readonly #modelId: string;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;

  constructor(options: SarvamTtsHttpProviderOptions) {
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.sarvamTts.defaultModel;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    const resolved = resolveSarvamTtsHttpRequest(this.#options, this.#modelId, request, "rest");
    const controller = new AbortController();
    const detachAbort = linkAbortSignal(request.signal, controller);
    let response: Response;
    try {
      response = await this.#fetch(SARVAM_TTS_REST_DEFAULT_URL_FOR(this.#options), {
        method: "POST",
        headers: sarvamTtsHeaders(this.#options.apiKey),
        body: JSON.stringify(toSarvamTtsBody(request.text, resolved)),
        signal: controller.signal,
      });
    } catch (error) {
      detachAbort();
      throw sarvamTtsHttpTransportError(error, request.signal, controller.signal);
    }

    try {
      if (!response.ok) {
        throw await sarvamTtsHttpResponseError(response);
      }
      const body = await readBoundedResponseText(response, SARVAM_TTS_REST_RESPONSE_MAX_BYTES);
      const parsed = parseSarvamRestResponse(body);
      const audio = decodeSarvamTtsAudio(parsed.audio, MAX_PROVIDER_TTS_OUTPUT_BYTES);
      return new SarvamTtsCompletedStream(request, {
        clock: this.#clock,
        model: resolved.model,
        language: resolved.language,
        voice: resolved.voice,
        transport: "rest",
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
        audio,
      });
    } catch (error) {
      throw normalizeSarvamTtsHttpError(error);
    } finally {
      detachAbort();
    }
  }
}

export class SarvamTtsHttpStreamProvider implements TextToSpeechProvider {
  readonly name = PROVIDER_NAMES.sarvamTts;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = SARVAM_TTS_HTTP_STREAM_CAPABILITIES;

  readonly #options: SarvamTtsHttpProviderOptions;
  readonly #modelId: string;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;

  constructor(options: SarvamTtsHttpProviderOptions) {
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.sarvamTts.defaultModel;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    const resolved = resolveSarvamTtsHttpRequest(
      this.#options,
      this.#modelId,
      request,
      "http-stream",
    );
    const controller = new AbortController();
    const detachAbort = linkAbortSignal(request.signal, controller);
    let response: Response;
    try {
      response = await this.#fetch(SARVAM_TTS_HTTP_STREAM_DEFAULT_URL_FOR(this.#options), {
        method: "POST",
        headers: {
          ...sarvamTtsHeaders(this.#options.apiKey),
          Accept: "audio/wav",
        },
        body: JSON.stringify(toSarvamTtsBody(request.text, resolved)),
        signal: controller.signal,
      });
    } catch (error) {
      detachAbort();
      throw sarvamTtsHttpTransportError(error, request.signal, controller.signal);
    }

    try {
      if (!response.ok) {
        throw await sarvamTtsHttpResponseError(response);
      }
      if (!response.body) {
        throw sarvamTtsProtocolError("Sarvam HTTP stream returned no response body");
      }
      const stream = new SarvamTtsHttpStream(response.body, request, {
        clock: this.#clock,
        model: resolved.model,
        language: resolved.language,
        voice: resolved.voice,
        transport: "http-stream",
        controller,
        detachAbort,
      });
      stream.start();
      return stream;
    } catch (error) {
      detachAbort();
      controller.abort();
      throw normalizeSarvamTtsHttpError(error);
    }
  }
}

export class SarvamTtsHttpStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
      this.#fail(error);
      return error;
    },
  });
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #request: TtsSynthesisRequest;
  readonly #options: SarvamTtsHttpStreamOptions;
  readonly #mediaEventIds: CounterIdGenerator<MediaEventId>;
  readonly #decoder = new SarvamWavStreamDecoder();
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  #mediaSequence = 1;
  #closed = false;
  #cancelled = false;
  #outputBytes = 0;
  #outputChunks = 0;
  #frameCount = 0;

  constructor(
    body: ReadableStream<Uint8Array>,
    request: TtsSynthesisRequest,
    options: SarvamTtsHttpStreamOptions,
  ) {
    this.#reader = body.getReader();
    this.#request = request;
    this.#options = options;
    this.#mediaEventIds = counterIdGenerator<MediaEventId>(
      `sarvam_tts_http_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    this.events = this.#events;
  }

  start(): void {
    void this.#pump();
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#cancelled = true;
    this.#options.controller.abort();
    await this.#reader.cancel().catch(() => undefined);
    this.#close();
  }

  async #pump(): Promise<void> {
    try {
      while (!this.#closed) {
        const result = await this.#reader.read();
        if (result.done) break;
        for (const audio of this.#decoder.push(result.value)) {
          this.#pushAudio(audio);
        }
      }
      this.#decoder.finish();
      if (this.#closed) return;
      this.#pushCommittedEvent();
      this.#close();
    } catch (error) {
      if (this.#cancelled || this.#options.controller.signal.aborted) {
        this.#close();
        return;
      }
      this.#fail(error);
    }
  }

  #pushAudio(bytes: Uint8Array): void {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength % 2 !== 0 ||
      this.#outputChunks >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
      this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
    ) {
      throw providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts);
    }

    const eventId = this.#mediaEventId("chunk");
    const frames = frameCountForPcm16le(bytes);
    const event = createMediaEvent({
      id: eventId,
      type: "media.audio.chunk",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.sarvamTts,
      audio: {
        format: this.#request.format,
        durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
        frameCount: frames,
        bytes: new Uint8Array(bytes),
      },
      metadata: {
        sarvam: {
          transport: this.#options.transport,
          model: this.#options.model,
          language: this.#options.language,
          voice: this.#options.voice,
        },
      },
    });
    if (!this.#pushEvent(event)) return;
    this.#chunkIds.push(eventId);
    this.#chunkSequences.push(this.#mediaSequence);
    this.#mediaSequence += 1;
    this.#frameCount += frames;
    this.#outputBytes += bytes.byteLength;
    this.#outputChunks += 1;
  }

  #pushCommittedEvent(): void {
    const committed: MediaAudioCommittedEvent = createMediaEvent({
      id: this.#mediaEventId("committed"),
      type: "media.audio.committed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.sarvamTts,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1_000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: [...this.#chunkIds],
      metadata: {
        sarvam: {
          transport: this.#options.transport,
          model: this.#options.model,
          language: this.#options.language,
          voice: this.#options.voice,
        },
      },
    });
    if (this.#pushEvent(committed)) this.#mediaSequence += 1;
  }

  #mediaEventId(kind: string): MediaEventId {
    return `${this.#mediaEventIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.sarvamTts));
    return false;
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.detachAbort();
    this.#events.close();
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    });
    this.#closed = true;
    this.#options.detachAbort();
    this.#options.controller.abort(throwable);
    void this.#reader.cancel().catch(() => undefined);
    this.#events.fail(throwable);
  }
}

class SarvamTtsCompletedStream implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #events = new AsyncQueue<TtsEvent>();
  #closed = false;

  constructor(request: TtsSynthesisRequest, options: SarvamTtsCompletedStreamOptions) {
    this.events = this.#events;
    const ids = counterIdGenerator<MediaEventId>(
      `sarvam_tts_rest_${String(request.sessionId)}_${String(request.turnId)}`,
    );
    const chunkId = `${ids.next()}_chunk_${options.clock.now()}` as MediaEventId;
    const frames = frameCountForPcm16le(options.audio);
    this.#events.push(
      createMediaEvent({
        id: chunkId,
        type: "media.audio.chunk",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        direction: "output",
        timestamp: options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.sarvamTts,
        audio: {
          format: request.format,
          durationMs: durationMsForPcm16le(options.audio, request.format.sampleRateHz),
          frameCount: frames,
          bytes: new Uint8Array(options.audio),
        },
        metadata: {
          sarvam: {
            transport: options.transport,
            model: options.model,
            language: options.language,
            voice: options.voice,
            ...(options.requestId ? { requestId: options.requestId } : {}),
          },
        },
      }),
    );
    this.#events.push(
      createMediaEvent({
        id: `${ids.next()}_committed_${options.clock.now()}` as MediaEventId,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        direction: "output",
        timestamp: options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.sarvamTts,
        durationMs: durationMsForPcm16le(options.audio, request.format.sampleRateHz),
        frameCount: frames,
        sequenceRange: [1, 1],
        chunkIds: [chunkId],
        metadata: {
          sarvam: {
            transport: options.transport,
            model: options.model,
            language: options.language,
            voice: options.voice,
            ...(options.requestId ? { requestId: options.requestId } : {}),
          },
        },
      }),
    );
    this.#events.close();
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.close();
  }
}

interface SarvamTtsCompletedStreamOptions {
  readonly clock: ProviderClock;
  readonly model: string;
  readonly language: string;
  readonly voice: string;
  readonly transport: "rest";
  readonly requestId?: string;
  readonly audio: Uint8Array;
}

interface SarvamTtsHttpStreamOptions {
  readonly clock: ProviderClock;
  readonly model: string;
  readonly language: string;
  readonly voice: string;
  readonly transport: "http-stream";
  readonly controller: AbortController;
  readonly detachAbort: () => void;
}

function resolveSarvamTtsHttpRequest(
  options: SarvamTtsHttpProviderOptions,
  configuredModel: string,
  request: TtsSynthesisRequest,
  transport: SarvamTtsHttpRequestOptions["transport"],
): SarvamTtsHttpRequestOptions {
  if (!sameAudioFormat(request.format, PCM16_16K_MONO)) {
    throw sarvamTtsValidationError("Sarvam HTTP TTS requires 16kHz PCM16 mono output");
  }
  if (request.timestamps === true) {
    throw sarvamTtsValidationError(
      "Sarvam Bulbul v3 HTTP TTS does not provide alignment timestamps",
    );
  }
  if (typeof request.text !== "string") {
    throw sarvamTtsValidationError("Sarvam TTS text must be a string");
  }
  const maxTextChars =
    transport === "rest" ? SARVAM_TTS_REST_MAX_TEXT_CHARS : SARVAM_TTS_HTTP_STREAM_MAX_TEXT_CHARS;
  if (request.text.length === 0 || request.text.length > maxTextChars) {
    throw sarvamTtsValidationError(
      `Sarvam ${transport === "rest" ? "REST" : "HTTP stream"} TTS text must contain 1-${maxTextChars} characters`,
      { maxTextChars, textChars: request.text.length },
    );
  }

  const model = request.model ?? configuredModel;
  assertSupportedModel(PROVIDER_NAMES.sarvamTts, PROVIDER_CATALOG.sarvamTts.models, model);
  const voice = request.voice ?? options.voiceId ?? ADAPTER_DEFAULTS.sarvamTts.voice;
  if (!SARVAM_TTS_VOICES.includes(voice as SarvamTtsVoice)) {
    throw TvicThrowableError.from(
      validationError(
        TVIC_ERROR_CODES.providerVoiceUnsupported,
        "Sarvam Bulbul v3 voice is invalid",
        {
          provider: PROVIDER_NAMES.sarvamTts,
          metadata: { voice, supportedVoices: SARVAM_TTS_VOICES },
        },
      ),
    );
  }
  const language = options.language ?? ADAPTER_DEFAULTS.sarvamTts.language;
  if (!SARVAM_TTS_LANGUAGES.includes(language as SarvamTtsLanguage)) {
    throw sarvamTtsValidationError("Sarvam Bulbul v3 language is invalid", {
      language,
      supportedLanguages: SARVAM_TTS_LANGUAGES,
    });
  }
  const pace = request.speed ?? options.pace ?? ADAPTER_DEFAULTS.sarvamTts.pace;
  assertSarvamTtsNumber("pace", pace, 0.5, 2);
  const temperature = options.temperature ?? ADAPTER_DEFAULTS.sarvamTts.temperature;
  assertSarvamTtsNumber("temperature", temperature, 0.01, 1);
  if (
    options.pronunciationDictionaryId !== undefined &&
    (typeof options.pronunciationDictionaryId !== "string" ||
      options.pronunciationDictionaryId.length === 0 ||
      options.pronunciationDictionaryId.length > 256)
  ) {
    throw sarvamTtsValidationError("Sarvam pronunciationDictionaryId is invalid");
  }
  return {
    model,
    language: language as SarvamTtsLanguage,
    voice: voice as SarvamTtsVoice,
    pace,
    temperature,
    transport,
    ...(options.pronunciationDictionaryId
      ? { pronunciationDictionaryId: options.pronunciationDictionaryId }
      : {}),
  };
}

function toSarvamTtsBody(
  text: string,
  options: SarvamTtsHttpRequestOptions,
): Readonly<Record<string, unknown>> {
  return {
    text,
    language_code: options.language,
    speaker: options.voice,
    model: options.model,
    pace: options.pace,
    temperature: options.temperature,
    speech_sample_rate: PCM16_16K_MONO.sampleRateHz,
    output_audio_codec: "wav",
    ...(options.pronunciationDictionaryId ? { dict_id: options.pronunciationDictionaryId } : {}),
  };
}

function sarvamTtsHeaders(apiKey: string): Readonly<Record<string, string>> {
  return {
    "api-subscription-key": apiKey,
    "Content-Type": "application/json",
  };
}

function SARVAM_TTS_REST_DEFAULT_URL_FOR(options: SarvamTtsHttpProviderOptions): string {
  return options.url ?? SARVAM_TTS_REST_DEFAULT_URL;
}

function SARVAM_TTS_HTTP_STREAM_DEFAULT_URL_FOR(options: SarvamTtsHttpProviderOptions): string {
  return options.url ?? SARVAM_TTS_HTTP_STREAM_DEFAULT_URL;
}

function parseSarvamRestResponse(body: string): {
  readonly audio: string;
  readonly requestId?: string;
} {
  const parsed = parseJsonObject(body) as SarvamRestResponse | null;
  if (!parsed || !Array.isArray(parsed.audios) || parsed.audios.length !== 1) {
    throw sarvamTtsProtocolError("Sarvam REST returned an invalid audios response");
  }
  const audio = parsed.audios[0];
  if (typeof audio !== "string" || audio.length === 0) {
    throw sarvamTtsProtocolError("Sarvam REST returned an invalid audio payload");
  }
  const requestId =
    typeof parsed.request_id === "string"
      ? boundedString(parsed.request_id, SARVAM_TTS_MAX_REQUEST_ID_CHARS)
      : undefined;
  return { audio, ...(requestId ? { requestId } : {}) };
}

async function sarvamTtsHttpResponseError(response: Response): Promise<TvicThrowableError> {
  const body = await readBoundedResponseText(response).catch(() => "");
  const parsed = parseJsonObject(body);
  const nested = asRecord(parsed?.error);
  const providerCode =
    typeof nested?.code === "string"
      ? boundedString(nested.code, 128)
      : typeof parsed?.code === "string"
        ? boundedString(parsed.code, 128)
        : undefined;
  const message =
    typeof nested?.message === "string"
      ? boundedString(nested.message, 1_024)
      : typeof parsed?.message === "string"
        ? boundedString(parsed.message, 1_024)
        : `Sarvam TTS request failed with HTTP ${response.status}`;
  const metadata = {
    httpStatus: response.status,
    ...(providerCode ? { providerCode } : {}),
  };
  const providerOptions = {
    provider: PROVIDER_NAMES.sarvamTts,
    metadata,
  } as const;
  if (/credit|balance|quota/.test(`${providerCode ?? ""} ${message}`.toLowerCase())) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerRateLimited, message, {
        ...providerOptions,
        retriable: false,
      }),
    );
  }
  if (response.status === 401 || response.status === 403) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerAuthFailed, message, providerOptions),
    );
  }
  if (response.status === 429) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerRateLimited, message, providerOptions),
    );
  }
  if (response.status === 400 || response.status === 422) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerInvalidRequest, message, providerOptions),
    );
  }
  if (response.status === 408 || response.status === 409 || response.status >= 500) {
    return TvicThrowableError.from(
      providerError(TVIC_ERROR_CODES.providerUpstreamFailed, message, {
        ...providerOptions,
        retriable: true,
      }),
    );
  }
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.sarvamTts, message, {
      ...providerOptions,
      retriable: false,
    }),
  );
}

function sarvamTtsHttpTransportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  controllerSignal: AbortSignal,
): TvicThrowableError {
  if (callerSignal?.aborted) {
    return TvicThrowableError.from(
      cancelledError("provider.connection_cancelled", "Sarvam TTS request was cancelled", {
        provider: PROVIDER_NAMES.sarvamTts,
      }),
    );
  }
  if (controllerSignal.aborted && controllerSignal.reason instanceof TvicThrowableError) {
    return controllerSignal.reason;
  }
  return TvicThrowableError.from(
    normalizeProviderError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    }),
  );
}

function normalizeSarvamTtsHttpError(error: unknown): TvicThrowableError {
  if (error instanceof TvicThrowableError) return error;
  return TvicThrowableError.from(
    normalizeProviderError(error, {
      code: PROVIDER_ERROR_CODES.sarvamTts,
      provider: PROVIDER_NAMES.sarvamTts,
    }),
  );
}

function sarvamTtsProtocolError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.sarvamTts, message, {
      provider: PROVIDER_NAMES.sarvamTts,
      retriable: false,
    }),
  );
}

function sarvamTtsValidationError(
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.sarvamTts,
      ...(metadata ? { metadata } : {}),
    }),
  );
}

function assertSarvamTtsNumber(
  name: string,
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw sarvamTtsValidationError(`Sarvam Bulbul v3 ${name} must be between ${min} and ${max}`, {
      [name]: value,
    });
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes = SARVAM_TTS_HTTP_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Sarvam response body exceeded the size limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function boundedString(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

export function createSarvamTtsRestProvider(
  options: SarvamTtsHttpProviderOptions,
): SarvamTtsRestProvider {
  return new SarvamTtsRestProvider(options);
}

export function createSarvamTtsHttpStreamProvider(
  options: SarvamTtsHttpProviderOptions,
): SarvamTtsHttpStreamProvider {
  return new SarvamTtsHttpStreamProvider(options);
}
