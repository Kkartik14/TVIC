import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { canonicalizeTwilioData, verifyTwilioSignature } from "@tvic/providers";
import type { TwilioParams } from "@tvic/providers";
import type { CallId, SessionId, TelephonyProvider } from "voice-runtime";

import {
  readFormBody,
  type CallIdentity,
  type StreamTokenStore,
  type TwimlReplayStore,
} from "./security.js";

/** Dependencies for Twilio webhook and media-stream authorization handlers. */
export interface TwimlHandlerDeps {
  readonly tokenStore: StreamTokenStore;
  readonly replayStore: TwimlReplayStore;
  readonly twilioAuthToken: string | undefined;
  /** When set, reject otherwise valid requests for a different Twilio account. */
  readonly expectedAccountSid?: string;
  /** Only true for explicitly enabled non-production development tunnels. */
  readonly allowUnauthenticatedTwiml: boolean;
  readonly replayTtlMs: number;
  readonly publicHost: string;
  readonly twimlPath: string;
  readonly mediaPath: string;
  readonly maxBodyBytes: number;
  readonly logger?: { info?(message: string): void; warn(message: string): void };
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

export function identityFromParams(
  params: TwilioParams,
  replayKey?: string,
  callContext?: { readonly callId: CallId; readonly sessionId: SessionId },
): CallIdentity | null {
  const from = singleParam(params.From);
  const to = singleParam(params.To);
  const twilioCallSid = singleParam(params.CallSid);
  const callDirection = singleParam(params.Direction);
  const accountSid = params.AccountSid === undefined ? undefined : singleParam(params.AccountSid);
  if (!from || !to || !twilioCallSid || (params.AccountSid !== undefined && !accountSid)) {
    return null;
  }
  return {
    from,
    to,
    direction: callDirection?.startsWith("outbound") ? "outbound" : "inbound",
    twilioCallSid,
    ...(accountSid ? { accountSid } : {}),
    ...(callContext ? { callId: callContext.callId, sessionId: callContext.sessionId } : {}),
    ...(replayKey ? { replayKey } : {}),
  };
}

function signedCallContext(
  url: URL,
):
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly callId: CallId; readonly sessionId: SessionId }
  | { readonly kind: "invalid" } {
  const callIds = url.searchParams.getAll("tvicCallId");
  const sessionIds = url.searchParams.getAll("tvicSessionId");
  if (callIds.length === 0 && sessionIds.length === 0) return { kind: "none" };
  if (callIds.length !== 1 || sessionIds.length !== 1) return { kind: "invalid" };
  const callId = callIds[0]?.trim();
  const sessionId = sessionIds[0]?.trim();
  const safeId = /^[A-Za-z0-9_-]{1,160}$/u;
  if (!callId || !sessionId || !safeId.test(callId) || !safeId.test(sessionId)) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    callId: callId as CallId,
    sessionId: sessionId as SessionId,
  };
}

export function twimlResponse(
  callId: CallId,
  token: string,
  expMs: number,
  opts: { readonly publicHost: string; readonly mediaPath: string },
): string {
  const path = opts.mediaPath.replace(":callId", callId);
  const streamUrl = `wss://${opts.publicHost}${path}`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${escapeXmlAttribute(streamUrl)}">`,
    `      <Parameter name="streamToken" value="${escapeXmlAttribute(token)}" />`,
    `      <Parameter name="streamTokenExpiresAt" value="${expMs}" />`,
    "    </Stream>",
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
    const callContext = signedCallContext(url);
    if (callContext.kind === "invalid") {
      warn("[twiml] rejected invalid outbound SDK call context");
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("invalid outbound call context");
      return true;
    }
    const identity = identityFromParams(
      body.params,
      replayKey,
      callContext.kind === "valid" ? callContext : undefined,
    );
    if (!identity || (callContext.kind === "valid" && identity.direction !== "outbound")) {
      warn("[twiml] rejected request with incomplete Twilio caller identity");
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("incomplete Twilio identity");
      return true;
    }
    if (deps.expectedAccountSid && identity.accountSid !== deps.expectedAccountSid) {
      warn("[twiml] rejected request for a different Twilio account");
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Twilio account mismatch");
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
      deps.logger?.info?.(
        `[twiml] accepted call ${identity.twilioCallSid} direction=${identity.direction ?? "inbound"}`,
      );
    } catch (error) {
      await claim.abort().catch(() => undefined);
      throw error;
    }
    return true;
  };
}

export interface TwilioStatusHandlerDeps {
  readonly telephony: TelephonyProvider & TwilioCallStatusReceiver;
  readonly accountSid: string;
  readonly authToken: string | undefined;
  readonly publicHost: string;
  readonly statusPath: string;
  readonly maxBodyBytes: number;
  readonly logger?: { info?(message: string): void; warn(message: string): void };
}

