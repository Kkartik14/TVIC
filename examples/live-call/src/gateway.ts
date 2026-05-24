import type { IncomingMessage, ServerResponse } from "node:http";

import type { CallId } from "@tvic/core";

import {
  readFormBody,
  validTwilioSignature,
  type CallIdentity,
  type StreamTokenStore,
} from "./security.js";

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
  readonly logger?: { warn(message: string): void };
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function identityFromParams(params: Record<string, string>): CallIdentity {
  return {
    from: params.From ?? "unknown",
    to: params.To ?? "unknown",
    ...(params.CallSid ? { twilioCallSid: params.CallSid } : {}),
    ...(params.AccountSid ? { accountSid: params.AccountSid } : {}),
  };
}

export function twimlResponse(
  callId: CallId,
  token: string,
  expMs: number,
  opts: { readonly publicHost: string; readonly mediaPath: string },
): string {
  const path = opts.mediaPath.replace(":callId", callId);
  const streamUrl = `wss://${opts.publicHost}${path}?token=${token}&exp=${expMs}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${streamUrl}" />`,
    "  </Connect>",
    "</Response>",
  ].join("\n");
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

    // Limits are enforced before buffering — no unauthenticated memory DoS.
    const body = await readFormBody(request, deps.maxBodyBytes);
    if (!body.ok) {
      response.writeHead(body.status, { "content-type": "text/plain" });
      response.end(body.message);
      return true;
    }

    if (deps.twilioAuthToken) {
      const signature = headerValue(request.headers["x-twilio-signature"]);
      const fullUrl = `https://${deps.publicHost}${deps.twimlPath}`;
      if (
        !signature ||
        !validTwilioSignature(deps.twilioAuthToken, fullUrl, body.params, signature)
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
    deps.tokenStore.prune();
    const { callId, token, expMs } = deps.tokenStore.issue(identityFromParams(body.params));
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
