import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CallId } from "@tvic/core";
import { canonicalizeTwilioData, verifyTwilioSignature } from "@tvic/providers";
import type { TwilioParams } from "@tvic/providers";

import {
  readFormBody,
  type CallIdentity,
  type StreamTokenStore,
  type TwimlReplayStore,
} from "./security.js";

/**
 * Pure, testable gateway HTTP/WS handlers, extracted from `main.ts` so the ingress
 * security surface (signature checks, body limits, token issue/consume, identity
 * binding) can be exercised against a real NodeMediaPlane without the provider stack.
 */
export interface TwimlHandlerDeps {
  readonly tokenStore: StreamTokenStore;
  readonly replayStore: TwimlReplayStore;
  readonly twilioAuthToken: string | undefined;
  /** Only true for explicitly enabled non-production development tunnels. */
  readonly allowUnauthenticatedTwiml: boolean;
  readonly replayTtlMs: number;
  readonly publicHost: string;
  readonly twimlPath: string;
  readonly mediaPath: string;
  readonly maxBodyBytes: number;
  readonly logger?: { warn(message: string): void };
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function singleParam(value: string | readonly string[] | undefined): string | undefined {
  const candidate = typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;
  const normalized = candidate?.trim();
  return normalized || undefined;
}

/**
 * Returns the stable idempotency key for the initial TwiML side effect.
 * Twilio's account and call identifiers are required because a request without
 * them cannot be safely distinguished from another call.
 */
export function twimlReplayKey(params: TwilioParams, endpoint: string): string | null {
  const accountSid = singleParam(params.AccountSid);
  const callSid = singleParam(params.CallSid);
  if (!accountSid || !callSid) return null;
  const digest = createHash("sha256")
    .update(`${accountSid}\0${callSid}\0${endpoint}\0initial-twiml`, "utf8")
    .digest("hex");
  return `initial-twiml:${digest}`;
}

function requestHash(fullUrl: string, params: TwilioParams): string {
  return createHash("sha256").update(canonicalizeTwilioData(fullUrl, params)).digest("hex");
}

export function identityFromParams(params: TwilioParams, replayKey?: string): CallIdentity | null {
  const from = singleParam(params.From);
  const to = singleParam(params.To);
  const twilioCallSid = singleParam(params.CallSid);
  const accountSid = params.AccountSid === undefined ? undefined : singleParam(params.AccountSid);
  if (!from || !to || !twilioCallSid || (params.AccountSid !== undefined && !accountSid)) {
    return null;
  }
  return {
    from,
    to,
    twilioCallSid,
    ...(accountSid ? { accountSid } : {}),
    ...(replayKey ? { replayKey } : {}),
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

    if (!deps.twilioAuthToken && !deps.allowUnauthenticatedTwiml) {
      warn("[twiml] rejected request because Twilio authentication is not configured");
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("webhook authentication is not configured");
      return true;
    }

    const fullUrl = `https://${deps.publicHost}${url.pathname}${url.search}`;
    if (deps.twilioAuthToken) {
      const signature = headerValue(request.headers["x-twilio-signature"]);
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
      warn("[twiml] UNAUTHENTICATED request served (explicit development mode only)");
    }

    // Require the identifiers that make the initial TwiML side effect
    // idempotent before reserving replay state or minting a stream token.
    const replayKey = twimlReplayKey(body.params, url.pathname);
    if (!replayKey) {
      warn("[twiml] rejected request without AccountSid and CallSid");
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("AccountSid and CallSid are required");
      return true;
    }
    // Bind the remaining verified Twilio identity to the single-use token.
    const identity = identityFromParams(body.params, replayKey);
    if (!identity) {
      warn("[twiml] rejected request with incomplete Twilio caller identity");
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("incomplete Twilio identity");
      return true;
    }

    deps.replayStore.prune();
    const claim = await deps.replayStore.acquire(
      replayKey,
      requestHash(fullUrl, body.params),
      deps.replayTtlMs,
    );
    if (claim.kind === "conflict") {
      warn("[twiml] rejected conflicting retry for an existing Twilio call");
      response.writeHead(409, { "content-type": "text/plain" });
      response.end("conflicting webhook retry");
      return true;
    }
    if (claim.kind === "busy") {
      response.writeHead(503, { "content-type": "text/plain", "retry-after": "1" });
      response.end("webhook retry is already being processed");
      return true;
    }
    if (claim.kind === "replayed") {
      response.writeHead(200, { "content-type": "text/xml" });
      response.end(claim.response);
      return true;
    }
    if (claim.kind === "consumed") {
      response.writeHead(409, { "content-type": "text/plain" });
      response.end("webhook token was already consumed");
      return true;
    }

    try {
      // Reserve the replay key before issuing the single-use stream token. A
      // retry or concurrent delivery therefore cannot create a second token.
      deps.tokenStore.prune();
      const { callId, token, expMs } = deps.tokenStore.issue({ ...identity, replayKey });
      const twiml = twimlResponse(callId as CallId, token, expMs, deps);
      await claim.complete(twiml);
      response.writeHead(200, { "content-type": "text/xml" });
      response.end(twiml);
    } catch (error) {
      await claim.abort().catch(() => undefined);
      throw error;
    }
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
