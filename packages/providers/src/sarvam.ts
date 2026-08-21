import WebSocket from "ws";

import { AsyncQueue, bytesToBase64 } from "@tvic/media";
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
  PCM16_8K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  counterIdGenerator,
} from "@tvic/core";

import { ADAPTER_DEFAULTS, PROVIDER_CATALOG } from "./catalog.js";
import {
  SystemProviderClock,
  normalizeProviderError,
  openWebSocket,
  parseJsonObject,
  providerError,
  assertSttPcm16leFormat,
  assertSttSampleRate,
  assertSupportedModel,
  providerStreamEnded,
  safeClose,
  safeSend,
  type ProviderClock,
} from "./common.js";

const SARVAM_LANGUAGES = [
  "hi-IN",
  "bn-IN",
  "gu-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
  "as-IN",
  "ur-IN",
  "ne-IN",
  "kok-IN",
  "ks-IN",
  "sd-IN",
  "sa-IN",
  "sat-IN",
  "mni-IN",
  "brx-IN",
  "mai-IN",
  "doi-IN",
  "en-IN",
] as const;

const SARVAM_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: false, buffer: false, truncation: false },
  transports: ["websocket"],
  languages: SARVAM_LANGUAGES,
  audio: { input: [PCM16_8K_MONO, PCM16_16K_MONO] },
  models: PROVIDER_CATALOG.sarvam.models,
  turnDetection: ["vad", "manual"],
  metadata: {
    interimResults: false,
    outputModes: ["transcribe", "translate", "verbatim", "translit", "codemix"],
  },
} satisfies ProviderCapabilities;

export type SarvamOutputMode = "transcribe" | "translate" | "verbatim" | "translit" | "codemix";

export interface SarvamSttProviderOptions {
  readonly apiKey: string;
  readonly url?: string;
  readonly allowUnknownModel?: boolean;
  readonly mode?: SarvamOutputMode;
  readonly highVadSensitivity?: boolean;
  readonly vadSignals?: boolean;
  readonly flushSignal?: boolean;
  readonly inputAudioCodec?: "pcm_s16le" | "pcm_l16" | "pcm_raw";
  readonly clock?: ProviderClock;
  readonly webSocketFactory?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
}

interface SarvamMessage {
  readonly type?: string;
  readonly data?: unknown;
}

export class SarvamSttProvider implements SpeechToTextProvider {
  readonly name = PROVIDER_NAMES.sarvam;
  readonly kind = "stt";
  readonly version = "0.1.0";
  readonly capabilities = SARVAM_CAPABILITIES;

  readonly #apiKey: string;
  readonly #url: string;
  readonly #allowUnknownModel: boolean;
  readonly #mode: SarvamOutputMode;
  readonly #highVadSensitivity: boolean;
  readonly #vadSignals: boolean;
  readonly #flushSignal: boolean;
  readonly #inputAudioCodec: NonNullable<SarvamSttProviderOptions["inputAudioCodec"]>;
  readonly #clock: ProviderClock;
  readonly #webSocketFactory: NonNullable<SarvamSttProviderOptions["webSocketFactory"]>;

