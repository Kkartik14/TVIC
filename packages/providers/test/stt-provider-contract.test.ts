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
  TvicThrowableError,
  isNormalizedError,
  type SpeechToTextProvider,
} from "@tvic/core";
import { normalizeSttConnectionError, normalizeSttSocketError } from "../src/common.js";

class ContractSocket {
  readonly sent: Array<string | Buffer> = [];
  factoryCalls = 0;
  readyState: number = WebSocket.OPEN;
  onSend: ((data: string | Buffer) => void) | undefined;
  #handlers = new Map<string, Set<(...values: unknown[]) => void>>();

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
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }
    this.readyState = WebSocket.CLOSED;
    this.#emit("close", code, reason);
  }

  fail(error: Error): void {
    this.#emit("error", error);
  }

  receive(message: unknown): void {
    this.#emit("message", Buffer.from(JSON.stringify(message)));
  }

  #emit(event: string, ...values: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...values);
    }
  }
}

interface SttContractCase {
  readonly name: string;
  readonly providerName: string;
  readonly errorCode: string;
  readonly supportedModel: string;
  readonly commitMode: "provider" | "none";
  readonly permanentErrorCode: string;
  create(socket: ContractSocket): SpeechToTextProvider;
  configure(socket: ContractSocket): void;
  emitPermanentError(socket: ContractSocket): void;
}

const cases: readonly SttContractCase[] = [
  {
    name: "Deepgram",
    providerName: PROVIDER_NAMES.deepgram,
    errorCode: PROVIDER_ERROR_CODES.deepgramStt,
    supportedModel: "nova-3",
    commitMode: "provider",
    permanentErrorCode: STT_ERROR_CODES.inputRejected,
    create: (socket) =>
      new DeepgramSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: () => undefined,
    emitPermanentError: (socket) =>
      socket.receive({ type: "Error", err_code: "DATA-0000", err_msg: "invalid audio" }),
  },
  {
    name: "Sarvam",
    providerName: PROVIDER_NAMES.sarvam,
    errorCode: PROVIDER_ERROR_CODES.sarvamStt,
    supportedModel: "saaras:v3",
    commitMode: "provider",
    permanentErrorCode: STT_ERROR_CODES.authFailed,
    create: (socket) =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: () => undefined,
    emitPermanentError: (socket) =>
      socket.receive({ type: "error", data: { code: "auth_error", error: "invalid api key" } }),
  },
  {
    name: "ElevenLabs STT",
    providerName: PROVIDER_NAMES.elevenlabsStt,
    errorCode: PROVIDER_ERROR_CODES.elevenlabsStt,
    supportedModel: "scribe_v2_realtime",
    commitMode: "provider",
    permanentErrorCode: STT_ERROR_CODES.authFailed,
    create: (socket) =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        webSocketFactory: () => {
          socket.factoryCalls += 1;
          return socket as unknown as WebSocket;
        },
      }),
    configure: () => undefined,
    emitPermanentError: (socket) =>
      socket.receive({ message_type: "auth_error", error: "invalid api key" }),
  },
  {
    name: "AssemblyAI",
    providerName: PROVIDER_NAMES.assemblyaiStt,
    errorCode: PROVIDER_ERROR_CODES.assemblyaiStt,
    supportedModel: "u3-rt-pro",
    commitMode: "none",
    permanentErrorCode: STT_ERROR_CODES.authFailed,
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
    emitPermanentError: (socket) =>
      socket.receive({ type: "Error", code: 1008, error: "invalid api key" }),
  },
  {
    name: "Soniox",
    providerName: PROVIDER_NAMES.sonioxStt,
    errorCode: PROVIDER_ERROR_CODES.sonioxStt,
    supportedModel: "stt-rt-v5",
    commitMode: "provider",
    permanentErrorCode: STT_ERROR_CODES.authFailed,
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
    emitPermanentError: (socket) =>
      socket.receive({ error_type: "unauthenticated", error_message: "invalid api key" }),
  },
];

