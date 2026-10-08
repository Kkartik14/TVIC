import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  createWebClientAudioProvider,
  type ConnectionObservabilityEvent,
  createNodeMediaPlane,
  PCM16_16K_MONO,
  type CallId,
  type NodeMediaPlane,
  type SessionId,
} from "voice-runtime";

import { createVoiceRequestHandler, createVoiceUpgradeAuthorizer } from "../src/gateway.js";
import { VoiceConnectionRegistry } from "../src/connection-lifecycle.js";
import {
  createAppUserToken,
  createVoiceSessionStore,
  type VoiceSessionIdentity,
} from "../src/security.js";

describe("voice-mode gateway", () => {
  let plane: NodeMediaPlane<VoiceSessionIdentity> | undefined;
  afterEach(async () => plane?.stop());

  it("supports browser CORS preflight and serves the hardened reference client", async () => {
    const store = createStore();
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["http://localhost:3000"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        clientRoot: new URL("../public/", import.meta.url),
      }),
      onConnection() {},
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const preflight = await fetch(`${base}/v1/voice/session`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("TVIC browser voice mode");
    const holdToTalk = await fetch(`${base}/hold-to-talk.js`);
    expect(holdToTalk.status).toBe(200);
    expect(holdToTalk.headers.get("content-type")).toContain("javascript");
    expect(await holdToTalk.text()).toContain("bindHoldToTalkButton");
  });

  it("preserves session.start while runtime startup is delayed", async () => {
    const callId = "delayed-start-call" as CallId;
    const telephony = createWebClientAudioProvider({
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 2_000,
    });
    const connections = new VoiceConnectionRegistry(telephony);
    let finishStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    let resolveInitialMessage!: () => void;
    const initialMessageReceived = new Promise<void>((resolve) => {
      resolveInitialMessage = resolve;
    });
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onConnection({ socket }) {
        const attempt = connections.begin("test-session", callId, socket);
        socket.on("message", () => resolveInitialMessage());
        void (async () => {
          try {
            await startupGate;
            await telephony.acceptWebSocket(
              attempt.socket,
              callId,
              "delayed-start-session" as SessionId,
            );
            attempt.settleStartup();
          } finally {
            connections.finish("test-session", attempt);
          }
        })();
      },
    });
    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/voice/test`);
    client.on("error", () => undefined);
    try {
      await new Promise<void>((resolve) => client.once("open", resolve));
      const ready = nextJson(client, "session.ready");
      client.send(startFrame("continuous"));
      await initialMessageReceived;
      finishStartup();
      const result = await Promise.race([
        ready,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300)),
      ]);
      expect(result).toMatchObject({ type: "session.ready" });
    } finally {
      client.close();
      await telephony.hangup(callId);
    }
  });

  it("returns service errors when process-local mint state reaches its bounds", async () => {
    const store = createVoiceSessionStore({
      tokenSecret: "token-secret",
      safetyIdentifierSecret: "safety-secret",
      ttlMs: 60_000,
      maxTrackedSessions: 1,
    });
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        maxTrackedMintUsers: 2,
      }),
      onConnection() {},
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;

    expect((await mintResponse(base, "user-1")).status).toBe(201);
    const sessionCapacity = await mintResponse(base, "user-2");
    expect(sessionCapacity.status).toBe(503);
    await expect(sessionCapacity.json()).resolves.toEqual({ error: "session_store_capacity" });

    const limiterCapacity = await mintResponse(base, "user-3");
    expect(limiterCapacity.status).toBe(503);
    await expect(limiterCapacity.json()).resolves.toEqual({ error: "mint_capacity_reached" });
  });

  it("rejects a malformed supersedes value without consuming a session slot", async () => {
    const store = createStore();
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
      }),
      onConnection() {},
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const malformed = await fetch(`${base}/v1/voice/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createAppUserToken("user-1", "app-secret")}`,
        "content-type": "application/json",
        origin: "https://app.example",
      },
      body: JSON.stringify({ mode: "continuous", supersedes: 123 }),
    });

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "invalid_supersedes" });
    await expect(mint(base, "user-1")).resolves.toMatchObject({ mode: "continuous" });
  });

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
        async supersedeSession() {},
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

  it("preserves the old slot when supersession cannot terminate the old session", async () => {
    const store = createStore();
    plane = createNodeMediaPlane({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        async supersedeSession() {
          throw new Error("old session is unavailable");
        },
      }),
      onConnection() {},
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const first = await mint(base, "user-failure");
    const failed = await mintResponse(base, "user-failure", first.sessionRef);
    expect(failed.status).toBe(503);
    expect((await mintResponse(base, "user-failure")).status).toBe(409);
  });

  it("rolls back a supersession when its HTTP request is cancelled", async () => {
    const store = createStore();
    let resolveSupersedeStarted: () => void = () => undefined;
    const supersedeStarted = new Promise<void>((resolve) => {
      resolveSupersedeStarted = resolve;
    });
    plane = createNodeMediaPlane<VoiceSessionIdentity>({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        async supersedeSession(_sessionRef, signal) {
          resolveSupersedeStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("request aborted")), {
              once: true,
            });
          });
        },
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
      }),
      onConnection({ socket }) {
        socket.close();
      },
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const first = await mint(base, "user-cancelled-supersede");
    const controller = new AbortController();
    const replacementRequest = mintResponse(
      base,
      "user-cancelled-supersede",
      first.sessionRef,
      "https://app.example",
      controller.signal,
    ).catch(() => undefined);
    await supersedeStarted;
    controller.abort();
    await replacementRequest;

    await expect(open(wsUrl(base, first), "https://app.example")).resolves.toBeUndefined();
  });

  it("finishes an irreversible supersession safely when its response is lost", async () => {
    const store = createStore();
    let resolveSupersedeStarted: () => void = () => undefined;
    const supersedeStarted = new Promise<void>((resolve) => {
      resolveSupersedeStarted = resolve;
    });
    let resolveAbortObserved: () => void = () => undefined;
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbortObserved = resolve;
    });
    let finishSupersede: () => void = () => undefined;
    const supersedeGate = new Promise<void>((resolve) => {
      finishSupersede = resolve;
    });
    let resolveSupersedeCompleted: () => void = () => undefined;
    const supersedeCompleted = new Promise<void>((resolve) => {
      resolveSupersedeCompleted = resolve;
    });
    let supersedeEffectCompleted = false;
    plane = createNodeMediaPlane<VoiceSessionIdentity>({
      port: 0,
      path: "/voice/:sessionRef",
      onRequest: createVoiceRequestHandler({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
        authSecret: "app-secret",
        adminSecret: "admin-secret",
        async supersedeSession(_sessionRef, signal) {
          resolveSupersedeStarted();
          signal.addEventListener("abort", resolveAbortObserved, { once: true });
          await supersedeGate;
          supersedeEffectCompleted = true;
          resolveSupersedeCompleted();
        },
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
      }),
      onConnection({ socket }) {
        socket.close();
      },
    });
    await plane.start();
    const base = `http://127.0.0.1:${plane.address?.port}`;
    const first = await mint(base, "user-lost-supersede-response");
    const controller = new AbortController();
    const replacementRequest = mintResponse(
      base,
      "user-lost-supersede-response",
      first.sessionRef,
      "https://app.example",
      controller.signal,
    ).catch(() => undefined);
    await supersedeStarted;
    controller.abort();
    await abortObserved;
    finishSupersede();
    await supersedeCompleted;
    await replacementRequest;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(supersedeEffectCompleted).toBe(true);
    await expect(rejectStatus(wsUrl(base, first), "https://app.example")).resolves.toBe(401);
    const fresh = await mint(base, "user-lost-supersede-response");
    expect(fresh.sessionRef).not.toBe(first.sessionRef);
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
        async supersedeSession() {},
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
    const providerOptions = {
      maxBinaryFrameBytes: 20,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 10_000,
      onConnectionEvent: (event: ConnectionObservabilityEvent) => transportEvents.push(event),
    };
    const provider = createWebClientAudioProvider({
      ...providerOptions,
      maxSessionDurationMs: 60_000,
    });
    const durationProvider = createWebClientAudioProvider({
      ...providerOptions,
      maxSessionDurationMs: 40,
    });
    const durationSessionRefs = new Set<string>();
    const providerFor = (sessionRef: string) =>
      durationSessionRefs.has(sessionRef) ? durationProvider : provider;
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
          await providerFor(ref).hangup(ref as CallId);
          return true;
        },
        async supersedeSession(ref) {
          await providerFor(ref).supersede(ref as CallId);
        },
      }),
      authorizeUpgrade: createVoiceUpgradeAuthorizer({
        tokenStore: store,
        allowedOrigins: ["https://app.example"],
      }),
      onConnection({ socket, upgradeContext }) {
        if (!upgradeContext) return;
        const handlePromise = providerFor(upgradeContext.sessionRef).acceptWebSocket(
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
    durationSessionRefs.add(expiring.sessionRef);
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
  signal?: AbortSignal,
) {
  return fetch(`${base}/v1/voice/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${createAppUserToken(userId, "app-secret")}`,
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ mode: "continuous", ...(supersedes ? { supersedes } : {}) }),
    ...(signal ? { signal } : {}),
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
