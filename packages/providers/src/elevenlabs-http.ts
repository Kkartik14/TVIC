import { PCM16_16K_MONO, PROVIDER_NAMES } from "@tvic/core";
import type {
  ProviderCapabilities,
  TextToSpeechProvider,
  TtsStream,
  TtsSynthesisRequest,
} from "@tvic/core";

import { PROVIDER_CATALOG } from "./catalog.js";
import { SystemProviderClock, type ProviderClock } from "./common.js";
import {
  assertVoice,
  buildUrl,
  dialogueBody,
  elevenLabsHttpResponseError,
  elevenLabsHttpTransportError,
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
import type { ElevenLabsTtsProviderOptions } from "./elevenlabs-options.js";

/** The only wire format decoded by the provider-neutral TVIC TTS boundary. */
export const ELEVENLABS_TTS_PCM_OUTPUT_FORMAT = "pcm_16000" as const;

/** Complete HTTP requests accept the same model-dependent limits as ElevenLabs TTS. */
export const ELEVENLABS_TTS_CHARACTER_LIMITS: Readonly<Record<string, number | undefined>> = {
  eleven_v3: 5_000,
  eleven_v3_conversational: 5_000,
  eleven_multilingual_v2: 10_000,
  eleven_flash_v2_5: 40_000,
  eleven_flash_v2: 30_000,
  eleven_turbo_v2_5: 40_000,
  eleven_turbo_v2: 30_000,
};

export const ELEVENLABS_DIALOGUE_MAX_CHARACTERS = 2_000;
export const ELEVENLABS_DIALOGUE_MAX_VOICES = 10;

export type ElevenLabsOutputRequest = Pick<TtsSynthesisRequest, "sessionId" | "turnId" | "format">;

const ELEVENLABS_TTS_REST_CAPABILITIES = {
  streaming: { input: false, output: false, native: false },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["http"],
  audio: { output: [PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.elevenlabs.models,
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
  models: PROVIDER_CATALOG.elevenlabs.models,
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
  /** Overrides the regular text-to-speech endpoint. */
  readonly url?: string;
  /** Overrides the text-to-dialogue endpoint. */
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
  /** Forces the regular single-voice TTS HTTP endpoint, including for v3 models. */
  synthesizeSpeech(request: ElevenLabsTtsHttpSynthesisRequest): Promise<TtsStream>;
}

export type HttpTransport = "rest" | "http-stream";

export class ElevenLabsTtsRestProvider implements ElevenLabsDialogueProvider {
  readonly name = PROVIDER_NAMES.elevenlabs;
  readonly kind = "tts";
  readonly version = "0.1.0";
  readonly capabilities: ProviderCapabilities = ELEVENLABS_TTS_REST_CAPABILITIES;

  readonly #options: ElevenLabsHttpTtsProviderOptions;
  readonly #modelId: string;
  readonly #allowUnknownModel: boolean;
  readonly #clock: ProviderClock;
  readonly #fetch: typeof fetch;

  constructor(options: ElevenLabsHttpTtsProviderOptions) {
    this.#options = options;
    this.#modelId = options.modelId ?? PROVIDER_CATALOG.elevenlabs.defaultModel;
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#fetch = options.fetchImpl ?? fetch;
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

  synthesize(request: TtsSynthesisRequest): Promise<TtsStream> {
    const model = request.model ?? this.#modelId;
    return model.startsWith("eleven_v3")
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
    const controller = new AbortController();
    const detachAbort = linkAbortSignal(request.signal, controller);
    const timestamped = request.timestamps === true;
    const url = buildUrl(
      endpointUrl(this.#options, protocol, transport, timestamped),
      this.#options,
      timestamped,
    );
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": this.#options.apiKey,
          "Content-Type": "application/json",
          Accept: timestamped ? "application/json" : "audio/pcm",
        },
        body: JSON.stringify(body()),
        signal: controller.signal,
      });
    } catch (error) {
      detachAbort();
      throw elevenLabsHttpTransportError(error, request.signal, controller.signal);
    }

    try {
      if (!response.ok) throw await elevenLabsHttpResponseError(response);
      if (transport === "rest") {
        const bytes = timestamped
          ? await readTimestampedResponse(response)
          : { audio: await readRawAudioResponse(response) };
        detachAbort();
        return new ElevenLabsCompletedStream(request, {
          clock: this.#clock,
          model,
          protocol,
          voice,
          audio: bytes.audio,
          ...(bytes.alignment ? { alignment: bytes.alignment } : {}),
        });
      }
      if (!response.body) throw elevenLabsProtocolError("ElevenLabs HTTP stream returned no body");
      const stream = new ElevenLabsHttpStream(response.body, request, {
        clock: this.#clock,
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
      throw normalizeElevenLabsHttpError(error);
    }
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
    // The base implementation is parameterized by transport through this small
    // adapter hook. The concrete class below replaces the factories; keeping the
    // behavior in one implementation avoids drift between REST and chunked HTTP.
    return executeElevenLabsHttpRequest(this, request, _protocol, "http-stream");
  }
}

/** A structural access point used by the stream subclass without exposing internals. */
interface ElevenLabsHttpProviderInternals {
  readonly _httpOptions: ElevenLabsHttpTtsProviderOptions;
  readonly _httpModelId: string;
  readonly _httpAllowUnknownModel: boolean;
  readonly _httpClock: ProviderClock;
  readonly _httpFetch: typeof fetch;
}

// The public classes intentionally remain simple factory targets. This helper is
// implemented below and is also used by the stream provider's public methods.
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
  const controller = new AbortController();
  const detachAbort = linkAbortSignal(request.signal, controller);
  const timestamped = request.timestamps === true;
  const url = buildUrl(
    endpointUrl(options, protocol, transport, timestamped),
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
    detachAbort();
    throw elevenLabsHttpTransportError(error, request.signal, controller.signal);
  }
  try {
    if (!response.ok) throw await elevenLabsHttpResponseError(response);
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
    throw normalizeElevenLabsHttpError(error);
  }
}

/** The factory is the preferred entry point for complete HTTP responses. */
export function createElevenLabsTtsRestProvider(
  options: ElevenLabsHttpTtsProviderOptions,
): ElevenLabsTtsRestProvider {
  return new ElevenLabsTtsRestProvider(options);
}

/** The factory is the preferred entry point for chunked HTTP responses. */
export function createElevenLabsTtsHttpStreamProvider(
  options: ElevenLabsHttpTtsProviderOptions,
): ElevenLabsTtsHttpStreamProvider {
  return new ElevenLabsTtsHttpStreamProvider(options);
}
