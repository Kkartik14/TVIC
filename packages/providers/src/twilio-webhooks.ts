// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 T-vic contributors

import { createHmac, timingSafeEqual } from "node:crypto";

export type TwilioParamValue = string | readonly string[];

export type TwilioParams = Readonly<Record<string, TwilioParamValue>>;

export type TwilioFlatParams = Readonly<Record<string, string>>;

export interface VerifyTwilioOptions {
  readonly signature: string;
  readonly url: string;
  readonly params: TwilioFlatParams | TwilioParams;
  readonly authToken: string;
}

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
      for (const v of Array.from(new Set(value)).sort()) {
        parts.push(key, v);
      }
    }
  }
  return Buffer.from(parts.join(""), "utf8");
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: TwilioFlatParams | TwilioParams,
): string {
  return createHmac("sha1", authToken).update(canonicalizeTwilioData(url, params)).digest("base64");
}

export function verifyTwilioSignature(options: VerifyTwilioOptions): boolean {
  if (!options.signature || options.signature.length === 0) {
    return false;
  }
  if (options.authToken !== undefined && options.authToken.length === 0) {
    throw new Error("verifyTwilioSignature: `authToken` must be a non-empty string");
  }
  const signatureMatch = /^[A-Za-z0-9+/]{27,28}={0,2}$/.exec(options.signature);
  if (signatureMatch?.[0] !== options.signature) {
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
