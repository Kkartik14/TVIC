import {
  countUnicodeCodePoints,
  evaluateTtsSelectionCompatibility,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type {
  ProviderCapabilities,
  ProviderCapabilitySnapshotVoice,
  ProviderCapabilityQuery,
  ProviderTtsVoiceCapabilityRequirement,
  TextToSpeechProvider,
  TtsProviderSelection,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { ELEVENLABS_CAPABILITY_FEATURES } from "./elevenlabs-capability-features.js";
import { SystemProviderClock, type ProviderClock } from "./common.js";
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
  resolveDialogueModel,
  speechBody,
  toSingleDialogueRequest,
  validateDialogueRequest,
  validateSpeechRequest,
  elevenLabsProtocolError,
} from "./elevenlabs-http-helpers.js";
import { ElevenLabsCompletedStream, ElevenLabsHttpStream } from "./elevenlabs-http-stream.js";
import {
  assertElevenLabsKnownVoiceIds,
  assertElevenLabsLanguageSetting,
  assertElevenLabsSsmlSetting,
  elevenLabsTtsSpeedRanges,
  elevenLabsWebSocketProtocol,
  isKnownElevenLabsVoiceId,
  requiredElevenLabsCapabilityQueries,
  resolveElevenLabsTtsLanguage,
  supportsElevenLabsConfiguredModelSelection,
  supportsElevenLabsTtsLanguage,
  supportsElevenLabsTtsSpeed,
  type ElevenLabsTtsProviderOptions,
} from "./elevenlabs-options.js";
import { validateTtsTextControls } from "./tts-text-controls.js";

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
  voiceSelection: "account_snapshot",
  modelSnapshotProviders: [PROVIDER_NAMES.elevenlabs],
  ttsSpeedRanges: elevenLabsTtsSpeedRanges(),
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
  voiceSelection: "account_snapshot",
  modelSnapshotProviders: [PROVIDER_NAMES.elevenlabs],
  ttsSpeedRanges: elevenLabsTtsSpeedRanges(),
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
  readonly usageAccounting = {
    reportsTextCharacters: true,
    usesRequestModelForUsage: true,
  } as const;
  readonly capabilities: ProviderCapabilities = ELEVENLABS_TTS_REST_CAPABILITIES;
  readonly providerCapabilitySnapshotVoices?: readonly ProviderCapabilitySnapshotVoice[];
  readonly requiredCapabilityQueries: readonly ProviderCapabilityQuery[] | undefined;
  readonly requiredCapabilityQueriesForModel: (
    model: string,
    voice?: string,
  ) => readonly ProviderCapabilityQuery[];
  readonly supportsConfiguredModelSelection: (model: string) => boolean;
  readonly requiredTtsVoiceCapabilities:
    | readonly ProviderTtsVoiceCapabilityRequirement[]
    | undefined;

  readonly #options: ElevenLabsHttpTtsProviderOptions;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;

  constructor(options: ElevenLabsHttpTtsProviderOptions) {
    assertElevenLabsKnownVoiceIds(options.knownVoiceIds);
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel;
    const protocol = elevenLabsWebSocketProtocol(this.#modelId);
    const dialogueVoices =
      protocol === "dialogue" ? (options.dialogueVoices ?? [options.voiceId]) : undefined;
    if (dialogueVoices !== undefined) {
      this.providerCapabilitySnapshotVoices = Object.freeze(
        dialogueVoices.map((voice) =>
          Object.freeze({ provider: PROVIDER_NAMES.elevenlabs, model: this.#modelId, voice }),
        ),
      );
    }
    assertElevenLabsSsmlSetting(options, protocol, "http");
    assertElevenLabsLanguageSetting(options, this.#modelId, protocol);
    this.requiredCapabilityQueries = requiredElevenLabsCapabilityQueries(
      this.#modelId,
      options.applyTextNormalization,
      undefined,
      options.useSpeakerBoost === true,
    );
    this.requiredCapabilityQueriesForModel = (model) =>
      requiredElevenLabsCapabilityQueries(
        model,
        options.applyTextNormalization,
        undefined,
        options.useSpeakerBoost === true,
      ) ?? [];
    this.supportsConfiguredModelSelection = (model) =>
      supportsElevenLabsConfiguredModelSelection(options, model);
    this.requiredTtsVoiceCapabilities = resolveElevenLabsTtsLanguage(undefined, options.language)
      ? Object.freeze([
          Object.freeze({
            provider: PROVIDER_NAMES.elevenlabs,
            feature: ELEVENLABS_CAPABILITY_FEATURES.ttsVoiceVerifiedLocales,
            modelSource: "selected" as const,
            configuredLanguageMustBeVerified: true,
          }),
        ])
      : undefined;
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

  supportsVoice(voice: string, model = this.#modelId): boolean {
    const protocol = elevenLabsWebSocketProtocol(model);
    if (!isKnownElevenLabsVoiceId(voice, this.#options, protocol)) return false;
    return (
      protocol !== "tts" ||
      this.#options.url === undefined ||
      voice === this.#options.voiceId ||
      this.#options.url.includes(":voice_id")
    );
  }

  get configuredLanguage(): string | undefined {
    return resolveElevenLabsTtsLanguage(undefined, this.#options.language);
  }

  supportsTtsLanguage(language: string, model = this.#modelId): boolean {
    return supportsElevenLabsTtsLanguage(language, model, this.#allowUnknownModel);
  }

  supportsTtsSpeed(speed: number, model = this.#modelId): boolean {
    return supportsElevenLabsTtsSpeed(speed, model, this.#allowUnknownModel);
  }

  supportsTtsSelection(selection: TtsProviderSelection): boolean {
    const model = selection.model ?? this.#modelId;
    const protocol = elevenLabsWebSocketProtocol(model);
    const transport =
      this.capabilities.metadata?.transport === "http-stream" ? "http-stream" : "rest";
    if (
      !supportsElevenLabsHttpModelRoute(model, transport, protocol) ||
      (this.#options.dialogueVoices !== undefined && protocol !== "dialogue")
    )
      return false;
    return (
      evaluateTtsSelectionCompatibility(this, selection, {
        checkModel: true,
        checkVoice: true,
        voiceOverride: selection.voice !== undefined,
        checkLanguage: selection.language !== undefined || this.configuredLanguage !== undefined,
        checkSpeed: selection.speed !== undefined,
        checkProviderSelection: false,
      }).length === 0
    );
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
    const model = request.model ?? this.#modelId;
    const transport =
      this.capabilities.metadata?.transport === "http-stream" ? "http-stream" : "rest";
    assertElevenLabsHttpModelRoute(model, transport, elevenLabsWebSocketProtocol(model));
    return elevenLabsWebSocketProtocol(model) === "dialogue"
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
    request = validateTtsTextControls(this, request);
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
    request = validateTtsTextControls(this, request);
    const model = resolveDialogueModel(this.#modelId, request.model, this.#allowUnknownModel);
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
  if (supportsElevenLabsHttpModelRoute(model, transport, protocol)) return;
  if (model === "eleven_v4_turbo") {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        `ElevenLabs ${model} is not supported by the ${transportName} transport`,
        { provider: PROVIDER_NAMES.elevenlabs },
      ),
    );
  }
  if (model === "eleven_v4" && (transport === "http-stream" || protocol === "tts")) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        `ElevenLabs ${model} is not supported by the ${transportName} transport on the ${protocol} route`,
        { provider: PROVIDER_NAMES.elevenlabs },
      ),
    );
  }
}

function supportsElevenLabsHttpModelRoute(
  model: string,
  transport: HttpTransport,
  protocol: "tts" | "dialogue",
): boolean {
  return (
    model !== "eleven_v4_turbo" &&
    !(model === "eleven_v4" && (transport === "http-stream" || protocol === "tts"))
  );
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
    return executeElevenLabsHttpRequest(
      this,
      validateTtsTextControls(this, request),
      _protocol,
      "http-stream",
    );
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
  const model =
    protocol === "dialogue"
      ? resolveDialogueModel(provider._httpModelId, request.model, provider._httpAllowUnknownModel)
      : resolveModel(provider._httpModelId, request.model, provider._httpAllowUnknownModel);
  assertElevenLabsHttpModelRoute(model, transport, protocol);
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
  const textCharacters =
    "inputs" in request
      ? request.inputs.reduce((total, input) => total + countUnicodeCodePoints(input.text), 0)
      : countUnicodeCodePoints(request.text);
  request.usageReporter?.reportTextCharacters(textCharacters);
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
