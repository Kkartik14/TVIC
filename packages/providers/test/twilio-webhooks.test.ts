import { describe, expect, it } from "vitest";

import {
  canonicalizeTwilioData,
  computeTwilioSignature,
  verifyTwilioSignature,
} from "../src/twilio-webhooks.js";

const AUTH_TOKEN = "test-auth-token-do-not-use-in-prod";
const URL = "https://example.com/twilio/webhook";

describe("computeTwilioSignature", () => {
  it("produces a stable base64-encoded HMAC-SHA1", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, { From: "+15551234567" });
    expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("produces the same signature for the same inputs (deterministic)", () => {
    const params = { From: "+15551234567", To: "+15559876543" };
    expect(computeTwilioSignature(AUTH_TOKEN, URL, params)).toBe(
      computeTwilioSignature(AUTH_TOKEN, URL, params),
    );
  });

  it("produces different signatures for different params (key sort order matters)", () => {
    const a = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1", b: "2" });
    const b = computeTwilioSignature(AUTH_TOKEN, URL, { b: "2", a: "1" });
    expect(a).toBe(b);
  });

  it("produces a different signature when params order is different content", () => {
    const a = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1", b: "2" });
    const b = computeTwilioSignature(AUTH_TOKEN, URL, { a: "2", b: "1" });
    expect(a).not.toBe(b);
  });

  it("produces a different signature for a different URL", () => {
    const params = { a: "1" };
    const a = computeTwilioSignature(AUTH_TOKEN, "https://a.example.com/x", params);
    const b = computeTwilioSignature(AUTH_TOKEN, "https://b.example.com/x", params);
    expect(a).not.toBe(b);
  });

  it("produces a different signature for a different auth token", () => {
    const params = { a: "1" };
    const a = computeTwilioSignature("token-a", URL, params);
    const b = computeTwilioSignature("token-b", URL, params);
    expect(a).not.toBe(b);
  });
});

describe("canonicalizeTwilioData", () => {
  it("sorts keys lexicographically", () => {
    const out = canonicalizeTwilioData(URL, { z: "1", a: "2", m: "3" });
    expect(out.toString("utf8")).toBe(`${URL}a2m3z1`);
  });

  it("appends array values in order when a key is repeated", () => {
    const out = canonicalizeTwilioData(URL, { a: ["1", "2", "3"] });
    expect(out.toString("utf8")).toBe(`${URL}a1a2a3`);
  });

  it("treats a string value the same as a single-element array", () => {
    expect(canonicalizeTwilioData(URL, { a: "1" }).toString("utf8")).toBe(
      canonicalizeTwilioData(URL, { a: ["1"] }).toString("utf8"),
    );
  });
});

describe("verifyTwilioSignature", () => {
  it("accepts a correctly signed request", () => {
    const params = { From: "+15551234567", To: "+15559876543" };
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, params);
    expect(verifyTwilioSignature({ signature: sig, url: URL, params, authToken: AUTH_TOKEN })).toBe(
      true,
    );
  });

  it("rejects a tampered signature", () => {
    const params = { From: "+15551234567" };
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, params);
    const tampered = sig.slice(0, -2) + (sig.endsWith("=") ? "AA" : "==");
    expect(
      verifyTwilioSignature({ signature: tampered, url: URL, params, authToken: AUTH_TOKEN }),
    ).toBe(false);
  });

  it("rejects when params are tampered", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1" });
    expect(
      verifyTwilioSignature({
        signature: sig,
        url: URL,
        params: { a: "2" },
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("rejects when URL is tampered", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1" });
    expect(
      verifyTwilioSignature({
        signature: sig,
        url: `${URL}/evil`,
        params: { a: "1" },
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("rejects when authToken is wrong", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1" });
    expect(
      verifyTwilioSignature({
        signature: sig,
        url: URL,
        params: { a: "1" },
        authToken: "wrong-token",
      }),
    ).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(
      verifyTwilioSignature({ signature: "", url: URL, params: {}, authToken: AUTH_TOKEN }),
    ).toBe(false);
  });

  it("rejects a non-base64 signature (with valid base64 length)", () => {
    // 28 chars but contains invalid base64 chars ('!').
    expect(
      verifyTwilioSignature({
        signature: "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
        url: URL,
        params: {},
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("rejects a signature of wrong base64 length (not 28 chars)", () => {
    expect(
      verifyTwilioSignature({
        signature: "abc",
        url: URL,
        params: {},
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("throws when authToken is empty string (programmer error)", () => {
    expect(() =>
      verifyTwilioSignature({
        signature: "abc",
        url: URL,
        params: {},
        authToken: "",
      }),
    ).toThrow(/`authToken` must be a non-empty string/);
  });

  it("rejects when params are empty but signature is for non-empty params", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1" });
    expect(
      verifyTwilioSignature({
        signature: sig,
        url: URL,
        params: {},
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("accepts the same signature with empty params (verifier for empty webhooks)", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, {});
    expect(
      verifyTwilioSignature({
        signature: sig,
        url: URL,
        params: {},
        authToken: AUTH_TOKEN,
      }),
    ).toBe(true);
  });

  it("handles array-valued params (repeated keys)", () => {
    const params = { RecordingChannels: ["1", "2"], RecordingStatus: "completed" };
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, params);
    expect(verifyTwilioSignature({ signature: sig, url: URL, params, authToken: AUTH_TOKEN })).toBe(
      true,
    );
  });

  it("rejects an array-valued param whose order is changed", () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, {
      a: ["1", "2"],
    });
    expect(
      verifyTwilioSignature({
        signature: sig,
        url: URL,
        params: { a: ["2", "1"] },
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });

  it("returns true unconditionally when skipVerification is true", () => {
    expect(
      verifyTwilioSignature({
        signature: "anything",
        url: URL,
        params: {},
        authToken: AUTH_TOKEN,
        skipVerification: true,
      }),
    ).toBe(true);
  });

  it("uses constant-time comparison (signature length mismatch is a fast reject)", () => {
    // The signature length for SHA1 base64 is 28 chars. A signature of
    // different length cannot match and must reject — but quickly.
    const sig = computeTwilioSignature(AUTH_TOKEN, URL, { a: "1" });
    const tooLong = sig + "A";
    expect(
      verifyTwilioSignature({
        signature: tooLong,
        url: URL,
        params: { a: "1" },
        authToken: AUTH_TOKEN,
      }),
    ).toBe(false);
  });
});
