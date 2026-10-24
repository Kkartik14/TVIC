import { PCM16_16K_MONO, PROVIDER_NAMES, TvicThrowableError, validationError } from "@tvic/core";
import type {
  ProviderCapabilities,
  TextToSpeechProvider,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import {
  assertNoUnsupportedTtsTextParts,
  SystemProviderClock,
  type ProviderClock,
} from "./common.js";
import {
  assertVoice,
  buildUrl,
  dialogueBody,
  elevenLabsHttpResponseError,
  elevenLabsHttpTransportError,
  elevenLabsOutcomeUnknownError,
  endpointUrl,
  linkAbortSignal,
  normalizeElevenLabsHttpError,
  readRawAudioResponse,
  readTimestampedResponse,
  resolveModel,
  speechBody,
  toSingleDialogueRequest,
  validateDialogueRequest,
  validateSpeechRequest,
  elevenLabsProtocolError,
} from "./elevenlabs-http-helpers.js";
import { ElevenLabsCompletedStream, ElevenLabsHttpStream } from "./elevenlabs-http-stream.js";
import {
  supportsElevenLabsTtsLanguage,
  supportsElevenLabsTtsSpeed,
  assertElevenLabsSsmlParsingDisabled,
  type ElevenLabsTtsProviderOptions,
} from "./elevenlabs-options.js";

export { ELEVENLABS_TTS_CHARACTER_LIMITS } from "./elevenlabs-options.js";

export const ELEVENLABS_TTS_PCM_OUTPUT_FORMAT = "pcm_16000" as const;

const ELEVENLABS_REST_TTS_MODELS = PROVIDER_CATALOG.elevenlabs.models.filter(
  (model) => model !== "eleven_v4_turbo",
);
const ELEVENLABS_HTTP_STREAM_TTS_MODELS = ELEVENLABS_REST_TTS_MODELS.filter(
  (model) => model !== "eleven_v4",
);

export const ELEVENLABS_DIALOGUE_MAX_CHARACTERS = 2_000;
export const ELEVENLABS_DIALOGUE_MAX_VOICES = 10;

export type ElevenLabsOutputRequest = Pick<TtsSynthesisRequest, "sessionId" | "turnId" | "format">;

const ELEVENLABS_TTS_REST_CAPABILITIES = {
  streaming: { input: false, output: false, native: false },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  models: ELEVENLABS_REST_TTS_MODELS,
  metadata: {
    transport: "rest",
    endpoints: [
      "/v1/text-to-speech/:voice_id",
      "/v1/text-to-speech/:voice_id/with-timestamps",
      "/v1/text-to-dialogue",
      "/v1/text-to-dialogue/with-timestamps",
    ],
    wireOutputFormat: ELEVENLABS_TTS_PCM_OUTPUT_FORMAT,
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation: "https://elevenlabs.io/docs/api-reference/streaming",
  },
} satisfies ProviderCapabilities;

const ELEVENLABS_TTS_HTTP_STREAM_CAPABILITIES = {
  streaming: { input: false, output: true, native: true },
  cancellation: { request: true, output: true, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  models: ELEVENLABS_HTTP_STREAM_TTS_MODELS,
  metadata: {
    transport: "http-stream",
    endpoints: [
      "/v1/text-to-speech/:voice_id/stream",
      "/v1/text-to-speech/:voice_id/stream/with-timestamps",
      "/v1/text-to-dialogue/stream",
      "/v1/text-to-dialogue/stream/with-timestamps",
    ],
    wireOutputFormat: ELEVENLABS_TTS_PCM_OUTPUT_FORMAT,
    normalizedOutput: "pcm_s16le/16000/mono",
    documentation: "https://elevenlabs.io/docs/api-reference/streaming",
  },
} satisfies ProviderCapabilities;

export interface ElevenLabsHttpTtsProviderOptions extends Omit<
  ElevenLabsTtsProviderOptions,
  "url" | "webSocketFactory"
> {
  readonly url?: string;
  readonly dialogueUrl?: string;
  readonly optimizeStreamingLatency?: 0 | 1 | 2 | 3 | 4;
  readonly applyLanguageTextNormalization?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export interface ElevenLabsTtsHttpSynthesisRequest extends TtsSynthesisRequest {
  readonly previousText?: string;
  readonly nextText?: string;
  readonly previousRequestIds?: readonly string[];
  readonly nextRequestIds?: readonly string[];
}

export interface ElevenLabsDialogueInput {
  readonly text: string;
  readonly voiceId: string;
}

export interface ElevenLabsDialogueSynthesisRequest extends Omit<
  TtsSynthesisRequest,
  "text" | "voice"
> {
  readonly inputs: readonly ElevenLabsDialogueInput[];
  readonly previousText?: string;
  readonly futureText?: string;
  readonly previousRequestIds?: readonly string[];
  readonly nextRequestIds?: readonly string[];
}

export interface ElevenLabsDialogueProvider extends TextToSpeechProvider {
  synthesizeDialogue(request: ElevenLabsDialogueSynthesisRequest): Promise<TtsStream>;
  synthesizeSpeech(request: ElevenLabsTtsHttpSynthesisRequest): Promise<TtsStream>;
}

export type HttpTransport = "rest" | "http-stream";

export class ElevenLabsTtsRestProvider implements ElevenLabsDialogueProvider {
  readonly name = PROVIDER_NAMES.elevenlabs;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities: ProviderCapabilities = ELEVENLABS_TTS_REST_CAPABILITIES;
  readonly requiresAccountVoiceCatalog = true;
  readonly accountVoiceCatalogProviders = [PROVIDER_NAMES.elevenlabs] as const;

  readonly #options: ElevenLabsHttpTtsProviderOptions;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;

  constructor(options: ElevenLabsHttpTtsProviderOptions) {
    assertElevenLabsSsmlParsingDisabled(options.enableSsmlParsing);
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get configuredModel(): string {
    return this.#modelId;
  }

  get configuredModelSource(): "configured" | "not_reported" {
    return this.#options.modelId === undefined ? "not_reported" : "configured";
  }

  get allowUnknownModel(): boolean {
    return this.#allowUnknownModel;
  }

  get configuredVoice(): string {
    return this.#options.voiceId;
  }

  supportsVoice(voice: string): boolean {
    try {
      return assertVoice(voice).trim().length > 0;
    } catch {
      return false;
    }
  }

  get configuredLanguage(): string | undefined {
    return this.#options.language;
  }

  supportsTtsLanguage(language: string, model = this.#modelId): boolean {
    return supportsElevenLabsTtsLanguage(language, model);
  }

  supportsTtsSpeed(speed: number, model = this.#modelId): boolean {
    return supportsElevenLabsTtsSpeed(speed, model);
  }

  get _httpOptions(): ElevenLabsHttpTtsProviderOptions {
    return this.#options;
  }

  get _httpModelId(): string {
    return this.#modelId;
  }

  get _httpAllowUnknownModel(): boolean {
    return this.#allowUnknownModel;
  }

  get _httpClock(): ProviderClock {
    return this.#clock;
  }

  get _httpFetch(): typeof fetch {
    return this.#fetch;
  }

  async synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    assertNoUnsupportedTtsTextParts(PROVIDER_NAMES.elevenlabs, request);
    const model = request.model ?? this.#modelId;
    const transport =
      this.capabilities.metadata?.transport === "http-stream" ? "http-stream" : "rest";
    assertElevenLabsHttpModelRoute(
      model,
      transport,
      model.startsWith("eleven_v3") || model === "eleven_v4" ? "dialogue" : "tts",
    );
    return model.startsWith("eleven_v3") || model === "eleven_v4"
      ? this.synthesizeDialogue(
          toSingleDialogueRequest(request, request.voice ?? this.#options.voiceId),
        )
      : this.synthesizeSpeech(request);
  }

  synthesizeSpeech(request: ElevenLabsTtsHttpSynthesisRequest): Promise<TtsStream> {
    return this.#synthesizeSpeech(request, "rest");
  }

  synthesizeDialogue(request: ElevenLabsDialogueSynthesisRequest): Promise<TtsStream> {
    return this.#synthesizeDialogue(request, "rest");
  }

  async #synthesizeSpeech(
    request: ElevenLabsTtsHttpSynthesisRequest,
    transport: HttpTransport,
  ): Promise<TtsStream> {
    const model = resolveModel(this.#modelId, request.model, this.#allowUnknownModel);
    assertElevenLabsHttpModelRoute(model, transport, "tts");
    const voice = assertVoice(request.voice ?? this.#options.voiceId);
    validateSpeechRequest(request, this.#options, model, voice);
    return this.#execute(request, transport, "tts", model, voice, () =>
      speechBody(request, this.#options, model),
    );
  }

  async #synthesizeDialogue(
    request: ElevenLabsDialogueSynthesisRequest,
    transport: HttpTransport,
  ): Promise<TtsStream> {
    const model = resolveModel(
      this.#modelId,
      request.model ?? "eleven_v3",
      this.#allowUnknownModel,
    );
    assertElevenLabsHttpModelRoute(model, transport, "dialogue");
    const primaryVoice = request.inputs[0]?.voiceId ?? this.#options.voiceId;
    validateDialogueRequest(request, this.#options, model, primaryVoice);
    return this.#execute(request, transport, "dialogue", model, primaryVoice, () =>
      dialogueBody(request, this.#options, model),
    );
  }

  async #execute(
    request: TtsSynthesisRequest | ElevenLabsDialogueSynthesisRequest,
    transport: HttpTransport,
    protocol: "tts" | "dialogue",
    model: string,
    voice: string,
    body: () => Readonly<Record<string, unknown>>,
  ): Promise<TtsStream> {
    return executeWithFetch(
      this.#fetch,
      this.#options,
      this.#clock,
      request,
      transport,
      protocol,
      model,
      voice,
      body(),
    );
  }
}

function assertElevenLabsHttpModelRoute(
  model: string,
  transport: HttpTransport,
  protocol: "tts" | "dialogue",
): void {
  const transportName = transport === "http-stream" ? "HTTP-stream" : "REST";
  if (model === "eleven_v4_turbo") {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        `ElevenLabs ${model} is not supported by the ${transportName} transport`,
      ),
    );
  }
  if (model === "eleven_v4" && (transport === "http-stream" || protocol === "tts")) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        `ElevenLabs ${model} is not supported by the ${transportName} transport on the ${protocol} route`,
      ),
    );
  }
}

