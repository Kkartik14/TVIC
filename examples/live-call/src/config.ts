export interface GatewayConfig {
  readonly port: number;
  /** Public host Twilio reaches us on, e.g. "abc123.ngrok.io" (no scheme). */
  readonly publicHost: string;
  readonly mediaPath: string;
  readonly twimlPath: string;
  readonly artifactsDir: string;
  readonly llmModel: string;
  readonly sttLanguage?: string;
  readonly deepgramApiKey: string;
  readonly openaiApiKey: string;
  readonly cartesiaApiKey: string;
  readonly cartesiaVoiceId: string;
  readonly cartesiaModel?: string;
  /** Master consent switch. When false, nothing is persisted for the call. */
  readonly recordCalls: boolean;
  /** Persist raw PCM (only takes effect when recordCalls is true). */
  readonly persistAudio: boolean;
  /** Secret for signing single-use media-stream tokens. Generated per-process if unset. */
  readonly streamTokenSecret?: string;
  readonly streamTokenTtlMs: number;
  /** Twilio auth token. When set, /twiml requires a valid X-Twilio-Signature. */
  readonly twilioAuthToken?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Parses a positive bounded integer env var, failing fast on garbage/out-of-range. */
export function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid integer for ${name}: ${JSON.stringify(raw)}`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, received ${value}`);
  }
  return value;
}

export function loadConfig(): GatewayConfig {
  const cartesiaModel = optional("CARTESIA_MODEL");
  const sttLanguage = optional("STT_LANGUAGE");
  const streamTokenSecret = optional("STREAM_TOKEN_SECRET");
  const twilioAuthToken = optional("TWILIO_AUTH_TOKEN");
  return {
    port: boundedInt("PORT", 8080, 1, 65535),
    publicHost: required("PUBLIC_HOST"),
    mediaPath: process.env.MEDIA_PATH ?? "/media/:callId",
    twimlPath: process.env.TWIML_PATH ?? "/twiml",
    artifactsDir: process.env.ARTIFACTS_DIR ?? "./calls",
    llmModel: process.env.LLM_MODEL ?? "gpt-4.1-mini",
    ...(sttLanguage ? { sttLanguage } : {}),
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    openaiApiKey: required("OPENAI_API_KEY"),
    cartesiaApiKey: required("CARTESIA_API_KEY"),
    cartesiaVoiceId: required("CARTESIA_VOICE_ID"),
    ...(cartesiaModel ? { cartesiaModel } : {}),
    recordCalls: (process.env.RECORD_CALLS ?? "false") === "true",
    persistAudio: (process.env.PERSIST_AUDIO ?? "false") === "true",
    ...(streamTokenSecret ? { streamTokenSecret } : {}),
    streamTokenTtlMs: boundedInt("STREAM_TOKEN_TTL_MS", 120000, 1000, 3_600_000),
    ...(twilioAuthToken ? { twilioAuthToken } : {}),
  };
}
