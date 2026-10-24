import WebSocket from "ws";

import {
  AsyncQueue,
  assertPcm16leFormat,
  durationMsForPcm16le,
  frameCountForPcm16le,
} from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  TVIC_ERROR_CODES,
  counterIdGenerator,
  countUnicodeCodePoints,
  hasSpeechControlCatalogFact,
  querySpeechControlCatalog,
  validateTtsPronunciationDictionaries,
  validateTtsTextNormalization,
  ttsTextPartsToPlainText,
  validationError,
  unknownErrorMessage,
  TvicThrowableError,
  createMediaEvent,
} from "@tvic/core";
import type {
  CounterIdGenerator,
  AudioFormat,
  IncrementalTextToSpeechProvider,
  MediaAudioCommittedEvent,
  MediaEventId,
  ProviderCapabilities,
  TtsEvent,
  TtsFlushResult,
  TtsSession,
  TtsSessionOpenRequest,
  TtsStream,
  TtsTextOperation,
  TtsTextPart,
  TtsPronunciationDictionaryReference,
  TtsTextNormalization,
  TtsProviderSelection,
  TtsSynthesisRequest,
  SpeechControlCatalogSnapshot,
} from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_API_VERSIONS, PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  providerEventQueueOverflow,
  providerThrowableError,
  providerError,
  MAX_PROVIDER_FRAME_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_BYTES,
  MAX_PROVIDER_TTS_OUTPUT_CHUNKS,
  MAX_PROVIDER_TTS_PENDING_FLUSHES,
  rawDataByteLength,
  rawDataToBuffer,
  safeClose,
  safeSend,
  assertSupportedModel,
  type ProviderClock,
} from "./common.js";
import {
  assertCartesiaOptions,
  assertCartesiaSpeed,
  cartesiaRequestLanguage,
  cartesiaTtsLanguageSupported,
  cartesiaGenerationConfig,
  type CartesiaGenerationConfig,
} from "./cartesia-options.js";
import {
  cartesiaProviderError,
  decodeCartesiaAudio,
  isValidFlushId,
  parseAlignment,
} from "./cartesia-protocol.js";
import type { CartesiaMessage } from "./cartesia-protocol.js";
import {
  assertCartesiaPlainText,
  MAX_CARTESIA_INPUT_UTF16_CODE_UNITS,
  MAX_CARTESIA_INPUT_UTF8_BYTES,
  cartesiaSupportsTtsTextOperations,
  cartesiaSupportsTypedParts,
  cartesiaSupportsPronunciationDictionaries,
  cartesiaSupportsTextNormalization,
  cartesiaTextNormalizationValue,
  serializeCartesiaPlainText,
  serializeCartesiaTtsText,
} from "./cartesia-tts-text.js";

export type { CartesiaGenerationConfig } from "./cartesia-options.js";
export { cartesiaProviderError } from "./cartesia-protocol.js";

export { MAX_CARTESIA_INPUT_UTF16_CODE_UNITS, MAX_CARTESIA_INPUT_UTF8_BYTES };

const CARTESIA_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.cartesia.models,
} satisfies ProviderCapabilities;

export interface CartesiaTtsProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly voiceId: string;
  readonly modelId?: string;
  readonly allowUnknownModel?: boolean;
  readonly speechControlCatalog?: SpeechControlCatalogSnapshot;
  readonly language?: string;
  readonly locale?: string;
  readonly accent?: string;
  readonly normalization?: string;
  readonly generationConfig?: CartesiaGenerationConfig;
  readonly pronunciationDictId?: string;
  readonly maxBufferDelayMs?: number;
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

export class CartesiaTtsProvider implements IncrementalTextToSpeechProvider {
  readonly name = PROVIDER_NAMES.cartesia;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities = CARTESIA_CAPABILITIES;
  readonly requiresAccountVoiceCatalog = true;
  readonly accountVoiceCatalogProviders = [PROVIDER_NAMES.cartesia] as const;
  readonly usageAccounting = {
    reportsTextCharacters: true,
    usesRequestModelForUsage: true,
  } as const;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #voiceId: string;
  readonly #modelId: string;
  readonly #configuredModelSource: "configured" | "not_reported";
  readonly #allowUnknownModel: boolean;
  readonly #language: string;
  readonly #locale: string | undefined;
  readonly #languageWasExplicitlyConfigured: boolean;
  readonly #speechControlCatalog: SpeechControlCatalogSnapshot | undefined;
  readonly #accent: string | undefined;
  readonly #normalization: string | undefined;
  readonly #generationConfig: CartesiaGenerationConfig | undefined;
  readonly #pronunciationDictId: string | undefined;
  readonly #maxBufferDelayMs: number;
  readonly #clock: ProviderClock;
  readonly #contextIds = counterIdGenerator<string>("cartesia_context");
  readonly #webSocketFactory: NonNullable<CartesiaTtsProviderOptions["webSocketFactory"]>;