export class ElevenLabsTtsHttpStreamProvider extends ElevenLabsTtsRestProvider {
  override readonly capabilities: ProviderCapabilities = ELEVENLABS_TTS_HTTP_STREAM_CAPABILITIES;

  override synthesizeSpeech(request: ElevenLabsTtsHttpSynthesisRequest): Promise<TtsStream> {
    return this.synthesizeSpeechStream(request);
  }

  override synthesizeDialogue(request: ElevenLabsDialogueSynthesisRequest): Promise<TtsStream> {
    return this.synthesizeDialogueStream(request);
  }

  private synthesizeSpeechStream(request: ElevenLabsTtsHttpSynthesisRequest): Promise<TtsStream> {
    return this.executeStreamSpeech(request);
  }

  private synthesizeDialogueStream(
    request: ElevenLabsDialogueSynthesisRequest,
  ): Promise<TtsStream> {
    return this.executeStreamDialogue(request);
  }

  private async executeStreamSpeech(
    request: ElevenLabsTtsHttpSynthesisRequest,
  ): Promise<TtsStream> {
    return this.executeViaProtectedPath(request, "tts");
  }

  private async executeStreamDialogue(
    request: ElevenLabsDialogueSynthesisRequest,
  ): Promise<TtsStream> {
    return this.executeViaProtectedPath(request, "dialogue");
  }

