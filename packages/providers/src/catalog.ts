/**
 * Vendor facts that change on the provider's release schedule rather than ours:
 * model catalogs and wire protocol versions.
 *
 * These deliberately live at the adapter edge instead of in `@tvic/core`. A model
 * list is not a runtime contract, it is dated evidence. Compiling it into core made
 * two things invisible: how old the claim was, and the fact that a vendor deprecating
 * a model silently turns `capabilities.models` into a false statement.
 *
 * Every entry carries the date it was verified and the document it came from.
 * Reverify before relying on an entry for a production or purchasing decision, and
 * treat a stale `verifiedAt` as a reason to omit a capability rather than assert it.
 */
export interface ProviderCatalogEntry {
  /** ISO date the model list below was last checked against `source`. */
  readonly verifiedAt: string;
  /** Official provider documentation the entry was read from. */
  readonly source: string;
  /** Model used when the caller does not choose one. */
  readonly defaultModel: string;
  /** Models this adapter is known to work with, not the vendor's full catalog. */
  readonly models: readonly string[];
  /** Optional transport-specific model groups when one adapter spans transports. */
  readonly realtimeModels?: readonly string[];
  readonly preRecordedModels?: readonly string[];
  readonly syncModels?: readonly string[];
  /** Models supported by a separate complete-input/batch contract, when present. */
  readonly batchModels?: readonly string[];
  /** Official documentation for the separate batch contract, when present. */
  readonly batchSource?: string;
}

/**
 * TVIC maturity labels are our release claim, not a vendor guarantee. They are
 * ordered from least to most supported as deferred, experimental, validated,
 * and stable. `validated` means the exact adapter/model path has passed the
 * small-scale live evidence profile; it is not an uptime or compatibility SLA.
 */
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
  },
  cartesiaStt: {
    verifiedAt: "2026-09-27",
    source: "https://docs.cartesia.ai/build-with-cartesia/stt/latest",
    defaultModel: "ink-2",
    models: ["ink-2", "ink-preview", "ink-whisper-2025-06-04"],
    batchModels: ["ink-whisper"],
    batchSource: "https://docs.cartesia.ai/api-reference/stt/transcribe",
  },
  sarvam: {
    verifiedAt: "2026-09-15",
    source: "https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws",
    defaultModel: "saaras:v3",
    models: ["saaras:v3", "saaras:v4"],
  },
  sarvamTts: {
    verifiedAt: "2026-09-25",
    source: "https://docs.sarvam.ai/api-reference/text-to-speech/convert",
    defaultModel: "bulbul:v3",
    models: ["bulbul:v3"],
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
  },
  elevenlabs: {
    verifiedAt: "2026-09-25",
    source: "https://elevenlabs.io/docs/overview/models",
    defaultModel: "eleven_flash_v2_5",
    models: [
      "eleven_flash_v2_5",
      "eleven_flash_v2",
      "eleven_v3",
      "eleven_v3_conversational",
      "eleven_multilingual_v2",
      "eleven_turbo_v2_5",
      "eleven_turbo_v2",
    ],
  },
  elevenlabsStt: {
    verifiedAt: "2026-09-24",
    source: "https://elevenlabs.io/docs/overview/models",
    defaultModel: "scribe_v2_realtime",
    models: ["scribe_v2_realtime", "scribe_v2", "scribe_v2_medical"],
  },
  assemblyai: {
    verifiedAt: "2026-09-27",
    source: "https://www.assemblyai.com/docs/streaming/select-the-speech-model",
    defaultModel: "universal-3-6-pro",
    models: ASSEMBLYAI_MODELS,
    realtimeModels: ASSEMBLYAI_REALTIME_MODELS,
    preRecordedModels: ASSEMBLYAI_PRE_RECORDED_MODELS,
    syncModels: ASSEMBLYAI_SYNC_MODELS,
  },
  soniox: {
    verifiedAt: "2026-08-20",
    source: "https://soniox.com/docs/api-reference/stt/websocket-api",
    defaultModel: "stt-rt-v5",
    models: ["stt-rt-v5"],
  },
  groq: {
    verifiedAt: "2026-09-15",
    source: "https://console.groq.com/docs/models",
    defaultModel: "openai/gpt-oss-20b",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  },
  openaiResponses: {
    verifiedAt: "2026-07-24",
    source: "https://platform.openai.com/docs/models",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"],
  },
} as const satisfies Record<string, ProviderCatalogEntry>;

/**
 * Provider wire protocol versions. Separate from the model catalog because a
 * protocol version changes adapter parsing, not just which model is selected.
 */
export const PROVIDER_API_VERSIONS = {
  cartesia: "2026-08-14",
  cartesiaStt: "2026-08-14",
} as const;

/**
 * TVIC's own adapter tuning. These are our decisions about how to drive a provider,
 * not facts about the provider, so they are not dated catalog entries.
 */
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
