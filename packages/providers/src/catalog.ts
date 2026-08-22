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
}

export const PROVIDER_CATALOG = {
  deepgram: {
    verifiedAt: "2026-07-24",
    source: "https://developers.deepgram.com/docs/models-languages-overview",
    defaultModel: "nova-3",
    models: ["nova-3", "nova-2"],
  },
  sarvam: {
    verifiedAt: "2026-08-20",
    source: "https://docs.sarvam.ai/api-reference/legacy/speech-to-text/transcribe/ws",
    defaultModel: "saaras:v3",
    models: ["saaras:v3", "saaras:v4"],
  },
  cartesia: {
    verifiedAt: "2026-07-24",
    source: "https://docs.cartesia.ai/api-reference/tts/tts",
    defaultModel: "sonic-3",
    models: ["sonic-3", "sonic-2"],
  },
  elevenlabs: {
    verifiedAt: "2026-07-24",
    source: "https://elevenlabs.io/docs/models",
    defaultModel: "eleven_flash_v2_5",
    models: ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"],
  },
  elevenlabsStt: {
    verifiedAt: "2026-08-20",
    source: "https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime",
    defaultModel: "scribe_v2_realtime",
    models: ["scribe_v2_realtime"],
  },
  assemblyai: {
    verifiedAt: "2026-08-20",
    source: "https://www.assemblyai.com/docs/streaming/message-sequence",
    defaultModel: "u3-rt-pro",
    models: ["u3-rt-pro"],
  },
  soniox: {
    verifiedAt: "2026-08-20",
    source: "https://soniox.com/docs/api-reference/stt/websocket-api",
    defaultModel: "stt-rt-v5",
    models: ["stt-rt-v5"],
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
  cartesia: "2026-03-01",
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
  cartesia: {
    language: "en",
  },
} as const;
