export interface GatewayConfig {
  readonly port: number;
  /** Public host Twilio reaches us on, e.g. "abc123.ngrok.io" (no scheme). */
  readonly publicHost: string;
  readonly mediaPath: string;
  readonly twimlPath: string;
  readonly llmModel: string;
  readonly groqApiUrl?: string;
  readonly sttLanguage?: string;
  readonly deepgramApiKey: string;
  readonly groqApiKey: string;
  readonly cartesiaApiKey: string;
  readonly cartesiaVoiceId: string;
  readonly cartesiaModel?: string;
  /** Secret for signing single-use media-stream tokens. Required in production. */
  readonly streamTokenSecret?: string;
  readonly streamTokenTtlMs: number;
  /** Twilio auth token. Required in production; /twiml validates its signature. */
  readonly twilioAuthToken?: string;
  /** Explicit development-only escape hatch, false unless opted in. */
  readonly allowUnauthenticatedTwiml: boolean;
  /** How long an identical authenticated TwiML request is replayable. */
  readonly twimlReplayTtlMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production";
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
  const groqApiUrl = optional("GROQ_API_URL");
  const sttLanguage = optional("STT_LANGUAGE");
  const streamTokenSecret = optional("STREAM_TOKEN_SECRET");
  const twilioAuthToken = optional("TWILIO_AUTH_TOKEN");
  const redisUrl = optional("REDIS_URL");
  const streamTokenTtlMs = boundedInt("STREAM_TOKEN_TTL_MS", 120000, 1000, 3_600_000);
  const twimlReplayTtlMs = boundedInt("TWIML_REPLAY_TTL_MS", 300000, 1000, 86_400_000);
  const allowUnauthenticatedTwiml = process.env.ALLOW_UNAUTHENTICATED_TWIML === "true";
  if (isProductionEnv() && !streamTokenSecret) {
    throw new Error("STREAM_TOKEN_SECRET is required in production");
  }
  if (isProductionEnv() && allowUnauthenticatedTwiml) {
    throw new Error("ALLOW_UNAUTHENTICATED_TWIML=true is forbidden in production");
  }
  if (isProductionEnv() && !twilioAuthToken) {
    throw new Error("TWILIO_AUTH_TOKEN is required in production");
  }
  if (isProductionEnv() && !redisUrl) {
    throw new Error("REDIS_URL is required in production for shared TwiML replay protection");
  }
  if (twimlReplayTtlMs < streamTokenTtlMs) {
    throw new Error("TWIML_REPLAY_TTL_MS must be at least STREAM_TOKEN_TTL_MS");
  }
  return {
    port: boundedInt("PORT", 8080, 1, 65535),
    publicHost: required("PUBLIC_HOST"),
    mediaPath: optional("MEDIA_PATH") ?? "/media/:callId",
    twimlPath: optional("TWIML_PATH") ?? "/twiml",
    llmModel: optional("GROQ_MODEL") ?? optional("LLM_MODEL") ?? "openai/gpt-oss-20b",
    ...(groqApiUrl ? { groqApiUrl } : {}),
    ...(sttLanguage ? { sttLanguage } : {}),
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    groqApiKey: required("GROQ_API_KEY"),
    cartesiaApiKey: required("CARTESIA_API_KEY"),
    cartesiaVoiceId: required("CARTESIA_VOICE_ID"),
    ...(cartesiaModel ? { cartesiaModel } : {}),
    ...(streamTokenSecret ? { streamTokenSecret } : {}),
    streamTokenTtlMs,
    ...(twilioAuthToken ? { twilioAuthToken } : {}),
    allowUnauthenticatedTwiml,
    twimlReplayTtlMs,
  };
}