  constructor(options: CartesiaTtsProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url =
      options.url ??
      `wss://api.cartesia.ai/tts/websocket?cartesia_version=${PROVIDER_API_VERSIONS.cartesia}`;
    this.#voiceId = options.voiceId;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.cartesia.defaultModel;
    this.#configuredModelSource = options.modelId === undefined ? "not_reported" : "configured";
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#speechControlCatalog = options.speechControlCatalog;
    this.#languageWasExplicitlyConfigured =
      options.language !== undefined || options.locale !== undefined;
    if (options.language !== undefined && options.locale !== undefined) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          "Cartesia accepts either language or locale, not both",
          { provider: PROVIDER_NAMES.cartesia },
        ),
      );
    }
    this.#language =
      options.locale !== undefined ? "" : (options.language ?? ADAPTER_DEFAULTS.cartesia.language);
    this.#locale = options.locale;
    this.#accent = options.accent;
    this.#normalization =
      options.normalization === undefined
        ? undefined
        : cartesiaConfiguredTextNormalization(options.normalization);
    this.#generationConfig = options.generationConfig;
    this.#pronunciationDictId = options.pronunciationDictId;
    this.#maxBufferDelayMs = options.maxBufferDelayMs ?? 0;
    if (options.pronunciationDictId !== undefined) {
      validateTtsPronunciationDictionaries([{ id: options.pronunciationDictId }]);
    }
    assertCartesiaOptions(this.#generationConfig, this.#maxBufferDelayMs);
    if (
      options.pronunciationDictId !== undefined &&
      !this.supportsTtsPronunciationDictionaries([{ id: options.pronunciationDictId }], {
        model: this.#modelId,
      })
    ) {
      throw cartesiaInvalidTextControl(
        "Cartesia pronunciation dictionaries require one valid ID and a Sonic 3 model",
      );
    }
    this.#assertEffectiveSpeed(
      this.#generationConfig?.speed,
      this.#modelId,
      this.#voiceId,
      this.#speechControlCatalog,
    );
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) =>
        new WebSocket(url, {
          headers,
          maxPayload: MAX_PROVIDER_FRAME_BYTES,
        }));
  }

  get configuredModel(): string {
    return this.#modelId;
  }

  get configuredModelSource(): "configured" | "not_reported" {
    return this.#configuredModelSource;
  }

  get allowUnknownModel(): boolean {
    return this.#allowUnknownModel;
  }

  get configuredVoice(): string {
    return this.#voiceId;
  }

  supportsVoice(voice: string): boolean {
    if (typeof voice !== "string" || voice.trim().length === 0) return false;
    if (voice === this.#voiceId) return true;
    return this.#catalogSupportsVoice(voice, this.#modelId, this.#speechControlCatalog);
  }

  get configuredLanguage(): string {
    return this.#locale ?? this.#language;
  }

  get languageWasExplicitlyConfigured(): boolean {
    return this.#languageWasExplicitlyConfigured;
  }

  supportsTtsLanguage(language: string, model = this.#modelId): boolean {
    return cartesiaTtsLanguageSupported(language, model, this.#locale);
  }

  supportsTtsSpeed(speed: number, model = this.#modelId, voice = this.#voiceId): boolean {
    return this.#supportsTtsSpeed(speed, model, voice, this.#speechControlCatalog);
  }

  supportsTtsSelection(selection: TtsProviderSelection): boolean {
    const model = selection.model ?? this.#modelId;
    const voice = selection.voice ?? this.#voiceId;
    if (
      !PROVIDER_CATALOG.cartesia.models.some((supportedModel) => supportedModel === model) &&
      !this.#allowUnknownModel
    ) {
      return false;
    }
    const catalog = selection.speechControlCatalog ?? this.#speechControlCatalog;
    if (voice !== this.#voiceId && !this.#catalogSupportsVoice(voice, model, catalog)) {
      return false;
    }
    if (
      selection.language !== undefined &&
      !cartesiaTtsLanguageSupported(selection.language, model, this.#locale)
    ) {
      return false;
    }
    const textControls = this.#effectiveTextControls(selection);
    if (
      textControls.textNormalization !== undefined &&
      !this.supportsTtsTextNormalization(textControls.textNormalization, { model, voice })
    ) {
      return false;
    }
    if (
      textControls.pronunciationDictionaries !== undefined &&
      !this.supportsTtsPronunciationDictionaries(textControls.pronunciationDictionaries, {
        model,
        voice,
      })
    ) {
      return false;
    }
    const speed = selection.speed ?? this.#generationConfig?.speed;
    if (speed === undefined) return true;
    return this.#supportsTtsSpeed(speed, model, voice, catalog);
  }

  supportsTtsTextOperations(
    operations: readonly TtsTextOperation[],
    selection: TtsProviderSelection,
  ): boolean {
    return cartesiaSupportsTtsTextOperations(selection.model ?? this.#modelId, operations);
  }

  supportsTtsTextNormalization(
    normalization: TtsTextNormalization,
    selection: TtsProviderSelection,
  ): boolean {
    return cartesiaSupportsTextNormalization(normalization, selection.model ?? this.#modelId);
  }

  supportsTtsPronunciationDictionaries(
    dictionaries: readonly TtsPronunciationDictionaryReference[],
    selection: TtsProviderSelection,
  ): boolean {
    return cartesiaSupportsPronunciationDictionaries(
      dictionaries,
      selection.model ?? this.#modelId,
    );
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertCartesiaFormat(request.format);
    assertCartesiaSpeed(request.speed);
    this.#assertRequestVoice(request);
    this.#assertRequestSpeed(request);
    this.#assertRequestTextControls(request);
    if (request.language !== undefined) {
      cartesiaRequestLanguage(request.language, request.model ?? this.#modelId, this.#locale);
    }
    assertSupportedModel(
      PROVIDER_NAMES.cartesia,
      PROVIDER_CATALOG.cartesia.models,
      request.model ?? this.#modelId,
      this.#allowUnknownModel,
    );
    if (request.textParts !== undefined) {
      assertCartesiaSynthesisText(request.text, request.textParts, request.model ?? this.#modelId);
    } else {
      assertCartesiaPlainText(request.text);
    }
    const socket = await this.#connect(request.signal);
    return this.#createStream(socket, request);
  }

  async openSession(request: TtsSessionOpenRequest): Promise<TtsSession> {
    assertCartesiaFormat(request.format);
    assertCartesiaSpeed(request.speed);
    this.#assertRequestVoice(request);
    this.#assertRequestSpeed(request);
    this.#assertRequestTextControls(request);
    if (request.language !== undefined) {
      cartesiaRequestLanguage(request.language, request.model ?? this.#modelId, this.#locale);
    }
    assertSupportedModel(
      PROVIDER_NAMES.cartesia,
      PROVIDER_CATALOG.cartesia.models,
      request.model ?? this.#modelId,
      this.#allowUnknownModel,
    );
    const socket = await this.#connect(request.signal);
    return this.#createStream(socket, request);
  }

  #assertRequestSpeed(request: TtsSessionOpenRequest): void {
    const speed = request.speed ?? this.#generationConfig?.speed;
    if (speed === undefined) return;
    const model = request.model ?? this.#modelId;
    const voice = request.voice ?? this.#voiceId;
    this.#assertEffectiveSpeed(
      speed,
      model,
      voice,
      request.speechControlCatalog ?? this.#speechControlCatalog,
    );
  }

  #assertRequestVoice(request: TtsSessionOpenRequest): void {
    const voice = request.voice ?? this.#voiceId;
    const catalog = request.speechControlCatalog ?? this.#speechControlCatalog;
    if (catalog && hasSpeechControlCatalogFact(catalog, this.name, "tts.voice")) {
      if (!this.#catalogSupportsVoice(voice, request.model ?? this.#modelId, catalog)) {
        throw TvicThrowableError.from(
          validationError(
            TVIC_ERROR_CODES.providerInvalidRequest,
            "Cartesia request voice is not supported by the supplied account catalog snapshot",
            { provider: this.name, metadata: { model: request.model ?? this.#modelId } },
          ),
        );
      }
      return;
    }
    if (voice !== this.#voiceId) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          "Cartesia request voice requires an account catalog snapshot",
          { provider: this.name, metadata: { model: request.model ?? this.#modelId } },
        ),
      );
    }
  }

  #assertRequestTextControls(request: TtsSessionOpenRequest): void {
    const model = request.model ?? this.#modelId;
    const voice = request.voice ?? this.#voiceId;
    const selection = {
      model,
      voice,
      ...(request.language !== undefined ? { language: request.language } : {}),
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      ...this.#effectiveTextControls(request),
    };
    if (selection.textNormalization !== undefined) {
      let normalization: TtsTextNormalization;
      try {
        normalization = validateTtsTextNormalization(selection.textNormalization);
      } catch {
        throw cartesiaInvalidTextControl("Cartesia TTS text normalization is invalid");
      }
      if (!this.supportsTtsTextNormalization(normalization, selection)) {
        throw cartesiaInvalidTextControl(
          "Cartesia does not support the requested text normalization for this model",
        );
      }
    }
    if (selection.pronunciationDictionaries !== undefined) {
      let dictionaries: readonly TtsPronunciationDictionaryReference[];
      try {
        dictionaries = validateTtsPronunciationDictionaries(selection.pronunciationDictionaries);
      } catch {
        throw cartesiaInvalidTextControl("Cartesia TTS pronunciation dictionaries are invalid");
      }
      if (!this.supportsTtsPronunciationDictionaries(dictionaries, selection)) {
        throw cartesiaInvalidTextControl(
          "Cartesia supports one provider-managed pronunciation dictionary on Sonic 3 models",
        );
      }
    }
  }

  #effectiveTextControls(
    selection: Pick<TtsProviderSelection, "textNormalization" | "pronunciationDictionaries">,
  ): Pick<TtsProviderSelection, "textNormalization" | "pronunciationDictionaries"> {
    const textNormalization =
      selection.textNormalization ??
      (this.#normalization === undefined
        ? undefined
        : this.#normalization === "auto" || this.#normalization === "off"
          ? this.#normalization
          : { mode: "locale" as const, locale: this.#normalization });
    const pronunciationDictionaries =
      selection.pronunciationDictionaries ??
      (this.#pronunciationDictId === undefined ? undefined : [{ id: this.#pronunciationDictId }]);
    return {
      ...(textNormalization !== undefined ? { textNormalization } : {}),
      ...(pronunciationDictionaries !== undefined ? { pronunciationDictionaries } : {}),
    };
  }

  #assertEffectiveSpeed(
    speed: number | undefined,
    model: string,
    voice: string,
    catalog?: SpeechControlCatalogSnapshot,
  ): void {
    if (speed !== undefined && !this.#supportsTtsSpeed(speed, model, voice, catalog)) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          "Cartesia request speed requires a valid non-Professional Voice Clone catalog fact and a supported model",
          { provider: PROVIDER_NAMES.cartesia, metadata: { model, voice, speed } },
        ),
      );
    }
  }

  #supportsTtsSpeed(
    speed: number,
    model: string,
    voice: string,
    catalog?: SpeechControlCatalogSnapshot,
  ): boolean {
    if (
      !Number.isFinite(speed) ||
      !PROVIDER_CATALOG.cartesia.models.some((supportedModel) => supportedModel === model)
    ) {
      return false;
    }
    if (!catalog) return false;
    const result = querySpeechControlCatalog(catalog, {
      provider: this.name,
      control: "tts.speed",
      model,
      voice,
    });
    if (result.status !== "supported") return false;
    if (
      result.fact.limits?.requiresAccountVoiceFact === true &&
      result.fact.scope.type !== "account"
    ) {
      return false;
    }
    const minimum = result.fact.limits?.min;
    const maximum = result.fact.limits?.max;
    return (
      typeof minimum === "number" &&
      typeof maximum === "number" &&
      speed >= minimum &&
      speed <= maximum
    );
  }

  #catalogSupportsVoice(
    voice: string,
    model: string,
    catalog?: SpeechControlCatalogSnapshot,
  ): boolean {
    if (!catalog) return false;
    return (
      querySpeechControlCatalog(catalog, {
        provider: this.name,
        control: "tts.voice",
        model,
        voice,
      }).status === "supported"
    );
  }

  async #connect(signal?: AbortSignal): Promise<WebSocket> {
    let socket: WebSocket | undefined;
    try {
      socket = this.#webSocketFactory(this.#url, {
        "X-API-Key": this.#apiKey,
        "Cartesia-Version": PROVIDER_API_VERSIONS.cartesia,
      });
      await openWebSocket(socket, signal ? { signal } : {});
      return socket;
    } catch (error) {
      if (socket) safeClose(socket);
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.cartesiaTts,
          provider: PROVIDER_NAMES.cartesia,
        }),
      );
    }
  }

  #streamOptions(request: TtsSessionOpenRequest): CartesiaStreamOptions {
    const modelId = request.model ?? this.#modelId;
    const voiceId = request.voice ?? this.#voiceId;
    const language =
      request.language === undefined
        ? cartesiaTtsLanguageSupported(this.#locale ?? this.#language, modelId, this.#locale)
          ? cartesiaRequestLanguage(this.#locale ?? this.#language, modelId, this.#locale)
          : {
              language: this.#language,
              ...(this.#locale !== undefined ? { locale: this.#locale } : {}),
            }
        : cartesiaRequestLanguage(request.language, modelId, this.#locale);
    const pronunciationDictId =
      request.pronunciationDictionaries === undefined
        ? this.#pronunciationDictId
        : request.pronunciationDictionaries[0]?.id;
    return {
      voiceId,
      modelId,
      ...language,
      ...(this.#accent !== undefined ? { accent: this.#accent } : {}),
      ...(request.textNormalization !== undefined
        ? { normalization: cartesiaTextNormalizationValue(request.textNormalization) }
        : this.#normalization !== undefined
          ? { normalization: this.#normalization }
          : {}),
      ...(this.#generationConfig !== undefined ? { generationConfig: this.#generationConfig } : {}),
      ...(pronunciationDictId !== undefined ? { pronunciationDictId } : {}),
      maxBufferDelayMs: this.#maxBufferDelayMs,
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      clock: this.#clock,
      timestamps: request.timestamps ?? false,
      contextId: `${this.#contextIds.next()}_${safeContextComponent(this.#clock.now())}`,
    };
  }

  #createStream(
    socket: WebSocket,
    request: TtsSessionOpenRequest | TtsSynthesisRequest,
  ): CartesiaTtsStream {
    try {
      return new CartesiaTtsStream(socket, request, this.#streamOptions(request));
    } catch (error) {
      safeClose(socket);
      throw TvicThrowableError.from(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.cartesiaTts,
          provider: PROVIDER_NAMES.cartesia,
        }),
      );
    }
  }
}

function assertCartesiaFormat(format: AudioFormat): void {
  try {
    assertPcm16leFormat(format);
    if (format.sampleRateHz !== PCM16_16K_MONO.sampleRateHz) {
      throw new Error(
        `Cartesia adapter output requires ${PCM16_16K_MONO.sampleRateHz}Hz audio, received ${format.sampleRateHz}Hz`,
      );
    }
  } catch (error) {
    throw TvicThrowableError.from(
      validationError("cartesia.audio_format_invalid", unknownErrorMessage(error), {
        provider: PROVIDER_NAMES.cartesia,
        metadata: { format },
      }),
    );
  }
}

function cartesiaInvalidTextControl(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.cartesia,
    }),
  );
}

