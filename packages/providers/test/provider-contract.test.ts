import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { openWebSocket, parseJsonObject } from "../src/common.js";

/**
 * Shared startup contract every WebSocket-based adapter relies on (Deepgram, Cartesia,
 * Twilio): a handshake resolves on open, and fails fast — closing the socket — on
 * error, timeout, or external abort, so a stalled connect can never leak or wedge.
 */
class FakeWs {
  readyState = 0; // CONNECTING
  closed = false;
  readonly #handlers = new Map<string, Set<(arg?: unknown) => void>>();

  on(event: string, handler: (arg?: unknown) => void): this {
    const set = this.#handlers.get(event) ?? new Set();
    set.add(handler);
    this.#handlers.set(event, set);
    return this;
  }

  off(event: string, handler: (arg?: unknown) => void): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  close(): void {
    this.closed = true;
  }

  fireOpen(): void {
    this.readyState = WebSocket.OPEN;
    for (const handler of this.#handlers.get("open") ?? []) {
      handler();
    }
  }

  fireError(error: Error): void {
    for (const handler of this.#handlers.get("error") ?? []) {
      handler(error);
    }
  }
}

function fake(): { socket: FakeWs; ws: WebSocket } {
  const socket = new FakeWs();
  return { socket, ws: socket as unknown as WebSocket };
}

describe("provider startup contract (openWebSocket)", () => {
  it("resolves once the socket opens", async () => {
    const { socket, ws } = fake();
    const pending = openWebSocket(ws, { timeoutMs: 1000 });
    socket.fireOpen();
    await expect(pending).resolves.toBeUndefined();
    expect(socket.closed).toBe(false);
  });

  it("rejects and closes the socket on a connection error", async () => {
    const { socket, ws } = fake();
    const pending = openWebSocket(ws, { timeoutMs: 1000 });
    socket.fireError(new Error("refused"));
    await expect(pending).rejects.toThrow("refused");
    expect(socket.closed).toBe(true);
  });

  it("rejects and closes the socket on a connect timeout", async () => {
    const { socket, ws } = fake();
    await expect(openWebSocket(ws, { timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(socket.closed).toBe(true);
  });

  it("rejects and closes the socket when the signal is already aborted", async () => {
    const { socket, ws } = fake();
    const controller = new AbortController();
    controller.abort();
    await expect(openWebSocket(ws, { timeoutMs: 1000, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(socket.closed).toBe(true);
  });

  it("rejects and closes the socket when the signal aborts mid-connect", async () => {
    const { socket, ws } = fake();
    const controller = new AbortController();
    const pending = openWebSocket(ws, { timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(socket.closed).toBe(true);
  });

  it("short-circuits when the socket is already open", async () => {
    const { socket, ws } = fake();
    socket.readyState = WebSocket.OPEN;
    await expect(openWebSocket(ws)).resolves.toBeUndefined();
  });
});

describe("provider JSON boundary", () => {
  it("returns only parsed objects from provider text frames", () => {
    expect(parseJsonObject('{"type":"ok"}')).toEqual({ type: "ok" });
    expect(parseJsonObject("[1,2,3]")).toBeNull();
    expect(parseJsonObject("not json")).toBeNull();
  });
});
