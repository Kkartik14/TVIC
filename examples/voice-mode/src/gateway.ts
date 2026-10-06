import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConnectionObservabilityEvent, UpgradeAuthorization } from "voice-runtime";

import {
  originAllowed,
  verifyAppUserToken,
  constantTimeStringEqual,
  type VoiceMode,
  type VoiceSessionIdentity,
  type VoiceSessionStore,
} from "./security.js";

export interface VoiceGatewayDeps {
  readonly tokenStore: VoiceSessionStore;
  readonly allowedOrigins: readonly string[];
  readonly authSecret: string;
  readonly adminSecret: string;
  readonly maxBodyBytes?: number;
  readonly mintRateLimitPerMinute?: number;
  readonly maxTrackedMintUsers?: number;
  readonly now?: () => number;
  /** Host side effects should check cancellation before starting; a completed telephony action cannot be rolled back. */
  readonly terminateSession?: (sessionRef: string, signal: AbortSignal) => Promise<boolean>;
  /** Host side effects should check cancellation before starting; a completed telephony action cannot be rolled back. */
  readonly supersedeSession?: (sessionRef: string, signal: AbortSignal) => Promise<void>;
  readonly onConnectionEvent?: (event: ConnectionObservabilityEvent) => void;
  /** Optional fixed asset root for the reference browser client. */
  readonly clientRoot?: URL;
}

export interface VoiceMintRateLimiter {
  allow(userId: string): "allowed" | "rate_limited" | "capacity_exceeded";
  readonly trackedUsers: number;
}

export function createVoiceMintRateLimiter(options: {
  readonly limitPerMinute: number;
  readonly maxTrackedUsers?: number;
  readonly now?: () => number;
}): VoiceMintRateLimiter {
  const MAX_ATTEMPTS_PER_USER = 1_000;
  const MAX_TRACKED_USERS_LIMIT = 10_000;
  const MAX_TRACKED_USERS = options.maxTrackedUsers ?? 10_000;
  const MAX_PRUNED_USERS_PER_REQUEST = 32;
  if (
    !Number.isSafeInteger(options.limitPerMinute) ||
    options.limitPerMinute < 1 ||
    options.limitPerMinute > MAX_ATTEMPTS_PER_USER
  ) {
    throw new RangeError(`limitPerMinute must be between 1 and ${MAX_ATTEMPTS_PER_USER}`);
  }
  if (
    !Number.isSafeInteger(MAX_TRACKED_USERS) ||
    MAX_TRACKED_USERS < 1 ||
    MAX_TRACKED_USERS > MAX_TRACKED_USERS_LIMIT
  ) {
    throw new RangeError(`maxTrackedUsers must be between 1 and ${MAX_TRACKED_USERS_LIMIT}`);
  }
  const attempts = new Map<string, number[]>();
  let pruneCursor = attempts.keys();
  const now = options.now ?? Date.now;
  const pruneUser = (userId: string, cutoff: number): number[] => {
    const timestamps = attempts.get(userId) ?? [];
    let retained = 0;
    for (const timestamp of timestamps) {
      if (timestamp > cutoff) timestamps[retained++] = timestamp;
    }
    timestamps.length = retained;
    if (retained === 0) attempts.delete(userId);
    return timestamps;
  };
  const pruneSome = (cutoff: number): void => {
    let inspected = 0;
    while (attempts.size > 0 && inspected < MAX_PRUNED_USERS_PER_REQUEST) {
      const next = pruneCursor.next();
      if (next.done) {
        pruneCursor = attempts.keys();
        continue;
      }
      inspected += 1;
      pruneUser(next.value, cutoff);
    }
  };
  return {
    allow(userId) {
      const time = now();
      const cutoff = time - 60_000;
      const recent = pruneUser(userId, cutoff);
      pruneSome(cutoff);
      if (recent.length >= options.limitPerMinute) return "rate_limited";
      if (!attempts.has(userId) && attempts.size >= MAX_TRACKED_USERS) return "capacity_exceeded";
      recent.push(time);
      attempts.set(userId, recent);
      return "allowed";
    },
    get trackedUsers() {
      return attempts.size;
    },
  };
}

