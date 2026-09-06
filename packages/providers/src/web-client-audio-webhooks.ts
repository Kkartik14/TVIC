// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 T-vic contributors
//
// Voice-session token verification.
//
// The voice-mode client opens a WebSocket to a voice session
// endpoint. The handshake includes three query parameters:
//   - sessionRef: a server-issued session reference (e.g. "voice_<uuid>")
//   - token: an HMAC-SHA256 signature of `${sessionRef}.${expMs}`
//   - exp: the expiry as a non-negative integer (milliseconds since epoch)
//
// Verification:
//   1. token must parse as hex of expected length (32 bytes for SHA-256 → 64 hex chars)
//   2. exp must be a non-negative integer string ("/^\\d+$/")
//   3. exp must not be in the past (with optional tolerance)
//   4. HMAC-SHA256(secret, `${sessionRef}.${expMs}`) must equal `token`
//
// The token is single-use: a successful verification does not invalidate
// the token (the server-side store does that), but re-use of a token
// within its TTL is detectable by the server.
//
// Default tolerance: 0 ms. The token's TTL is the natural replay window.
// If the server and client clocks are skewed, pass a non-zero tolerance.
//
// Array: this is a separate primitive from the Twilio verifier because the
// crypto, payload shape, and validation rules are different. They are
// siblings in `@tvic/providers`, not parent/child.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyVoiceSessionTokenOptions {
  /** The token from the WebSocket upgrade query string. */
  readonly token: string | null | undefined;
  /** The expected session reference (e.g. "voice_<uuid>"). */
  readonly sessionRef: string;
  /** The expiry as a string of non-negative integer milliseconds. */
  readonly exp: string | null | undefined;
  /** The shared secret used to sign the token. */
  readonly secret: string;
  /** Optional: current time in ms. Defaults to Date.now. Injected for tests. */
  readonly now?: () => number;
  /**
   * Optional: tolerance window in ms for the expiry check. Default 0.
   * Use this if server and client clocks are skewed.
   */
  readonly toleranceMs?: number;
  /**
   * When true, return true unconditionally. Use ONLY in tests.
   */
  readonly skipVerification?: boolean;
}

/**
 * Compute the expected voice-session token for a given session ref
 * and expiry. Exposed for tests and the example app's token generator.
 */
export function signVoiceSessionToken(secret: string, sessionRef: string, expMs: number): string {
  return createHmac("sha256", secret).update(`${sessionRef}.${expMs}`).digest("hex");
}

/**
 * Verify a voice-session token. Returns true on success, false
 * otherwise. Does NOT throw for invalid input — callers should branch
 * on the boolean.
 *
 * @example
 *   ```ts
 *   const ok = verifyVoiceSessionToken({
 *     token: url.searchParams.get("token"),
 *     sessionRef: matchPathParams.url.sessionRef,
 *     exp: url.searchParams.get("exp"),
 *     secret: process.env.VOICE_TOKEN_SECRET!,
 *   });
 *   if (!ok) return new Response("invalid token", { status: 401 });
 *   ```
 */
export function verifyVoiceSessionToken(options: VerifyVoiceSessionTokenOptions): boolean {
  if (options.skipVerification) {
    return true;
  }
  if (typeof options.token !== "string" || typeof options.exp !== "string") {
    return false;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(options.token)) {
    return false;
  }
  // Canonical parse: reject anything that isn't a pure integer.
  // (e.g. "123abc", "-1", "1.5", "  123  ").
  if (!/^\d+$/.test(options.exp)) {
    return false;
  }
  const expMs = Number(options.exp);
  if (!Number.isSafeInteger(expMs) || expMs < 0) {
    return false;
  }
  const toleranceMs = options.toleranceMs ?? 0;
  const now = (options.now ?? Date.now)();
  if (now > expMs + toleranceMs) {
    return false;
  }
  const provided = Buffer.from(options.token, "hex");
  const expected = Buffer.from(
    signVoiceSessionToken(options.secret, options.sessionRef, expMs),
    "hex",
  );
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