  private executeViaProtectedPath(
    request: TtsSynthesisRequest | ElevenLabsDialogueSynthesisRequest,
    _protocol: "tts" | "dialogue",
  ): Promise<TtsStream> {
    const model = resolveModel(this._httpModelId, request.model, this._httpAllowUnknownModel);
    assertElevenLabsHttpModelRoute(model, "http-stream", _protocol);
    return executeElevenLabsHttpRequest(this, request, _protocol, "http-stream");
  }
}

interface ElevenLabsHttpProviderInternals {
  readonly _httpOptions: ElevenLabsHttpTtsProviderOptions;
  readonly _httpModelId: string;
  readonly _httpAllowUnknownModel: boolean;
  readonly _httpClock: ProviderClock;
  readonly _httpFetch: typeof fetch;
}

async function executeElevenLabsHttpRequest(
  provider: ElevenLabsHttpProviderInternals,
  request: TtsSynthesisRequest | ElevenLabsDialogueSynthesisRequest,
  protocol: "tts" | "dialogue",
  transport: HttpTransport,
): Promise<TtsStream> {
  const options = provider._httpOptions;
  const model = resolveModel(
    provider._httpModelId,
    protocol === "dialogue" ? (request.model ?? "eleven_v3") : request.model,
    provider._httpAllowUnknownModel,
  );
  const voice =
    protocol === "tts"
      ? assertVoice((request as TtsSynthesisRequest).voice ?? options.voiceId)
      : assertVoice(
          (request as ElevenLabsDialogueSynthesisRequest).inputs[0]?.voiceId ?? options.voiceId,
        );
  const body =
    protocol === "tts"
      ? (() => {
          const speechRequest = request as ElevenLabsTtsHttpSynthesisRequest;
          validateSpeechRequest(speechRequest, options, model, voice);
          return speechBody(speechRequest, options, model);
        })()
      : (() => {
          const dialogueRequest = request as ElevenLabsDialogueSynthesisRequest;
          validateDialogueRequest(dialogueRequest, options, model, voice);
          return dialogueBody(dialogueRequest, options, model);
        })();
  return executeWithFetch(
    provider._httpFetch,
    options,
    provider._httpClock,
    request,
    transport,
    protocol,
    model,
    voice,
    body,
  );
}

