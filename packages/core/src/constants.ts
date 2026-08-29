import type { AudioFormat } from "./audio.js";

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
  unexpectedEof: "stt.transport.unexpected_eof",
  connectFailed: "stt.transport.connect_failed",
  connectTimeout: "stt.transport.connect_timeout",
  authFailed: "stt.provider.auth_failed",
  invalidRequest: "stt.provider.invalid_request",
  inputRejected: "stt.provider.input_rejected",
  rateLimited: "stt.provider.rate_limited",
  quotaExceeded: "stt.provider.quota_exceeded",
  serviceUnavailable: "stt.provider.service_unavailable",
  providerInternal: "stt.provider.internal",
  protocolError: "stt.provider.protocol_error",
  sessionExpired: "stt.provider.session_expired",
  streamEnded: "stt.stream_ended",
  bufferOverflow: "stt.reconnect.buffer_overflow",
  recoveryExhausted: "stt.reconnect.recovery_exhausted",
  closed: "stt.reconnect.closed",
} as const;

// Vendor model catalogs and wire protocol versions are not runtime contracts. They
// change on the provider's schedule and need a verification date, so they live in
// `@tvic/providers/catalog.ts` at the adapter edge instead of here.
