import type { UsageUnit } from "@tvic/core";

export interface ProviderCatalogEntry {
  readonly verifiedAt: string;
  readonly source: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly deprecatedModels?: readonly string[];
  readonly realtimeModels?: readonly string[];
  readonly preRecordedModels?: readonly string[];
  readonly syncModels?: readonly string[];
  readonly batchModels?: readonly string[];
  readonly batchSource?: string;
  readonly usage?: ProviderUsageDeclaration;
}

export type ProviderUsageStatus = "provider_reported" | "runtime_measured" | "not_reported";

export interface ProviderUsageMetricDeclaration {
  readonly status: ProviderUsageStatus;
  readonly unit?: UsageUnit;
  readonly source: string;
  readonly verifiedAt: string;
  readonly providerField?: string;
  readonly originalUnit?: string;
  readonly reason?: "not_documented" | "unverified";
  readonly note: string;
}

export interface ProviderUsageRouteDeclaration {
  readonly scope: "live" | "batch" | "sync";
  readonly transport: string;
  readonly metrics: Readonly<Record<string, ProviderUsageMetricDeclaration>>;
}

export interface ProviderUsageDeclaration {
  readonly routes: Readonly<Record<string, ProviderUsageRouteDeclaration>>;
}

type CompleteProviderCatalogEntry = ProviderCatalogEntry & {
  readonly usage: ProviderUsageDeclaration;
};

const PROVIDER_USAGE_VERIFIED_AT = "2026-10-20";
const RUNTIME_USAGE_VERIFIED_AT = "2026-10-21";

function providerReported(
  providerField: string,
  unit: UsageUnit,
  source: string,
  note: string,
  options: { readonly originalUnit?: string; readonly verifiedAt?: string } = {},
): ProviderUsageMetricDeclaration {
  return {
    status: "provider_reported",
    unit,
    source,
    verifiedAt: options.verifiedAt ?? PROVIDER_USAGE_VERIFIED_AT,
    providerField,
    ...(options.originalUnit ? { originalUnit: options.originalUnit } : {}),
    note,
  };
}

function runtimeMeasured(
  unit: UsageUnit,
  source: string,
  note: string,
): ProviderUsageMetricDeclaration {
  return {
    status: "runtime_measured",
    unit,
    source,
    verifiedAt: RUNTIME_USAGE_VERIFIED_AT,
    note,
  };
}

function notReported(
  source: string,
  reason: "not_documented" | "unverified",
  note: string,
  verifiedAt = PROVIDER_USAGE_VERIFIED_AT,
): ProviderUsageMetricDeclaration {
  return { status: "not_reported", source, verifiedAt, reason, note };
}

function usageRoute(
  scope: ProviderUsageRouteDeclaration["scope"],
  transport: string,
  metrics: Readonly<Record<string, ProviderUsageMetricDeclaration>>,
): ProviderUsageRouteDeclaration {
  return { scope, transport, metrics };
}

const STT_AUDIO_MS_SENT = runtimeMeasured(
  "milliseconds",
  "TVIC runtime: packages/runtime/src/stt-command-controller.ts and packages/runtime/src/resilient-stt-stream.ts",
  "Runtime-derived from PCM bytes, sample rate, channels, and encoding after each live provider audio write is confirmed. Reconnect replays count per successful physical write; buffered audio is excluded until sent, and batch uploads are excluded.",
);

const LLM_REQUEST_COUNT = runtimeMeasured(
  "requests",
  "TVIC runtime: packages/runtime/src/pipeline-turn-output.ts",
  "Counts each live LLM complete() invocation, including tool-continuation passes; it does not count hidden provider retries.",
);

const TTS_CHARACTERS_SENT = runtimeMeasured(
  "unicode_code_points",
  "TVIC runtime: packages/runtime/src/pipeline-turn-output.ts and packages/runtime/src/incremental-tts-input.ts",
  "Counts Unicode code points at each provider synthesis-method invocation. This is a TVIC measure, not provider receipt or billing.",
);

const TTS_AUDIO_MS_RECEIVED = runtimeMeasured(
  "milliseconds",
  "TVIC runtime: packages/runtime/src/pipeline-tts-playback.ts",
  "Derived from normalized PCM bytes and format when audio chunks are read from the provider stream; not provider-reported duration.",
);

