import { afterEach, describe, expect, it, vi } from "vitest";

import { boundedInt, loadConfig } from "../src/config.js";

const REQUIRED = {
  ALLOWED_ORIGINS: "https://app.example, https://desktop.example",
  VOICE_AUTH_SECRET: "auth-secret-012345678901234567890123",
  VOICE_ADMIN_SECRET: "admin-secret-01234567890123456789012",
  STREAM_TOKEN_SECRET: "stream-secret-01234567890123456789",
  SAFETY_IDENTIFIER_SECRET: "safety-secret-01234567890123456789",
  DEEPGRAM_API_KEY: "deepgram-key",
  OPENAI_API_KEY: "openai-key",
} as const;

afterEach(() => vi.unstubAllEnvs());

describe("voice-mode config", () => {
  it("loads safe defaults including the 45-minute hard cap", () => {
    stubRequired();
    vi.stubEnv("VOICE_PROVIDER_MODE", "mock");
    const config = loadConfig();
    expect(config.providerMode).toBe("mock");
    expect(config.llmProvider).toBe("openai");
    expect(config.allowedOrigins).toEqual(["https://app.example", "https://desktop.example"]);
    expect(config.maxSessionDurationMs).toBe(45 * 60_000);
    expect(config.concurrentSessionCap).toBe(1);
    expect(config.streamTokenTtlMs).toBe(120_000);
  });

  it("requires every security and provider credential", () => {
    stubRequired();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VOICE_PROVIDER_MODE", "live");
    vi.stubEnv("SAFETY_IDENTIFIER_SECRET", "");
    expect(() => loadConfig()).toThrow("Missing required env var: SAFETY_IDENTIFIER_SECRET");
  });

  it("rejects mock mode and short secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VOICE_PROVIDER_MODE", "mock");
    expect(() => loadConfig()).toThrow("VOICE_PROVIDER_MODE=mock is not allowed in production");
    vi.stubEnv("VOICE_PROVIDER_MODE", "live");
    vi.stubEnv("VOICE_AUTH_SECRET", "short");
    expect(() => loadConfig()).toThrow("VOICE_AUTH_SECRET must be at least 32 characters");
  });

  it("defaults to mock providers outside production", () => {
    vi.unstubAllEnvs();
    const config = loadConfig();
    expect(config.providerMode).toBe("mock");
    expect(config.deepgramApiKey).toBe("");
    expect(config.llmApiKey).toBe("");
  });

  it("supports Groq's OpenAI-compatible Responses endpoint for live smoke tests", () => {
    stubRequired();
    vi.stubEnv("VOICE_PROVIDER_MODE", "live");
    vi.stubEnv("VOICE_LLM_PROVIDER", "groq");
    vi.stubEnv("GROQ_API_KEY", "groq-key");
    const config = loadConfig();
    expect(config.llmProvider).toBe("groq");
    expect(config.llmApiKey).toBe("groq-key");
    expect(config.llmApiUrl).toBe("https://api.groq.com/openai/v1/responses");
    expect(config.llmModel).toBe("llama-3.1-8b-instant");
  });

  it("requires Cartesia credentials as a complete optional pair", () => {
    stubRequired();
    vi.stubEnv("CARTESIA_API_KEY", "cartesia-key");
    expect(() => loadConfig()).toThrow(
      "CARTESIA_API_KEY and CARTESIA_VOICE_ID must be configured together",
    );
  });

  it("rejects malformed and out-of-range integers", () => {
    vi.stubEnv("PORT", "abc");
    expect(() => boundedInt("PORT", 8090, 1, 65535)).toThrow("Invalid integer for PORT");
    vi.stubEnv("PORT", "70000");
    expect(() => boundedInt("PORT", 8090, 1, 65535)).toThrow("PORT must be between 1 and 65535");
  });
});

function stubRequired(): void {
  for (const [name, value] of Object.entries(REQUIRED)) vi.stubEnv(name, value);
  vi.stubEnv("CARTESIA_API_KEY", "");
  vi.stubEnv("CARTESIA_VOICE_ID", "");
  vi.stubEnv("PORT", "");
  vi.stubEnv("MAX_SESSION_DURATION_MS", "");
  vi.stubEnv("CONCURRENT_SESSION_CAP", "");
  vi.stubEnv("STREAM_TOKEN_TTL_MS", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VOICE_PROVIDER_MODE", "mock");
  vi.stubEnv("VOICE_LLM_PROVIDER", "openai");
}