export function createVoiceRequestHandler(
  deps: VoiceGatewayDeps,
): (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => Promise<boolean> {
  const rateLimiter = createVoiceMintRateLimiter({
    limitPerMinute: deps.mintRateLimitPerMinute ?? 10,
    ...(deps.maxTrackedMintUsers !== undefined
      ? { maxTrackedUsers: deps.maxTrackedMintUsers }
      : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return async (request, response, signal) => {
    if (signal.aborted || response.destroyed) return true;
    const url = new URL(request.url ?? "/", "http://voice.local");
    if (deps.clientRoot && request.method === "GET") {
      const asset = await serveClientAsset(response, url.pathname, deps.clientRoot, signal);
      if (asset) return true;
    }
    if (url.pathname === "/v1/voice/session") {
      const origin = header(request, "origin") ?? undefined;
      const cors = corsHeaders(origin, deps.allowedOrigins);
      if (request.method === "OPTIONS") {
        if (origin !== undefined && !originAllowed(origin, deps.allowedOrigins)) {
          return reply(response, 403, { error: "origin_rejected" });
        }
        response.writeHead(204, cors);
        response.end();
        return true;
      }
      if (request.method !== "POST") return reply(response, 405, { error: "method_not_allowed" });
      if (!originAllowed(origin, deps.allowedOrigins)) {
        observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "origin_rejected" });
        return reply(response, 403, { error: "origin_rejected" }, cors);
      }
      const userId = verifyAppUserToken(bearer(request), deps.authSecret);
      if (!userId) {
        observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "unauthorized" });
        return reply(response, 401, { error: "unauthorized" }, cors);
      }
      const mintLimit = rateLimiter.allow(userId);
      if (mintLimit === "rate_limited") {
        return reply(response, 429, { error: "rate_limited", closeCode: 4429 }, cors);
      }
      if (mintLimit === "capacity_exceeded") {
        return reply(response, 503, { error: "mint_capacity_reached" }, cors);
      }
      const body = await readJsonBody(request, deps.maxBodyBytes ?? 4096, signal);
      if (signal.aborted || response.destroyed) return true;
      if (!body.ok) return reply(response, body.status, { error: body.error }, cors);
      const mode = body.value.mode;
      if (mode !== "push_to_talk" && mode !== "continuous") {
        return reply(response, 400, { error: "invalid_mode" }, cors);
      }
      const supersedesValue = body.value.supersedes;
      if (
        supersedesValue !== undefined &&
        (typeof supersedesValue !== "string" || !supersedesValue.trim())
      ) {
        return reply(response, 400, { error: "invalid_supersedes" }, cors);
      }
      const supersedes = typeof supersedesValue === "string" ? supersedesValue : undefined;
      if (signal.aborted || response.destroyed) return true;
      const reserved = deps.tokenStore.reserve(userId, mode, supersedes);
      if (!reserved.ok) {
        const status =
          reserved.reason === "cap_exceeded"
            ? 409
            : reserved.reason === "invalid_supersedes"
              ? 403
              : 503;
        return reply(response, status, { error: reserved.reason }, cors);
      }
      if (supersedes && !deps.supersedeSession) {
        deps.tokenStore.rollbackSupersede(reserved.issued.identity.sessionRef);
        return reply(response, 503, { error: "supersede_unavailable" }, cors);
      }
      if (supersedes) {
        try {
          if (signal.aborted || response.destroyed) {
            deps.tokenStore.rollbackSupersede(reserved.issued.identity.sessionRef);
            return true;
          }
          await deps.supersedeSession?.(supersedes, signal);
          deps.tokenStore.commitSupersede(reserved.issued.identity.sessionRef);
        } catch {
          deps.tokenStore.rollbackSupersede(reserved.issued.identity.sessionRef);
          if (signal.aborted || response.destroyed) return true;
          return reply(response, 503, { error: "supersede_failed" }, cors);
        }
      }
      if (supersedes) {
        observe(deps.onConnectionEvent, {
          type: "reconnect_detected",
          sessionRef: reserved.issued.identity.sessionRef,
          supersedes,
        });
      }
      if (signal.aborted || response.destroyed) {
        deps.tokenStore.release(reserved.issued.identity.sessionRef);
        return true;
      }
      return reply(
        response,
        201,
        {
          sessionRef: reserved.issued.identity.sessionRef,
          token: reserved.issued.token,
          expMs: reserved.issued.expMs,
          mode,
        },
        cors,
      );
    }

    const admin = /^\/v1\/voice\/admin\/sessions\/([^/]+)\/terminate$/.exec(url.pathname);
    if (admin) {
      if (request.method !== "POST") return reply(response, 405, { error: "method_not_allowed" });
      if (!constantTimeStringEqual(bearer(request), deps.adminSecret))
        return reply(response, 401, { error: "unauthorized" });
      const sessionRef = decodeURIComponent(admin[1] ?? "");
      const terminated = (await deps.terminateSession?.(sessionRef, signal)) ?? false;
      deps.tokenStore.release(sessionRef);
      if (signal.aborted || response.destroyed) return true;
      return reply(response, terminated ? 200 : 404, { terminated });
    }
    return false;
  };
}

