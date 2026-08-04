import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type CallId, type SessionId } from "@tvic/core";
import {
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  createWebClientAudioProvider,
  type ConnectionObservabilityEvent,
} from "@tvic/providers";
import { createNodeMediaPlane, type NodeMediaPlane } from "@tvic/runtime";

import { createVoiceRequestHandler, createVoiceUpgradeAuthorizer } from "../src/gateway.js";
import {
  createAppUserToken,
  createVoiceSessionStore,
  type VoiceSessionIdentity,
} from "../src/security.js";

describe("voice-mode gateway", () => {
  let plane: NodeMediaPlane<VoiceSessionIdentity> | undefined;
  afterEach(async () => plane?.stop());

  it("mints, authorizes before upgrade, rejects replay/origin mismatch, and supersedes", async () => {
    const store = createStore();
    const identities: VoiceSessionIdentity[] = [];
    plane = createNodeMediaPlane<VoiceSessionIdentity>({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
      }),
      onConnection({ socket, upgradeContext }) {
        if (upgradeContext) identities.push(upgradeContext);
        socket.close();
      },
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const first = await mint(base, "user-1");
    const wsUrl = `${base.replace("http", "ws")}/voice/${first.sessionRef}?token=${first.token}&exp=${first.expMs}`;

    await expect(open(wsUrl, "https://app.example")).resolves.toBeUndefined();
    expect(identities[0]?.userId).toBe("user-1");
    await expect(rejectStatus(wsUrl, "https://app.example")).resolves.toBe(401);

    const occupied = await mintResponse(base, "user-1");
    expect(occupied.status).toBe(409);
    const replacement = await mint(base, "user-1", first.sessionRef);
    expect(replacement.sessionRef).not.toBe(first.sessionRef);
    const replacementUrl = `${base.replace("http", "ws")}/voice/${replacement.sessionRef}?token=${replacement.token}&exp=${replacement.expMs}`;
    await expect(rejectStatus(replacementUrl, "https://evil.example")).resolves.toBe(403);
  });

  it("rate-limits minting and separately authenticates operator termination", async () => {
    const store = createStore(2);
    const terminated: string[] = [];
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: [],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        mintRateLimitPerMinute: 1,
        async terminateSession(ref) {
          terminated.push(ref);
          return true;
        },
      }),
      onConnection() {},
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const issued = await mint(base, "user-1", undefined, null);
    expect((await mintResponse(base, "user-1", undefined, null)).status).toBe(429);
    expect(
      (
        await fetch(`${base}/v1/voice/admin/sessions/${issued.sessionRef}/terminate`, {
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/v1/voice/admin/sessions/${issued.sessionRef}/terminate`, {
          method: "POST",
          headers: { authorization: "Bearer admin-secret" },
        })
      ).status,
    ).toBe(200);
    expect(terminated).toEqual([issued.sessionRef]);
  });

  it("rejects an expired token before the WebSocket handshake opens", async () => {
    let now = 1_000;
    const store = createVoiceSessionStore({
      tokenSecret: "token-secret",
      safetyIdentifierSecret: "safety-secret",
      ttlMs: 10,
      now: () => now,
    });
    plane = createNodeMediaPlane<VoiceSessionIdentity>({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        now: () => now,
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
      }),
      onConnection() {
        throw new Error("expired token unexpectedly connected");
      },
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const issued = await mint(base, "user-expired");
    now = issued.expMs + 1;
    await expect(rejectStatus(wsUrl(base, issued), "https://app.example")).resolves.toBe(401);
  });

  it("reports auth rejection and reconnect detection without trusting observers", async () => {
    const store = createStore();
    const events: ConnectionObservabilityEvent[] = [];
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        onConnectionEvent(event) {
          events.push(event);
          throw new Error("observer failed");
        },
      }),
      onConnection() {},
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    expect((await mintResponse(base, "user-1", undefined, "https://evil.example")).status).toBe(
      403,
    );
    const first = await mint(base, "user-1");
    await mint(base, "user-1", first.sessionRef);
    expect(events).toEqual([
      { type: "auth_rejected", reason: "origin_rejected" },
      expect.objectContaining({
        type: "reconnect_detected",
        supersedes: first.sessionRef,
      }),
    ]);
  });

  it("runs protocol, explicit-interrupt, frame-limit, duration, and kill-switch paths", async () => {
    const store = createStore(4);
    const transportEvents: ConnectionObservabilityEvent[] = [];
    const provider = createWebClientAudioProvider({
      maxBinaryFrameBytes: 20,
      maxSessionDurationMs: 40,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 10_000,
      onConnectionEvent: (event) => transportEvents.push(event),
    });
    const interruptSeen = new Map<string, Promise<boolean>>();
    plane = createNodeMediaPlane<VoiceSessionIdentity>({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        async terminateSession(ref) {
          await provider.hangup(ref as CallId);
          return true;
        },
        async supersedeSession(ref) {
          await provider.supersede(ref as CallId);
        },
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
      }),
      onConnection({ socket, upgradeContext }) {
        if (!upgradeContext) return;
        const handlePromise = provider.acceptWebSocket(
          socket,
          upgradeContext.sessionRef as CallId,
          `session_${upgradeContext.sessionRef}` as SessionId,
          { expectedMode: upgradeContext.mode },
        );
        interruptSeen.set(
          upgradeContext.sessionRef,
          handlePromise.then(async (handle) => {
            for await (const event of handle.events) {
              if (event.type === "media.interrupt.requested") return true;
            }
            return false;
          }),
        );
      },
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;

    const interactive = await mint(base, "user-interrupt");
    const interactiveSocket = await openSocket(wsUrl(base, interactive), "https://app.example");
    interactiveSocket.send(startFrame("continuous"));
    await nextJson(interactiveSocket, "session.ready");
    interactiveSocket.send(JSON.stringify({ type: "client.interrupt" }));
    await expect(interruptSeen.get(interactive.sessionRef)).resolves.toBe(true);
    const killClose = closeCode(interactiveSocket);
    const killResponse = await fetch(
      `${base}/v1/voice/admin/sessions/${interactive.sessionRef}/terminate`,
      { method: "POST", headers: { authorization: "Bearer admin-secret" } },
    );
    expect(killResponse.status).toBe(200);
    await expect(killClose).resolves.toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated);

    const oversized = await mint(base, "user-oversized");
    const oversizedSocket = await openSocket(wsUrl(base, oversized), "https://app.example");
    oversizedSocket.send(startFrame("continuous"));
    await nextJson(oversizedSocket, "session.ready");
    const oversizedClose = closeCode(oversizedSocket);
    oversizedSocket.send(Buffer.alloc(21));
    await expect(oversizedClose).resolves.toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit);

    const expiring = await mint(base, "user-duration");
    const expiringSocket = await openSocket(wsUrl(base, expiring), "https://app.example");
    expiringSocket.send(startFrame("continuous"));
    await nextJson(expiringSocket, "session.ready");
    await expect(closeCode(expiringSocket)).resolves.toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.maxDuration);

    const prior = await mint(base, "user-reconnect");
    const priorSocket = await openSocket(wsUrl(base, prior), "https://app.example");
    priorSocket.send(startFrame("continuous"));
    await nextJson(priorSocket, "session.ready");
    const supersededClose = closeCode(priorSocket);
    const replacement = await mint(base, "user-reconnect", prior.sessionRef);
    expect(replacement.sessionRef).not.toBe(prior.sessionRef);
    await expect(supersededClose).resolves.toBe(WEB_CLIENT_AUDIO_CLOSE_CODES.superseded);

    expect(transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session_started" }),
        expect.objectContaining({ type: "session_ended", closeCode: 4500 }),
        expect.objectContaining({ type: "session_ended", closeCode: 4413 }),
        expect.objectContaining({ type: "session_ended", closeCode: 4410 }),
        expect.objectContaining({ type: "session_ended", closeCode: 4409 }),
      ]),
    );
  });
});

function createStore(cap = 1) {
  return createVoiceSessionStore({
    tokenSecret: "token-secret",
    safetyIdentifierSecret: "safety-secret",
    ttlMs: 60_000,
    concurrentSessionCap: cap,
  });
}

async function mint(
  base: string,
  userId: string,
  supersedes?: string,
  origin: string | null = "https://app.example",
) {
  const response = await mintResponse(base, userId, supersedes, origin);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ sessionRef: string; token: string; expMs: number }>;
}

function mintResponse(
  base: string,
  userId: string,
  supersedes?: string,
  origin: string | null = "https://app.example",
) {
  return fetch(`${base}/v1/voice/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${createAppUserToken(userId, "app-secret")}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ mode: "continuous", ...(supersedes ? { supersedes } : {}) }),
  });
}

function open(url: string, origin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function openSocket(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function wsUrl(
  base: string,
  issued: { readonly sessionRef: string; readonly token: string; readonly expMs: number },
): string {
  return `${base.replace("http", "ws")}/voice/${issued.sessionRef}?token=${issued.token}&exp=${issued.expMs}`;
}

function startFrame(mode: "push_to_talk" | "continuous"): string {
  return JSON.stringify({
    type: "session.start",
    protocolVersion: 1,
    mode,
    clientPlatform: "e2e-test",
    audioFormat: PCM16_16K_MONO,
  });
}

function nextJson(socket: WebSocket, type: string): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      const value = JSON.parse(raw.toString("utf8")) as Readonly<Record<string, unknown>>;
      if (value.type !== type) return;
      socket.off("message", onMessage);
      resolve(value);
    };
    socket.on("message", onMessage);
  });
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

function rejectStatus(url: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
    socket.once("error", () => undefined);
  });
}
