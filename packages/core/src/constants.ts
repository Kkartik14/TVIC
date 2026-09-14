import type { AudioFormat } from "./audio.js";

/** Canonical cross-provider error codes shared by runtime and adapters. */
export const TVIC_ERROR_CODES = Object.freeze({
  providerAuthFailed: "provider.auth_failed",
  providerRateLimited: "provider.rate_limited",
  providerModelUnsupported: "provider.model_unsupported",
  providerVoiceUnsupported: "provider.voice_unsupported",
  providerInputRejected: "provider.input_rejected",
  providerInvalidRequest: "provider.invalid_request",
  providerSessionExpired: "provider.session_expired",
  providerProtocolInvalid: "provider.protocol_invalid",
  providerSequenceInvalid: "provider.sequence_invalid",
  providerUpstreamFailed: "provider.upstream_failed",
  providerIdentityMismatch: "provider.identity_mismatch",
  providerStreamBufferOverflow: "provider.stream_buffer_overflow",
  sttSessionBufferOverflow: "stt.session_buffer_overflow",
  sttCommitInFlight: "stt.commit_in_flight",
  llmProviderFailed: "llm.provider.failed",
  sttTransportUnexpectedEof: "stt.transport.unexpected_eof",
  ttsTransportUnexpectedEof: "tts.transport.unexpected_eof",
  llmProviderUnexpectedEof: "llm.provider.unexpected_eof",
} as const);

/** One-release aliases accepted at provider and persisted-data boundaries. */
export const TVIC_ERROR_CODE_ALIASES = Object.freeze({
  "stt.provider.auth_failed": TVIC_ERROR_CODES.providerAuthFailed,
  "stt.provider.rate_limited": TVIC_ERROR_CODES.providerRateLimited,
  "stt.provider.quota_exceeded": TVIC_ERROR_CODES.providerRateLimited,
  "stt.provider.invalid_request": TVIC_ERROR_CODES.providerInvalidRequest,
  "stt.provider.input_rejected": TVIC_ERROR_CODES.providerInputRejected,
  "stt.provider.session_expired": TVIC_ERROR_CODES.providerSessionExpired,
  "stt.provider.protocol_error": TVIC_ERROR_CODES.providerProtocolInvalid,
  "stt.provider.service_unavailable": TVIC_ERROR_CODES.providerUpstreamFailed,
  "stt.provider.internal": TVIC_ERROR_CODES.providerUpstreamFailed,
  "model.unsupported": TVIC_ERROR_CODES.providerModelUnsupported,
  "voice.unsupported": TVIC_ERROR_CODES.providerVoiceUnsupported,
  "stt.model_unsupported": TVIC_ERROR_CODES.providerModelUnsupported,
} as const);

export const TELEPHONY_SAMPLE_RATE_HZ = 8000;
export const RUNTIME_SAMPLE_RATE_HZ = 16000;
export const MONO_CHANNELS = 1;

export const PCM16_16K_MONO = {
  encoding: "pcm_s16le",
  sampleRateHz: RUNTIME_SAMPLE_RATE_HZ,
  channels: MONO_CHANNELS,
} as const satisfies AudioFormat;

export const PCM16_8K_MONO = {
  encoding: "pcm_s16le",
  sampleRateHz: TELEPHONY_SAMPLE_RATE_HZ,
  channels: MONO_CHANNELS,
} as const satisfies AudioFormat;

export const PROVIDER_NAMES = {
  twilio: "twilio-media-streams",
  deepgram: "deepgram",
  cartesia: "cartesia",
  elevenlabs: "elevenlabs",
  elevenlabsStt: "elevenlabs-stt-realtime",
  sarvam: "sarvam",
  assemblyaiStt: "assemblyai-stt",
  sonioxStt: "soniox-stt",
  openaiResponses: "openai-responses",
  webClientAudio: "web-client-audio",
} as const;

export const PROVIDER_ERROR_CODES = {
  twilioMedia: "twilio.media_stream.error",
  deepgramStt: "deepgram.stt.error",
  cartesiaTts: "cartesia.tts.error",
  elevenlabsTts: "elevenlabs.tts.error",
  elevenlabsStt: "elevenlabs.stt.error",
  sarvamStt: "sarvam.stt.error",
  assemblyaiStt: "assemblyai.stt.error",
  sonioxStt: "soniox.stt.error",
  openaiResponses: "openai.responses.error",
  openaiHttp: "openai.http_error",
  openaiResponseFailed: "openai.response.failed",
  webClientAudio: "web_client_audio.error",
} as const;

/** Stable runtime taxonomy consumed by reconnect and call-failure policy. */
export const STT_ERROR_CODES = {
  transportWriteFailed: "stt.transport.write_failed",
  unexpectedEof: TVIC_ERROR_CODES.sttTransportUnexpectedEof,
  connectFailed: "stt.transport.connect_failed",
  connectTimeout: "stt.transport.connect_timeout",
  authFailed: TVIC_ERROR_CODES.providerAuthFailed,
  invalidRequest: TVIC_ERROR_CODES.providerInvalidRequest,
  inputRejected: TVIC_ERROR_CODES.providerInputRejected,
  rateLimited: TVIC_ERROR_CODES.providerRateLimited,
  quotaExceeded: TVIC_ERROR_CODES.providerRateLimited,
  serviceUnavailable: TVIC_ERROR_CODES.providerUpstreamFailed,
  providerInternal: TVIC_ERROR_CODES.providerUpstreamFailed,
  protocolError: TVIC_ERROR_CODES.providerProtocolInvalid,
  sessionExpired: TVIC_ERROR_CODES.providerSessionExpired,
  streamEnded: "stt.stream_ended",
  bufferOverflow: "stt.reconnect.buffer_overflow",
  recoveryExhausted: "stt.reconnect.recovery_exhausted",
  closed: "stt.reconnect.closed",
} as const;

// Vendor model catalogs and wire protocol versions are not runtime contracts. They
// change on the provider's schedule and need a verification date, so they live in
// `@tvic/providers/catalog.ts` at the adapter edge instead of here.
