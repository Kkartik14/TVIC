import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  STT_ERROR_CODES,
  nowTimestamp,
  providerError,
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
import { redactSttConnectionUrl } from "../src/common.js";
import { sonioxProtocolError } from "../src/soniox-stt.js";

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
  {
    name: "Soniox",
    model: "stt-rt-v5",
    create: () =>
      new SonioxSttProvider({
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
      const cause = (normalized as { cause?: unknown }).cause;
      expect(cause).toBeDefined();
      expect(JSON.stringify(cause)).toContain("[redacted URL]");
      expect(JSON.stringify(cause)).not.toContain(secretTerm);
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
    const cause = (normalized as { cause?: unknown }).cause;
    expect(cause).toBeDefined();
    expect(JSON.stringify(cause)).toContain("[redacted URL]");
    expect(JSON.stringify(cause)).not.toContain(secretTerm);
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

  it("does not redact short vocabulary or words embedded in unrelated metadata", () => {
    const redacted = redactSttConnectionUrl(
      providerError("stt.connect_failed", "a deepgram error mentions deep", {
        provider: "test",
        metadata: { providerCode: "deepgram", field: "deep" },
      }),
      ["a", "deep"],
    );

    expect(redacted.message).toBe("a deepgram error mentions [REDACTED]");
    expect(redacted.metadata).toEqual({
      providerCode: "deepgram",
      field: "[REDACTED]",
    });
  });

  it("redacts overlapping vocabulary matches against the original string", () => {
    const redacted = redactSttConnectionUrl(
      providerError("stt.connect_failed", "Rejected foo-bar-baz by Deepgram", {
        provider: "test",
      }),
      ["foo-bar", "bar-baz"],
    );

    expect(redacted.message).toBe("Rejected [REDACTED] by Deepgram");
  });

  it("fails closed when redaction encounters an exotic error object", () => {
    const exoticCause = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("uninspectable cause");
        },
      },
    );
    const redacted = redactSttConnectionUrl(
      providerError(STT_ERROR_CODES.authFailed, `Rejected ${secretTerm}`, {
        provider: "test",
        retriable: false,
        metadata: { cause: exoticCause },
        cause: exoticCause,
      }),
      [secretTerm],
    );

    expect(redacted.message).toBe("STT provider failure; details were redacted");
    expect(redacted.code).toBe(STT_ERROR_CODES.authFailed);
    expect(redacted.retriable).toBe(false);
    expect(redacted.provider).toBe("test");
    expect(redacted.cause).toBeUndefined();
    expect(redacted.metadata).toBeUndefined();
  });

  it("does not preserve opaque symbol or function values in redacted metadata", () => {
    const redacted = redactSttConnectionUrl(
      providerError("stt.connect_failed", `Rejected ${secretTerm}`, {
        provider: "test",
        metadata: {
          symbolValue: Symbol(secretTerm),
          functionValue: () => secretTerm,
        },
      }),
      [secretTerm],
    );

    expect(redacted.message).not.toContain(secretTerm);
    expect(redacted.metadata).toEqual({
      symbolValue: "[redacted]",
      functionValue: "[redacted]",
    });
    expect(JSON.stringify(redacted)).not.toContain(secretTerm);
  });

  it("preserves binary values, Maps and repeated object references", () => {
    const shared = { customer: secretTerm };
    const binary = Buffer.from([0, 1, 2, 255]);
    const map = new Map([[secretTerm, shared]]);
    const redacted = redactSttConnectionUrl(
      providerError("stt.connect_failed", `Rejected ${secretTerm}`, {
        provider: "test",
        metadata: { first: shared, second: shared, binary, map },
      }),
      [secretTerm],
    );
    const metadata = redacted.metadata as {
      readonly first: { readonly customer: string };
      readonly second: { readonly customer: string };
      readonly binary: Buffer;
      readonly map: Map<unknown, { readonly customer: string }>;
    };

    expect(metadata.first).toBe(metadata.second);
    expect(metadata.first.customer).toBe("[REDACTED]");
    expect(Buffer.isBuffer(metadata.binary)).toBe(true);
    expect(metadata.binary).toEqual(binary);
    expect(metadata.map).toBeInstanceOf(Map);
    expect(metadata.map.get("[REDACTED]")).toBe(metadata.first);
  });

  it("keeps provider model metadata intact while redacting message text", () => {
    const redacted = redactSttConnectionUrl(
      providerError("stt.connect_failed", "The nova-3 model rejected nova", {
        provider: "test",
        metadata: { model: "nova-3", explanation: "nova-3" },
      }),
      ["nova"],
    );

    expect(redacted.message).toBe("The [REDACTED]-3 model rejected [REDACTED]");
    expect(redacted.metadata).toEqual({
      model: "nova-3",
      explanation: "[REDACTED]-3",
    });
  });

  it("redacts short Hangul names inside unspaced text", () => {
    const redacted = redactSttConnectionUrl(
      providerError("stt.connect_failed", "고객님 음성을 분석하지 못했습니다", {
        provider: "test",
      }),
      ["고객"],
    );

    expect(redacted.message).toBe("[REDACTED]님 음성을 분석하지 못했습니다");
  });

  it("uses shared redaction rules for Soniox payload errors", () => {
    expect(
      sonioxProtocolError({ error_type: "invalid_request", error_message: "Invalid request" }, [
        "a",
      ]).message,
    ).toBe("Invalid request");
  });

  it("redacts short CJK and unspaced Thai vocabulary inside running text", () => {
    const redacted = redactSttConnectionUrl(
      providerError(
        "stt.connect_failed",
        "deepgram rejected 顧客東京様 and ผู้ใช้ภาษาไทยกำลังพูด",
        {
          provider: "test",
          metadata: { customerName: "顧客東京様", providerCode: "deepgram" },
        },
      ),
      ["東京", "ภาษาไทย", "deep"],
    );

    expect(redacted.message).toBe(
      "deepgram rejected 顧客[REDACTED]様 and ผู้ใช้[REDACTED]กำลังพูด",
    );
    expect(redacted.metadata).toEqual({
      customerName: "顧客[REDACTED]様",
      providerCode: "deepgram",
    });
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
