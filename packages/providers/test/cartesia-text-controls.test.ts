import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  createProviderCapabilitySnapshot,
  PCM16_16K_MONO,
  PROVIDER_CAPABILITY_FEATURES,
} from "@tvic/core";
import { CartesiaTtsProvider } from "../src/cartesia.js";
import { renderCartesiaText } from "../src/cartesia-text-controls.js";

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

  receive(value: Readonly<Record<string, unknown>>): void {
    const payload = Buffer.from(JSON.stringify(value));
    for (const handler of this.#handlers.get("message") ?? []) {
      handler(payload);
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    for (const handler of this.#handlers.get("close") ?? []) {
      handler(1000, Buffer.alloc(0));
    }
  }
}

function cartesiaVoiceSnapshot(isProfessional: boolean) {
  return createProviderCapabilitySnapshot({
    provider: "cartesia",
    source: "https://docs.cartesia.ai/api-reference/voices/get",
    fetchedAt: new Date(Date.now() - 1_000).toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    facts: [
      {
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceIsPro,
        scope: "voice",
        voice: "voice-1",
        status: "supported",
        value: isProfessional,
      },
    ],
  });
}

describe("Cartesia TTS text controls", () => {
  it.each(["openSession", "synthesize"] as const)(
    "rejects request speed for a professional voice before %s connects",
    async (operation) => {
      const webSocketFactory = vi.fn(() => {
        throw new Error("socket should not be created");
      });
      const provider = new CartesiaTtsProvider({
        apiKey: "test",
        voiceId: "voice-1",
        webSocketFactory,
      });
      const providerCapabilitySnapshots = [
        createProviderCapabilitySnapshot({
          provider: "cartesia",
          source: "https://docs.cartesia.ai/api-reference/voices/get",
          fetchedAt: new Date(Date.now() - 1_000).toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
          facts: [
            {
              feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceIsPro,
              scope: "voice",
              voice: "voice-1",
              status: "supported",
              value: true,
            },
          ],
        }),
      ];
      const request = {
        sessionId: "session_cartesia_pro_speed" as never,
        turnId: "turn_cartesia_pro_speed" as never,
        format: PCM16_16K_MONO,
        speed: 1,
        providerCapabilitySnapshots,
      };

      const operationPromise =
        operation === "openSession"
          ? provider.openSession(request)
          : provider.synthesize({ ...request, text: "Hello", stream: true });

      await expect(operationPromise).rejects.toThrow(/professional voice/i);
      expect(webSocketFactory).not.toHaveBeenCalled();
    },
  );

  it.each(["openSession", "synthesize"] as const)(
    "rejects request speed without a verified voice snapshot before %s connects",
    async (operation) => {
      const webSocketFactory = vi.fn(() => {
        throw new Error("socket should not be created");
      });
      const provider = new CartesiaTtsProvider({
        apiKey: "test",
        voiceId: "voice-1",
        webSocketFactory,
      });
      const request = {
        sessionId: "session_cartesia_unknown_speed" as never,
        turnId: "turn_cartesia_unknown_speed" as never,
        format: PCM16_16K_MONO,
        speed: 1,
      };

      const operationPromise =
        operation === "openSession"
          ? provider.openSession(request)
          : provider.synthesize({ ...request, text: "Hello", stream: true });

      await expect(operationPromise).rejects.toThrow(/snapshot_missing/);
      expect(webSocketFactory).not.toHaveBeenCalled();
    },
  );

  it("declares voice metadata requirements when speed is configured", () => {
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      generationConfig: { speed: 1 },
    });

    expect(provider.requiredTtsVoiceCapabilities).toEqual([
      {
        provider: "cartesia",
        feature: "tts.voice.isPro",
        expectedBooleanValue: false,
      },
    ]);
  });

  it("keeps normalization separate from language and forwards a dictionary on supported models", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      modelId: "sonic-3.6",
      language: "hi",
      normalization: "en-IN",
      pronunciationDictId: "dictionary-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_normalization" as never,
      turnId: "turn_cartesia_normalization" as never,
      format: PCM16_16K_MONO,
    });
    await session.sendText("Hello");

    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      language: "hi",
      normalization: "en-IN",
      pronunciation_dict_id: "dictionary-1",
    });
    await session.cancel();
  });

  it("rejects pronunciation dictionaries for models without catalog support", () => {
    expect(
      () =>
        new CartesiaTtsProvider({
          apiKey: "test",
          voiceId: "voice-1",
          modelId: "sonic-3.5",
          pronunciationDictId: "dictionary-1",
        }),
    ).toThrow(/pronunciation dictionaries.*sonic-3.5/i);
  });

  it("rejects normalization for models without catalog support and malformed values", () => {
    expect(
      () =>
        new CartesiaTtsProvider({
          apiKey: "test",
          voiceId: "voice-1",
          modelId: "sonic-3.5",
          normalization: "auto",
        }),
    ).toThrow(/normalization.*sonic-3.5/i);
    expect(
      () =>
        new CartesiaTtsProvider({
          apiKey: "test",
          voiceId: "voice-1",
          normalization: "not a language tag",
        }),
    ).toThrow(/normalization must be/);
  });

  it("bounds Cartesia pronunciation dictionary identifiers", () => {
    expect(
      () =>
        new CartesiaTtsProvider({
          apiKey: "test",
          voiceId: "voice-1",
          pronunciationDictId: `id-${"x".repeat(256)}`,
        }),
    ).toThrow(/dictionary ID is invalid/);
  });

  it.each([0.6, 1.5])("accepts the Cartesia speed boundary %s", async (speed) => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: `session_cartesia_speed_${speed}` as never,
      turnId: `turn_cartesia_speed_${speed}` as never,
      format: PCM16_16K_MONO,
      speed,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
    });
    await session.sendText("Hello");

    expect(JSON.parse(socket.sent[0]!).generation_config).toEqual({ speed });
    await session.cancel();
  });

  it.each([0.59, 1.51])("rejects Cartesia speed %s before connecting", async (speed) => {
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
        sessionId: `session_cartesia_invalid_speed_${speed}` as never,
        turnId: `turn_cartesia_invalid_speed_${speed}` as never,
        format: PCM16_16K_MONO,
        speed,
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(connected).toBe(false);
  });

  it("rejects a request model that cannot honor configured pronunciation dictionaries before connecting", async () => {
    let connected = false;
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      pronunciationDictId: "dictionary-1",
      webSocketFactory: () => {
        connected = true;
        return new CartesiaTextControlSocket() as unknown as WebSocket;
      },
    });

    await expect(
      provider.openSession({
        sessionId: "session_cartesia_dictionary_model" as never,
        turnId: "turn_cartesia_dictionary_model" as never,
        model: "sonic-3.5",
        format: PCM16_16K_MONO,
      }),
    ).rejects.toMatchObject({ category: "validation" });
    expect(connected).toBe(false);
  });

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

  it("checks the serialized size before expanding escaped text", () => {
    const replaceAll = vi.spyOn(String.prototype, "replaceAll");
    try {
      expect(() => renderCartesiaText("&".repeat(100_000), [], 32)).toThrow(/byte limit/);
      expect(replaceAll).not.toHaveBeenCalled();
    } finally {
      replaceAll.mockRestore();
    }
  });

  it("advances each control search across repeated matches", () => {
    const text = "X".repeat(20);
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    try {
      expect(
        renderCartesiaText(
          text,
          [
            { type: "spell", match: "X" },
            { type: "spell", match: "not-present" },
          ],
          400,
        ),
      ).toBe("<spell>X</spell>".repeat(text.length));
      expect(indexOf.mock.calls.length).toBeLessThan(text.length * 2 + 20);
    } finally {
      indexOf.mockRestore();
    }
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

  it("keeps a surrogate pair together across incremental writes", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_split_surrogate" as never,
      turnId: "turn_cartesia_split_surrogate" as never,
      format: PCM16_16K_MONO,
    });

    await session.sendText("A\ud83d");
    await session.sendText("\ude00B");

    expect(socket.sent.map((value) => JSON.parse(value).transcript)).toEqual(["A", "😀B"]);
    await session.cancel();
  });

  it("replaces an unpaired surrogate when a flush closes the text boundary", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_unpaired_surrogate" as never,
      turnId: "turn_cartesia_unpaired_surrogate" as never,
      format: PCM16_16K_MONO,
    });

    await session.sendText("\ud83d");
    const flush = session.flush();
    const requests = socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);

    expect(requests.map((value) => value.transcript)).toEqual(["�", ""]);
    socket.receive({ type: "flush_done", context_id: requests[0]!.context_id, flush_id: 0 });
    await expect(flush).resolves.toMatchObject({ acknowledgedBy: "provider" });
    await session.cancel();
  });

  it("replaces an isolated low surrogate before writing it", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_isolated_low_surrogate" as never,
      turnId: "turn_cartesia_isolated_low_surrogate" as never,
      format: PCM16_16K_MONO,
    });

    await session.sendText("\ude00");

    expect(socket.sent.map((value) => JSON.parse(value).transcript)).toEqual(["�"]);
    await session.cancel();
  });

  it("sends a partial control prefix before acknowledging a flush", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_partial_flush" as never,
      turnId: "turn_cartesia_partial_flush" as never,
      format: PCM16_16K_MONO,
      textControls: [{ type: "spell", match: "ABC123" }],
    });

    await session.sendText("Say ABC");
    const flush = session.flush();
    const requests = socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);

    expect(requests.map((value) => value.transcript)).toEqual(["Say ", "ABC", ""]);
    expect(requests[1]).not.toHaveProperty("flush");
    expect(requests[2]).toMatchObject({ flush: true });
    socket.receive({ type: "flush_done", context_id: requests[0]!.context_id, flush_id: 0 });
    await expect(flush).resolves.toMatchObject({ acknowledgedBy: "provider" });
    await session.cancel();
  });
});