async function executeWithFetch(
  fetchImpl: typeof fetch,
  options: ElevenLabsHttpTtsProviderOptions,
  clock: ProviderClock,
  request: TtsSynthesisRequest | ElevenLabsDialogueSynthesisRequest,
  transport: HttpTransport,
  protocol: "tts" | "dialogue",
  model: string,
  voice: string,
  body: Readonly<Record<string, unknown>>,
): Promise<TtsStream> {
  const characterCostUsage =
    protocol === "tts" && transport === "rest"
      ? request.usageReporter?.beginOperation({
          field: "providerCharacterCount",
          unit: "provider_defined",
          aggregation: "sum",
          model,
        })
      : undefined;
  let characterCostUsageFinished = false;
  const finishCharacterCostUsage = (response?: Response): void => {
    if (!characterCostUsage || characterCostUsageFinished) return;
    characterCostUsageFinished = true;
    if (!response?.ok) {
      characterCostUsage.notReported("absent");
      characterCostUsage.finish();
      return;
    }
    const header = response.headers.get("character-cost");
    if (header === null) {
      characterCostUsage.notReported("absent");
    } else {
      const value = parseCharacterCost(header);
      if (value === undefined) characterCostUsage.notReported("invalid");
      else characterCostUsage.report(value);
    }
    characterCostUsage.finish();
  };
  const controller = new AbortController();
  const detachAbort = linkAbortSignal(request.signal, controller);
  const timestamped = request.timestamps === true;
  const url = buildUrl(
    endpointUrl(options, protocol, transport, timestamped, voice),
    options,
    timestamped,
  );
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "xi-api-key": options.apiKey,
        "Content-Type": "application/json",
        Accept: timestamped ? "application/json" : "audio/pcm",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    finishCharacterCostUsage();
    detachAbort();
    throw elevenLabsHttpTransportError(error, request.signal, controller.signal);
  }
  try {
    if (!response.ok) {
      finishCharacterCostUsage(response);
      throw await elevenLabsHttpResponseError(response);
    }
    finishCharacterCostUsage(response);
    if (transport === "rest") {
      const data = timestamped
        ? await readTimestampedResponse(response)
        : { audio: await readRawAudioResponse(response) };
      detachAbort();
      return new ElevenLabsCompletedStream(request, {
        clock,
        model,
        protocol,
        voice,
        audio: data.audio,
        ...(data.alignment ? { alignment: data.alignment } : {}),
      });
    }
    if (!response.body) throw elevenLabsProtocolError("ElevenLabs HTTP stream returned no body");
    const stream = new ElevenLabsHttpStream(response.body, request, {
      clock,
      controller,
      detachAbort,
      model,
      protocol,
      voice,
      timestamped,
    });
    stream.start();
    return stream;
  } catch (error) {
    detachAbort();
    controller.abort();
    throw response.ok ? elevenLabsOutcomeUnknownError(error) : normalizeElevenLabsHttpError(error);
  }
}

function parseCharacterCost(header: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/u.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function createElevenLabsTtsRestProvider(
  options: ElevenLabsHttpTtsProviderOptions,
): ElevenLabsTtsRestProvider {
  return new ElevenLabsTtsRestProvider(options);
}

export function createElevenLabsTtsHttpStreamProvider(
  options: ElevenLabsHttpTtsProviderOptions,
): ElevenLabsTtsHttpStreamProvider {
  return new ElevenLabsTtsHttpStreamProvider(options);
}
