import { afterEach, describe, expect, it, vi } from "vitest";

import { boundedInt, loadConfig } from "../src/config.js";

const REQUIRED = {
  ALLOWED_ORIGINS: "https://app.example, https://desktop.example",
  VOICE_AUTH_SECRET: "auth-secret",
  VOICE_ADMIN_SECRET: "admin-secret",
  STREAM_TOKEN_SECRET: "stream-secret",
  SAFETY_IDENTIFIER_SECRET: "safety-secret",
  DEEPGRAM_API_KEY: "deepgram-key",
  OPENAI_API_KEY: "openai-key",
} as const;

afterEach(() => vi.unstubAllEnvs());

describe("voice-mode config", () => {
  it("loads safe defaults including the 45-minute hard cap", () => {
    stubRequired();
    const config = loadConfig();
    expect(config.allowedOrigins).toEqual(["https://app.example", "https://desktop.example"]);
    expect(config.maxSessionDurationMs).toBe(45 * 60_000);
    expect(config.concurrentSessionCap).toBe(1);
    expect(config.streamTokenTtlMs).toBe(120_000);
  });

  it("requires every security and provider credential", () => {
    stubRequired();
    vi.stubEnv("SAFETY_IDENTIFIER_SECRET", "");
    expect(() => loadConfig()).toThrow("Missing required env var: SAFETY_IDENTIFIER_SECRET");
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
}
