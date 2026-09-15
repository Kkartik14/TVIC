import { afterEach, describe, expect, it, vi } from "vitest";

import { boundedInt, loadConfig } from "../src/config.js";

const KEY = "TVIC_TEST_BOUNDED_INT";

afterEach(() => {
  delete process.env[KEY];
  vi.unstubAllEnvs();
});

function stubProviderEnvironment(): void {
  vi.stubEnv("PUBLIC_HOST", "gateway.example");
  vi.stubEnv("DEEPGRAM_API_KEY", "deepgram-key");
  vi.stubEnv("GROQ_API_KEY", "groq-key");
  vi.stubEnv("CARTESIA_API_KEY", "cartesia-key");
  vi.stubEnv("CARTESIA_VOICE_ID", "voice-id");
}

describe("provider environment validation", () => {
  it("rejects whitespace-only required values", () => {
    stubProviderEnvironment();
    vi.stubEnv("DEEPGRAM_API_KEY", "   ");

    expect(() => loadConfig()).toThrow(/DEEPGRAM_API_KEY/);
  });

  it("ignores whitespace-only optional model overrides", () => {
    stubProviderEnvironment();
    vi.stubEnv("GROQ_MODEL", "   ");
    vi.stubEnv("LLM_MODEL", "   ");

    expect(loadConfig().llmModel).toBe("openai/gpt-oss-20b");
  });

  it("requires a stable stream-token secret in production", () => {
    stubProviderEnvironment();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => loadConfig()).toThrow(/STREAM_TOKEN_SECRET/);
    vi.stubEnv("STREAM_TOKEN_SECRET", "stable-stream-secret");
    expect(() => loadConfig()).toThrow(/TWILIO_AUTH_TOKEN/);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "stable-twilio-token");
    expect(loadConfig().streamTokenSecret).toBe("stable-stream-secret");
    expect(loadConfig().twilioAuthToken).toBe("stable-twilio-token");
  });
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