function cartesiaConfiguredTextNormalization(value: string): string {
  if (value === "auto" || value === "off") return value;
  if (value === "on") {
    throw cartesiaInvalidTextControl('Cartesia normalization accepts "auto", "off", or a locale');
  }
  try {
    const normalization = validateTtsTextNormalization({ mode: "locale", locale: value });
    return cartesiaTextNormalizationValue(normalization);
  } catch {
    throw cartesiaInvalidTextControl("Cartesia normalization locale must be a valid BCP-47 tag");
  }
}

function assertCartesiaSynthesisText(
  text: string,
  parts: readonly TtsTextPart[],
  model: string,
): void {
  let plainText: string;
  try {
    plainText = ttsTextPartsToPlainText(parts);
  } catch {
    throw cartesiaTextOperationError("Cartesia text parts are invalid or exceed supported limits");
  }
  if (plainText !== text) {
    throw cartesiaTextOperationError("Cartesia text parts must preserve the request's plain text");
  }
  if (
    parts.some((part) => part.type === "spell" || part.type === "pause") &&
    !cartesiaSupportsTypedParts(model)
  ) {
    throw cartesiaTextOperationError("Cartesia typed text controls require a Sonic-3 model");
  }
  try {
    serializeCartesiaTtsText(parts);
  } catch {
    throw cartesiaTextOperationError("Cartesia typed text parts are invalid or unsupported");
  }
}

