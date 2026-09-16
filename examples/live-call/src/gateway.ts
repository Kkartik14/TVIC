import type { IncomingMessage, ServerResponse } from "node:http";

import type { CallId } from "@tvic/core";
import { verifyTwilioSignature } from "@tvic/providers";
import type { TwilioParams } from "@tvic/providers";

import { readFormBody, type CallIdentity, type StreamTokenStore } from "./security.js";

/**
 * Pure, testable gateway HTTP/WS handlers, extracted from `main.ts` so the ingress
 * security surface (signature checks, body limits, token issue/consume, identity
 * binding) can be exercised against a real NodeMediaPlane without the provider stack.
 */
export interface TwimlHandlerDeps {
  readonly tokenStore: StreamTokenStore;
  readonly twilioAuthToken: string | undefined;
  readonly publicHost: string;
  readonly twimlPath: string;
  readonly mediaPath: string;
  readonly maxBodyBytes: number;
  /** Bounded duplicate-webhook window keyed by the authenticated Twilio call. */
  readonly replayWindowMs?: number;
  readonly maxReplayEntries?: number;
  readonly now?: () => number;
  readonly logger?: { warn(message: string): void };
}

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60_000;
const DEFAULT_MAX_REPLAY_ENTRIES = 10_000;

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function identityFromParams(params: TwilioParams): CallIdentity | null {
  const requiredSingle = (value: string | readonly string[] | undefined): string | null => {
    const candidate =
      typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;
    const normalized = candidate?.trim();
    return normalized || null;
  };
  const from = requiredSingle(params.From);
  const to = requiredSingle(params.To);
  const twilioCallSid = requiredSingle(params.CallSid);
  const accountSid = params.AccountSid === undefined ? null : requiredSingle(params.AccountSid);
  if (!from || !to || !twilioCallSid || (params.AccountSid !== undefined && !accountSid)) {
    return null;
  }
  return {
    from,
    to,
    twilioCallSid,
    ...(accountSid ? { accountSid } : {}),
  };
}

export function twimlResponse(
  callId: CallId,
  token: string,
  expMs: number,
  opts: { readonly publicHost: string; readonly mediaPath: string },
): string {
  const path = opts.mediaPath.replace(":callId", callId);
  const query = new URLSearchParams({ token, exp: String(expMs) });
  const streamUrl = `wss://${opts.publicHost}${path}?${query}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escapeXmlAttribute(streamUrl)}" />`,
    "  </Connect>",
    "</Response>",
  ].join("\n");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Builds the NodeMediaPlane `onRequest` handler for the Twilio TwiML webhook. */
export function createTwimlRequestHandler(
  deps: TwimlHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const warn = deps.logger?.warn ?? (() => undefined);
  const replayWindowMs = deps.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  const maxReplayEntries = deps.maxReplayEntries ?? DEFAULT_MAX_REPLAY_ENTRIES;
  if (!Number.isSafeInteger(replayWindowMs) || replayWindowMs < 1) {
    throw new Error("replayWindowMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1) {
    throw new Error("maxReplayEntries must be a positive integer");
  }
  const replayedCallSids = new Map<string, number>();
  const pruneReplays = (now: number): void => {
    for (const [key, expiresAt] of replayedCallSids) {
      if (expiresAt <= now) replayedCallSids.delete(key);
    }
  };
  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${deps.publicHost}`);
    if (url.pathname !== deps.twimlPath) {
      return false;
    }

    // Limits are enforced before buffering: no unauthenticated memory DoS.
    const body = await readFormBody(request, deps.maxBodyBytes);
    if (!body.ok) {
      response.writeHead(body.status, { "content-type": "text/plain" });
      response.end(body.message);
      return true;
    }

    if (deps.twilioAuthToken) {
      const signature = headerValue(request.headers["x-twilio-signature"]);
      const fullUrl = `https://${deps.publicHost}${url.pathname}${url.search}`;
      if (
        !signature ||
        !verifyTwilioSignature({
          signature,
          url: fullUrl,
          params: body.params,
          authToken: deps.twilioAuthToken,
        })
      ) {
        warn("[twiml] rejected request with invalid Twilio signature");
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("invalid signature");
        return true;
      }
    } else {
      warn("[twiml] UNAUTHENTICATED request served (TWILIO_AUTH_TOKEN unset; dev only)");
    }

    // Bind the verified Twilio identity to the single-use token so the media plane
    // builds the Call from real From/To/CallSid without re-trusting the WS client.
    const identity = identityFromParams(body.params);
    if (!identity) {
      warn("[twiml] rejected request with incomplete Twilio caller identity");
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("incomplete Twilio identity");
      return true;
    }
    const now = deps.now?.() ?? Date.now();
    pruneReplays(now);
    const replayKey = `${identity.accountSid ?? ""}\u0000${identity.twilioCallSid}`;
    if (replayedCallSids.has(replayKey)) {
      warn("[twiml] rejected a duplicate Twilio webhook for the same CallSid");
      response.writeHead(409, { "content-type": "text/plain" });
      response.end("duplicate Twilio webhook");
      return true;
    }
    if (replayedCallSids.size >= maxReplayEntries) {
      warn("[twiml] replay guard capacity reached");
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("replay guard unavailable");
      return true;
    }
    deps.tokenStore.prune();
    const { callId, token, expMs } = deps.tokenStore.issue(identity);
    replayedCallSids.set(replayKey, now + replayWindowMs);
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(twimlResponse(callId as CallId, token, expMs, deps));
    return true;
  };
}

/** Consumes the single-use stream token, returning the bound identity or null. */
export function authorizeStreamConnection(
  tokenStore: StreamTokenStore,
  callId: string | undefined,
  token: string | null,
  exp: string | null,
): CallIdentity | null {
  if (callId === undefined) {
    return null;
  }
  return tokenStore.consume(callId, token, exp);
}
