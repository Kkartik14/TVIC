import type { AudioFormat } from "./audio.js";

export const TELEPHONY_SAMPLE_RATE_HZ = 8000;
export const RUNTIME_SAMPLE_RATE_HZ = 16000;
export const MONO_CHANNELS = 1;

export const PCM16_16K_MONO = {
  encoding: "pcm_s16le",
  sampleRateHz: RUNTIME_SAMPLE_RATE_HZ,
  channels: MONO_CHANNELS,
} as const satisfies AudioFormat;

export const PROVIDER_NAMES = {
  twilio: "twilio-media-streams",
  deepgram: "deepgram",
  cartesia: "cartesia",
  elevenlabs: "elevenlabs",
  openaiResponses: "openai-responses",
  webClientAudio: "web-client-audio",
} as const;

export const PROVIDER_ERROR_CODES = {
  twilioMedia: "twilio.media_stream.error",
  deepgramStt: "deepgram.stt.error",
  cartesiaTts: "cartesia.tts.error",
  elevenlabsTts: "elevenlabs.tts.error",
  openaiResponses: "openai.responses.error",
  openaiHttp: "openai.http_error",
  openaiResponseFailed: "openai.response.failed",
  webClientAudio: "web_client_audio.error",
} as const;

// Vendor model catalogs and wire protocol versions are not runtime contracts. They
// change on the provider's schedule and need a verification date, so they live in
// `@tvic/providers/catalog.ts` at the adapter edge instead of here.
