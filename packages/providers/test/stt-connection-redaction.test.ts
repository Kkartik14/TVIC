import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type SpeechToTextProvider } from "@tvic/core";
import {
  AssemblyAiSttProvider,
  CartesiaSttProvider,
  DeepgramSttProvider,
  ElevenLabsSttProvider,
  SarvamSttProvider,
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
});

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