function ttsLiveMetrics(
  source: string,
  providerCharacterCount = notReported(
    source,
    "not_documented",
    "This route's reviewed response contract does not expose a per-request provider character count. Runtime charactersSent is a separate Unicode code-point measure.",
  ),
  unavailableReason: "not_documented" | "unverified" = "not_documented",
): Readonly<Record<string, ProviderUsageMetricDeclaration>> {
  return {
    charactersSent: TTS_CHARACTERS_SENT,
    audioMsReceived: TTS_AUDIO_MS_RECEIVED,
    providerCharacterCount,
    providerAudioDurationMs: notReported(
      source,
      unavailableReason,
      "The reviewed route does not provide a per-request provider audio-duration total. Runtime audioMsReceived is measured from decoded PCM chunks.",
    ),
  };
}

export const PROVIDER_STABILITY_LEVELS = Object.freeze([
  "deferred",
  "experimental",
  "validated",
  "stable",
] as const);

export type ProviderStability = (typeof PROVIDER_STABILITY_LEVELS)[number];

export const ASSEMBLYAI_REALTIME_MODELS = Object.freeze([
  "universal-3-6-pro",
  "universal-3-5-pro",
  "universal-streaming-english",
  "universal-streaming-multilingual",
] as const);

export const ASSEMBLYAI_REALTIME_LANGUAGE_CODES = Object.freeze({
  "universal-3-6-pro": Object.freeze([
    "af",
    "ar",
    "ca",
    "da",
    "de",
    "en",
    "es",
    "et",
    "fa",
    "fi",
    "fr",
    "gl",
    "he",
    "hi",
    "it",
    "ja",
    "ko",
    "mr",
    "nl",
    "nn",
    "no",
    "pt",
    "ro",
    "ru",
    "sv",
    "tr",
    "ur",
    "vi",
    "xh",
    "yue",
    "zh",
    "zu",
  ]),
  "universal-3-5-pro": Object.freeze([
    "ar",
    "da",
    "de",
    "en",
    "es",
    "fi",
    "fr",
    "he",
    "hi",
    "it",
    "ja",
    "nl",
    "no",
    "pt",
    "sv",
    "tr",
    "ur",
    "vi",
    "zh",
  ]),
});

export const ASSEMBLYAI_PRE_RECORDED_MODELS = Object.freeze([
  "universal-3-5-pro",
  "universal-2",
] as const);

export const ASSEMBLYAI_SYNC_MODELS = Object.freeze(["universal-3-5-pro"] as const);

export const ASSEMBLYAI_MODELS = Object.freeze([
  ...new Set([
    ...ASSEMBLYAI_REALTIME_MODELS,
    ...ASSEMBLYAI_PRE_RECORDED_MODELS,
    ...ASSEMBLYAI_SYNC_MODELS,
  ]),
] as readonly string[]);

export const PROVIDER_STABILITY = Object.freeze({
  deepgram: "experimental",
  cartesiaStt: "experimental",
  sarvam: "experimental",
  elevenlabsStt: "experimental",
  assemblyai: "experimental",
  soniox: "experimental",
  sarvamTts: "experimental",
  groq: "experimental",
  openaiResponses: "experimental",
  cartesia: "experimental",
  elevenlabs: "experimental",
  webClientAudio: "stable",
  twilio: "stable",
} as const satisfies Readonly<Record<string, ProviderStability>>);

