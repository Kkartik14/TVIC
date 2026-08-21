import { loadLocalEnv } from "./env.js";

loadLocalEnv();

export interface VoiceModeConfig {
  readonly providerMode: "live" | "mock";
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
  readonly llmProvider: "openai" | "groq";
  readonly llmModel: string;
  readonly deepgramApiKey: string;
  readonly llmApiKey: string;
  readonly llmApiUrl: string;
  readonly cartesiaApiKey?: string;
  readonly cartesiaVoiceId?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function secret(name: string): string {
  const value = optional(name);
  if (value) {
    if (isProduction() && value.length < 32) {
      throw new Error(`${name} must be at least 32 characters in production`);
    }
    return value;
  }
  if (isProduction()) throw new Error(`Missing required env var: ${name}`);
  return `local-development-${name.toLowerCase()}`;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production";
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
  const providerMode = process.env.VOICE_PROVIDER_MODE ?? (isProduction() ? "live" : "mock");
  if (providerMode !== "live" && providerMode !== "mock") {
    throw new Error("VOICE_PROVIDER_MODE must be live or mock");
  }
  if (isProduction() && providerMode !== "live") {
    throw new Error("VOICE_PROVIDER_MODE=mock is not allowed in production");
  }
  const cartesiaApiKey = optional("CARTESIA_API_KEY");
  const cartesiaVoiceId = optional("CARTESIA_VOICE_ID");
  if (Boolean(cartesiaApiKey) !== Boolean(cartesiaVoiceId)) {
    throw new Error("CARTESIA_API_KEY and CARTESIA_VOICE_ID must be configured together");
  }
  const allowedOrigins = (
    optional("ALLOWED_ORIGINS") ?? "http://localhost:8090,http://127.0.0.1:8090"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) throw new Error("ALLOWED_ORIGINS must not be empty");
  const llmProvider = process.env.VOICE_LLM_PROVIDER ?? "openai";
  if (llmProvider !== "openai" && llmProvider !== "groq") {
    throw new Error("VOICE_LLM_PROVIDER must be openai or groq");
  }
  const authSecret = secret("VOICE_AUTH_SECRET");
  const adminSecret = secret("VOICE_ADMIN_SECRET");
  const streamTokenSecret = secret("STREAM_TOKEN_SECRET");
  const safetyIdentifierSecret = secret("SAFETY_IDENTIFIER_SECRET");
  const llmApiKey =
    providerMode === "live"
      ? required(llmProvider === "groq" ? "GROQ_API_KEY" : "OPENAI_API_KEY")
      : "";
  const deepgramApiKey = providerMode === "live" ? required("DEEPGRAM_API_KEY") : "";
  return {
    providerMode,
    port: boundedInt("PORT", 8090, 1, 65535),
    path: process.env.VOICE_PATH ?? "/voice/:sessionRef",
    allowedOrigins,
    authSecret,
    adminSecret,
    streamTokenSecret,
    safetyIdentifierSecret,
    streamTokenTtlMs: boundedInt("STREAM_TOKEN_TTL_MS", 120_000, 1_000, 3_600_000),
    maxSessionDurationMs: boundedInt("MAX_SESSION_DURATION_MS", 2_700_000, 10_000, 86_400_000),
    concurrentSessionCap: boundedInt("CONCURRENT_SESSION_CAP", 1, 1, 20),
    mintRateLimitPerMinute: boundedInt("MINT_RATE_LIMIT_PER_MINUTE", 10, 1, 1_000),
    llmProvider,
    llmModel:
      process.env.LLM_MODEL ?? (llmProvider === "groq" ? "llama-3.1-8b-instant" : "gpt-4.1-mini"),
    deepgramApiKey,
    llmApiKey,
    llmApiUrl:
      process.env.LLM_API_URL ??
      (llmProvider === "groq"
        ? "https://api.groq.com/openai/v1/responses"
        : "https://api.openai.com/v1/responses"),
    ...(cartesiaApiKey ? { cartesiaApiKey } : {}),
    ...(cartesiaVoiceId ? { cartesiaVoiceId } : {}),
  };
}
