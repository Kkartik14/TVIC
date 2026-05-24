import { describe, expect, it } from "vitest";
import WebSocket from "ws";

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