describe("STT provider contract", () => {
  it("preserves Soniox cancellation while initializing an already-open socket", async () => {
    const socket = new ContractSocket();
    const provider = new SonioxSttProvider({
      apiKey: "test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const controller = new AbortController();
    const opening = provider.open({
      sessionId: "soniox-cancelled-start" as never,
      format: PCM16_16K_MONO,
      interimResults: true,
      signal: controller.signal,
    });
    controller.abort();

    await expect(opening).rejects.toMatchObject({
      name: "CancelledError",
      code: "soniox.stt.begin_cancelled",
      category: "cancelled",
      provider: PROVIDER_NAMES.sonioxStt,
    });
  });

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

  it.each(cases)("$name maps a documented permanent wire error", async (testCase) => {
    const socket = new ContractSocket();
    testCase.configure(socket);
    const provider = testCase.create(socket);
    const stream = await provider.open({
      sessionId: `${testCase.name}-permanent-error` as never,
      format: PCM16_16K_MONO,
      model: testCase.supportedModel,
      interimResults: true,
    });
    const pending = stream.events[Symbol.asyncIterator]().next();

    testCase.emitPermanentError(socket);

    await expect(pending).rejects.toBeInstanceOf(TvicThrowableError);
    await expect(pending).rejects.toMatchObject({
      code: testCase.permanentErrorCode,
      provider: testCase.providerName,
      retriable: false,
    });
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

    await expect(pending).rejects.toBeInstanceOf(TvicThrowableError);
    await expect(pending).rejects.toMatchObject({
      category: "provider",
      code: "stt.transport.connect_failed",
      provider: testCase.providerName,
      message: "contract socket failure",
      retriable: true,
    });
    await expect(stream.events[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      category: "provider",
      code: "stt.transport.connect_failed",
      provider: testCase.providerName,
      message: "contract socket failure",
      retriable: true,
    });
  });

  it("normalizes legacy provider-shaped failures instead of returning them unchanged", () => {
    const legacy = {
      code: "stt.provider.input_rejected",
      category: "provider",
      message: "legacy input rejected",
      retriable: false,
    };

    const connection = normalizeSttConnectionError(legacy, {
      provider: PROVIDER_NAMES.deepgram,
      providerCode: PROVIDER_ERROR_CODES.deepgramStt,
    });
    const socket = normalizeSttSocketError(legacy, {
      provider: PROVIDER_NAMES.deepgram,
      providerCode: PROVIDER_ERROR_CODES.deepgramStt,
    });

    expect(isNormalizedError(connection)).toBe(true);
    expect(isNormalizedError(socket)).toBe(true);
    expect(connection.name).toBe("ProviderError");
    expect(socket.name).toBe("ProviderError");
    expect(connection.message).toBe(legacy.message);
    expect(socket.message).toBe(legacy.message);
  });

  it.each(cases)("$name preserves unexpected close metadata", async (testCase) => {
    const socket = new ContractSocket();
    testCase.configure(socket);
    const provider = testCase.create(socket);
    const stream = await provider.open({
      sessionId: `${testCase.name}-close-metadata` as never,
      format: PCM16_16K_MONO,
      model: testCase.supportedModel,
      interimResults: true,
    });
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.close(1006, Buffer.from("network drop"));

    await expect(pending).rejects.toMatchObject({
      provider: testCase.providerName,
      retriable: true,
      metadata: expect.objectContaining({
        wsCloseCode: 1006,
        wsCloseReason: "network drop",
      }),
    });
  });

  it.each(cases)("$name treats an unclassified policy close as permanent", async (testCase) => {
    const socket = new ContractSocket();
    testCase.configure(socket);
    const provider = testCase.create(socket);
    const stream = await provider.open({
      sessionId: `${testCase.name}-policy-close` as never,
      format: PCM16_16K_MONO,
      model: testCase.supportedModel,
      interimResults: true,
    });
    const pending = stream.events[Symbol.asyncIterator]().next();

    socket.close(1008, Buffer.from("policy"));

    await expect(pending).rejects.toMatchObject({
      provider: testCase.providerName,
      retriable: false,
      metadata: expect.objectContaining({
        wsCloseCode: 1008,
        wsCloseReason: "policy",
      }),
    });
  });

  it.each(cases)("$name treats a policy close before open as permanent", async (testCase) => {
    const socket = new ContractSocket();
    socket.readyState = WebSocket.CONNECTING;
    testCase.configure(socket);
    const provider = testCase.create(socket);
    const opening = provider.open({
      sessionId: `${testCase.name}-policy-before-open` as never,
      format: PCM16_16K_MONO,
      model: testCase.supportedModel,
      interimResults: true,
    });

    socket.close(1008, Buffer.from("policy"));

    await expect(opening).rejects.toMatchObject({
      code: STT_ERROR_CODES.protocolError,
      provider: testCase.providerName,
      retriable: false,
      metadata: expect.objectContaining({
        wsCloseCode: 1008,
        wsCloseReason: "policy",
      }),
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
      metadata: expect.objectContaining({
        operation: "audio",
        providerCode: testCase.errorCode,
      }),
    });
    await stream.close();
  });
});
