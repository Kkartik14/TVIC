export interface GatewayConfig {
  readonly port: number;
  /** Public host Twilio reaches us on, e.g. "abc123.ngrok.io" (no scheme). */
  readonly publicHost: string;
  readonly mediaPath: string;
  readonly twimlPath: string;
  readonly twilioStatusPath: string;
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
  readonly twilioAccountSid?: string;
  readonly twilioApiKeySid?: string;
  readonly twilioApiKeySecret?: string;
  readonly twilioFromNumber?: string;
  /** Shared secret for the example's outbound-call control endpoint. */
  readonly outboundCallToken?: string;
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

function publicPath(name: string, fallback: string): string {
  const value = optional(name) ?? fallback;
  if (!value.startsWith("/") || value.startsWith("//") || /[?#\s]/u.test(value)) {
    throw new Error(`${name} must be an absolute path without a query or fragment`);
  }
  return value;
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.TVIC_ENV === "production";
}

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
  const twilioAccountSid = optional("TWILIO_ACCOUNT_SID");
  const twilioApiKeySid = optional("TWILIO_API_KEY_SID");
  const twilioApiKeySecret = optional("TWILIO_API_KEY_SECRET");
  const twilioFromNumber = optional("TWILIO_FROM_NUMBER");
  const outboundCallToken = optional("TVIC_OUTBOUND_CALL_TOKEN");
  const redisUrl = optional("REDIS_URL");
  const publicHost = required("PUBLIC_HOST");
  const mediaPath = publicPath("MEDIA_PATH", "/media/:callId");
  const twimlPath = publicPath("TWIML_PATH", "/twiml");
  const twilioStatusPath = publicPath("TWILIO_STATUS_PATH", "/twilio/status");
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
  if (!/^[A-Za-z0-9.-]+$/u.test(publicHost)) {
    throw new Error("PUBLIC_HOST must be a hostname only, without scheme, path, or port");
  }
  if ((mediaPath.match(/:callId/gu)?.length ?? 0) !== 1) {
    throw new Error("MEDIA_PATH must contain exactly one :callId parameter");
  }
  if ((twilioApiKeySid === undefined) !== (twilioApiKeySecret === undefined)) {
    throw new Error("TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET must be set together");
  }
  if (twilioAccountSid && !/^AC[0-9a-f]{32}$/iu.test(twilioAccountSid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be an Account SID beginning with AC");
  }
  if (twilioApiKeySid && !/^SK[0-9a-f]{32}$/iu.test(twilioApiKeySid)) {
    throw new Error("TWILIO_API_KEY_SID must be an API key SID beginning with SK");
  }
  if (twilioApiKeySid && !twilioAccountSid) {
    throw new Error("TWILIO_ACCOUNT_SID is required when using a Twilio API key");
  }
  if (twilioFromNumber && !/^\+[1-9]\d{7,14}$/u.test(twilioFromNumber)) {
    throw new Error("TWILIO_FROM_NUMBER must use E.164 format");
  }
  if (outboundCallToken && outboundCallToken.length < 32) {
    throw new Error("TVIC_OUTBOUND_CALL_TOKEN must contain at least 32 characters");
  }
  if (outboundCallToken) {
    if (!twilioAccountSid || !twilioFromNumber || !twilioAuthToken) {
      throw new Error(
        "Outbound calls require TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, and TWILIO_AUTH_TOKEN",
      );
    }
  }
  if (twimlReplayTtlMs < streamTokenTtlMs) {
    throw new Error("TWIML_REPLAY_TTL_MS must be at least STREAM_TOKEN_TTL_MS");
  }
  return {
    port: boundedInt("PORT", 8080, 1, 65535),
    publicHost,
    mediaPath,
    twimlPath,
    twilioStatusPath,
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
    ...(twilioAccountSid ? { twilioAccountSid } : {}),
    ...(twilioApiKeySid ? { twilioApiKeySid } : {}),
    ...(twilioApiKeySecret ? { twilioApiKeySecret } : {}),
    ...(twilioFromNumber ? { twilioFromNumber } : {}),
    ...(outboundCallToken ? { outboundCallToken } : {}),
    allowUnauthenticatedTwiml,
    twimlReplayTtlMs,
  };
}
