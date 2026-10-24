import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type SpeechToTextProvider } from "@tvic/core";
import {
  AssemblyAiSttProvider,
  CartesiaSttProvider,
  DeepgramSttProvider,
  ElevenLabsSttProvider,
} from "../src/index.js";

const secretTerm = "customer_private_891";
const request = {
  sessionId: "stt_connection_redaction" as never,
  format: PCM16_16K_MONO,
  interimResults: true,
  vocabulary: [secretTerm],
};

const providers: readonly { readonly name: string; readonly create: () => SpeechToTextProvider }[] =
  [
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
  ];

describe("STT connection error redaction", () => {
  it.each(providers)("redacts vocabulary from $name handshake errors", async ({ create }) => {
    let failure: unknown;
    try {
      await create().open(request);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
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