export const PROVIDER_CATALOG = {
  deepgram: {
    verifiedAt: "2026-09-15",
    source: "https://developers.deepgram.com/docs/models-languages-overview",
    defaultModel: "nova-3",
    models: ["nova-3", "nova-2"],
    usage: {
      routes: {
        realtime: usageRoute("live", "WebSocket /v1/listen", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerAudioMs: providerReported(
            "Metadata.duration",
            "milliseconds",
            "https://developers.deepgram.com/reference/speech-to-text/listen-streaming",
            "Provider stream-level duration, normalized from seconds. It is emitted in a terminal Metadata message and may be absent when teardown closes the stream first. Retain each stream as a bounded observation because reconnect replay can overlap; do not sum result-level duration ranges.",
            { originalUnit: "seconds" },
          ),
        }),
      },
    },
  },
  cartesiaStt: {
    verifiedAt: "2026-09-27",
    source: "https://docs.cartesia.ai/build-with-cartesia/stt/latest",
    defaultModel: "ink-2",
    models: ["ink-2", "ink-preview", "ink-whisper-2025-06-04"],
    batchModels: ["ink-whisper"],
    batchSource: "https://docs.cartesia.ai/api-reference/stt/transcribe",
    usage: {
      routes: {
        realtimeManual: usageRoute("live", "Manual WebSocket /stt/websocket", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerAudioMs: providerReported(
            "duration",
            "milliseconds",
            "https://docs.cartesia.ai/api-reference/stt/websocket",
            "Duration on a final transcript message, normalized from seconds. Preserve as per-message observations; additive session semantics are not established.",
            { originalUnit: "seconds" },
          ),
        }),
        realtimeAuto: usageRoute("live", "Auto-turn WebSocket /stt/turns/websocket", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerAudioMs: notReported(
            "https://docs.cartesia.ai/api-reference/stt/turns/websocket",
            "unverified",
            "The accessible auto-turn examples do not establish a provider audio-duration field; the complete schema was not retrievable during the 2026-10-20 review. Do not inherit the manual route's duration claim.",
          ),
        }),
        batch: usageRoute("batch", "HTTP POST /stt", {
          providerAudioMs: notReported(
            "https://docs.cartesia.ai/api-reference/stt/transcribe",
            "unverified",
            "The TVIC batch parser accepts a duration property, but the reviewed official response reference does not establish its unit or semantics. It is not included in live-session usage until verified.",
          ),
        }),
      },
    },
  },
  sarvam: {
    verifiedAt: "2026-09-15",
    source: "https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws",
    defaultModel: "saaras:v3",
    models: ["saaras:v3", "saaras:v4"],
    usage: {
      routes: {
        realtime: usageRoute("live", "Legacy WebSocket /speech-to-text/ws", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerAudioDuration: providerReported(
            "data.metrics.audio_duration",
            "provider_defined",
            "https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws",
            "Per-transcript provider audio-duration observation. The reviewed API example does not label the numeric unit, so preserve the raw provider-defined value and do not convert or sum it.",
            { verifiedAt: "2026-10-21" },
          ),
          providerProcessingDuration: providerReported(
            "data.metrics.processing_latency",
            "provider_defined",
            "https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws",
            "Provider processing-latency observation, distinct from audio duration. The reviewed API example does not label the numeric unit; do not convert or treat it as audio consumed.",
            { verifiedAt: "2026-10-21" },
          ),
        }),
      },
    },
  },
  sarvamTts: {
    verifiedAt: "2026-10-09",
    source: "https://docs.sarvam.ai/api/getting-started/models/bulbul",
    defaultModel: "bulbul:v3",
    models: ["bulbul:v3", "bulbul:v4-flash"],
    usage: {
      routes: {
        websocket: usageRoute(
          "live",
          "WebSocket synthesis",
          ttsLiveMetrics("https://docs.sarvam.ai/api-reference/text-to-speech/stream"),
        ),
        rest: usageRoute(
          "live",
          "HTTP REST synthesis",
          ttsLiveMetrics("https://docs.sarvam.ai/api-reference/text-to-speech/convert"),
        ),
        httpStream: usageRoute(
          "live",
          "HTTP streaming synthesis",
          ttsLiveMetrics("https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream"),
        ),
      },
    },
  },
  cartesia: {
    verifiedAt: "2026-09-25",
    source: "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest",
    defaultModel: "sonic-3.6",
    models: [
      "sonic-3.6",
      "sonic-3.6-2026-08-27",
      "sonic-preview",
      "sonic-3.5",
      "sonic-3.5-2026-05-04",
      "sonic-3",
      "sonic-3-2026-01-12",
    ],
    usage: {
      routes: {
        websocket: usageRoute(
          "live",
          "WebSocket /tts/websocket",
          ttsLiveMetrics(
            "https://docs.cartesia.ai/api-reference/tts/websocket",
            notReported(
              "https://docs.cartesia.ai/api-reference/tts/websocket",
              "unverified",
              "The TVIC provider audit could not retrieve the complete WebSocket response contract, so provider character-count semantics are not verified. Runtime charactersSent is a separate Unicode code-point measure.",
            ),
            "unverified",
          ),
        ),
      },
    },
  },
  elevenlabs: {
    verifiedAt: "2026-10-24",
    source: "https://elevenlabs.io/docs/overview/models",
    defaultModel: "eleven_flash_v2_5",
    models: [
      "eleven_flash_v2_5",
      "eleven_flash_v2",
      "eleven_v3",
      "eleven_v3_conversational",
      "eleven_v4",
      "eleven_v4_turbo",
      "eleven_multilingual_v2",
      "eleven_turbo_v2_5",
      "eleven_turbo_v2",
    ],
    deprecatedModels: ["eleven_turbo_v2_5", "eleven_turbo_v2"],
    usage: {
      routes: {
        websocket: usageRoute(
          "live",
          "Standard TTS WebSocket",
          ttsLiveMetrics(
            "https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input",
          ),
        ),
        multiContextWebsocket: usageRoute(
          "live",
          "Standard TTS multi-context WebSocket",
          ttsLiveMetrics(
            "https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input",
          ),
        ),
        httpConvert: usageRoute(
          "live",
          "HTTP standard Text-to-Speech Convert",
          ttsLiveMetrics(
            "https://elevenlabs.io/docs/api-reference/introduction/",
            providerReported(
              "character-cost",
              "provider_defined",
              "https://elevenlabs.io/docs/api-reference/introduction/",
              "Provider response header documented for standard HTTP Convert. Preserve separately from runtime Unicode code points; the docs do not establish the provider's character-counting algorithm.",
              { verifiedAt: "2026-10-21", originalUnit: "provider character-cost header" },
            ),
          ),
        ),
        httpStream: usageRoute(
          "live",
          "HTTP standard TTS streaming",
          ttsLiveMetrics("https://elevenlabs.io/docs/api-reference/streaming"),
        ),
        dialogueWebsocket: usageRoute(
          "live",
          "Text-to-Dialogue WebSocket",
          ttsLiveMetrics("https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket"),
        ),
        dialogueMultiContextWebsocket: usageRoute(
          "live",
          "Text-to-Dialogue multi-context WebSocket",
          ttsLiveMetrics(
            "https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-multi-websocket",
          ),
        ),
        dialogueHttpConvert: usageRoute(
          "live",
          "HTTP Text-to-Dialogue Convert",
          ttsLiveMetrics("https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert"),
        ),
        dialogueHttpStream: usageRoute(
          "live",
          "HTTP Text-to-Dialogue stream",
          ttsLiveMetrics("https://elevenlabs.io/docs/api-reference/text-to-dialogue/stream"),
        ),
      },
    },
  },
  elevenlabsStt: {
    verifiedAt: "2026-09-24",
    source: "https://elevenlabs.io/docs/overview/models",
    defaultModel: "scribe_v2_realtime",
    models: ["scribe_v2_realtime", "scribe_v2", "scribe_v2_medical"],
    usage: {
      routes: {
        realtime: usageRoute("live", "Scribe realtime WebSocket", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerAudioMs: notReported(
            "https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime",
            "not_documented",
            "The documented realtime event set has no provider duration/usage field. Transcript timestamps are alignment, not audio consumption.",
          ),
        }),
        batch: usageRoute("batch", "Scribe batch HTTP transcription", {
          providerAudioMs: notReported(
            "https://elevenlabs.io/docs/api-reference/speech-to-text",
            "not_documented",
            "The reviewed batch response schema does not expose a provider audio-duration field.",
          ),
        }),
      },
    },
  },
  assemblyai: {
    verifiedAt: "2026-10-24",
    source: "https://www.assemblyai.com/blog/multilingual-transcription",
    defaultModel: "universal-3-6-pro",
    models: ASSEMBLYAI_MODELS,
    realtimeModels: ASSEMBLYAI_REALTIME_MODELS,
    preRecordedModels: ASSEMBLYAI_PRE_RECORDED_MODELS,
    syncModels: ASSEMBLYAI_SYNC_MODELS,
    usage: {
      routes: {
        realtime: usageRoute("live", "Streaming WebSocket", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerAudioMs: providerReported(
            "Termination.audio_duration_seconds",
            "milliseconds",
            "https://www.assemblyai.com/docs/streaming/message-sequence",
            "Total audio processed on one provider stream, normalized from seconds. Available only when the terminal Termination message is received. Retain each stream as a bounded observation because reconnect replay can overlap.",
            { originalUnit: "seconds", verifiedAt: "2026-10-21" },
          ),
          providerSessionMs: providerReported(
            "Termination.session_duration_seconds",
            "milliseconds",
            "https://www.assemblyai.com/docs/streaming/message-sequence",
            "Provider connection wall-clock duration, normalized from seconds. Retain each connection as a bounded observation; this is distinct from audio duration and must not be labeled as audio consumed.",
            { originalUnit: "seconds", verifiedAt: "2026-10-21" },
          ),
        }),
        preRecorded: usageRoute("batch", "Pre-recorded HTTP transcription", {
          providerAudioMs: providerReported(
            "audio_duration",
            "milliseconds",
            "https://www.assemblyai.com/docs/pre-recorded-audio/guides/bulk-transcription-and-load-tests-at-scale",
            "Provider duration of the uploaded audio, normalized from seconds. This batch result does not contribute to a live session summary.",
            { originalUnit: "seconds", verifiedAt: "2026-10-21" },
          ),
        }),
        sync: usageRoute("sync", "Synchronous HTTP transcription", {
          providerAudioMs: providerReported(
            "audio_duration_ms",
            "milliseconds",
            "https://www.assemblyai.com/blog/sync-speech-to-text-api-technical-walkthrough",
            "Provider audio duration already expressed in milliseconds. This complete-input route is separate from live streaming and pre-recorded batch transcription.",
            { originalUnit: "milliseconds", verifiedAt: "2026-10-21" },
          ),
        }),
      },
    },
  },
  soniox: {
    verifiedAt: "2026-08-20",
    source: "https://soniox.com/docs/api-reference/stt/websocket-api",
    defaultModel: "stt-rt-v5",
    models: ["stt-rt-v5"],
    usage: {
      routes: {
        realtime: usageRoute("live", "Realtime WebSocket", {
          audioMsSent: STT_AUDIO_MS_SENT,
          providerFinalAudioProcessedMs: providerReported(
            "final_audio_proc_ms",
            "milliseconds",
            "https://soniox.com/docs/api-reference/stt/websocket-api",
            "Provider processing duration for audio represented by final tokens. Preserve separately from total_audio_proc_ms.",
            { originalUnit: "milliseconds" },
          ),
          providerTotalAudioProcessedMs: providerReported(
            "total_audio_proc_ms",
            "milliseconds",
            "https://soniox.com/docs/api-reference/stt/websocket-api",
            "Provider processing duration for audio represented by final and non-final tokens. Preserve separately from final_audio_proc_ms.",
            { originalUnit: "milliseconds" },
          ),
        }),
      },
    },
  },
  groq: {
    verifiedAt: "2026-09-15",
    source: "https://console.groq.com/docs/models",
    defaultModel: "openai/gpt-oss-20b",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
    usage: {
      routes: {
        streaming: usageRoute("live", "Streaming Chat Completions", {
          requestCount: LLM_REQUEST_COUNT,
          inputTokens: providerReported(
            "usage.prompt_tokens (or usage.input_tokens)",
            "tokens",
            "https://console.groq.com/docs/api-reference",
            "Available only when a streaming response supplies a usage-bearing terminal chunk; the reviewed streaming documentation does not guarantee one. Cached tokens, when present, are included within this input count.",
          ),
          outputTokens: providerReported(
            "usage.completion_tokens (or usage.output_tokens)",
            "tokens",
            "https://console.groq.com/docs/api-reference",
            "Available only when a streaming response supplies a usage-bearing terminal chunk; the reviewed streaming documentation does not guarantee one.",
          ),
          cachedTokens: providerReported(
            "usage.prompt_tokens_details.cached_tokens (or usage.input_tokens_details.cached_tokens)",
            "tokens",
            "https://console.groq.com/docs/prompt-caching",
            "Optional cached input-token subset. This is a breakdown of inputTokens and must not be added to it.",
          ),
        }),
      },
    },
  },
  openaiResponses: {
    verifiedAt: "2026-07-24",
    source: "https://platform.openai.com/docs/models",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"],
    usage: {
      routes: {
        streaming: usageRoute("live", "Responses API streaming events", {
          requestCount: LLM_REQUEST_COUNT,
          inputTokens: providerReported(
            "response.usage.input_tokens",
            "tokens",
            "https://developers.openai.com/api/reference/resources/responses/streaming-events",
            "Reported on completed responses when a usage object is present. The reviewed incomplete and failed examples have null usage.",
          ),
          outputTokens: providerReported(
            "response.usage.output_tokens",
            "tokens",
            "https://developers.openai.com/api/reference/resources/responses/streaming-events",
            "Reported on completed responses when a usage object is present. The reviewed incomplete and failed examples have null usage.",
          ),
          cachedTokens: providerReported(
            "response.usage.input_tokens_details.cached_tokens",
            "tokens",
            "https://developers.openai.com/api/reference/resources/responses/streaming-events",
            "Optional cached input-token subset. This is a breakdown of inputTokens and must not be added to it.",
          ),
        }),
      },
    },
  },
} as const satisfies Record<string, CompleteProviderCatalogEntry>;

export const PROVIDER_API_VERSIONS = {
  cartesia: "2026-08-14",
  cartesiaStt: "2026-08-14",
} as const;

export const ADAPTER_DEFAULTS = {
  deepgram: {
    endpointingMs: 300,
    vadEvents: true,
    punctuate: true,
  },
  sarvam: {
    mode: "transcribe",
    highVadSensitivity: true,
    vadSignals: true,
    flushSignal: true,
    inputAudioCodec: "pcm_s16le",
  },
  sarvamTts: {
    language: "en-IN",
    voice: "shubh",
    pace: 1,
    temperature: 0.6,
    minBufferSize: 50,
    maxChunkLength: 150,
  },
  cartesia: {
    language: "en",
  },
  cartesiaStt: {
    mode: "manual",
  },
} as const;
