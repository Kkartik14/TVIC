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
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  type SpeechToTextProvider,
  type SttStream,
} from "@tvic/core";

interface SttErrorCase {
  readonly name: string;
  readonly providerName: string;
  readonly create: (socket: ErrorSocket) => SpeechToTextProvider;
  readonly unknownMessage: unknown;
}

const cases: readonly SttErrorCase[] = [
  {
    name: "Sarvam",
    providerName: PROVIDER_NAMES.sarvam,
    create: (socket) =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: () => socket as unknown as WebSocket,
      }),
    unknownMessage: { type: "mystery" },
  },
  {
    name: "ElevenLabs Scribe",
    providerName: PROVIDER_NAMES.elevenlabsStt,
    create: (socket) =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        webSocketFactory: () => socket as unknown as WebSocket,
      }),
    unknownMessage: { message_type: "mystery" },
  },
  {
    name: "AssemblyAI",
    providerName: PROVIDER_NAMES.assemblyaiStt,
    create: (socket) =>
      new AssemblyAiSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          queueMicrotask(() => socket.receive({ type: "Begin", id: "assembly-errors" }));
          return socket as unknown as WebSocket;
        },
      }),
    unknownMessage: { type: "mystery" },
  },
  {
    name: "Soniox",
    providerName: PROVIDER_NAMES.sonioxStt,
    create: (socket) =>
      new SonioxSttProvider({
        apiKey: "test",
        webSocketFactory: () => socket as unknown as WebSocket,
      }),
    unknownMessage: { mystery: true },
  },
];

describe("Provider error and protocol boundaries", () => {
  it.each(cases)("$name fails malformed JSON instead of silently closing", async (testCase) => {
    const socket = new ErrorSocket();
    const stream = await open(testCase, socket);
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receiveRaw(Buffer.from("{"));

    await expect(pending).rejects.toMatchObject({
      category: "provider",
      code: STT_ERROR_CODES.protocolError,
      provider: testCase.providerName,
      retriable: false,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it.each(cases)("$name fails an unknown state-bearing message", async (testCase) => {
    const socket = new ErrorSocket();
    const stream = await open(testCase, socket);
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive(testCase.unknownMessage);

    await expect(pending).rejects.toMatchObject({
      category: "provider",
      code: STT_ERROR_CODES.protocolError,
      provider: testCase.providerName,
      retriable: false,
    });
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("Soniox rejects a token with missing required fields", async () => {
    const socket = new ErrorSocket();
    const stream = await open(cases[3]!, socket);
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.receive({ tokens: [{ text: "hello" }] });

    await expect(pending).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: PROVIDER_NAMES.sonioxStt,
    });
  });
});

async function open(testCase: SttErrorCase, socket: ErrorSocket): Promise<SttStream> {
  return testCase.create(socket).open({
    sessionId: "protocol-errors-session" as never,
    format: PCM16_16K_MONO,
    interimResults: true,
  });
}

class ErrorSocket {
  readyState: number = WebSocket.OPEN;
  readonly #handlers = new Map<string, Set<(...values: unknown[]) => void>>();

  on(event: string, handler: (...values: unknown[]) => void): this {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  send(_data: string | Buffer): void {}

  close(code = 1000, reason = Buffer.alloc(0)): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", code, reason);
  }

  receive(message: unknown): void {
    this.receiveRaw(Buffer.from(JSON.stringify(message)));
  }

  receiveRaw(data: WebSocket.RawData): void {
    this.#emit("message", data);
  }

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...values);
  }
}
