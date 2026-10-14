// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 T-vic contributors

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyVoiceSessionTokenOptions {
  readonly token: string | null | undefined;
  readonly sessionRef: string;
  readonly exp: string | null | undefined;
  readonly secret: string;
  readonly now?: () => number;
  readonly toleranceMs?: number;
}

export function signVoiceSessionToken(secret: string, sessionRef: string, expMs: number): string {
  if (secret.length === 0) {
    throw new Error("signVoiceSessionToken: `secret` must be a non-empty string");
  }
  if (!Number.isSafeInteger(expMs) || expMs < 0) {
    throw new Error("signVoiceSessionToken: `expMs` must be a non-negative safe integer");
  }
  return createHmac("sha256", secret).update(`${sessionRef}.${expMs}`).digest("hex");
}

export function verifyVoiceSessionToken(options: VerifyVoiceSessionTokenOptions): boolean {
  if (typeof options.secret !== "string" || options.secret.length === 0) {
    return false;
  }
  if (typeof options.token !== "string" || typeof options.exp !== "string") {
    return false;
  }
  const tokenMatch = /^[0-9a-fA-F]{64}$/.exec(options.token);
  if (tokenMatch?.[0] !== options.token) {
    return false;
  }
  const expiryMatch = /^\d+$/.exec(options.exp);
  if (expiryMatch?.[0] !== options.exp) {
    return false;
  }
  const expMs = Number(options.exp);
  if (!Number.isSafeInteger(expMs) || expMs < 0) {
    return false;
  }
  const toleranceMs = options.toleranceMs ?? 0;
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    return false;
  }
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now) || now - expMs > toleranceMs) {
    return false;
  }
  const provided = Buffer.from(options.token, "hex");
  const expected = Buffer.from(
    signVoiceSessionToken(options.secret, options.sessionRef, expMs),
    "hex",
  );
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
