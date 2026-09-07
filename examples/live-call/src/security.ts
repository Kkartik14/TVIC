import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TwilioParams } from "@tvic/providers";

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
      if (
        typeof token !== "string" ||
        typeof exp !== "string" ||
        !/^\d+$/.test(exp) ||
        !/^[0-9a-fA-F]{64}$/.test(token)
      ) {
        return null;
      }
      const expMs = Number(exp);
      if (!Number.isSafeInteger(expMs) || expMs < 0) return null;
      const entry = issued.get(callId);
      if (!entry || entry.expMs !== expMs || now() > expMs) {
        return null;
      }
      const expectedHex = sign(callId, expMs);
      const provided = Buffer.from(token, "hex");
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

export type ReadFormBodyResult =
  | { readonly ok: true; readonly params: TwilioParams }
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
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
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

  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    const previous = params[key];
    if (previous === undefined) {
      params[key] = value;
    } else if (typeof previous === "string") {
      params[key] = [previous, value];
    } else {
      previous.push(value);
    }
  }
  return { ok: true, params };
}