export interface TwilioCallStatusReceiver {
  receiveCallStatus(callId: CallId, sessionId: SessionId, callSid: string, value: unknown): boolean;
}

/** Handles signature-verified Twilio call progress callbacks for SDK dials. */
export function createTwilioStatusRequestHandler(
  deps: TwilioStatusHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const warn = deps.logger?.warn ?? (() => undefined);
  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${deps.publicHost}`);
    if (url.pathname !== deps.statusPath) return false;
    const body = await readFormBody(request, deps.maxBodyBytes);
    if (!body.ok) {
      response.writeHead(body.status, { "content-type": "text/plain" });
      response.end(body.message);
      return true;
    }
    if (!deps.authToken) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("webhook authentication is not configured");
      return true;
    }
    const signature = headerValue(request.headers["x-twilio-signature"]);
    const fullUrl = `https://${deps.publicHost}${url.pathname}${url.search}`;
    if (
      !signature ||
      !verifyTwilioSignature({
        signature,
        url: fullUrl,
        params: body.params,
        authToken: deps.authToken,
      })
    ) {
      warn("[twilio-status] rejected request with invalid Twilio signature");
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("invalid signature");
      return true;
    }
    const context = signedCallContext(url);
    const callSid = singleParam(body.params.CallSid);
    const accountSid = singleParam(body.params.AccountSid);
    const callStatus = singleParam(body.params.CallStatus);
    if (
      context.kind !== "valid" ||
      !callSid ||
      !/^CA[0-9a-f]{32}$/iu.test(callSid) ||
      accountSid !== deps.accountSid ||
      !callStatus
    ) {
      warn("[twilio-status] rejected callback with incomplete or mismatched call identity");
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("incomplete Twilio call identity");
      return true;
    }
    const accepted = deps.telephony.receiveCallStatus(
      context.callId,
      context.sessionId,
      callSid,
      callStatus,
    );
    if (accepted) {
      deps.logger?.info?.(`[twilio-status] call ${context.callId} status=${callStatus}`);
    } else {
      deps.logger?.info?.(`[twilio-status] no pending SDK dial for call ${context.callId}`);
    }
    response.writeHead(204);
    response.end();
    return true;
  };
}

export interface OutboundCallRequestHandlerDeps {
  readonly token: string | undefined;
  readonly path: string;
  readonly maxBodyBytes: number;
  readonly startCall: (to: string) => Promise<{
    readonly callId: string;
    readonly sessionId: string;
    readonly callSid: string;
  }>;
  readonly logger?: { warn(message: string): void };
}

/** Authenticated host endpoint used by the guarded real-call runner. */
export function createOutboundCallRequestHandler(
  deps: OutboundCallRequestHandlerDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const warn = deps.logger?.warn ?? (() => undefined);
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== deps.path) return false;
    if ((request.method ?? "GET").toUpperCase() !== "POST") {
      response.writeHead(405, { allow: "POST", "content-type": "text/plain" });
      response.end("method not allowed");
      return true;
    }
    if (!deps.token) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return true;
    }
    const authorization = headerValue(request.headers.authorization);
    const match = authorization?.match(/^Bearer ([^\s]+)$/u);
    const provided = match?.[1];
    const expectedBytes = Buffer.from(deps.token, "utf8");
    const providedBytes = Buffer.from(provided ?? "", "utf8");
    if (
      !provided ||
      providedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(providedBytes, expectedBytes)
    ) {
      response.writeHead(401, { "www-authenticate": "Bearer", "content-type": "text/plain" });
      response.end("unauthorized");
      return true;
    }
    const contentType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      response.writeHead(415, { "content-type": "text/plain" });
      response.end("unsupported media type");
      return true;
    }
    const lengthHeader = headerValue(request.headers["content-length"]);
    const declaredBytes = lengthHeader === null ? undefined : Number(lengthHeader);
    if (
      declaredBytes !== undefined &&
      Number.isFinite(declaredBytes) &&
      declaredBytes > deps.maxBodyBytes
    ) {
      response.writeHead(413, { "content-type": "text/plain" });
      response.end("payload too large");
      return true;
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      totalBytes += buffer.length;
      if (totalBytes > deps.maxBodyBytes) {
        response.writeHead(413, { "content-type": "text/plain" });
        response.end("payload too large");
        return true;
      }
      chunks.push(buffer);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("invalid JSON");
      return true;
    }
    const to = isRecord(payload) && typeof payload.to === "string" ? payload.to.trim() : "";
    if (
      !isRecord(payload) ||
      Object.keys(payload).some((key) => key !== "to") ||
      !/^\+[1-9]\d{7,14}$/u.test(to)
    ) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("body must contain a single E.164 'to' number");
      return true;
    }
    try {
      const created = await deps.startCall(to);
      response.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(created));
    } catch (error) {
      warn(`[outbound] SDK dial failed (${safeErrorCode(error)})`);
      response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "outbound call could not be started" }));
    }
    return true;
  };
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
