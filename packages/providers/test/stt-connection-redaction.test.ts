import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  nowTimestamp,
  type SpeechToTextProvider,
  type SttStream,
} from "@tvic/core";
import {
  DeepgramSttStream,
  AssemblyAiSttStream,
  AssemblyAiSttProvider,
  CartesiaSttProvider,
  DeepgramSttProvider,
  ElevenLabsSttStream,
  ElevenLabsSttProvider,
  SarvamSttProvider,
  SarvamSttStream,
  SonioxSttProvider,
} from "../src/index.js";

const secretTerm = "customer_private_891";
const request = {
  sessionId: "stt_connection_redaction" as never,
  format: PCM16_16K_MONO,
  interimResults: true,
  vocabulary: [secretTerm],
};

const providers: readonly {
  readonly name: string;
  readonly create: () => SpeechToTextProvider;
  readonly model?: string;
}[] = [
  {
    name: "AssemblyAI",
    create: () =>
      new AssemblyAiSttProvider({
        apiKey: "test",
        modelId: "universal-3-6-pro",
        webSocketFactory: (url) => {
          throw handshakeError(url);
        },
      }),
  },
  {
    name: "Cartesia",
    create: () =>
      new CartesiaSttProvider({
        apiKey: "test",
        modelId: "ink-2",
        webSocketFactory: (url) => {
          throw handshakeError(url);
        },
      }),
  },
  {
    name: "Deepgram",
    create: () =>
      new DeepgramSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          throw handshakeError(url);
        },
      }),
  },
  {
    name: "ElevenLabs",
    create: () =>
      new ElevenLabsSttProvider({
        apiKey: "test",
        modelId: "scribe_v2_realtime",
        webSocketFactory: (url) => {
          throw handshakeError(url);
        },
      }),
  },
  {
    name: "Sarvam",
    model: "saaras:v4",
    create: () =>
      new SarvamSttProvider({
        apiKey: "test",
        webSocketFactory: (url) => {
          throw handshakeError(url);
        },
      }),
  },
];

describe("STT connection error redaction", () => {
  it.each(providers)(
    "redacts vocabulary from $name handshake errors",
    async ({ create, model }) => {
      let failure: unknown;
      try {
        await create().open({ ...request, ...(model ? { model } : {}) });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(secretTerm);
      const normalized = (failure as { error?: unknown }).error ?? failure;
      expect(JSON.stringify(normalized)).not.toContain(secretTerm);
      expect((failure as { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it("redacts vocabulary from asynchronous Sarvam handshake errors", async () => {
    const provider = new SarvamSttProvider({
      apiKey: "test",
      webSocketFactory: (url) => failingHandshakeSocket(url),
    });
    let failure: unknown;
    try {
      await provider.open({ ...request, model: "saaras:v4" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secretTerm);
    const normalized = (failure as { error?: unknown }).error ?? failure;
    expect(JSON.stringify(normalized)).not.toContain(secretTerm);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it("redacts submitted Soniox terms from provider payload errors", async () => {
    const configuredTerm = "account_private_714";
    const socket = new OpenSocket();
    const provider = new SonioxSttProvider({
      apiKey: "test",
      context: { terms: [configuredTerm] },
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const stream = await provider.open({ ...request, model: "stt-rt-v5" });
    const pendingEvent = stream.events[Symbol.asyncIterator]().next();
    socket.receive({
      error_type: "invalid_request",
      error_message: `Invalid terms: ${secretTerm}, ${configuredTerm}`,
      more_info: `https://soniox.example/errors?term=${secretTerm}&context=${configuredTerm}`,
    });
    let failure: unknown;
    try {
      await pendingEvent;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secretTerm);
    expect(String(failure)).not.toContain(configuredTerm);
    const normalized = (failure as { error?: unknown }).error ?? failure;
    expect(JSON.stringify(normalized)).not.toContain(secretTerm);
    expect(JSON.stringify(normalized)).not.toContain(configuredTerm);
  });

  it.each([
    {
      name: "AssemblyAI",
      create: (socket: OpenSocket): SttStream =>
        new AssemblyAiSttStream(
          socket as unknown as WebSocket,
          { ...request, model: "universal-3-6-pro" },
          testClock,
        ),
      frame: {
        type: "Error",
        code: 410,
        error: `Rejected ${secretTerm}`,
        message: `Invalid keyterm ${secretTerm}`,
      },
    },
    {
      name: "ElevenLabs",
      create: (socket: OpenSocket): SttStream =>
        new ElevenLabsSttStream(
          socket as unknown as WebSocket,
          { ...request, model: "scribe_v2_realtime" },
          testClock,
        ),
      frame: {
        message_type: "unaccepted_terms",
        error: `Rejected ${secretTerm}`,
      },
    },
    {
      name: "Sarvam",
      create: (socket: OpenSocket): SttStream =>
        new SarvamSttStream(
          socket as unknown as WebSocket,
          { ...request, model: "saaras:v4" },
          testClock,
        ),
      frame: {
        type: "error",
        data: { code: "request_invalid", error: `Rejected ${secretTerm}` },
      },
    },
  ])("redacts submitted vocabulary from $name stream errors", async ({ create, frame }) => {
    const socket = new OpenSocket();
    const stream = create(socket);
    const pending = stream.events[Symbol.asyncIterator]().next();
    socket.receive(frame);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(secretTerm);
    const normalized = (failure as { error?: unknown }).error ?? failure;
    expect(JSON.stringify(normalized)).not.toContain(secretTerm);
  });

  it("redacts terms and connection URLs from socket errors and causes", async () => {
    const socket = new OpenSocket();
    const stream = new DeepgramSttStream(
      socket as unknown as WebSocket,
      { ...request, model: "nova-3" },
      testClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();
    socket.emit(
      "error",
      Object.assign(
        new Error(
          `WebSocket failed for wss://stt.example/listen?keyterm=${encodeURIComponent(secretTerm)}`,
        ),
        { cause: new Error(secretTerm) },
      ),
    );

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(String(failure)).not.toContain(secretTerm);
    expect(String(failure)).not.toContain("wss://stt.example");
    const normalized = (failure as { error?: unknown }).error ?? failure;
    expect(JSON.stringify(normalized)).not.toContain(secretTerm);
    expect(JSON.stringify(normalized)).not.toContain("wss://stt.example");
  });

  it("redacts vocabulary from provider close metadata", async () => {
    const socket = new OpenSocket();
    const stream = new SarvamSttStream(
      socket as unknown as WebSocket,
      { ...request, model: "saaras:v4" },
      testClock,
    );
    const pending = stream.events[Symbol.asyncIterator]().next();
    socket.emit("close", 1008, Buffer.from(`Rejected term ${secretTerm}`));

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    const normalized = (failure as { error?: unknown }).error ?? failure;
    expect(JSON.stringify(normalized)).not.toContain(secretTerm);
  });
});

class OpenSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  send(): void {}

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  receive(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
}

const testClock = {
  now: nowTimestamp,
  monotonicNowMs: () => 0,
};

function handshakeError(url: string): Error {
  return Object.assign(new Error(`WebSocket handshake failed for ${url}`), {
    wsCloseReason: `provider rejected ${url}`,
  });
}

function failingHandshakeSocket(url: string): WebSocket {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    close: () => void;
  };
  socket.readyState = WebSocket.CONNECTING;
  socket.close = () => {
    socket.readyState = WebSocket.CLOSED;
  };
  setImmediate(() => socket.emit("error", handshakeError(url)));
  return socket as unknown as WebSocket;
}
