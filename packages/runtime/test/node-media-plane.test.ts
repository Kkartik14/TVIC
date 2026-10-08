import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createConnection } from "node:net";

import { createNodeMediaPlane, matchPath } from "../src/index.js";

describe("matchPath", () => {
  it("matches a parameterized path and decodes the param", () => {
    expect(matchPath("/media/:callId", "/media/call_123")).toEqual({ callId: "call_123" });
    expect(matchPath("/media/:callId", "/media/a%2Fb")).toEqual({ callId: "a/b" });
  });

  it("returns null on length mismatch or literal mismatch", () => {
    expect(matchPath("/media/:callId", "/media/a/b")).toBeNull();
    expect(matchPath("/media/:callId", "/other/x")).toBeNull();
  });

  it("returns null (never throws) on a malformed percent-escape", () => {
    expect(matchPath("/media/:callId", "/media/%E0%A4%A")).toBeNull();
    expect(matchPath("/media/:callId", "/media/%")).toBeNull();
  });
});

describe("NodeMediaPlane", () => {
  it("stops a listener when stop races startup", async () => {
    const plane = createNodeMediaPlane({ port: 0, path: "/media/:callId", onConnection() {} });
    try {
      const starting = plane.start();
      const stopping = plane.stop();
      await Promise.all([starting, stopping]);
      expect(plane.isRunning).toBe(false);
      expect(plane.address).toBeNull();
    } finally {
      await plane.stop();
    }
  });

  it("shares an in-flight stop between concurrent callers", async () => {
    const plane = createNodeMediaPlane({ port: 0, path: "/media/:callId", onConnection() {} });
    await plane.start();
    try {
      const results = await Promise.allSettled([plane.stop(), plane.stop()]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(plane.isRunning).toBe(false);
    } finally {
      await plane.stop();
    }
  });

  it("bounds shutdown when a WebSocket peer ignores the close handshake", async () => {
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      webSocketCloseTimeoutMs: 20,
      onConnection() {},
    });
    await plane.start();
    const peer = createConnection({ port: plane.address?.port ?? 0, host: "127.0.0.1" });
    peer.on("error", () => undefined);
    await new Promise<void>((resolve) => peer.once("connect", resolve));
    const handshake = new Promise<void>((resolve) => {
      let response = "";
      peer.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.includes("\r\n\r\n")) resolve();
      });
    });
    peer.write(
      "GET /media/x HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    try {
      await handshake;
      const startedAt = Date.now();
      await plane.stop();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(plane.isRunning).toBe(false);
    } finally {
      peer.destroy();
      await plane.stop();
    }
  });

  it("closes fragmented messages that exceed the configured parser limit", async () => {
    let resolveConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      maxInboundFrameFragments: 1,
      webSocketCloseTimeoutMs: 20,
      onConnection({ socket: webSocket }) {
        webSocket.on("error", () => undefined);
        resolveConnected();
      },
    });
    await plane.start();
    const socket = createConnection({ port: plane.address?.port ?? 0, host: "127.0.0.1" });
    socket.on("error", () => undefined);
    let response = Buffer.alloc(0);
    const handshake = new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        response = Buffer.concat([response, chunk]);
        if (response.includes(Buffer.from("\r\n\r\n"))) resolve();
      });
    });
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        "GET /media/x HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      await handshake;
      await connected;
      expect(response.toString("utf8")).toContain("HTTP/1.1 101");

      // An empty, non-final text frame followed by an empty continuation is a
      // valid two-fragment message. Both client frames carry the required mask.
      socket.write(Buffer.from([0x01, 0x80, 0, 0, 0, 0, 0x80, 0x80, 0, 0, 0, 0]));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const didClose = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(didClose).toBe(true);
    } finally {
      socket.destroy();
      await plane.stop();
    }
  });

  it("limits aggregate RFC WebSocket Ping and Pong frames and answers allowed Pings", async () => {
    let resolveInboundBarrier: () => void = () => undefined;
    const inboundBarrier = new Promise<void>((resolve) => {
      resolveInboundBarrier = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      onConnection({ socket }) {
        socket.once("message", () => resolveInboundBarrier());
      },
    });
    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
    client.on("error", () => undefined);
    try {
      await new Promise<void>((resolve) => client.once("open", resolve));
      let pongCount = 0;
      let resolveFirstPong: () => void = () => undefined;
      const firstPong = new Promise<void>((resolve) => {
        resolveFirstPong = resolve;
      });
      let resolveFivePongs: () => void = () => undefined;
      const fivePongs = new Promise<void>((resolve) => {
        resolveFivePongs = resolve;
      });
      client.on("pong", () => {
        pongCount += 1;
        if (pongCount === 1) resolveFirstPong();
        if (pongCount === 5) resolveFivePongs();
      });
      client.ping("probe");
      await firstPong;
      expect(pongCount).toBe(1);

      for (let index = 0; index < 4; index += 1) client.ping("mixed");
      for (let index = 0; index < 5; index += 1) client.pong("mixed");
      client.send("inbound-barrier");
      await Promise.all([fivePongs, inboundBarrier]);
      expect(client.readyState).toBe(WebSocket.OPEN);

      const closed = new Promise<number>((resolve) =>
        client.once("close", (code) => resolve(code)),
      );
      client.pong("over-limit");
      const closeCode = await Promise.race([
        closed,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_000)),
      ]);
      expect(closeCode).toBe(1008);
    } finally {
      client.close();
      await plane.stop();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16_385])(
    "rejects invalid inbound fragment limits (%s)",
    (maxInboundFrameFragments) => {
      expect(() =>
        createNodeMediaPlane({
          port: 0,
          path: "/media/:callId",
          maxInboundFrameFragments,
          onConnection() {},
        }),
      ).toThrow("maxInboundFrameFragments must be an integer from 1 to 16384");
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16_777_217, 4_294_967_296])(
    "rejects invalid inbound payload limits (%s)",
    (maxInboundFrameBytes) => {
      expect(() =>
        createNodeMediaPlane({
          port: 0,
          path: "/media/:callId",
          maxInboundFrameBytes,
          onConnection() {},
        }),
      ).toThrow("maxInboundFrameBytes must be an integer from 1 to 16777216");
    },
  );

  it("shares shutdown when an HTTP abort listener re-enters stop", async () => {
    let resolveRouteStarted: () => void = () => undefined;
    const routeStarted = new Promise<void>((resolve) => {
      resolveRouteStarted = resolve;
    });
    let resolveReentered: () => void = () => undefined;
    const reentered = new Promise<void>((resolve) => {
      resolveReentered = resolve;
    });
    let reentrantStop: Promise<void> | undefined;
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      onRequest: async (_request, _response, signal) => {
        signal.addEventListener(
          "abort",
          () => {
            reentrantStop = plane.stop();
            resolveReentered();
          },
          { once: true },
        );
        resolveRouteStarted();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return true;
      },
      onConnection() {},
    });
    await plane.start();
    const request = fetch(`http://127.0.0.1:${plane.address?.port}/webhook`).catch(() => undefined);
    try {
      await routeStarted;
      const outerStop = plane.stop();
      await reentered;
      const results = await Promise.allSettled([outerStop, reentrantStop!]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(plane.isRunning).toBe(false);
    } finally {
      await Promise.allSettled([plane.stop()]);
      await request;
    }
  });

  it("can restart and stop the same media plane", async () => {
    let connections = 0;
    let resolveConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      onConnection() {
        connections += 1;
        resolveConnected();
      },
    });
    await plane.start();
    await plane.stop();

    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/restarted`);
    client.on("error", () => undefined);
    try {
      expect(plane.isRunning).toBe(true);
      expect(plane.address?.port).toBeTypeOf("number");
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          client.once("open", resolve);
          client.once("error", reject);
        }),
        connected,
      ]);
      expect(connections).toBe(1);
      const clientClosed = new Promise<void>((resolve) => client.once("close", resolve));
      client.close();
      await clientClosed;
      await expect(plane.stop()).resolves.toBeUndefined();
      expect(plane.isRunning).toBe(false);
    } finally {
      client.terminate();
      await plane.stop();
    }
  });

  it("stops HTTP admission and closes clients with an active health check", async () => {
    let healthSignal: AbortSignal | undefined;
    let resolveHealthStarted: () => void = () => undefined;
    const healthStarted = new Promise<void>((resolve) => {
      resolveHealthStarted = resolve;
    });
    let releaseHealthCheck: () => void = () => undefined;
    const healthCheckGate = new Promise<void>((resolve) => {
      releaseHealthCheck = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      healthCheck: async (signal) => {
        healthSignal = signal;
        resolveHealthStarted();
        await healthCheckGate;
        return { ok: true };
      },
      onConnection() {},
    });
    await plane.start();
    const port = plane.address?.port;
    const request = fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      await healthStarted;
      stopping = plane.stop();
      const stoppedPromptly = await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(stoppedPromptly).toBe(true);
      expect(plane.isRunning).toBe(false);
      expect(healthSignal?.aborted).toBe(true);
    } finally {
      releaseHealthCheck();
      await (stopping ?? plane.stop());
      await request;
    }
  });

  it("aborts an active HTTP route and refuses new requests during shutdown", async () => {
    let calls = 0;
    let routeSignal: AbortSignal | undefined;
    let resolveRouteStarted: () => void = () => undefined;
    const routeStarted = new Promise<void>((resolve) => {
      resolveRouteStarted = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      onRequest: async (_request, _response, signal) => {
        calls += 1;
        routeSignal = signal;
        resolveRouteStarted();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return true;
      },
      onConnection() {},
    });
    await plane.start();
    const url = `http://127.0.0.1:${plane.address?.port}/webhook`;
    const inFlightRequest = fetch(url).catch(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      await routeStarted;
      stopping = plane.stop();
      await stopping;
      expect(routeSignal?.aborted).toBe(true);
      await fetch(url).catch(() => undefined);
      expect(calls).toBe(1);
    } finally {
      await (stopping ?? plane.stop());
      await inFlightRequest;
    }
  });

  it("keeps the HTTP signal active after a normal response close", async () => {
    let routeSignal: AbortSignal | undefined;
    let resolveRouteFinished: () => void = () => undefined;
    const routeFinished = new Promise<void>((resolve) => {
      resolveRouteFinished = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      onRequest: async (_request, response, signal) => {
        routeSignal = signal;
        response.writeHead(204);
        response.end();
        await new Promise<void>((resolve) => setImmediate(resolve));
        resolveRouteFinished();
        return true;
      },
      onConnection() {},
    });
    await plane.start();
    try {
      const response = await fetch(`http://127.0.0.1:${plane.address?.port}/webhook`);
      expect(response.status).toBe(204);
      await routeFinished;
      expect(routeSignal?.aborted).toBe(false);
    } finally {
      await plane.stop();
    }
  });

  it("aborts an HTTP signal when a client disconnects before its response", async () => {
    let routeSignal: AbortSignal | undefined;
    let resolveRouteStarted: () => void = () => undefined;
    const routeStarted = new Promise<void>((resolve) => {
      resolveRouteStarted = resolve;
    });
    let resolveRouteAborted: () => void = () => undefined;
    const routeAborted = new Promise<void>((resolve) => {
      resolveRouteAborted = resolve;
    });
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      onRequest: (_request, _response, signal) => {
        routeSignal = signal;
        resolveRouteStarted();
        return new Promise<boolean>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolveRouteAborted();
              resolve(true);
            },
            { once: true },
          );
        });
      },
      onConnection() {},
    });
    await plane.start();
    const requestAbort = new AbortController();
    const request = fetch(`http://127.0.0.1:${plane.address?.port}/webhook`, {
      signal: requestAbort.signal,
    }).catch(() => undefined);
    try {
      await routeStarted;
      requestAbort.abort();
      const abortedPromptly = await Promise.race([
        routeAborted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(abortedPromptly).toBe(true);
      expect(routeSignal?.aborted).toBe(true);
      await request;
    } finally {
      await plane.stop();
    }
  });

  it("authorizes before upgrade and threads typed context to the connection", async () => {
    let receivedUserId: string | undefined;
    let resolveConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const plane = createNodeMediaPlane<{ userId: string }>({
      port: 0,
      path: "/media/:callId",
      authorizeUpgrade() {
        return { ok: true, context: { userId: "user_123" } };
      },
      onConnection({ upgradeContext }) {
        receivedUserId = upgradeContext?.userId;
        resolveConnected();
      },
    });

    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
    client.on("error", () => undefined);
    try {
      await connected;
      expect(receivedUserId).toBe("user_123");
    } finally {
      client.close();
      await plane.stop();
    }
  });

  it("supports bounded asynchronous authorization and forwards its abort signal", async () => {
    let receivedUserId: string | undefined;
    let authorizationSignal: AbortSignal | undefined;
    let resolveConnected: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const plane = createNodeMediaPlane<{ userId: string }>({
      port: 0,
      path: "/media/:callId",
      authorizationTimeoutMs: 250,
      async authorizeUpgrade(_request, _url, _params, signal) {
        authorizationSignal = signal;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return { ok: true, context: { userId: "user_async" } };
      },
      onConnection({ upgradeContext }) {
        receivedUserId = upgradeContext?.userId;
        resolveConnected();
      },
    });

    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
    client.on("error", () => undefined);
    try {
      await connected;
      expect(receivedUserId).toBe("user_async");
      expect(authorizationSignal?.aborted).toBe(false);
    } finally {
      client.close();
      await plane.stop();
    }
  });

  it("uses the default authorization deadline and releases a grant returned after it", async () => {
    let authorizationSignal: AbortSignal | undefined;
    let releasedSlot: string | undefined;
    let resolveReleased: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const plane = createNodeMediaPlane<{ slot: string }>({
      port: 0,
      path: "/media/:callId",
      async authorizeUpgrade(_request, _url, _params, signal) {
        authorizationSignal = signal;
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        return { ok: true, context: { slot: "late_slot" } };
      },
      onUpgradeAborted(context) {
        releasedSlot = context.slot;
        resolveReleased();
      },
      onConnection() {
        throw new Error("timed out authorization must not connect");
      },
    });

    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        client.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        client.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
        client.once("error", () => undefined);
      });
      expect(status).toBe(503);
      await released;
      expect(authorizationSignal?.aborted).toBe(true);
      expect(releasedSlot).toBe("late_slot");
    } finally {
      client.terminate();
      await plane.stop();
    }
  });

  it("keeps a slot occupied while a timed-out authorization promise is still pending", async () => {
    let authorizationCalls = 0;
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      authorizationTimeoutMs: 10,
      maxPendingAuthorizations: 1,
      async authorizeUpgrade() {
        authorizationCalls += 1;
        await new Promise<void>(() => undefined);
        return { ok: true, context: undefined };
      },
      onConnection() {
        throw new Error("pending authorization must not connect");
      },
    });

    await plane.start();
    const clients: WebSocket[] = [];
    const connectRejected = async (): Promise<number> => {
      const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
      clients.push(client);
      return new Promise<number>((resolve, reject) => {
        client.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        client.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
        client.once("error", () => undefined);
      });
    };
    try {
      await expect(connectRejected()).resolves.toBe(503);
      await expect(connectRejected()).resolves.toBe(503);
      expect(authorizationCalls).toBe(1);
    } finally {
      for (const client of clients) client.terminate();
      await plane.stop();
    }
  });

  it.each([401, 403])("rejects unauthorized upgrades with HTTP %i", async (statusCode) => {
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      authorizeUpgrade() {
        return { ok: false, statusCode };
      },
      onConnection() {
        throw new Error("must not connect");
      },
    });

    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
    try {
      const observed = await new Promise<number>((resolve, reject) => {
        client.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        client.once("open", () => reject(new Error("upgrade unexpectedly succeeded")));
        client.once("error", () => undefined);
      });
      expect(observed).toBe(statusCode);
    } finally {
      client.terminate();
      await plane.stop();
    }
  });

  it("fails closed when upgrade authorization throws", async () => {
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      authorizeUpgrade() {
        throw new Error("auth failed");
      },
      onConnection() {},
    });
    await plane.start();
    const client = new WebSocket(`ws://127.0.0.1:${plane.address?.port}/media/x`);
    try {
      const status = await new Promise<number>((resolve) => {
        client.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        client.once("error", () => undefined);
      });
      expect(status).toBe(500);
    } finally {
      client.terminate();
      await plane.stop();
    }
  });

  it("returns readiness failure when the health check throws", async () => {
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      healthCheck: async () => {
        throw new Error("database unavailable");
      },
      onConnection() {},
    });

    await plane.start();
    try {
      const response = await fetch(`http://127.0.0.1:${plane.address?.port}/healthz`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false });
    } finally {
      await plane.stop();
    }
  });

  it("does not expose arbitrary health check details", async () => {
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      healthCheck: async () => ({
        ok: false,
        checks: { database: { ok: false, detail: "internal database endpoint unavailable" } },
      }),
      onConnection() {},
    });

    await plane.start();
    try {
      const response = await fetch(`http://127.0.0.1:${plane.address?.port}/healthz`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ ok: false });
    } finally {
      await plane.stop();
    }
  });

  it("aborts pending authorization and closes its raw socket during stop", async () => {
    let authorizationSignal: AbortSignal | undefined;
    let resolveAuthorizationStarted: () => void = () => undefined;
    const authorizationStarted = new Promise<void>((resolve) => {
      resolveAuthorizationStarted = resolve;
    });
    let releases = 0;
    let resolveReleased: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const plane = createNodeMediaPlane<{ callId: string }>({
      port: 0,
      path: "/media/:callId",
      authorizationTimeoutMs: 1_000,
      authorizeUpgrade(_request, _url, _params, signal) {
        authorizationSignal = signal;
        resolveAuthorizationStarted();
        return new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () => resolve({ ok: true, context: { callId: "reserved-call" } }),
            { once: true },
          ),
        );
      },
      onUpgradeAborted() {
        releases += 1;
        resolveReleased();
      },
      onConnection() {
        throw new Error("a stopped media plane must not upgrade a late grant");
      },
    });

    await plane.start();
    const socket = createConnection({ port: plane.address?.port ?? 0, host: "127.0.0.1" });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      "GET /media/x HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    let stopping: Promise<void> | undefined;
    try {
      await authorizationStarted;
      stopping = plane.stop();
      const stoppedPromptly = await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(stoppedPromptly).toBe(true);
      await released;
      expect(authorizationSignal?.aborted).toBe(true);
      expect(releases).toBe(1);
    } finally {
      socket.destroy();
      await (stopping ?? plane.stop());
    }
  });

  it("releases accepted context when ws rejects the handshake after authorization", async () => {
    let releases = 0;
    let authorizations = 0;
    const cleanupFailure = new Error("reservation restore failed");
    let reportedCleanupError: unknown;
    let resolveReleased: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    let resolveCleanupError: () => void = () => undefined;
    const cleanupErrorReported = new Promise<void>((resolve) => {
      resolveCleanupError = resolve;
    });
    const plane = createNodeMediaPlane<{ slot: string }>({
      port: 0,
      path: "/media/:callId",
      authorizeUpgrade() {
        authorizations += 1;
        return { ok: true, context: { slot: "slot_1" } };
      },
      onUpgradeAborted(context) {
        expect(context.slot).toBe("slot_1");
        releases += 1;
        resolveReleased();
        throw cleanupFailure;
      },
      onUpgradeAbortedError(error, context) {
        expect(context.slot).toBe("slot_1");
        reportedCleanupError = error;
        resolveCleanupError();
        return Promise.reject(new Error("cleanup error observer failure is swallowed"));
      },
      onConnection() {
        throw new Error("must not connect");
      },
    });
    await plane.start();
    const socket = createConnection({ port: plane.address?.port ?? 0, host: "127.0.0.1" });
    socket.on("error", () => undefined);
    let response = "";
    const handshakeRejected = new Promise<void>((resolve) => {
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.includes("\r\n\r\n")) resolve();
      });
    });
    socket.write(
      "GET /media/x HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: invalid\r\n\r\n",
    );
    try {
      await handshakeRejected;
      expect(response).toContain("HTTP/1.1 400");
      await released;
      await cleanupErrorReported;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(authorizations).toBe(1);
      expect(releases).toBe(1);
      expect(reportedCleanupError).toBe(cleanupFailure);
    } finally {
      socket.destroy();
      await plane.stop();
    }
  });

  it("routes async onConnection failures to onConnectionError instead of crashing", async () => {
    let captured: unknown;
    let resolveErrored: () => void = () => undefined;
    const errored = new Promise<void>((resolve) => {
      resolveErrored = resolve;
    });

    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      async onConnection() {
        throw new Error("handler boom");
      },
      onConnectionError(error) {
        captured = error;
        resolveErrored();
      },
    });

    await plane.start();
    const port = plane.address?.port;
    expect(port).toBeTypeOf("number");

    const client = new WebSocket(`ws://127.0.0.1:${port}/media/x`);
    client.on("error", () => undefined); // swallow teardown reset noise
    try {
      await errored;
      expect(captured).toBeInstanceOf(Error);
      expect((captured as Error).message).toBe("handler boom");
    } finally {
      client.close();
      await plane.stop();
    }
  });

  it("closes the socket when the error handler itself throws", async () => {
    const plane = createNodeMediaPlane({
      port: 0,
      path: "/media/:callId",
      async onConnection() {
        throw new Error("handler boom");
      },
      onConnectionError() {
        throw new Error("error handler boom too");
      },
    });

    await plane.start();
    const port = plane.address?.port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/media/x`);
    client.on("error", () => undefined);
    try {
      // The connection must be closed (no unhandled rejection / hang) despite the
      // error handler also failing.
      await new Promise<void>((resolve) => client.on("close", () => resolve()));
    } finally {
      await plane.stop();
    }
  });
});
