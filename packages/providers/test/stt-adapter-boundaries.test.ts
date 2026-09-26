import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  AssemblyAiSttProvider,
  ElevenLabsSttProvider,
  SarvamSttProvider,
  SonioxSttProvider,
} from "../src/index.js";
import {
  PCM16_16K_MONO,
  PCM16_8K_MONO,
  createMediaEvent,
  type AudioFormat,
  type SpeechToTextProvider,
  type SttStream,
} from "@tvic/core";

class AdapterSocket {
  readonly sent: Array<string | Buffer> = [];
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();
  readyState: number = WebSocket.OPEN;
  onSend: ((data: string | Buffer) => void) | undefined;

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

  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data));
    this.onSend?.(data);
  }

  close(code = 1000, reason = Buffer.alloc(0)): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, reason);
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }

  private emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...values);
  }
}

interface SttAdapterCase {
  readonly name: string;
  readonly create: (socket: AdapterSocket) => SpeechToTextProvider;
  readonly configure: (socket: AdapterSocket) => void;
}

const cases: readonly SttAdapterCase[] = [
  {
    name: "Sarvam",
    create: (socket) =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: () => socket as unknown as WebSocket,
      }),
    configure: () => undefined,
  },
  {
    name: "ElevenLabs Scribe",
    create: (socket) =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        webSocketFactory: () => socket as unknown as WebSocket,
      }),
    configure: () => undefined,
  },
  {
    name: "AssemblyAI",
    create: (socket) =>
      new AssemblyAiSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          queueMicrotask(() => socket.receive({ type: "Begin", id: "assembly-begin" }));
          return socket as unknown as WebSocket;
        },
      }),
    configure: (socket) => {
      socket.onSend = (data) => {
        if (typeof data === "string" && JSON.parse(data).type === "Terminate") {
          socket.receive({ type: "Termination" });
        }
      };
    },
  },
  {
    name: "Soniox",
    create: (socket) =>
      new SonioxSttProvider({
        apiKey: "test",
        webSocketFactory: () => socket as unknown as WebSocket,
      }),
    configure: (socket) => {
      socket.onSend = (data) => {
        if (data === "") socket.receive({ finished: true });
      };
    },
  },
];

function audioChunk(format: AudioFormat, bytes = new Uint8Array(format.sampleRateHz / 50 / 2)) {
  return createMediaEvent({
    id: "stt-audio" as never,
    type: "media.audio.chunk",
    sessionId: "stt-session" as never,
    sequence: 1,
    direction: "input",
    timestamp: "2026-09-24T00:00:00.000Z" as never,
    monotonicOffsetMs: 0,
    audio: {
      format,
      durationMs: 20,
      frameCount: format.sampleRateHz / 50,
      bytes,
    },
  });
}

async function openAt16k(testCase: SttAdapterCase, socket: AdapterSocket): Promise<SttStream> {
  testCase.configure(socket);
  const provider = testCase.create(socket);
  return provider.open({
    sessionId: "stt-session" as never,
    format: PCM16_16K_MONO,
    interimResults: true,
  });
}

describe("STT adapter format boundaries", () => {
  it.each(cases)(
    "$name rejects a chunk whose rate differs from the opened stream",
    async (testCase) => {
      const socket = new AdapterSocket();
      const stream = await openAt16k(testCase, socket);

      await expect(stream.sendAudio(audioChunk(PCM16_8K_MONO))).rejects.toMatchObject({
        code: "stt.sample_rate_mismatch",
      });
      expect(socket.sent).toHaveLength(testCase.name === "Soniox" ? 1 : 0);

      await stream.close();
    },
  );

  it.each(cases)("$name rejects an unsupported rate before opening a socket", async (testCase) => {
    const socket = new AdapterSocket();
    const provider = testCase.create(socket);

    await expect(
      provider.open({
        sessionId: "stt-invalid-rate" as never,
        format: { ...PCM16_16K_MONO, sampleRateHz: 11025 as never },
        interimResults: true,
      }),
    ).rejects.toMatchObject({
      category: "validation",
      code: "stt.sample_rate_unsupported",
    });
    expect(socket.sent).toHaveLength(0);
  });

  it.each(cases)("$name rejects an odd-byte PCM chunk before writing", async (testCase) => {
    const socket = new AdapterSocket();
    const stream = await openAt16k(testCase, socket);
    const writesBeforeChunk = socket.sent.length;

    await expect(
      stream.sendAudio(audioChunk(PCM16_16K_MONO, new Uint8Array([0]))),
    ).rejects.toMatchObject({
      category: "validation",
      code: "stt.audio_odd_byte_length",
    });
    expect(socket.sent).toHaveLength(writesBeforeChunk);
    await stream.close();
  });
});

describe("AssemblyAI formatted-turn branches", () => {
  it("holds an explicit unformatted final until its formatted replacement", async () => {
    const socket = new AdapterSocket();
    const stream = await openAssembly(socket, true);
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive({
      type: "Turn",
      turn_order: 7,
      turn_is_formatted: false,
      transcript: "raw turn",
      end_of_turn: true,
    });
    socket.receive({
      type: "Turn",
      turn_order: 7,
      turn_is_formatted: true,
      transcript: "formatted turn",
      end_of_turn: true,
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.final", text: "formatted turn" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.endpoint" },
      done: false,
    });
    await stream.close();
  });

  it("emits an unformatted final directly when formatTurns is disabled", async () => {
    const socket = new AdapterSocket();
    const stream = await openAssembly(socket, false);
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive({
      type: "Turn",
      turn_order: 8,
      turn_is_formatted: false,
      transcript: "direct turn",
      end_of_turn: true,
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.final", text: "direct turn" },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "stt.endpoint" },
      done: false,
    });
    await stream.close();
  });

  it("fails if the provider closes while a formatted replacement is pending", async () => {
    const socket = new AdapterSocket();
    const stream = await openAssembly(socket, true);
    const iterator = stream.events[Symbol.asyncIterator]();

    socket.receive({
      type: "Turn",
      turn_order: 9,
      turn_is_formatted: false,
      transcript: "never replaced",
      end_of_turn: true,
    });
    const pending = iterator.next();
    socket.close(1000);

    await expect(pending).rejects.toMatchObject({
      code: "provider.protocol_invalid",
      provider: "assemblyai-stt",
      retriable: false,
    });
  });
});

async function openAssembly(socket: AdapterSocket, formatTurns: boolean): Promise<SttStream> {
  socket.onSend = (data) => {
    if (typeof data === "string" && JSON.parse(data).type === "Terminate") {
      socket.receive({ type: "Termination" });
    }
  };
  const provider = new AssemblyAiSttProvider({
    apiKey: "test",
    formatTurns,
    webSocketFactory: () => {
      queueMicrotask(() => socket.receive({ type: "Begin", id: "assembly-begin" }));
      return socket as unknown as WebSocket;
    },
  });
  return provider.open({
    sessionId: "assembly-session" as never,
    format: PCM16_16K_MONO,
    interimResults: true,
  });
}
