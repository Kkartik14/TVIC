import { once } from "node:events";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { describe, expect, it } from "vitest";

import { StartupBufferedTwilioSocket } from "../src/startup-buffered-twilio-socket.js";

describe("StartupBufferedTwilioSocket", () => {
  it("replays early Twilio frames before forwarding the remote close", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP listener");
    const accepted = once(server, "connection").then(([socket]) => socket as WebSocket);
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.on("error", () => undefined);
    let serverSocket: WebSocket | undefined;

    try {
      await once(client, "open");
      serverSocket = await accepted;
      let receivedCount = 0;
      let resolveReceived!: () => void;
      const allReceived = new Promise<void>((resolve) => {
        resolveReceived = resolve;
      });
      serverSocket.on("message", () => {
        receivedCount += 1;
        if (receivedCount === 3) resolveReceived();
      });
      const buffered = new StartupBufferedTwilioSocket(serverSocket);
      const frames = [
        JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }),
        JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZ-test" }),
        JSON.stringify({
          event: "media",
          sequenceNumber: "2",
          streamSid: "MZ-test",
          media: { track: "inbound", chunk: "1", timestamp: "0", payload: "AA==" },
        }),
      ];
      for (const frame of frames) {
        await new Promise<void>((resolve, reject) => {
          client.send(frame, (error) => (error ? reject(error) : resolve()));
        });
      }
      await allReceived;
      client.close();
      await once(serverSocket, "close");

      const replayed: string[] = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      buffered.on("message", (data) => replayed.push(rawDataText(data)));
      buffered.on("close", resolveClosed);
      await closed;
      expect(replayed).toEqual(frames);
    } finally {
      client.terminate();
      serverSocket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes the socket when early frames exceed the startup buffer", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP listener");
    const accepted = once(server, "connection").then(([socket]) => socket as WebSocket);
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.on("error", () => undefined);
    let serverSocket: WebSocket | undefined;

    try {
      await once(client, "open");
      serverSocket = await accepted;
      const buffered = new StartupBufferedTwilioSocket(serverSocket);
      let resolveError!: (error: Error) => void;
      const startupError = new Promise<Error>((resolve) => {
        resolveError = resolve;
      });
      buffered.on("error", resolveError);
      let resolveCloseCode!: (code: number) => void;
      const closeCode = new Promise<number>((resolve) => {
        resolveCloseCode = resolve;
      });
      serverSocket.once("close", (code) => resolveCloseCode(code));

      for (let index = 0; index < 33; index += 1) {
        await new Promise<void>((resolve, reject) => {
          client.send(`frame-${index}`, (error) => (error ? reject(error) : resolve()));
        });
      }

      await expect(startupError).resolves.toMatchObject({
        message: "Twilio media stream startup buffer exceeded",
      });
      await expect(closeCode).resolves.toBe(1009);
    } finally {
      client.terminate();
      serverSocket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}