  constructor(options: SarvamSttProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#url = options.url ?? "wss://api.sarvam.ai/speech-to-text/ws";
    this.#allowUnknownModel = options.allowUnknownModel ?? false;
    this.#mode = options.mode ?? ADAPTER_DEFAULTS.sarvam.mode;
    this.#highVadSensitivity =
      options.highVadSensitivity ?? ADAPTER_DEFAULTS.sarvam.highVadSensitivity;
    this.#vadSignals = options.vadSignals ?? ADAPTER_DEFAULTS.sarvam.vadSignals;
    this.#flushSignal = options.flushSignal ?? ADAPTER_DEFAULTS.sarvam.flushSignal;
    this.#inputAudioCodec = options.inputAudioCodec ?? ADAPTER_DEFAULTS.sarvam.inputAudioCodec;
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
    assertSttSampleRate(PROVIDER_NAMES.sarvam, request.format.sampleRateHz, [8000, 16000]);
    const model = request.model ?? PROVIDER_CATALOG.sarvam.defaultModel;
    assertSupportedModel(
      PROVIDER_NAMES.sarvam,
      PROVIDER_CATALOG.sarvam.models,
      model,
      request.allowUnknownModel ?? this.#allowUnknownModel,
    );

    const url = new URL(this.#url);
    url.searchParams.set("model", model);
    url.searchParams.set("mode", this.#mode);
    // Sarvam's WS query parameter is hyphenated ("language-code"), unlike every
    // other param on this connection and unlike the underscored `language_code`
    // field the server echoes back in transcript responses:
    // https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws
    url.searchParams.set("language-code", request.language ?? "unknown");
    url.searchParams.set("sample_rate", String(request.format.sampleRateHz));
    url.searchParams.set("input_audio_codec", this.#inputAudioCodec);
    url.searchParams.set("high_vad_sensitivity", String(this.#highVadSensitivity));
    url.searchParams.set("vad_signals", String(this.#vadSignals));
    url.searchParams.set("flush_signal", String(this.#flushSignal));

    const socket = this.#webSocketFactory(url.toString(), {
      "api-subscription-key": this.#apiKey,
    });

    try {
      await openWebSocket(socket, request.signal ? { signal: request.signal } : {});
    } catch (error) {
      throw normalizeProviderError(error, {
        code: PROVIDER_ERROR_CODES.sarvamStt,
        provider: PROVIDER_NAMES.sarvam,
      });
    }

    return new SarvamSttStream(socket, request, this.#clock, this.#inputAudioCodec);
  }
}

export class SarvamSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode = "provider" as const;
  readonly #socket: WebSocket;
  readonly #request: SttOpenRequest;
  readonly #clock: ProviderClock;
  readonly #inputAudioCodec: NonNullable<SarvamSttProviderOptions["inputAudioCodec"]>;
  readonly #events = new AsyncQueue<TranscriptEvent>();
  readonly #ids = counterIdGenerator<ProviderEventId>("sarvam_event");
  #sequence = 1;
  #closed = false;
  #flushPending = false;

  constructor(
    socket: WebSocket,
    request: SttOpenRequest,
    clock: ProviderClock,
    inputAudioCodec: NonNullable<SarvamSttProviderOptions["inputAudioCodec"]> = "pcm_s16le",
  ) {
    this.#socket = socket;
    this.#request = request;
    this.#clock = clock;
    this.#inputAudioCodec = inputAudioCodec;
    this.events = this.#events;

    socket.on("message", (data) => this.#handleMessage(data.toString("utf8")));
    socket.on("close", () => this.#closeQueue());
    socket.on("error", (error) => {
      this.#closed = true;
      this.#events.fail(
        normalizeProviderError(error, {
          code: PROVIDER_ERROR_CODES.sarvamStt,
          provider: PROVIDER_NAMES.sarvam,
        }),
      );
    });
  }

  async sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed) {
      throw providerStreamEnded(PROVIDER_NAMES.sarvam, PROVIDER_ERROR_CODES.sarvamStt);
    }
    safeSend(
      this.#socket,
      JSON.stringify({
        audio: {
          data: bytesToBase64(chunk.audio.bytes),
          sample_rate: String(chunk.audio.format.sampleRateHz),
          encoding: this.#inputAudioCodec,
        },
      }),
    );
  }

  async commit(): Promise<void> {
    if (this.#closed) {
      throw providerStreamEnded(PROVIDER_NAMES.sarvam, PROVIDER_ERROR_CODES.sarvamStt);
    }
    this.#flushPending = true;
    safeSend(this.#socket, JSON.stringify({ type: "flush" }));
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
    const parsed = parseJsonObject(body) as SarvamMessage | null;
    if (!parsed) {
      return;
    }

    const data = asRecord(parsed.data);
    // Sarvam's documented error envelope is `{ type: "error", data: { error, code } }`
    // (both fields nested under `data`, never at the message's top level):
    // https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws
    if (parsed.type === "error") {
      this.#closed = true;
      this.#events.fail(
        providerError(
          typeof data?.code === "string" ? data.code : PROVIDER_ERROR_CODES.sarvamStt,
          typeof data?.error === "string" ? data.error : "Sarvam STT error",
          { provider: PROVIDER_NAMES.sarvam, retriable: false },
        ),
      );
      safeClose(this.#socket);
      return;
    }

    if (parsed.type === "events") {
      this.#handleVadEvent(data);
      return;
    }
    if (parsed.type !== "data") {
      return;
    }

    const text = typeof data?.transcript === "string" ? data.transcript.trim() : "";
    const isPartial = data?.is_final === false || data?.final === false;
    if (text) {
      const timestamp = this.#clock.now();
      this.#events.push({
        id: this.#ids.next(),
        type: isPartial ? "stt.partial" : "stt.final",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.sarvam,
        text,
        // Sarvam's transcript response has no transcript-confidence field — only
        // `language_probability` (confidence about detected language), which is a
        // different signal and would misrepresent this field if reused here:
        // https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws
        ...(typeof data?.language_code === "string" ? { language: data.language_code } : {}),
        startTimestamp: timestamp,
        endTimestamp: timestamp,
        metadata: {
          sarvam: {
            ...(typeof data?.request_id === "string" ? { requestId: data.request_id } : {}),
            ...(data?.metrics !== undefined ? { metrics: data.metrics } : {}),
          },
        },
      });
      this.#sequence += 1;
    }

    if (this.#flushPending && !isPartial) {
      this.#pushEndpoint("manual");
      this.#flushPending = false;
    }
  }

  #handleVadEvent(data: Readonly<Record<string, unknown>> | undefined): void {
    const signalType = data?.signal_type;
    if (signalType === "START_SPEECH") {
      this.#events.push({
        id: this.#ids.next(),
        type: "stt.speech.started",
        direction: "input",
        sessionId: this.#request.sessionId,
        sequence: this.#sequence,
        provider: PROVIDER_NAMES.sarvam,
        timestamp: this.#clock.now(),
      });
      this.#sequence += 1;
    } else if (signalType === "END_SPEECH") {
      this.#pushEndpoint(this.#flushPending ? "manual" : "silence");
      this.#flushPending = false;
    }
  }

  #pushEndpoint(reason: "manual" | "silence"): void {
    this.#events.push({
      id: this.#ids.next(),
      type: "stt.endpoint",
      direction: "input",
      sessionId: this.#request.sessionId,
      sequence: this.#sequence,
      provider: PROVIDER_NAMES.sarvam,
      reason,
      timestamp: this.#clock.now(),
    });
    this.#sequence += 1;
  }

  #closeQueue(): void {
    this.#closed = true;
    this.#events.close();
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function createSarvamSttProvider(options: SarvamSttProviderOptions): SarvamSttProvider {
  return new SarvamSttProvider(options);
}
