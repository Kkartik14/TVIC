import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, TvicThrowableError } from "@tvic/core";
import { AssemblyAiSttProvider } from "../src/index.js";

class ContextSocket extends EventEmitter {
  readonly sent: string[] = [];
  readonly order: string[] = [];
  readonly audioByteLengths: number[] = [];
  readonly delayedBinaryCallbacks: Array<(error?: Error) => void> = [];
  readyState: number = WebSocket.OPEN;
  delayNextBinaryCallback = false;
  delayAllBinaryCallbacks = false;
  failNextContextCallback = false;
  throwNextContextSend = false;
  terminateCount = 0;

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    if (typeof data === "string") {
      this.sent.push(data);
      if (JSON.parse(data).type === "UpdateConfiguration") {
        this.order.push("context");
        if (this.throwNextContextSend) {
          this.throwNextContextSend = false;
          throw new Error("local socket send failed");
        }
        if (this.failNextContextCallback) {
          this.failNextContextCallback = false;
          callback?.(new Error("local socket callback failed"));
          return;
        }
      }
      if (JSON.parse(data).type === "Terminate") {
        queueMicrotask(() => this.emit("message", Buffer.from('{"type":"Termination"}')));
      }
    } else {
      this.order.push("audio");
      this.audioByteLengths.push(data.byteLength);
      if (this.delayNextBinaryCallback || this.delayAllBinaryCallbacks) {
        this.delayNextBinaryCallback = false;
        if (callback) this.delayedBinaryCallbacks.push(callback);
        return;
      }
    }
    callback?.();
  }

  releaseDelayedBinaryCallbacks(): void {
    for (const callback of this.delayedBinaryCallbacks.splice(0)) callback();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.terminateCount += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
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

  it.each(["callback", "synchronous send"] as const)(
    "normalizes %s failures while updating context",
    async (failureMode) => {
      const socket = new ContextSocket();
      if (failureMode === "callback") socket.failNextContextCallback = true;
      else socket.throwNextContextSend = true;
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
        sessionId: "assembly_context_error" as never,
        format: PCM16_16K_MONO,
        model: "universal-3-6-pro",
        interimResults: true,
      });

      const failure = await stream.updateAgentContext!("context").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TvicThrowableError);
      expect(failure).toMatchObject({ code: "stt.context_update_failed" });
      await stream.close();
    },
  );

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
        durationMs: 50,
        frameCount: 800,
        bytes: new Uint8Array(1_600),
      },
    } as never);
    await (
      stream as typeof stream & { updateAgentContext: (context: string) => Promise<void> }
    ).updateAgentContext("latest reply");

    expect(socket.order).toEqual(["audio", "context"]);
    await stream.close();
  });

  it("does not pad subminimum caller audio when updating the context", async () => {
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
      sessionId: "assembly_context_short_audio" as never,
      format: PCM16_16K_MONO,
      model: "universal-3-6-pro",
      interimResults: true,
    });
    const sendAudio = (byteLength: number): Promise<void> =>
      stream.sendAudio({
        audio: {
          format: PCM16_16K_MONO,
          durationMs: byteLength / 32,
          frameCount: byteLength / 2,
          bytes: new Uint8Array(byteLength),
        },
      } as never);

    await sendAudio(160);
    await stream.updateAgentContext!("first reply");
    expect(socket.order).toEqual(["context"]);

    await sendAudio(1_440);
    await stream.updateAgentContext!("second reply");
    expect(socket.order).toEqual(["context", "audio", "context"]);
    expect(socket.audioByteLengths).toEqual([1_600]);
    await stream.close();
  });

  it("does not send a timed-out context after a delayed audio flush completes", async () => {
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
      sessionId: "assembly_context_cancelled_flush" as never,
      format: PCM16_16K_MONO,
      model: "universal-3-6-pro",
      interimResults: true,
    });
    const updateAbort = new AbortController();
    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 50,
        frameCount: 800,
        bytes: new Uint8Array(1_600),
      },
    } as never);
    socket.delayNextBinaryCallback = true;
    const contextUpdate = stream.updateAgentContext!("stale reply", {
      signal: updateAbort.signal,
    });
    let contextSettled = false;
    let contextFailure: unknown;
    void contextUpdate.then(
      () => {
        contextSettled = true;
      },
      (error: unknown) => {
        contextFailure = error;
        contextSettled = true;
      },
    );
    await waitFor(
      () => socket.delayedBinaryCallbacks.length === 1 || contextSettled,
      () => `callbacks=${socket.delayedBinaryCallbacks.length}, failure=${String(contextFailure)}`,
    );
    expect(socket.delayedBinaryCallbacks).toHaveLength(1);
    updateAbort.abort();
    await stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 100,
        frameCount: 1_600,
        bytes: new Uint8Array(3_200),
      },
    } as never);
    socket.releaseDelayedBinaryCallbacks();

    await expect(contextUpdate).rejects.toMatchObject({
      code: "stt.context_update_failed",
      retriable: true,
    });
    expect(socket.order).toEqual(["audio", "audio"]);
    expect(socket.sent.map((message) => JSON.parse(message).type)).not.toContain(
      "UpdateConfiguration",
    );
    await stream.close();
  });

  it("does not send a context update after close starts during a delayed audio flush", async () => {
    const socket = new ContextSocket();
    socket.delayAllBinaryCallbacks = true;
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
      sessionId: "assembly_context_close_during_flush" as never,
      format: PCM16_16K_MONO,
      model: "universal-3-6-pro",
      interimResults: true,
    });

    const audioWrite = stream.sendAudio({
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 200,
        frameCount: 3_200,
        bytes: new Uint8Array(6_400),
      },
    } as never);
    await waitFor(() => socket.delayedBinaryCallbacks.length === 1);

    const contextUpdate = stream.updateAgentContext!("must not follow close");
    const contextFailure = contextUpdate.catch((error: unknown) => error);
    await waitFor(() => socket.delayedBinaryCallbacks.length === 2);

    const closing = stream.close();
    socket.releaseDelayedBinaryCallbacks();

    await expect(contextFailure).resolves.toBeInstanceOf(TvicThrowableError);
    await Promise.all([audioWrite, closing]);
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual(["Terminate"]);
  });

  it.each(["partial frame", "in-flight full frame"] as const)(
    "bounds close while an AssemblyAI %s write is stalled",
    async (writeKind) => {
      const socket = new ContextSocket();
      socket.delayAllBinaryCallbacks = true;
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
        sessionId: `assembly_close_stalled_${writeKind.replaceAll(" ", "_")}` as never,
        format: PCM16_16K_MONO,
        model: "universal-3-6-pro",
        interimResults: true,
      });
      const events = stream.events[Symbol.asyncIterator]();

      const audioWrite =
        writeKind === "partial frame"
          ? stream.sendAudio({
              audio: {
                format: PCM16_16K_MONO,
                durationMs: 1,
                frameCount: 1,
                bytes: new Uint8Array(2),
              },
            } as never)
          : stream.sendAudio({
              audio: {
                format: PCM16_16K_MONO,
                durationMs: 100,
                frameCount: 1_600,
                bytes: new Uint8Array(3_200),
              },
            } as never);
      void audioWrite.catch(() => undefined);
      const audioOutcome = audioWrite.then(
        () => undefined,
        (error: unknown) => error,
      );
      const closing = stream.close();
      await waitFor(() => socket.delayedBinaryCallbacks.length === 1);

      await expect(closing).resolves.toBeUndefined();
      if (writeKind === "in-flight full frame") {
        await expect(audioOutcome).resolves.toBeInstanceOf(TvicThrowableError);
      } else {
        await expect(audioOutcome).resolves.toBeUndefined();
      }
      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect(socket.terminateCount).toBe(1);
      expect(socket.sent).toEqual([]);
      await expect(events.next()).resolves.toMatchObject({ done: true });
    },
  );
});

async function waitFor(predicate: () => boolean, describe?: () => string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition did not become true${describe ? ` (${describe()})` : ""}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
