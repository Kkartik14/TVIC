import type { IncomingMessage, ServerResponse } from "node:http";

import type { UpgradeAuthorization } from "@tvic/runtime";
import type { ConnectionObservabilityEvent } from "@tvic/providers";

import {
  originAllowed,
  verifyAppUserToken,
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
  readonly now?: () => number;
  readonly terminateSession?: (sessionRef: string) => Promise<boolean>;
  readonly supersedeSession?: (sessionRef: string) => Promise<void>;
  readonly onConnectionEvent?: (event: ConnectionObservabilityEvent) => void;
}

export interface VoiceMintRateLimiter {
  allow(userId: string): boolean;
  readonly trackedUsers: number;
}

export function createVoiceMintRateLimiter(options: {
  readonly limitPerMinute: number;
  readonly now?: () => number;
}): VoiceMintRateLimiter {
  const attempts = new Map<string, number[]>();
  const now = options.now ?? Date.now;
  const prune = (cutoff: number): void => {
    for (const [userId, timestamps] of attempts) {
      const recent = timestamps.filter((at) => at > cutoff);
      if (recent.length === 0) attempts.delete(userId);
      else if (recent.length !== timestamps.length) attempts.set(userId, recent);
    }
  };
  return {
    allow(userId) {
      const time = now();
      prune(time - 60_000);
      const recent = attempts.get(userId) ?? [];
      if (recent.length >= options.limitPerMinute) return false;
      recent.push(time);
      attempts.set(userId, recent);
      return true;
    },
    get trackedUsers() {
      return attempts.size;
    },
  };
}

export function createVoiceRequestHandler(
  deps: VoiceGatewayDeps,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const rateLimiter = createVoiceMintRateLimiter({
    limitPerMinute: deps.mintRateLimitPerMinute ?? 10,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://voice.local");
    if (url.pathname === "/v1/voice/session") {
      if (request.method !== "POST") return reply(response, 405, { error: "method_not_allowed" });
      if (!originAllowed(header(request, "origin") ?? undefined, deps.allowedOrigins)) {
        observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "origin_rejected" });
        return reply(response, 403, { error: "origin_rejected" });
      }
      const userId = verifyAppUserToken(bearer(request), deps.authSecret);
      if (!userId) {
        observe(deps.onConnectionEvent, { type: "auth_rejected", reason: "unauthorized" });
        return reply(response, 401, { error: "unauthorized" });
      }
      if (!rateLimiter.allow(userId)) {
        return reply(response, 429, { error: "rate_limited", closeCode: 4429 });
      }
      const body = await readJsonBody(request, deps.maxBodyBytes ?? 4096);
      if (!body.ok) return reply(response, body.status, { error: body.error });
      const mode = body.value.mode;
      if (mode !== "push_to_talk" && mode !== "continuous") {
        return reply(response, 400, { error: "invalid_mode" });
      }
      const supersedes =
        typeof body.value.supersedes === "string" ? body.value.supersedes : undefined;
      const reserved = deps.tokenStore.reserve(userId, mode, supersedes);
      if (!reserved.ok) {
        return reply(response, reserved.reason === "cap_exceeded" ? 409 : 403, {
          error: reserved.reason,
        });
      }
      if (supersedes) {
        observe(deps.onConnectionEvent, {
          type: "reconnect_detected",
          sessionRef: reserved.issued.identity.sessionRef,
          supersedes,
        });
        await deps.supersedeSession?.(supersedes).catch(() => undefined);
      }
      return reply(response, 201, {
        sessionRef: reserved.issued.identity.sessionRef,
        token: reserved.issued.token,
        expMs: reserved.issued.expMs,
        mode,
      });
    }

    const admin = /^\/v1\/voice\/admin\/sessions\/([^/]+)\/terminate$/.exec(url.pathname);
    if (admin) {
      if (request.method !== "POST") return reply(response, 405, { error: "method_not_allowed" });
      if (bearer(request) !== deps.adminSecret)
        return reply(response, 401, { error: "unauthorized" });
      const sessionRef = decodeURIComponent(admin[1] ?? "");
      const terminated = (await deps.terminateSession?.(sessionRef)) ?? false;
      deps.tokenStore.release(sessionRef);
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

function reply(response: ServerResponse, status: number, value: unknown): true {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
  return true;
}

type JsonBodyResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly status: number; readonly error: string };

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<JsonBodyResult> {
  const type = String(request.headers["content-type"] ?? "");
  if (!type.includes("application/json"))
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
  for await (const raw of request) {
    const chunk = raw as Buffer;
    total += chunk.byteLength;
    if (total > maxBytes) {
      request.destroy();
      return { ok: false, status: 413, error: "payload_too_large" };
    }
    chunks.push(chunk);
  }
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
