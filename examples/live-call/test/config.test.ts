import { afterEach, describe, expect, it, vi } from "vitest";

import { boundedInt, loadConfig } from "../src/config.js";

const KEY = "TVIC_TEST_BOUNDED_INT";

afterEach(() => {
  delete process.env[KEY];
  vi.unstubAllEnvs();
});

describe("boundedInt", () => {
  it("returns the fallback when unset", () => {
    expect(boundedInt(KEY, 8080, 1, 65535)).toBe(8080);
  });

  it("parses a valid in-range integer", () => {
    process.env[KEY] = "9090";
    expect(boundedInt(KEY, 8080, 1, 65535)).toBe(9090);
  });

  it("throws on non-numeric values", () => {
    process.env[KEY] = "12ab";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow();
    process.env[KEY] = "-5";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow();
  });

  it("throws when out of range", () => {
    process.env[KEY] = "70000";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow(/between/);
    process.env[KEY] = "0";
    expect(() => boundedInt(KEY, 8080, 1, 65535)).toThrow(/between/);
  });
});

describe("loadConfig security boundaries", () => {
  function setRequiredConfig(): void {
    vi.stubEnv("PORT", "8080");
    vi.stubEnv("PUBLIC_HOST", "gateway.example");
    vi.stubEnv("DEEPGRAM_API_KEY", "deepgram");
    vi.stubEnv("OPENAI_API_KEY", "openai");
    vi.stubEnv("CARTESIA_API_KEY", "cartesia");
    vi.stubEnv("CARTESIA_VOICE_ID", "voice");
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:56379");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TVIC_ENV", "test");
    vi.stubEnv("STREAM_TOKEN_TTL_MS", "120000");
    vi.stubEnv("TWIML_REPLAY_TTL_MS", "300000");
  }

  it("defaults unauthenticated TwiML to disabled", () => {
    setRequiredConfig();
    expect(loadConfig()).toMatchObject({
      allowUnauthenticatedTwiml: false,
      streamTokenTtlMs: 120000,
      twimlReplayTtlMs: 300000,
    });
  });

  it("requires Twilio authentication in production", () => {
    setRequiredConfig();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => loadConfig()).toThrow("TWILIO_AUTH_TOKEN is required in production");
  });

  it("rejects the development bypass flag in production", () => {
    setRequiredConfig();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio");
    vi.stubEnv("ALLOW_UNAUTHENTICATED_TWIML", "true");
    expect(() => loadConfig()).toThrow(
      "ALLOW_UNAUTHENTICATED_TWIML=true is forbidden in production",
    );
  });

  it("requires shared replay storage in production", () => {
    setRequiredConfig();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio");
    vi.stubEnv("REDIS_URL", "");
    expect(() => loadConfig()).toThrow(
      "REDIS_URL is required in production for shared TwiML replay protection",
    );
  });

  it("keeps replay retention at least as long as stream-token retention", () => {
    setRequiredConfig();
    vi.stubEnv("STREAM_TOKEN_TTL_MS", "300000");
    vi.stubEnv("TWIML_REPLAY_TTL_MS", "120000");
    expect(() => loadConfig()).toThrow("TWIML_REPLAY_TTL_MS must be at least STREAM_TOKEN_TTL_MS");
  });
});
