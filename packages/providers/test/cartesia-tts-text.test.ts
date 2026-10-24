import { describe, expect, it, vi } from "vitest";

import type { ProviderUsageOperation } from "@tvic/core";
import { countUnicodeCodePoints, PCM16_16K_MONO, PROVIDER_NAMES } from "@tvic/core";

import { CartesiaTtsProvider } from "../src/cartesia.js";
import { serializeCartesiaTtsText } from "../src/cartesia-tts-text.js";

describe("Cartesia TTS typed text", () => {
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
});

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