function cartesiaTextOperationError(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(TVIC_ERROR_CODES.providerInvalidRequest, message, {
      provider: PROVIDER_NAMES.cartesia,
    }),
  );
}

function safeContextComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

interface CartesiaStreamOptions {
  readonly voiceId: string;
  readonly modelId: string;
  readonly language: string;
  readonly locale?: string;
  readonly accent?: string;
  readonly normalization?: string;
  readonly generationConfig?: CartesiaGenerationConfig;
  readonly pronunciationDictId?: string;
  readonly maxBufferDelayMs?: number;
  readonly speed?: number;
  readonly clock: ProviderClock;
  readonly timestamps: boolean;
  readonly contextId: string;
}

interface FlushWaiter {
  readonly id: number;
  readonly resolve: (result: TtsFlushResult) => void;
  readonly reject: (error: unknown) => void;
}

export class CartesiaTtsStream implements TtsSession {
  readonly events: AsyncIterable<TtsEvent>;
  readonly #socket: WebSocket;
  readonly #request: TtsSessionOpenRequest;
  readonly #options: CartesiaStreamOptions;
  readonly #events = new AsyncQueue<TtsEvent>({
    onOverflow: () => {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.cartesia);
      this.#fail(error);
      return error;
    },
  });
  readonly #contextId: string;
  readonly #mediaEventIds: CounterIdGenerator<MediaEventId>;
  readonly #chunkIds: MediaEventId[] = [];
  readonly #chunkSequences: number[] = [];
  readonly #flushWaiters: FlushWaiter[] = [];
  #mediaSequence = 1;
  #controlSequence = 1;
  #nextFlushId = 0;
  #expectedFlushId = 0;
  #providerFlushBase: number | undefined;
  #frameCount = 0;
  #outputBytes = 0;
  #inputUtf16CodeUnits = 0;
  #inputUtf8Bytes = 0;
  #closed = false;
  #done = false;
  #cancelled = false;
  #finishing = false;

  constructor(
    socket: WebSocket,
    request: TtsSessionOpenRequest | TtsSynthesisRequest,
    options: CartesiaStreamOptions,
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#options = options;
    this.#contextId = options.contextId;
    this.#mediaEventIds = counterIdGenerator<MediaEventId>(`${this.#contextId}_media`);
    this.events = this.#events;

    socket.on("message", (data) => {
      if (this.#closed) {
        return;
      }
      if (rawDataByteLength(data) > MAX_PROVIDER_FRAME_BYTES) {
        this.#fail(this.#lifecycleError("Cartesia frame exceeded the size limit"));
        return;
      }
      this.#handleMessage(rawDataToBuffer(data).toString("utf8"));
    });
    socket.on("close", () => {
      if (this.#closed) {
        return;
      }
      if (this.#done || this.#cancelled) {
        this.#closeQueue();
        return;
      }
      this.#fail(this.#lifecycleError("Cartesia socket closed before generation completed"));
    });
    socket.on("error", (error) => {
      const normalized = normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.cartesiaTts,
        provider: PROVIDER_NAMES.cartesia,
      });
      this.#fail(this.#markOutcomeUnknown(normalized));
    });

    if ("text" in request) {
      const text =
        request.textParts === undefined
          ? serializeCartesiaPlainText(request.text)
          : serializeCartesiaTtsText(request.textParts);
      this.#sendTranscript(text, this.#generationRequest(text, false));
      this.#finishing = true;
    }
  }

  async sendText(text: string): Promise<void> {
    this.#assertWritable();
    if (text.length === 0) {
      return;
    }
    let serialized: string;
    try {
      serialized = serializeCartesiaPlainText(text);
    } catch {
      throw cartesiaTextOperationError("Cartesia text must be a control-free string");
    }
    this.#sendTranscript(serialized, this.#generationRequest(serialized, true));
  }

  async sendTextParts(parts: readonly TtsTextPart[]): Promise<void> {
    this.#assertWritable();
    if (
      parts.some((part) => part.type === "spell" || part.type === "pause") &&
      !cartesiaSupportsTypedParts(this.#options.modelId)
    ) {
      throw cartesiaTextOperationError("Cartesia typed text controls require a Sonic-3 model");
    }
    let serialized: string;
    try {
      serialized = serializeCartesiaTtsText(parts);
    } catch {
      throw cartesiaTextOperationError("Cartesia typed text parts are invalid or unsupported");
    }
    if (serialized.length === 0) return;
    this.#sendTranscript(serialized, this.#generationRequest(serialized, true));
  }

  async flush(): Promise<TtsFlushResult> {
    this.#assertWritable();
    if (this.#flushWaiters.length >= MAX_PROVIDER_TTS_PENDING_FLUSHES) {
      const error = providerEventQueueOverflow(PROVIDER_NAMES.cartesia);
      this.#fail(error);
      return Promise.reject(error);
    }
    return new Promise<TtsFlushResult>((resolve, reject) => {
      const waiter = { id: this.#nextFlushId, resolve, reject };
      this.#nextFlushId += 1;
      this.#flushWaiters.push(waiter);
      try {
        this.#send(this.#generationRequest("", true, true));
      } catch (error) {
        const index = this.#flushWaiters.indexOf(waiter);
        if (index >= 0) {
          this.#flushWaiters.splice(index, 1);
        }
        reject(error);
      }
    });
  }

  async finish(): Promise<void> {
    if (this.#finishing || this.#closed) {
      return;
    }
    this.#assertWritable();
    this.#finishing = true;
    this.#send(this.#generationRequest("", false));
  }

  async cancel(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#cancelled = true;
    safeSend(this.#socket, JSON.stringify({ context_id: this.#contextId, cancel: true }));
    this.#closeQueue(this.#lifecycleError("Cartesia synthesis context was cancelled"));
    safeClose(this.#socket);
  }

  #handleMessage(body: string): void {
    const message = parseJsonObject(body) as CartesiaMessage | null;
    if (!message) {
      this.#fail(this.#lifecycleError("Cartesia returned malformed JSON"));
      return;
    }

    if (message.type === "error") {
      const error = cartesiaProviderError(message);
      const outcomeUnknown =
        this.#inputUtf8Bytes > 0 &&
        error.retriable &&
        error.code !== TVIC_ERROR_CODES.providerRateLimited;
      this.#fail(
        outcomeUnknown
          ? {
              ...error,
              retriable: false,
              metadata: { ...(error.metadata ?? {}), outcomeUnknown: true },
            }
          : error,
      );
      return;
    }

    const hasContextualResponse =
      message.type === "chunk" ||
      message.type === "flush_done" ||
      message.type === "timestamps" ||
      message.type === "phoneme_timestamps" ||
      message.type === "done" ||
      message.done === true;
    if (hasContextualResponse && message.context_id !== this.#contextId) {
      this.#fail(this.#lifecycleError("Cartesia response context does not match the stream"));
      return;
    }

    if (message.type === "chunk") {
      if (typeof message.data !== "string") {
        this.#fail(this.#lifecycleError("Cartesia returned a chunk without audio data"));
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = decodeCartesiaAudio(message.data);
      } catch {
        this.#fail(this.#lifecycleError("Cartesia returned malformed PCM audio"));
        return;
      }
      if (
        this.#chunkIds.length >= MAX_PROVIDER_TTS_OUTPUT_CHUNKS ||
        this.#outputBytes + bytes.byteLength > MAX_PROVIDER_TTS_OUTPUT_BYTES
      ) {
        this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.cartesia));
        return;
      }
      const eventId = this.#mediaEventId("chunk");
      const frames = frameCountForPcm16le(bytes);
      const sequence = this.#mediaSequence;
      const event = createMediaEvent({
        id: eventId,
        type: "media.audio.chunk",
        sessionId: this.#request.sessionId,
        turnId: this.#request.turnId,
        sequence,
        direction: "output",
        timestamp: this.#options.clock.now(),
        monotonicOffsetMs: 0,
        provider: PROVIDER_NAMES.cartesia,
        audio: {
          format: this.#request.format,
          durationMs: durationMsForPcm16le(bytes, this.#request.format.sampleRateHz),
          frameCount: frames,
          bytes,
        },
        metadata: {
          contextId: message.context_id,
          ...(typeof message.flush_id === "number" ? { flushId: message.flush_id } : {}),
        },
      });
      if (!this.#pushEvent(event)) return;
      this.#frameCount += frames;
      this.#outputBytes += bytes.byteLength;
      this.#chunkIds.push(eventId);
      this.#chunkSequences.push(sequence);
      this.#mediaSequence += 1;
      return;
    }

    if (message.type === "flush_done") {
      if (!isValidFlushId(message.flush_id)) {
        this.#fail(this.#lifecycleError("Cartesia returned an invalid flush acknowledgement"));
        return;
      }
      const flushId = message.flush_id;
      const waiter = this.#flushWaiters[0];
      if (this.#providerFlushBase === undefined) {
        if (flushId !== 0 && flushId !== 1) {
          this.#fail(
            this.#lifecycleError("Cartesia returned an uncorrelated flush acknowledgement"),
          );
          return;
        }
        this.#providerFlushBase = flushId;
      }
      const expectedProviderFlushId = this.#providerFlushBase + this.#expectedFlushId;
      if (flushId !== expectedProviderFlushId) {
        this.#fail(this.#lifecycleError("Cartesia returned an uncorrelated flush acknowledgement"));
        return;
      }
      if (!waiter) {
        if (flushId === expectedProviderFlushId) {
          this.#expectedFlushId += 1;
          return;
        }
        this.#fail(this.#lifecycleError("Cartesia returned an uncorrelated flush acknowledgement"));
        return;
      }
      if (
        !this.#pushEvent({
          type: "tts.flush.completed",
          sessionId: this.#request.sessionId,
          turnId: this.#request.turnId,
          sequence: this.#controlSequence,
          provider: PROVIDER_NAMES.cartesia,
          timestamp: this.#options.clock.now(),
          flushId,
          acknowledgedBy: "provider",
        })
      ) {
        return;
      }
      this.#controlSequence += 1;
      this.#expectedFlushId += 1;
      this.#flushWaiters.shift();
      waiter.resolve({ id: flushId, acknowledgedBy: "provider" });
      return;
    }

    const alignment =
      message.type === "timestamps"
        ? parseAlignment(message.word_timestamps, "words")
        : message.type === "phoneme_timestamps"
          ? parseAlignment(message.phoneme_timestamps, "phonemes")
          : null;
    if (alignment) {
      if (
        !this.#pushEvent({
          type: "tts.alignment",
          sessionId: this.#request.sessionId,
          turnId: this.#request.turnId,
          sequence: this.#controlSequence,
          provider: PROVIDER_NAMES.cartesia,
          timestamp: this.#options.clock.now(),
          unit: message.type === "timestamps" ? "word" : "phoneme",
          tokens: alignment.tokens,
          startMs: alignment.startMs,
          endMs: alignment.endMs,
          ...(typeof message.flush_id === "number" ? { flushId: message.flush_id } : {}),
        })
      ) {
        return;
      }
      this.#controlSequence += 1;
      return;
    }

    if (message.type === "timestamps" || message.type === "phoneme_timestamps") {
      this.#fail(this.#lifecycleError(`Cartesia returned malformed ${message.type} data`));
      return;
    }

    if (message.type === "done" || message.done === true) {
      if (this.#flushWaiters.length > 0) {
        this.#fail(this.#lifecycleError("Cartesia completed before acknowledging every flush"));
        return;
      }
      if (!this.#pushEvent(this.#committedEvent())) return;
      this.#done = true;
      this.#closeQueue();
      safeClose(this.#socket);
      return;
    }

    this.#fail(this.#lifecycleError("Cartesia returned an unexpected message type"));
  }

  #generationRequest(
    transcript: string,
    continuation: boolean,
    flush = false,
  ): Readonly<Record<string, unknown>> {
    return {
      model_id: this.#options.modelId,
      transcript,
      voice: this.#options.voiceId,
      ...(this.#options.locale !== undefined
        ? { locale: this.#options.locale }
        : { language: this.#options.language }),
      context_id: this.#contextId,
      output_format: {
        container: "raw",
        encoding: this.#request.format.encoding,
        sample_rate: this.#request.format.sampleRateHz,
      },
      add_timestamps: this.#options.timestamps,
      continue: continuation,
      ...(this.#options.accent ? { accent: this.#options.accent } : {}),
      ...(this.#options.normalization ? { normalization: this.#options.normalization } : {}),
      ...(this.#options.pronunciationDictId
        ? { pronunciation_dict_id: this.#options.pronunciationDictId }
        : {}),
      ...cartesiaGenerationConfig(this.#options.generationConfig, this.#options.speed),
      max_buffer_delay_ms: this.#options.maxBufferDelayMs ?? 0,
      ...(flush ? { flush: true } : {}),
    };
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    if (!safeSend(this.#socket, JSON.stringify(message))) {
      const error = this.#markOutcomeUnknown(
        providerError(
          TVIC_ERROR_CODES.providerTransportWriteFailed,
          "Cartesia socket is not writable",
          {
            provider: PROVIDER_NAMES.cartesia,
            retriable: false,
            metadata: { operation: "send" },
          },
        ),
      );
      this.#fail(error);
      throw error;
    }
  }

  #sendTranscript(text: string, message: Readonly<Record<string, unknown>>): void {
    const utf16CodeUnits = text.length;
    const utf8Bytes = Buffer.byteLength(text, "utf8");
    if (
      this.#inputUtf16CodeUnits + utf16CodeUnits > MAX_CARTESIA_INPUT_UTF16_CODE_UNITS ||
      this.#inputUtf8Bytes + utf8Bytes > MAX_CARTESIA_INPUT_UTF8_BYTES
    ) {
      const error = TvicThrowableError.from(
        providerError(
          TVIC_ERROR_CODES.providerInputRejected,
          "Cartesia cumulative transcript input exceeded its bounded session limit",
          {
            provider: PROVIDER_NAMES.cartesia,
            retriable: false,
            metadata: {
              maxUtf16CodeUnits: MAX_CARTESIA_INPUT_UTF16_CODE_UNITS,
              maxUtf8Bytes: MAX_CARTESIA_INPUT_UTF8_BYTES,
            },
          },
        ),
      );
      this.#fail(error);
      throw error;
    }
    this.#send(message);
    this.#inputUtf16CodeUnits += utf16CodeUnits;
    this.#inputUtf8Bytes += utf8Bytes;
    this.#request.usageReporter?.reportTextCharacters(countUnicodeCodePoints(text));
  }

  #assertWritable(): void {
    if (this.#closed) {
      throw this.#lifecycleError("Cartesia synthesis context is closed");
    }
    if (this.#finishing) {
      throw this.#lifecycleError("Cartesia synthesis context is already finishing");
    }
  }

  #committedEvent(): MediaAudioCommittedEvent {
    return createMediaEvent({
      id: this.#mediaEventId("committed"),
      type: "media.audio.committed",
      sessionId: this.#request.sessionId,
      turnId: this.#request.turnId,
      sequence: this.#mediaSequence,
      direction: "output",
      timestamp: this.#options.clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.cartesia,
      durationMs: (this.#frameCount / this.#request.format.sampleRateHz) * 1000,
      frameCount: this.#frameCount,
      sequenceRange: [this.#chunkSequences[0] ?? 0, this.#chunkSequences.at(-1) ?? 0],
      chunkIds: this.#chunkIds,
      metadata: {
        contextId: this.#contextId,
      },
    });
  }

  #mediaEventId(kind: string): MediaEventId {
    return `${this.#mediaEventIds.next()}_${kind}_${this.#options.clock.now()}` as MediaEventId;
  }

  #closeQueue(
    flushError = this.#lifecycleError(
      "Cartesia synthesis context closed before flush acknowledgement",
    ),
  ): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(flushError, {
      code: PROVIDER_ERROR_CODES.cartesiaTts,
      provider: PROVIDER_NAMES.cartesia,
    });
    this.#closed = true;
    this.#rejectFlushes(throwable);
    this.#events.close();
  }

  #fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    const throwable = providerThrowableError(error, {
      code: PROVIDER_ERROR_CODES.cartesiaTts,
      provider: PROVIDER_NAMES.cartesia,
    });
    this.#closed = true;
    this.#rejectFlushes(throwable);
    this.#events.fail(throwable);
    safeClose(this.#socket);
  }

  #pushEvent(event: TtsEvent): boolean {
    if (this.#events.push(event)) return true;
    this.#fail(providerEventQueueOverflow(PROVIDER_NAMES.cartesia));
    return false;
  }

  #rejectFlushes(error: unknown): void {
    for (const waiter of this.#flushWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  #lifecycleError(message: string): TvicThrowableError {
    return TvicThrowableError.from(
      this.#markOutcomeUnknown(
        providerError(PROVIDER_ERROR_CODES.cartesiaTts, message, {
          provider: PROVIDER_NAMES.cartesia,
          retriable: false,
        }),
      ),
    );
  }

  #markOutcomeUnknown(error: unknown): unknown {
    if (this.#inputUtf8Bytes === 0) return error;
    const normalized = TvicThrowableError.from(error).error;
    return {
      ...normalized,
      retriable: false,
      metadata: { ...(normalized.metadata ?? {}), outcomeUnknown: true },
    };
  }
}

export function createCartesiaTtsProvider(
  options: CartesiaTtsProviderOptions,
): CartesiaTtsProvider {
  return new CartesiaTtsProvider(options);
}
