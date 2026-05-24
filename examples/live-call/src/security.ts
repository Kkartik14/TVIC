import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Verified Twilio call identity, bound to a stream token at issue time. */
export interface CallIdentity {
  readonly from: string;
  readonly to: string;
  readonly twilioCallSid?: string;
  readonly accountSid?: string;
}

export interface IssuedStreamToken {
  readonly callId: string;
  readonly token: string;
  readonly expMs: number;
}

export interface StreamTokenStore {
  issue(identity: CallIdentity): IssuedStreamToken;
  /** Returns the bound identity if the token is valid and unused, else null. */
  consume(callId: string, token: string | null, exp: string | null): CallIdentity | null;
  prune(): void;
}

/**
 * Single-use, TTL-bounded HMAC stream tokens. A token is minted per TwiML request
 * and consumed exactly once when the media WebSocket connects.
 */
export function createStreamTokenStore(
  secret: string,
  ttlMs: number,
  now: () => number = Date.now,
): StreamTokenStore {
  const issued = new Map<string, { readonly expMs: number; readonly identity: CallIdentity }>();
  const sign = (callId: string, expMs: number): string =>
    createHmac("sha256", secret).update(`${callId}.${expMs}`).digest("hex");

  return {
    issue(identity): IssuedStreamToken {
      const callId = `call_${randomUUID()}`;
      const expMs = now() + ttlMs;
      issued.set(callId, { expMs, identity });
      return { callId, token: sign(callId, expMs), expMs };
    },
    consume(callId, token, exp): CallIdentity | null {
      // Canonical parse: reject anything that isn't a pure integer (e.g. "123abc").
      if (!token || exp === null || !/^\d+$/.test(exp)) {
        return null;
      }
      const expMs = Number.parseInt(exp, 10);
      const entry = issued.get(callId);
      if (!entry || entry.expMs !== expMs || now() > expMs) {
        return null;
      }
      const expectedHex = sign(callId, expMs);
      let provided: Buffer;
      try {
        provided = Buffer.from(token, "hex");
      } catch {
        return null;
      }
      const expected = Buffer.from(expectedHex, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return null;
      }
      issued.delete(callId); // single use
      return entry.identity;
    },
    prune(): void {
      const t = now();
      for (const [callId, entry] of issued) {
        if (t > entry.expMs) {
          issued.delete(callId);
        }
      }
    },
  };
}

/** base64(HMAC-SHA1(authToken, url + sorted(key+value))). Constant-time compared. */
export function validTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  let data = fullUrl;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  const provided = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
}

export type ReadFormBodyResult =
  | { readonly ok: true; readonly params: Record<string, string> }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Reads a form-encoded POST body with hard limits applied BEFORE buffering, so an
 * unauthenticated public endpoint cannot be used for a memory-exhaustion DoS.
 */
export async function readFormBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<ReadFormBodyResult> {
  if ((request.method ?? "GET").toUpperCase() !== "POST") {
    return { ok: false, status: 405, message: "method not allowed" };
  }
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return { ok: false, status: 415, message: "unsupported media type" };
  }
  const lengthHeader = request.headers["content-length"];
  const declared = lengthHeader
    ? Number.parseInt(Array.isArray(lengthHeader) ? (lengthHeader[0] ?? "") : lengthHeader, 10)
    : undefined;
  if (declared !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, message: "payload too large" };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      request.destroy();
      return { ok: false, status: 413, message: "payload too large" };
    }
    chunks.push(buffer);
  }

  return {
    ok: true,
    params: Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))),
  };
}
