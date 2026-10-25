import { describe, expect, it, vi } from "vitest";

import type { ProviderUsageOperation, TtsSessionOpenRequest } from "@tvic/core";
import {
  countUnicodeCodePoints,
  createSpeechControlCatalogSnapshot,
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  type SpeechControlCatalogSnapshot,
} from "@tvic/core";

import {
  CartesiaTtsProvider as CartesiaTtsProviderImpl,
  type CartesiaTtsProviderOptions,
} from "../src/cartesia.js";
import { serializeCartesiaPlainText, serializeCartesiaTtsText } from "../src/cartesia-tts-text.js";
import { cartesiaVoiceCatalog } from "./speech-control-catalog-fixtures.js";

class CartesiaTtsProvider extends CartesiaTtsProviderImpl {
  constructor(options: CartesiaTtsProviderOptions) {
    super({
      ...options,
      speechControlCatalog:
        options.speechControlCatalog ??
        cartesiaVoiceCatalog(options.voiceId, {
          ...(options.modelId !== undefined ? { extraModels: [options.modelId] } : {}),
        }),
    });
  }
}

describe("Cartesia TTS typed text", () => {
  it("does not infer text-control support from an unknown Sonic 3 model prefix", () => {
    const model = "sonic-3.99";
    const voice = "account-voice";
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: PROVIDER_NAMES.cartesia,
          control: "tts.voice",
          scope: { type: "account", model, voice },
          status: "supported",
          mutability: "provider",
          source: "https://docs.cartesia.ai/api-reference/voices/get",
          verifiedAt: "2026-10-25",
        },
      ],
      { fetchedAt: "2026-10-24T00:00:00.000Z", validUntil: "2026-10-26T00:00:00.000Z" },
    );
    const provider = new CartesiaTtsProviderImpl({
      apiKey: "test-key",
      voiceId: voice,
      modelId: model,
      allowUnknownModel: true,
      speechControlCatalog: catalog,
      webSocketFactory: () => new FakeSocket() as never,
    });
    const selection = { model, voice, speechControlCatalog: catalog };

    expect(provider.supportsTtsTextOperations([{ type: "spell", match: "TVIC" }], selection)).toBe(
      false,
    );
    expect(provider.supportsTtsTextNormalization("auto", selection)).toBe(false);
    expect(provider.supportsTtsPronunciationDictionaries([{ id: "dictionary" }], selection)).toBe(
      false,
    );
  });

  it("keeps its configured voice decision stable if the caller mutates the catalog", () => {
    const catalog = {
      version: 1 as const,
      fetchedAt: "2026-10-24T00:00:00.000Z",
      validUntil: "2026-10-26T00:00:00.000Z",
      facts: [
        {
          provider: PROVIDER_NAMES.cartesia,
          control: "tts.voice",
          scope: { type: "voice" as const, model: "sonic-3.6", voice: "voice" },
          status: "unsupported" as const,
          mutability: "provider" as const,
          source: "https://docs.cartesia.ai/voices",
          verifiedAt: "2026-10-25",
        },
      ],
    } as SpeechControlCatalogSnapshot & {
      facts: Array<SpeechControlCatalogSnapshot["facts"][number]>;
    };
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      modelId: "sonic-3.6",
      speechControlCatalog: catalog,
      webSocketFactory: () => new FakeSocket() as never,
    });

    expect(provider.supportsVoice("voice")).toBe(false);
    Object.assign(catalog.facts[0]!, { status: "supported" });
    expect(provider.supportsVoice("voice")).toBe(false);
  });

  it("rejects invalid configured pronunciation dictionary identifiers", () => {
    expect(
      () =>
        new CartesiaTtsProvider({
          apiKey: "test-key",
          voiceId: "voice",
          modelId: "sonic-3.6",
          pronunciationDictId: "",
          webSocketFactory: () => new FakeSocket() as never,
        }),
    ).toThrow(/pronunciation dictionary identifier is invalid/u);
  });

  it("serializes plain text as escaped text and only typed controls as tags", () => {
    expect(
      serializeCartesiaTtsText([
        { type: "text", text: 'Literal <break time="1s"/> & safe ' },
        { type: "spell", text: "AB12" },
        { type: "text", text: ". Wait." },
        { type: "pause", durationMs: 500 },
        { type: "text", text: " Continue." },
      ]),
    ).toBe(
      'Literal &lt;break time=&quot;1s&quot;/&gt; &amp; safe <spell>AB12</spell>. Wait.<break time="500ms"/> Continue.',
    );
  });

  it("rejects oversized text without allocating a code point array", () => {
    const from = vi.spyOn(Array, "from");
    const replaceAll = vi.spyOn(String.prototype, "replaceAll");
    try {
      expect(() => serializeCartesiaTtsText([{ type: "text", text: "a".repeat(20_001) }])).toThrow(
        /code point limit/u,
      );
      expect(from).not.toHaveBeenCalled();
      expect(replaceAll).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
      replaceAll.mockRestore();
    }
  });

  it("rejects oversized plain text before expanding provider markup", () => {
    const replaceAll = vi.spyOn(String.prototype, "replaceAll");
    try {
      expect(() => serializeCartesiaPlainText("&".repeat(1_048_577))).toThrow(
        /Cartesia plain text exceeds the supported input limit/u,
      );
      expect(replaceAll).not.toHaveBeenCalled();
    } finally {
      replaceAll.mockRestore();
    }
  });

  it("rejects oversized spell text without allocating a code point array", () => {
    const from = vi.spyOn(Array, "from");
    try {
      expect(() =>
        serializeCartesiaTtsText([{ type: "spell", text: "a".repeat(100_000) }]),
      ).toThrow(/128 code points/u);
      expect(from).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
    }
  });

  it("rejects oversized typed synthesis parts before opening a connection", async () => {
    let socketCalls = 0;
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.synthesize({
        ...requestForCallControls(),
        text: "x".repeat(66),
        textParts: Array.from({ length: 66 }, () => ({ type: "text" as const, text: "x" })),
        stream: false,
      }),
    ).rejects.toMatchObject({ code: "provider.invalid_request" });
    expect(socketCalls).toBe(0);
  });

  it("writes serialized text and reports provider-bound code points", async () => {
    const socket = new FakeSocket();
    const reported: number[] = [];
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_text" as never,
      turnId: "turn_cartesia_text" as never,
      format: PCM16_16K_MONO,
      usageReporter: {
        report: vi.fn(),
        beginOperation: () => usageOperation(),
        reportTextCharacters: (value) => reported.push(value),
      },
    });

    await session.sendText("Literal <spell>NOT A COMMAND</spell>.");
    const serialized = "Literal &lt;spell&gt;NOT A COMMAND&lt;/spell&gt;.";
    expect(transcript(socket.sent[0])).toBe(serialized);
    expect(session.sendTextParts).toEqual(expect.any(Function));
    await session.sendTextParts?.([
      { type: "text", text: "Code " },
      { type: "spell", text: "AB12" },
      { type: "text", text: "." },
    ]);

    expect(transcript(socket.sent[1])).toBe("Code <spell>AB12</spell>.");
    expect(reported).toEqual([
      countUnicodeCodePoints(serialized),
      countUnicodeCodePoints("Code <spell>AB12</spell>."),
    ]);
    await session.cancel();
  });

  it("preserves ordinary line breaks and tabs in plain speech text", async () => {
    const socket = new FakeSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession(requestForCallControls());

    await session.sendText("First line.\nSecond\tline.\r\n");

    expect(transcript(socket.sent[0])).toBe("First line.\nSecond\tline.\r\n");
    await session.cancel();
  });

  it("accepts a supported model language that is not listed as a voice accent", async () => {
    const socket = new FakeSocket();
    const catalog = createSpeechControlCatalogSnapshot(
      [
        {
          provider: "cartesia",
          control: "tts.voice",
          scope: { type: "account", model: "sonic-3.6", voice: "account-voice" },
          status: "supported",
          mutability: "call",
          source: "https://docs.cartesia.ai/api-reference/voices/get",
          verifiedAt: "2026-10-24",
        },
        {
          provider: "cartesia",
          control: "tts.voice_accent",
          scope: { type: "account", model: "sonic-3.6", voice: "account-voice" },
          status: "supported",
          mutability: "call",
          source: "https://docs.cartesia.ai/api-reference/voices/get",
          verifiedAt: "2026-10-24",
          languages: ["hi-IN"],
        },
      ],
      { fetchedAt: "2026-10-24T10:00:00.000Z", validUntil: "2026-10-25T10:00:00.000Z" },
    );
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "account-voice",
      modelId: "sonic-3.6",
      speechControlCatalog: catalog,
      webSocketFactory: () => socket as never,
    });

    const session = await provider.openSession({
      ...requestForCallControls(),
      language: "fr-FR",
      speechControlCatalog: catalog,
    });
    await session.sendText("Bonjour.");

    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({ locale: "fr-FR" });
    await session.cancel();
  });

  it("rejects invalid one-shot plain text before opening the provider socket", async () => {
    let socketCalls = 0;
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.synthesize({ ...requestForCallControls(), text: "unsafe\u0085", stream: false }),
    ).rejects.toThrow(/unsupported control characters/u);
    expect(socketCalls).toBe(0);
  });

  it("rejects configured normalization when a call overrides to an incompatible model", async () => {
    let socketCalls = 0;
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      modelId: "sonic-3.6",
      normalization: "auto",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...requestForCallControls(), model: "sonic-preview" }),
    ).rejects.toThrow(/normalization.*model/u);
    expect(socketCalls).toBe(0);
  });

  it("rejects a configured pronunciation dictionary on an incompatible call model", async () => {
    let socketCalls = 0;
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      modelId: "sonic-3.6",
      pronunciationDictId: "configured-dictionary",
      webSocketFactory: () => {
        socketCalls += 1;
        return new FakeSocket() as never;
      },
    });

    await expect(
      provider.openSession({ ...requestForCallControls(), model: "sonic-preview" }),
    ).rejects.toThrow(/pronunciation dictionary.*Sonic 3 models/u);
    expect(socketCalls).toBe(0);
  });

  it("serializes explicit typed parts on the one-shot synthesis request", async () => {
    const socket = new FakeSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => socket as never,
    });

    const stream = await provider.synthesize({
      sessionId: "session_cartesia_synthesis_parts" as never,
      turnId: "turn_cartesia_synthesis_parts" as never,
      format: PCM16_16K_MONO,
      text: "Code AB12.",
      textParts: [
        { type: "text", text: "Code " },
        { type: "spell", text: "AB12" },
        { type: "text", text: "." },
      ],
      stream: true,
    });

    expect(transcript(socket.sent[0])).toBe("Code <spell>AB12</spell>.");
    await stream.cancel();
  });

  it("rejects typed operations that Cartesia does not implement", async () => {
    const socket = new FakeSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => socket as never,
    });
    const session = await provider.openSession({
      sessionId: "session_cartesia_unsupported_text" as never,
      turnId: "turn_cartesia_unsupported_text" as never,
      format: PCM16_16K_MONO,
    });

    await expect(
      session.sendTextParts?.([
        {
          type: "phoneme",
          text: "read",
          alphabet: "ipa",
          pronunciation: "ɹiːd",
        },
      ]),
    ).rejects.toMatchObject({
      provider: PROVIDER_NAMES.cartesia,
    });
    expect(socket.sent).toEqual([]);
    await session.cancel();
  });

  it("declares controls only for the supported Sonic-3 model family", () => {
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      webSocketFactory: () => new FakeSocket() as never,
    });
    const spell = [{ type: "spell", match: "A7B9" }] as const;
    const phoneme = [
      { type: "phoneme", match: "read", alphabet: "ipa", pronunciation: "ɹiːd" },
    ] as const;

    expect(provider.supportsTtsTextOperations(spell, {})).toBe(true);
    expect(provider.supportsTtsTextOperations(spell, { model: "sonic-preview" })).toBe(false);
    expect(provider.supportsTtsTextOperations(phoneme, {})).toBe(false);
  });

  it("applies call-scoped normalization and dictionary references over configured defaults", async () => {
    const socket = new FakeSocket();
    const provider = new CartesiaTtsProvider({
      apiKey: "test-key",
      voiceId: "voice",
      modelId: "sonic-3.6",
      normalization: "auto",
      pronunciationDictId: "configured-dictionary",
      webSocketFactory: () => socket as never,
    });
    const callSettings = {
      ...requestForCallControls(),
      textNormalization: { mode: "locale", locale: "en-IN" },
      pronunciationDictionaries: [{ id: "call-dictionary" }],
    } as TtsSessionOpenRequest;

    const session = await provider.openSession(callSettings);
    await session.sendText("1,234");

    const message = JSON.parse(socket.sent[0] ?? "{}") as Record<string, unknown>;
    expect(message.normalization).toBe("en-IN");
    expect(message.pronunciation_dict_id).toBe("call-dictionary");
    await session.cancel();
  });
});

function requestForCallControls(): TtsSessionOpenRequest {
  return {
    sessionId: "session_cartesia_controls" as never,
    turnId: "turn_cartesia_controls" as never,
    format: PCM16_16K_MONO,
  };
}

function transcript(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return (JSON.parse(value) as { transcript?: string }).transcript;
}

function usageOperation(): ProviderUsageOperation {
  return {
    report: vi.fn(),
    notReported: vi.fn(),
    finish: vi.fn(),
  };
}

class FakeSocket {
  readonly sent: string[] = [];
  readyState = 1;
  bufferedAmount = 0;
  readonly #handlers = new Map<string, ((value?: unknown) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.#emit("close");
  }

  on(event: string, handler: (value?: never) => void): this {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (value?: unknown) => void);
    this.#handlers.set(event, handlers);
    return this;
  }

  #emit(event: string, value?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(value);
  }
}
