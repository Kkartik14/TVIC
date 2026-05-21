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
  openaiResponses: "openai-responses",
} as const;

export const PROVIDER_ERROR_CODES = {
  twilioMedia: "twilio.media_stream.error",
  deepgramStt: "deepgram.stt.error",
  cartesiaTts: "cartesia.tts.error",
  openaiResponses: "openai.responses.error",
  openaiHttp: "openai.http_error",
  openaiResponseFailed: "openai.response.failed",
} as const;

export const PROVIDER_DEFAULTS = {
  deepgram: {
    model: "nova-3",
    models: ["nova-3", "nova-2"],
    endpointingMs: 300,
    vadEvents: true,
    punctuate: true,
  },
  cartesia: {
    apiVersion: "2026-03-01",
    model: "sonic-3",
    models: ["sonic-3", "sonic-2"],
    language: "en",
  },
  openaiResponses: {
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"],
  },
} as const;
