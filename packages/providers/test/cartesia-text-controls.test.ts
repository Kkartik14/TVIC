import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";
import { CartesiaTtsProvider } from "../src/cartesia.js";

class CartesiaTextControlSocket {
  readonly sent: string[] = [];
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();
  readyState: number = WebSocket.OPEN;

  on(event: string, handler: (...values: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (...values: unknown[]) => void): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  send(data: string | Buffer, callback?: (error?: Error) => void): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    callback?.();
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.#handlers.get("close") ?? []) {
      handler(1000, Buffer.alloc(0));
    }
  }
}

describe("Cartesia TTS text controls", () => {
  it("escapes generated markup and adds only typed host operations", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_controls" as never,
      turnId: "turn_cartesia_controls" as never,
      format: PCM16_16K_MONO,
      textControls: [
        { type: "spell", match: "ABC123" },
        { type: "pause", match: "after this", durationMs: 250 },
      ],
    });

    await session.sendText('Read <spell>ABC123</spell> & wait after this <break time="2s"/>');

    expect(JSON.parse(socket.sent[0]!).transcript).toBe(
      'Read &lt;spell&gt;<spell>ABC123</spell>&lt;/spell&gt; &amp; wait after this<break time="250ms"/> &lt;break time="2s"/&gt;',
    );
    await session.cancel();
  });

  it("rejects unsupported controls before opening the socket", async () => {
    let connected = false;
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => {
        connected = true;
        return new CartesiaTextControlSocket() as unknown as WebSocket;
      },
    });

    await expect(
      provider.openSession({
        sessionId: "session_cartesia_unknown_control" as never,
        turnId: "turn_cartesia_unknown_control" as never,
        format: PCM16_16K_MONO,
        textControls: [{ type: "phoneme", match: "TVIC", phonemes: "t-vik" } as never],
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(connected).toBe(false);
  });

  it("keeps a split control together across incremental writes and counts serialized text", async () => {
    const socket = new CartesiaTextControlSocket();
    const reportedCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_split_control" as never,
      turnId: "turn_cartesia_split_control" as never,
      format: PCM16_16K_MONO,
      textControls: [{ type: "spell", match: "ABC123" }],
      usageReporter: {
        report() {},
        beginOperation() {
          throw new Error("unused");
        },
        reportTextCharacters(value) {
          reportedCharacters.push(value);
        },
      },
    });

    await session.sendText("Start ABC");
    await session.sendText("123 end");

    expect(socket.sent.map((value) => JSON.parse(value).transcript)).toEqual([
      "Start ",
      "<spell>ABC123</spell> end",
    ]);
    expect(reportedCharacters).toEqual([6, 25]);
    await session.cancel();
  });
});