export function createVoiceUpgradeAuthorizer(deps: {
  readonly tokenStore: VoiceSessionStore;
  readonly allowedOrigins: readonly string[];
  readonly onConnectionEvent?: (event: ConnectionObservabilityEvent) => void;
}): (
  request: IncomingMessage,
  url: URL,
  params: Readonly<Record<string, string>>,
) => UpgradeAuthorization<VoiceSessionIdentity> {
  return (request, url, params) => {
    if (!originAllowed(header(request, "origin") ?? undefined, deps.allowedOrigins)) {
      observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "origin_rejected" });
      return { ok: false, statusCode: 403 };
    }
    const sessionRef = params.sessionRef;
    if (!sessionRef) {
      observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "missing_session" });
      return { ok: false, statusCode: 401 };
    }
    const identity = deps.tokenStore.consume(
      sessionRef,
      url.searchParams.get("token"),
      url.searchParams.get("exp"),
    );
    if (identity) return { ok: true, context: identity };
    observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "invalid_token" });
    return { ok: false, statusCode: 401 };
  };
}

function observe(
  report: ((event: ConnectionObservabilityEvent) => void) | undefined,
  event: ConnectionObservabilityEvent,
): void {
  try {
    report?.(event);
  } catch {
    // Observation must never affect authorization or session lifecycle.
  }
}

function bearer(request: IncomingMessage): string | null {
  const authorization = header(request, "authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function reply(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): true {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
  return true;
}

function corsHeaders(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Readonly<Record<string, string>> {
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

async function serveClientAsset(
  response: ServerResponse,
  pathname: string,
  root: URL,
  signal: AbortSignal,
): Promise<boolean> {
  const files: Readonly<Record<string, { readonly name: string; readonly type: string }>> = {
    "/": { name: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
    "/voice-client.js": { name: "voice-client.js", type: "text/javascript; charset=utf-8" },
    "/hold-to-talk.js": { name: "hold-to-talk.js", type: "text/javascript; charset=utf-8" },
    "/pcm-worklet.js": { name: "pcm-worklet.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
  };
  const asset = files[pathname];
  if (!asset) return false;
  if (signal.aborted || response.destroyed) return true;
  try {
    const body = await readFile(new URL(asset.name, root));
    if (signal.aborted || response.destroyed) return true;
    response.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self'; script-src 'self'; style-src 'self'",
      "permissions-policy": "microphone=(self)",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
    return true;
  } catch {
    if (signal.aborted || response.destroyed) return true;
    response.writeHead(404);
    response.end();
    return true;
  }
}

type JsonBodyResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: number; readonly error: string };

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<JsonBodyResult> {
  signal?.throwIfAborted();
  const contentType = header(request, "content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json")
    return { ok: false, status: 415, error: "unsupported_media_type" };
  const lengthHeader = request.headers["content-length"];
  const declared = lengthHeader
    ? Number.parseInt(Array.isArray(lengthHeader) ? (lengthHeader[0] ?? "") : lengthHeader, 10)
    : undefined;
  if (declared !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const destroyOnAbort = (): void => {
    request.destroy();
  };
  signal?.addEventListener("abort", destroyOnAbort, { once: true });
  try {
    for await (const raw of request) {
      signal?.throwIfAborted();
      const chunk = raw as Buffer;
      total += chunk.byteLength;
      if (total > maxBytes) {
        request.destroy();
        return { ok: false, status: 413, error: "payload_too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", destroyOnAbort);
  }
  signal?.throwIfAborted();
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value: value as Readonly<Record<string, unknown>> }
      : { ok: false, status: 400, error: "invalid_json" };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

export type { VoiceMode };
