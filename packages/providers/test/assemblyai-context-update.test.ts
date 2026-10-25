import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";
import { AssemblyAiSttProvider } from "../src/index.js";

class ContextSocket extends EventEmitter {
  readonly sent: string[] = [];
  readonly order: string[] = [];
  readyState: number = WebSocket.OPEN;

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string") {
      this.sent.push(data);
      if (JSON.parse(data).type === "UpdateConfiguration") this.order.push("context");
      if (JSON.parse(data).type === "Terminate") {
        queueMicrotask(() => this.emit("message", Buffer.from('{"type":"Termination"}')));
      }
    } else {
      this.order.push("audio");
    }
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }
}

describe("AssemblyAI live agent context", () => {
  it("declares context update support only for Universal-3 Pro models", () => {
    const provider = new AssemblyAiSttProvider({ apiKey: "test" });

    expect(provider.supportsSttAgentContext?.("universal-3-5-pro")).toBe(true);
    expect(provider.supportsSttAgentContext?.("universal-3-6-pro")).toBe(true);
    expect(provider.supportsSttAgentContext?.("universal-streaming-english")).toBe(false);
  });

  it("sends UpdateConfiguration without putting context in the connection URL", async () => {
    const socket = new ContextSocket();
    let openedUrl = "";
    const provider = new AssemblyAiSttProvider({
      apiKey: "test",
      modelId: "universal-3-6-pro",
      webSocketFactory: (url) => {
        openedUrl = url;
        queueMicrotask(() =>
          socket.emit("message", Buffer.from('{"type":"Begin","id":"context"}')),
        );
        return socket as never;
      },
    });
    const stream = await provider.open({
      sessionId: "assembly_context" as never,
      format: PCM16_16K_MONO,
      model: "universal-3-6-pro",
      interimResults: true,
    });

    await (
      stream as typeof stream & { updateAgentContext: (context: string) => Promise<void> }
    ).updateAgentContext("What date should I book?");

    expect(new URL(openedUrl).searchParams.has("agent_context")).toBe(false);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { type: "UpdateConfiguration", agent_context: "What date should I book?" },
    ]);
    await stream.close();
  });

  it("flushes buffered caller audio before sending UpdateConfiguration", async () => {
    const socket = new ContextSocket();
    const provider = new AssemblyAiSttProvider({
      apiKey: "test",
      modelId: "universal-3-6-pro",
      webSocketFactory: (_url) => {
        queueMicrotask(() =>
          socket.emit("message", Buffer.from('{"type":"Begin","id":"context"}')),
        );
        return socket as never;
      },
    });
    const stream = await provider.open({
      sessionId: "assembly_context_audio_order" as never,
      format: PCM16_16K_MONO,
      model: "universal-3-6-pro",
      interimResults: true,
    });

    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array(640),
      },
    } as never);
    await (
      stream as typeof stream & { updateAgentContext: (context: string) => Promise<void> }
    ).updateAgentContext("latest reply");

    expect(socket.order).toEqual(["audio", "context"]);
    await stream.close();
  });
});
