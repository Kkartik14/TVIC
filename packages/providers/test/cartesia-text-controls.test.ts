import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  createProviderCapabilitySnapshot,
  PCM16_16K_MONO,
  PROVIDER_CAPABILITY_FEATURES,
  TVIC_ERROR_CODES,
} from "@tvic/core";
import { CartesiaTtsProvider, MAX_CARTESIA_INPUT_UTF16_CODE_UNITS } from "../src/cartesia.js";
import { CARTESIA_CAPABILITY_FEATURES } from "../src/index.js";
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
        feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
        scope: "voice",
        model: "sonic-3.6",
        voice: "voice-1",
        status: "supported",
      },
      {
        feature: CARTESIA_CAPABILITY_FEATURES.ttsVoiceIsPro,
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
    "keeps configured voice setup usable without a capability snapshot on %s",
    async (operation) => {
      const socket = new CartesiaTextControlSocket();
      const webSocketFactory = vi.fn(() => socket as unknown as WebSocket);
      const provider = new CartesiaTtsProvider({
        apiKey: "test",
        voiceId: "voice-1",
        webSocketFactory,
      });
      const request = {
        sessionId: "session_cartesia_default_voice_snapshot" as never,
        turnId: "turn_cartesia_default_voice_snapshot" as never,
        format: PCM16_16K_MONO,
        speed: 1,
      };

      const result =
        operation === "openSession"
          ? await provider.openSession(request)
          : await provider.synthesize({ ...request, text: "Hello", stream: true });

      expect(webSocketFactory).toHaveBeenCalledOnce();
      await result.cancel();
    },
  );

  it("opens with the configured voice when its fresh account snapshot supports it", async () => {
    const socket = new CartesiaTextControlSocket();
    const webSocketFactory = vi.fn(() => socket as unknown as WebSocket);
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory,
    });

    const session = await provider.openSession({
      sessionId: "session_cartesia_default_voice_supported" as never,
      turnId: "turn_cartesia_default_voice_supported" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
    });

    expect(webSocketFactory).toHaveBeenCalledOnce();
    await session.cancel();
  });

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
              feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
              scope: "voice",
              model: "sonic-3.6",
              voice: "voice-1",
              status: "supported",
            },
            {
              feature: CARTESIA_CAPABILITY_FEATURES.ttsVoiceIsPro,
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
    "allows request speed without optional voice snapshots before %s connects",
    async (operation) => {
      const socket = new CartesiaTextControlSocket();
      const webSocketFactory = vi.fn(() => socket as unknown as WebSocket);
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

      const stream = await operationPromise;
      expect(webSocketFactory).toHaveBeenCalledOnce();
      await stream.cancel();
    },
  );

  it.each([
    [
      "unsupported",
      createProviderCapabilitySnapshot({
        provider: "cartesia",
        source: "https://docs.cartesia.ai/api-reference/voices/get",
        fetchedAt: new Date(Date.now() - 1_000).toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        facts: [
          {
            feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
            scope: "voice",
            model: "sonic-3.6",
            voice: "voice-archived",
            status: "unsupported",
          },
        ],
      }),
    ],
    [
      "expired",
      createProviderCapabilitySnapshot({
        provider: "cartesia",
        source: "https://docs.cartesia.ai/api-reference/voices/get",
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        validUntil: new Date(Date.now() - 1_000).toISOString(),
        facts: [
          {
            feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
            scope: "voice",
            model: "sonic-3.6",
            voice: "voice-archived",
            status: "supported",
          },
        ],
      }),
    ],
  ] as const)(
    "rejects an explicit %s request voice before opening a socket",
    async (_state, snapshot) => {
      const webSocketFactory = vi.fn(() => {
        throw new Error("socket should not be created");
      });
      const provider = new CartesiaTtsProvider({
        apiKey: "test",
        voiceId: "voice-configured",
        modelId: "sonic-3.6",
        webSocketFactory,
      });

      await expect(
        provider.openSession({
          sessionId: "session_cartesia_unavailable_voice" as never,
          turnId: "turn_cartesia_unavailable_voice" as never,
          format: PCM16_16K_MONO,
          voice: "voice-archived",
          providerCapabilitySnapshots: [snapshot],
        }),
      ).rejects.toThrow(/capability snapshot/i);
      expect(webSocketFactory).not.toHaveBeenCalled();
    },
  );

  it("allows an explicit request voice when optional snapshots are omitted", async () => {
    const socket = new CartesiaTextControlSocket();
    const webSocketFactory = vi.fn(() => socket as unknown as WebSocket);
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      modelId: "sonic-3.6",
      webSocketFactory,
    });

    const session = await provider.openSession({
      sessionId: "session_cartesia_no_snapshot_voice_override" as never,
      turnId: "turn_cartesia_no_snapshot_voice_override" as never,
      format: PCM16_16K_MONO,
      voice: "voice-archived",
    });
    expect(webSocketFactory).toHaveBeenCalledOnce();
    await session.cancel();
  });

  it("requires explicit capability data when an empty snapshot list is supplied", async () => {
    const webSocketFactory = vi.fn(() => {
      throw new Error("socket should not be created");
    });
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      modelId: "sonic-3.6",
      webSocketFactory,
    });

    await expect(
      provider.openSession({
        sessionId: "session_cartesia_empty_snapshot_list" as never,
        turnId: "turn_cartesia_empty_snapshot_list" as never,
        format: PCM16_16K_MONO,
        voice: "voice-archived",
        providerCapabilitySnapshots: [],
      }),
    ).rejects.toThrow(/snapshot_missing/i);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("allows an explicit request voice with a current available capability fact", async () => {
    const socket = new CartesiaTextControlSocket();
    const webSocketFactory = vi.fn(() => socket as unknown as WebSocket);
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-configured",
      modelId: "sonic-3.6",
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
            feature: PROVIDER_CAPABILITY_FEATURES.ttsVoiceAvailable,
            scope: "voice",
            model: "sonic-3.6",
            voice: "voice-requested",
            status: "supported",
          },
        ],
      }),
    ];

    const session = await provider.openSession({
      sessionId: "session_cartesia_available_voice" as never,
      turnId: "turn_cartesia_available_voice" as never,
      format: PCM16_16K_MONO,
      voice: "voice-requested",
      providerCapabilitySnapshots,
    });

    expect(webSocketFactory).toHaveBeenCalledOnce();
    await session.cancel();
  });

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
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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

  it("keeps a split control together and counts the serialized provider text", async () => {
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
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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

  it("does not count text buffered for a control that is never emitted", async () => {
    const socket = new CartesiaTextControlSocket();
    const reportedCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_buffered_control_usage" as never,
      turnId: "turn_cartesia_buffered_control_usage" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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

    await session.sendText("ABC");
    expect(reportedCharacters).toEqual([]);
    await session.cancel();
    expect(reportedCharacters).toEqual([]);
  });

  it("counts accepted caller text before a provider write that fails", async () => {
    const socket = new CartesiaTextControlSocket();
    const reportedCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_write_failure_usage" as never,
      turnId: "turn_cartesia_write_failure_usage" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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
    socket.readyState = WebSocket.CLOSED;

    await expect(session.sendText("A🌟")).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerTransportWriteFailed,
    });

    expect(reportedCharacters).toEqual([2]);
  });

  it("serializes a complete self-overlapping control at the end of streamed text", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_self_overlapping_control" as never,
      turnId: "turn_cartesia_self_overlapping_control" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      textControls: [{ type: "spell", match: "abab" }],
    });

    await session.sendText("abab");
    await session.finish();

    expect(socket.sent.map((value) => JSON.parse(value).transcript)).toEqual([
      "<spell>abab</spell>",
      "",
    ]);
    await session.cancel();
  });

  it("keeps the renderer's first non-overlapping control when a later chunk overlaps it", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_overlapping_control_chunks" as never,
      turnId: "turn_cartesia_overlapping_control_chunks" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      textControls: [{ type: "spell", match: "abab" }],
    });

    await session.sendText("ababa");
    await session.sendText("b");
    await session.finish();

    expect(socket.sent.map((value) => JSON.parse(value).transcript)).toEqual([
      "<spell>abab</spell>",
      "ab",
      "",
    ]);
    await session.cancel();
  });

  it("counts serialized one-shot text including markup and XML escaping", async () => {
    const socket = new CartesiaTextControlSocket();
    const reportedCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    const stream = await provider.synthesize({
      sessionId: "session_cartesia_one_shot_usage" as never,
      turnId: "turn_cartesia_one_shot_usage" as never,
      format: PCM16_16K_MONO,
      text: "ABC&<>",
      stream: false,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      textControls: [{ type: "spell", match: "ABC" }],
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

    expect(JSON.parse(socket.sent[0]!).transcript).toBe("<spell>ABC</spell>&amp;&lt;&gt;");
    expect(reportedCharacters).toEqual([31]);
    await stream.cancel();
  });

  it("preserves ampersands and angle brackets when no text controls are used", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    const stream = await provider.synthesize({
      sessionId: "session_cartesia_plain_entities" as never,
      turnId: "turn_cartesia_plain_entities" as never,
      format: PCM16_16K_MONO,
      text: "AT&T compares C < D and D > C.",
      stream: false,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
    });

    expect(JSON.parse(socket.sent[0]!).transcript).toBe("AT&T compares C < D and D > C.");
    await stream.cancel();
  });

  it("fails the session when serialized incremental text exceeds the provider limit", async () => {
    const socket = new CartesiaTextControlSocket();
    const reportedCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_render_overflow" as never,
      turnId: "turn_cartesia_render_overflow" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      textControls: [{ type: "spell", match: ">" }],
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

    await expect(session.sendText(">".repeat(250_000))).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInputRejected,
    });
    await expect(session.sendText("later text")).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInputRejected,
    });
    await expect(session.finish()).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInputRejected,
    });
    expect(reportedCharacters).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("fails the session after rejecting oversized incremental source text", async () => {
    const socket = new CartesiaTextControlSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_source_overflow" as never,
      turnId: "turn_cartesia_source_overflow" as never,
      format: PCM16_16K_MONO,
    });

    await expect(
      session.sendText("x".repeat(MAX_CARTESIA_INPUT_UTF16_CODE_UNITS + 1)),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInputRejected });
    await expect(session.sendText("later text")).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInputRejected,
    });
    await expect(session.finish()).rejects.toMatchObject({
      code: TVIC_ERROR_CODES.providerInputRejected,
    });
    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects oversized one-shot source text before opening the socket", async () => {
    const webSocketFactory = vi.fn(() => new CartesiaTextControlSocket() as unknown as WebSocket);
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory,
    });

    await expect(
      provider.synthesize({
        sessionId: "session_cartesia_oversized_one_shot" as never,
        turnId: "turn_cartesia_oversized_one_shot" as never,
        format: PCM16_16K_MONO,
        text: "\ud800".repeat(MAX_CARTESIA_INPUT_UTF16_CODE_UNITS + 1),
        stream: false,
      }),
    ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInputRejected });

    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("rejects oversized cumulative session source text before rendering or usage reporting", async () => {
    const socket = new CartesiaTextControlSocket();
    const reportedCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_oversized_incremental" as never,
      turnId: "turn_cartesia_oversized_incremental" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      textControls: [{ type: "spell", match: "not-present" }],
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
    const indexOf = vi.spyOn(String.prototype, "indexOf");

    try {
      await expect(
        session.sendText("x".repeat(MAX_CARTESIA_INPUT_UTF16_CODE_UNITS + 1)),
      ).rejects.toMatchObject({ code: TVIC_ERROR_CODES.providerInputRejected });

      expect(indexOf).not.toHaveBeenCalled();
      expect(socket.sent).toEqual([]);
      expect(reportedCharacters).toEqual([]);
    } finally {
      indexOf.mockRestore();
      await session.cancel();
    }
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
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
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
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
    });

    await session.sendText("\ude00");

    expect(socket.sent.map((value) => JSON.parse(value).transcript)).toEqual(["�"]);
    await session.cancel();
  });

  it.each(["\ud83d", "\ude00"] as const)(
    "replaces an unpaired surrogate in one-shot synthesis input %s",
    async (text) => {
      const socket = new CartesiaTextControlSocket();
      const provider = new CartesiaTtsProvider({
        apiKey: "test",
        voiceId: "voice-1",
        webSocketFactory: () => socket as unknown as WebSocket,
      });
      const stream = await provider.synthesize({
        sessionId: "session_cartesia_one_shot_surrogate" as never,
        turnId: "turn_cartesia_one_shot_surrogate" as never,
        format: PCM16_16K_MONO,
        text,
        stream: false,
        providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      });

      expect(JSON.parse(socket.sent[0]!).transcript).toBe("�");
      await stream.cancel();
    },
  );

  it("treats an incomplete control match as literal text at a flush boundary", async () => {
    const socket = new CartesiaTextControlSocket();
    const textCharacters: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test",
      voiceId: "voice-1",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_partial_flush" as never,
      turnId: "turn_cartesia_partial_flush" as never,
      format: PCM16_16K_MONO,
      providerCapabilitySnapshots: [cartesiaVoiceSnapshot(false)],
      textControls: [{ type: "spell", match: "ABC123" }],
      usageReporter: {
        report() {},
        beginOperation() {
          throw new Error("unused");
        },
        reportTextCharacters(value) {
          textCharacters.push(value);
        },
      },
    });

    await session.sendText("Say ABC");
    const firstFlush = session.flush();
    const firstRequests = socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);

    expect(firstRequests.map((value) => value.transcript)).toEqual(["Say ", "ABC", ""]);
    socket.receive({ type: "flush_done", context_id: firstRequests[0]!.context_id, flush_id: 0 });
    await expect(firstFlush).resolves.toMatchObject({ acknowledgedBy: "provider" });
    await session.sendText("123");
    const secondFlush = session.flush();
    const requests = socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);

    expect(requests.map((value) => value.transcript)).toEqual(["Say ", "ABC", "", "123", ""]);
    expect(requests[2]).toMatchObject({ flush: true });
    expect(requests[4]).toMatchObject({ flush: true });
    socket.receive({ type: "flush_done", context_id: requests[0]!.context_id, flush_id: 1 });
    await expect(secondFlush).resolves.toMatchObject({ acknowledgedBy: "provider" });
    expect(textCharacters).toEqual([4, 3, 3]);
    await session.cancel();
  });
});
