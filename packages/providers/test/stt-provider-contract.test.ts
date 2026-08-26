import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  AssemblyAiSttProvider,
  DeepgramSttProvider,
  ElevenLabsSttProvider,
  SarvamSttProvider,
  SonioxSttProvider,
} from "../src/index.js";
import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  type SpeechToTextProvider,
} from "@tvic/core";

class ContractSocket {
  readonly sent: Array<string | Buffer> = [];
  factoryCalls = 0;
  readyState: number = WebSocket.OPEN;
  onSend: ((data: string | Buffer) => void) | undefined;
  #handlers = new Map<string, Set<(value?: unknown) => void>>();

  on(event: string, handler: (value?: unknown) => void): this {
    const handlers = this.#handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (value?: unknown) => void): this {
    this.#handlers.get(event)?.delete(handler);
    return this;
  }

  send(data: string | Buffer): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data));
    this.onSend?.(data);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.#emit("close");
  }

  fail(error: Error): void {
    this.#emit("error", error);
  }

  receive(message: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(value);
    }
  }
}

interface SttContractCase {
  readonly name: string;
  readonly providerName: string;
  readonly errorCode: string;
  readonly supportedModel: string;
  readonly commitMode: "provider" | "none";
  create(socket: ContractSocket): SpeechToTextProvider;
  configure(socket: ContractSocket): void;
}

const cases: readonly SttContractCase[] = [
  {
    name: "Deepgram",
    providerName: PROVIDER_NAMES.deepgram,
    errorCode: PROVIDER_ERROR_CODES.deepgramStt,
    supportedModel: "nova-3",
    commitMode: "provider",
    create: (socket) =>
      new DeepgramSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: () => undefined,
  },
  {
    name: "Sarvam",
    providerName: PROVIDER_NAMES.sarvam,
    errorCode: PROVIDER_ERROR_CODES.sarvamStt,
    supportedModel: "saaras:v3",
    commitMode: "provider",
    create: (socket) =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: () => undefined,
  },
  {
    name: "ElevenLabs STT",
    providerName: PROVIDER_NAMES.elevenlabsStt,
    errorCode: PROVIDER_ERROR_CODES.elevenlabsStt,
    supportedModel: "scribe_v2_realtime",
    commitMode: "provider",
    create: (socket) =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: () => undefined,
  },
  {
    name: "AssemblyAI",
    providerName: PROVIDER_NAMES.assemblyaiStt,
    errorCode: PROVIDER_ERROR_CODES.assemblyaiStt,
    supportedModel: "u3-rt-pro",
    commitMode: "none",
    create: (socket) =>
      new AssemblyAiSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          queueMicrotask(() => socket.receive({ type: "Begin", id: "contract" }));
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
    providerName: PROVIDER_NAMES.sonioxStt,
    errorCode: PROVIDER_ERROR_CODES.sonioxStt,
    supportedModel: "stt-rt-v5",
    commitMode: "provider",
    create: (socket) =>
      new SonioxSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: (socket) => {
      socket.onSend = (data) => {
        if (typeof data !== "string") {
          return;
        }
        if (data === "") {
          socket.receive({ finished: true });
          return;
        }
        if (JSON.parse(data).type === "finalize") {
          socket.receive({ tokens: [{ text: "<fin>", is_final: true }] });
        }
      };
    },
  },
];

