export interface VoiceModeConfig {
  readonly port: number;
  readonly path: string;
  readonly allowedOrigins: readonly string[];
  readonly authSecret: string;
  readonly adminSecret: string;
  readonly streamTokenSecret: string;
  readonly safetyIdentifierSecret: string;
  readonly streamTokenTtlMs: number;
  readonly maxSessionDurationMs: number;
  readonly concurrentSessionCap: number;
  readonly mintRateLimitPerMinute: number;
  readonly llmModel: string;
  readonly deepgramApiKey: string;
  readonly openaiApiKey: string;
  readonly cartesiaApiKey?: string;
  readonly cartesiaVoiceId?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

export function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid integer for ${name}`);
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

export function loadConfig(): VoiceModeConfig {
  const cartesiaApiKey = optional("CARTESIA_API_KEY");
  const cartesiaVoiceId = optional("CARTESIA_VOICE_ID");
  if (Boolean(cartesiaApiKey) !== Boolean(cartesiaVoiceId)) {
    throw new Error("CARTESIA_API_KEY and CARTESIA_VOICE_ID must be configured together");
  }
  const allowedOrigins = required("ALLOWED_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) throw new Error("ALLOWED_ORIGINS must not be empty");
  return {
    port: boundedInt("PORT", 8090, 1, 65535),
    path: process.env.VOICE_PATH ?? "/voice/:sessionRef",
    allowedOrigins,
    authSecret: required("VOICE_AUTH_SECRET"),
    adminSecret: required("VOICE_ADMIN_SECRET"),
    streamTokenSecret: required("STREAM_TOKEN_SECRET"),
    safetyIdentifierSecret: required("SAFETY_IDENTIFIER_SECRET"),
    streamTokenTtlMs: boundedInt("STREAM_TOKEN_TTL_MS", 120_000, 1_000, 3_600_000),
    maxSessionDurationMs: boundedInt("MAX_SESSION_DURATION_MS", 2_700_000, 10_000, 86_400_000),
    concurrentSessionCap: boundedInt("CONCURRENT_SESSION_CAP", 1, 1, 20),
    mintRateLimitPerMinute: boundedInt("MINT_RATE_LIMIT_PER_MINUTE", 10, 1, 1_000),
    llmModel: process.env.LLM_MODEL ?? "gpt-4.1-mini",
    deepgramApiKey: required("DEEPGRAM_API_KEY"),
    openaiApiKey: required("OPENAI_API_KEY"),
    ...(cartesiaApiKey ? { cartesiaApiKey } : {}),
    ...(cartesiaVoiceId ? { cartesiaVoiceId } : {}),
  };
}
