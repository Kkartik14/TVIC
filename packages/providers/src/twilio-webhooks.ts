// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 T-vic contributors
//
// Twilio webhook signature verification.
//
// Twilio signs inbound webhooks with X-Twilio-Signature, computed as
//   base64( HMAC-SHA1( authToken, fullUrl + sortedConcatenation(key + value) ) )
// See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// The signature covers the FULL URL (with query string) plus the POST
// parameters sorted lexicographically by key. There is no timestamp in
// the signature, so callers should additionally check the request
// timestamp if replay protection is required.
//
// This module exposes:
//   - verifyTwilioSignature(): the canonical signature check
//   - computeTwilioSignature(): helper to compute the expected signature
//     (useful for tests; the example apps use this in the signature
//     generator to produce golden fixtures)
//
// Arrays: Twilio occasionally sends repeated param keys (e.g. multiple
// RecordingChannels). The `params` overload accepts either a flat string
// map or a string-or-string-array map. When a key has multiple values,
// the SDK serializes them in the order Twilio delivered them, joined as
// a single string with the value-array joined by Twilio's documented
// behavior (each occurrence appended).
//
// Security note: callers MUST also verify the request's timestamp
// themselves. Twilio's signature does not include a timestamp.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A single param value or an array of repeated param values. Twilio sends
 * each value as a separate URL-encoded occurrence in the POST body, so a
 * key that appears N times in the request will appear N times here.
 */
export type TwilioParamValue = string | readonly string[];

/**
 * The set of POST parameters signed by Twilio. Twilio sorts by key (NOT by
 * the order they appear in the body), and concatenates `key + value` for
 * each entry, with no separator.
 */
export type TwilioParams = Readonly<Record<string, TwilioParamValue>>;

/**
 * The simplest form: a single string value per key. Most webhooks fit this
 * shape; use `TwilioParams` directly only when you need to handle repeated
 * keys.
 */
export type TwilioFlatParams = Readonly<Record<string, string>>;

export interface VerifyTwilioOptions {
  /** The X-Twilio-Signature header value. */
  readonly signature: string;
  /** The full request URL (with query string). */
  readonly url: string;
  /** The parsed POST params, as a key-value map. */
  readonly params: TwilioFlatParams | TwilioParams;
  /**
   * The Twilio auth token. Used as the HMAC key. Required.
   *
   * For token rotation, wrap the verifier yourself:
   *   const ok = verifyTwilioSignature({...authTokenA}) ||
   *             verifyTwilioSignature({...authTokenB});
   */
  readonly authToken: string;
  /**
   * When true, return true unconditionally. Use this ONLY in tests, never
   * in production. Defaults to false.
   */
  readonly skipVerification?: boolean;
}

/**
 * Canonicalize the params for signing. Sorts keys lexicographically and
 * concatenates `key + value` (or `key + v1 + key + v2 + ...` for arrays).
 *
 * Twilio's documented algorithm: sort the parameter keys alphabetically
 * and append `key + value` to the data string in that order. When a key
 * appears multiple times, each occurrence is appended in document order.
 */
function isStringValue(value: TwilioParamValue): value is string {
  return typeof value === "string";
}

export function canonicalizeTwilioData(
  url: string,
  params: TwilioFlatParams | TwilioParams,
): Buffer {
  const keys = Object.keys(params).sort();
  const parts: string[] = [url];
  for (const key of keys) {
    const value = params[key];
    if (value === undefined) {
      continue;
    }
    if (isStringValue(value)) {
      parts.push(key, value);
    } else {
      for (const v of value) {
        parts.push(key, v);
      }
    }
  }
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * Compute the expected signature for a given auth token, URL, and params.
 * Exposed for tests and golden fixtures. Production code should call
 * `verifyTwilioSignature` instead.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: TwilioFlatParams | TwilioParams,
): string {
  return createHmac("sha1", authToken).update(canonicalizeTwilioData(url, params)).digest("base64");
}

/**
 * Verify a Twilio X-Twilio-Signature header. Returns true if the signature
 * matches the configured auth token.
 *
 * Returns false (does not throw) for malformed inputs:
 *   - missing or empty signature
 *   - signature is not valid base64 of length 28
 *   - signature decodes to a byte array that does not match the expected HMAC
 *
 * Throws (programmer error, not attacker error):
 *   - when `authToken` is empty string
 *
 * @remarks
 * Twilio's signature does NOT include a timestamp or nonce. To prevent replay,
 * the caller MUST enforce an idempotency check (e.g. dedupe by `CallSid` +
 * `MessageSid` with a TTL).
 *
 * @example
 *   ```ts
 *   const sig = Array.isArray(req.headers["x-twilio-signature"])
 *     ? req.headers["x-twilio-signature"][0]
 *     : req.headers["x-twilio-signature"];
 *   const ok = verifyTwilioSignature({
 *     signature: sig,
 *     url: `https://example.com${req.url}`,
 *     params: parsedFormBody,
 *     authToken: process.env.TWILIO_AUTH_TOKEN!,
 *   });
 *   if (!ok) return new Response("invalid signature", { status: 403 });
 *   ```
 */
export function verifyTwilioSignature(options: VerifyTwilioOptions): boolean {
  if (options.skipVerification) {
    return true;
  }
  if (!options.signature || options.signature.length === 0) {
    return false;
  }
  if (options.authToken !== undefined && options.authToken.length === 0) {
    throw new Error("verifyTwilioSignature: `authToken` must be a non-empty string");
  }
  if (!/^[A-Za-z0-9+/]{27,28}={0,2}$/.test(options.signature)) {
    return false;
  }
  const provided = Buffer.from(options.signature, "base64");
  if (provided.length !== 20) {
    return false;
  }
  if (options.authToken === undefined) {
    throw new Error("verifyTwilioSignature: `authToken` is required");
  }
  const expected = Buffer.from(
    computeTwilioSignature(options.authToken, options.url, options.params),
    "base64",
  );
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
