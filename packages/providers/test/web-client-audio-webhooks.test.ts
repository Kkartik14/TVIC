import { describe, expect, it } from "vitest";

import {
  signVoiceSessionToken,
  verifyVoiceSessionToken,
} from "../src/web-client-audio-webhooks.js";

const SECRET = "test-voice-token-secret";
const SESSION_REF = "voice_abc-123";

describe("signVoiceSessionToken", () => {
  it("produces a stable hex HMAC-SHA256 (64 hex chars)", () => {
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same token for the same inputs (deterministic)", () => {
    const a = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    const b = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    expect(a).toBe(b);
  });

  it("produces a different token for a different secret", () => {
    const a = signVoiceSessionToken("secret-a", SESSION_REF, 1_700_000_000_000);
    const b = signVoiceSessionToken("secret-b", SESSION_REF, 1_700_000_000_000);
    expect(a).not.toBe(b);
  });

  it("produces a different token for a different sessionRef", () => {
    const a = signVoiceSessionToken(SECRET, "voice_a", 1_700_000_000_000);
    const b = signVoiceSessionToken(SECRET, "voice_b", 1_700_000_000_000);
    expect(a).not.toBe(b);
  });

  it("produces a different token for a different expiry", () => {
    const a = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    const b = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_001);
    expect(a).not.toBe(b);
  });
});

describe("verifyVoiceSessionToken", () => {
  it("accepts a correctly signed, unexpired token", () => {
    const now = 1_700_000_000_000;
    const exp = now + 60_000;
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: String(exp),
        secret: SECRET,
        now: () => now,
      }),
    ).toBe(true);
  });

  it("rejects an expired token (current time past exp)", () => {
    const exp = 1_700_000_000_000;
    const now = exp + 1;
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: String(exp),
        secret: SECRET,
        now: () => now,
      }),
    ).toBe(false);
  });

  it("accepts an expired token within the tolerance window", () => {
    const exp = 1_700_000_000_000;
    const now = exp + 5_000;
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: String(exp),
        secret: SECRET,
        now: () => now,
        toleranceMs: 10_000,
      }),
    ).toBe(true);
  });

  it("rejects when secret is wrong", () => {
    const exp = 1_700_000_000_000;
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: String(exp),
        secret: "wrong-secret",
      }),
    ).toBe(false);
  });

  it("rejects when sessionRef is wrong", () => {
    const exp = 1_700_000_000_000;
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: "voice_wrong",
        exp: String(exp),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects when token is null or undefined", () => {
    expect(
      verifyVoiceSessionToken({
        token: null,
        sessionRef: SESSION_REF,
        exp: "1",
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyVoiceSessionToken({
        token: undefined,
        sessionRef: SESSION_REF,
        exp: "1",
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects when exp is null or undefined", () => {
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: null,
        secret: SECRET,
      }),
    ).toBe(false);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: undefined,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects when exp is not a pure non-negative integer", () => {
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    const badExps = ["-1", "1.5", "1e3", "123abc", " 123 ", "0x1", "  ", "abc"];
    for (const exp of badExps) {
      expect(
        verifyVoiceSessionToken({
          token: tok,
          sessionRef: SESSION_REF,
          exp,
          secret: SECRET,
        }),
      ).toBe(false);
    }
  });

  it("rejects an empty token", () => {
    expect(
      verifyVoiceSessionToken({
        token: "",
        sessionRef: SESSION_REF,
        exp: "1",
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a valid token with trailing non-hex characters", () => {
    const now = 1_700_000_000_000;
    const exp = now + 60_000;
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: `${tok}zz`,
        sessionRef: SESSION_REF,
        exp: String(exp),
        secret: SECRET,
        now: () => now,
      }),
    ).toBe(false);
  });

  it("rejects a non-hex token (wrong length after Buffer.from hex)", () => {
    expect(
      verifyVoiceSessionToken({
        token: "not-hex",
        sessionRef: SESSION_REF,
        exp: "1",
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("returns true unconditionally when skipVerification is true", () => {
    expect(
      verifyVoiceSessionToken({
        token: "anything",
        sessionRef: SESSION_REF,
        exp: "1",
        secret: SECRET,
        skipVerification: true,
      }),
    ).toBe(true);
  });

  it("default tolerance is 0 (no clock-skew slack)", () => {
    const exp = 1_700_000_000_000;
    const now = exp + 1; // 1 ms past
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, exp);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: String(exp),
        secret: SECRET,
        now: () => now,
        // toleranceMs omitted
      }),
    ).toBe(false);
  });

  it("rejects an expiry beyond the safe integer range", () => {
    const tok = signVoiceSessionToken(SECRET, SESSION_REF, 1_700_000_000_000);
    expect(
      verifyVoiceSessionToken({
        token: tok,
        sessionRef: SESSION_REF,
        exp: "9007199254740992",
        secret: SECRET,
        now: () => 0,
      }),
    ).toBe(false);
  });
});
