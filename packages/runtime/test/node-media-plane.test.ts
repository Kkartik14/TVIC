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

  it("releases accepted context exactly once when the raw handshake aborts", async () => {
    let releases = 0;
    let resolveReleased: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const plane = createNodeMediaPlane<{ slot: string }>({
      port: 0,
      path: "/media/:callId",
      authorizeUpgrade(request) {
        request.socket.destroy(new Error("client dropped"));
        return { ok: true, context: { slot: "slot_1" } };
      },
      onUpgradeAborted(context) {
        expect(context.slot).toBe("slot_1");
        releases += 1;
        resolveReleased();
        throw new Error("cleanup observer failure is swallowed");
      },
      onConnection() {
        throw new Error("must not connect");
      },
    });
    await plane.start();
    const socket = createConnection({ port: plane.address?.port ?? 0, host: "127.0.0.1" });
    socket.on("error", () => undefined);
    socket.write(
      "GET /media/x HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    try {
      await released;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(releases).toBe(1);
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