describe("STT provider contract", () => {
  it.each(cases)("$name opens, accepts audio, commits, and closes", async (testCase) => {
    const socket = new ContractSocket();
    testCase.configure(socket);
    const provider = testCase.create(socket);

    expect(provider.kind).toBe("stt");
    expect(provider.name).toBe(testCase.providerName);
    expect(provider.capabilities.streaming.input).toBe(true);

    const stream = await provider.open({
      sessionId: `${testCase.name}-session` as never,
      format: PCM16_16K_MONO,
      model: testCase.supportedModel,
      interimResults: true,
    });
    expect(stream.events).toBeDefined();
    expect(stream.commitMode ?? "provider").toBe(testCase.commitMode);
    expect(stream.timestampOrigin).toBe("generation");

    await stream.sendAudio({
      id: "contract-audio" as never,
      type: "media.audio.chunk",
      sessionId: `${testCase.name}-session` as never,
      sequence: 1,
      direction: "input",
      timestamp: "2026-08-21T00:00:00.000Z" as never,
      monotonicOffsetMs: 0,
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 100,
        frameCount: 1600,
        bytes: new Uint8Array(3200),
      },
    });
    await expect(stream.commit()).resolves.toBeUndefined();
    await expect(stream.close()).resolves.toBeUndefined();
    await expect(stream.close()).resolves.toBeUndefined();
    await expect(stream.commit()).rejects.toMatchObject({
      code: testCase.errorCode,
      provider: testCase.providerName,
    });
    await expect(
      stream.sendAudio({
        id: "late-audio" as never,
        type: "media.audio.chunk",
        sessionId: `${testCase.name}-session` as never,
        sequence: 2,
        direction: "input",
        timestamp: "2026-08-21T00:00:00.000Z" as never,
        monotonicOffsetMs: 100,
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 20,
          frameCount: 320,
          bytes: new Uint8Array(640),
        },
      }),
    ).rejects.toMatchObject({
      code: testCase.errorCode,
      provider: testCase.providerName,
      message: expect.stringContaining("stream has ended"),
    });
  });

  it.each(cases)("$name rejects malformed audio before connecting", async (testCase) => {
    const socket = new ContractSocket();
    const provider = testCase.create(socket);

    await expect(
      provider.open({
        sessionId: `${testCase.name}-invalid-format` as never,
        format: { ...PCM16_16K_MONO, channels: 2 },
        interimResults: true,
      }),
    ).rejects.toMatchObject({
      category: "validation",
      code: "stt.audio_format_invalid",
    });
    expect(socket.sent).toHaveLength(0);
    expect(socket.factoryCalls).toBe(0);
  });

  it.each(cases)("$name rejects unsupported models before connecting", async (testCase) => {
    const socket = new ContractSocket();
    const provider = testCase.create(socket);

    await expect(
      provider.open({
        sessionId: `${testCase.name}-invalid-model` as never,
        format: PCM16_16K_MONO,
        model: "not-a-real-model",
        interimResults: true,
      }),
    ).rejects.toMatchObject({
      category: "validation",
      code: "stt.model_unsupported",
      provider: testCase.providerName,
    });
    expect(socket.sent).toHaveLength(0);
    expect(socket.factoryCalls).toBe(0);
  });

  it.each(cases)("$name allows an explicitly opted-in custom model", async (testCase) => {
    const socket = new ContractSocket();
    testCase.configure(socket);
    const provider = testCase.create(socket);
    const stream = await provider.open({
      sessionId: `${testCase.name}-custom-model` as never,
      format: PCM16_16K_MONO,
      model: "self-hosted-model",
      allowUnknownModel: true,
      interimResults: true,
    });

    expect(socket.factoryCalls).toBe(1);
    await stream.close();
  });

  it.each(cases)("$name normalizes socket errors for reconnect policy", async (testCase) => {
    const socket = new ContractSocket();
    const provider = testCase.create(socket);
    const stream = await provider.open({
      sessionId: `${testCase.name}-error` as never,
      format: PCM16_16K_MONO,
      interimResults: true,
    });
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.fail(new Error("contract socket failure"));

    await expect(pending).rejects.toMatchObject({
      category: "provider",
      code: "stt.transport.connect_failed",
      provider: testCase.providerName,
      message: "contract socket failure",
      retriable: true,
    });
  });

  it.each(cases)("$name rejects an audio write that the socket cannot accept", async (testCase) => {
    const socket = new ContractSocket();
    testCase.configure(socket);
    const provider = testCase.create(socket);
    const stream = await provider.open({
      sessionId: `${testCase.name}-write-failure` as never,
      format: PCM16_16K_MONO,
      model: testCase.supportedModel,
      interimResults: true,
    });
    socket.readyState = WebSocket.CLOSING;
    await expect(
      stream.sendAudio({
        id: "write-failure-audio" as never,
        type: "media.audio.chunk",
        sessionId: `${testCase.name}-write-failure` as never,
        sequence: 1,
        direction: "input",
        timestamp: "2026-08-25T00:00:00.000Z" as never,
        monotonicOffsetMs: 0,
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 100,
          frameCount: 1600,
          bytes: new Uint8Array(3200),
        },
      }),
    ).rejects.toMatchObject({
      code: STT_ERROR_CODES.transportWriteFailed,
      retriable: true,
    });
    await stream.close();
  });
});
