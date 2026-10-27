import { describe, expect, it, vi } from "vitest";

import type { TtsEvent, TtsSession } from "@tvic/core";

import { IncrementalTtsInput } from "../src/incremental-tts-input.js";
import { MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES } from "../src/pipeline-constants.js";

describe("IncrementalTtsInput", () => {
  it("streams sentences ending in Unicode sentence terminals before generation finishes", async () => {
    const samples = [
      {
        text: "आपकाखा नंबर क्या है। मैं अभीजाँचकरताहूँ।",
        sentences: ["आपकाखा नंबर क्या है। ", "मैं अभीजाँचकरताहूँ।"],
      },
      { text: "বাংলা বাক্য। আরেকটি বাক্য।", sentences: ["বাংলা বাক্য। ", "আরেকটি বাক্য।"] },
      { text: "یہ اردو جملہ ہے۔ دوسرا جملہ۔", sentences: ["یہ اردو جملہ ہے۔ ", "دوسرا جملہ۔"] },
      { text: "今日は確認します。次の文です。", sentences: ["今日は確認します。", "次の文です。"] },
      { text: "これは答えです。」次です。", sentences: ["これは答えです。」", "次です。"] },
      { text: "你好。】再见。", sentences: ["你好。】", "再见。"] },
    ];

    for (const sample of samples) {
      const fake = makeSession();
      const input = new IncrementalTtsInput({ openSession: async () => fake.session });

      await input.pushToken(sample.text);

      expect(fake.sent).toEqual(sample.sentences);
      await input.finish();
    }
  });

  it("flushes a sentence-ending ellipsis before the next incremental sentence arrives", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });

    await input.pushToken("Wait…");
    expect(fake.sent).toEqual(["Wait…"]);

    await input.pushToken(" Then continue.");
    await input.finish();

    expect(fake.sent).toEqual(["Wait…", " Then continue."]);
  });

  it("opens on the first token and sends sentence-sized acknowledged boundaries", async () => {
    const fake = makeSession();
    let opens = 0;
    const input = new IncrementalTtsInput({
      async openSession() {
        opens += 1;
        return fake.session;
      },
    });

    await input.pushToken("Hello");
    expect(opens).toBe(1);
    expect(fake.sent).toEqual([]);
    await input.pushToken(". How are");
    await input.pushToken(" you?");
    await input.finish();

    expect(fake.sent).toEqual(["Hello. ", "How are you?"]);
    expect(fake.flushCalls).toBe(2);
    expect(fake.finishCalls).toBe(1);
  });

  it("bounds provider operations when one token contains dense sentence boundaries", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const text = "x! ".repeat(349_525);

    await input.pushToken(text);

    expect(fake.sent.join("")).toBe(text);
    expect(fake.sent.every((chunk) => chunk.length <= 2_500)).toBe(true);
    expect(fake.flushCalls).toBeLessThanOrEqual(452);
    await input.finish();
  });

  it("keeps long sentence batches on word boundaries", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const text = `${"word ".repeat(1_000)}done.`;

    await input.pushToken(text);
    await input.finish();

    expect(fake.sent.join("")).toBe(text);
    expect(fake.sent.every((chunk) => chunk.length <= 2_500)).toBe(true);
    expect(fake.sent.slice(0, -1).every((chunk) => /\s$/u.test(chunk))).toBe(true);
  });

  it.each(["flushBoundary", "finish"] as const)(
    "sends unfinished text in bounded batches on %s",
    async (boundary) => {
      const fake = makeSession();
      const input = new IncrementalTtsInput({ openSession: async () => fake.session });
      const text = "x".repeat(10_001);

      await input.pushToken(text);
      if (boundary === "flushBoundary") {
        await input.flushBoundary();
      } else {
        await input.finish();
      }

      expect(fake.sent.join("")).toBe(text);
      expect(fake.sent.length).toBe(5);
      expect(fake.sent.every((chunk) => chunk.length <= 2_500)).toBe(true);
      if (boundary === "flushBoundary") expect(fake.flushCalls).toBe(1);
      if (boundary === "finish") expect(fake.finishCalls).toBe(1);
      await input.finish();
    },
  );

  it("keeps unfinished text batches on word boundaries", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const text = "word ".repeat(1_000);

    await input.pushToken(text);
    await input.flushBoundary();

    expect(fake.sent.join("")).toBe(text);
    expect(fake.sent.every((chunk) => chunk.length <= 2_500)).toBe(true);
    expect(fake.sent.slice(0, -1).every((chunk) => /\s$/u.test(chunk))).toBe(true);
    await input.finish();
  });

  it("keeps supplementary Unicode within the provider UTF-16 text limit", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const text = `${"🙂".repeat(1_250)}!`;

    await input.pushToken(text);
    await input.finish();

    expect(fake.sent.join("")).toBe(text);
    expect(fake.sent.every((chunk) => chunk.length <= 2_500)).toBe(true);
  });

  it("does not rescan punctuation-free text as it arrives in small tokens", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const text = "no punctuation ".repeat(10);

    try {
      for (let index = 0; index < 256; index += 1) await input.pushToken(text);
      await input.flushBoundary();

      expect(fake.sent.join("")).toBe(text.repeat(256));
      expect(segment.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      segment.mockRestore();
    }
    await input.finish();
  });

  it("rejects an oversized token without allocating an encoded copy", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const encode = vi.spyOn(TextEncoder.prototype, "encode");

    try {
      await expect(
        input.pushToken("x".repeat(MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES + 1)),
      ).rejects.toMatchObject({ code: "provider.stream_buffer_overflow" });
      expect(encode.mock.calls.length).toBe(0);
    } finally {
      encode.mockRestore();
    }
    await input.cancel();
  });

  it("flushes an incomplete sentence before a tool boundary", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });

    await input.pushToken("Let me check that");
    await input.flushBoundary();
    await input.finish();

    expect(fake.sent).toEqual(["Let me check that"]);
    expect(fake.flushCalls).toBe(1);
  });

  it("serializes concurrent sentence boundaries on one provider session", async () => {
    let releaseFirstFlush!: () => void;
    let resolveFirstFlushStarted!: () => void;
    const firstFlushStarted = new Promise<void>((resolve) => {
      resolveFirstFlushStarted = resolve;
    });
    let flushCalls = 0;
    let activeFlushes = 0;
    let maxActiveFlushes = 0;
    const sent: string[] = [];
    const session: TtsSession = {
      events: emptyEvents(),
      async sendText(text) {
        sent.push(text);
      },
      async flush() {
        flushCalls += 1;
        activeFlushes += 1;
        maxActiveFlushes = Math.max(maxActiveFlushes, activeFlushes);
        if (flushCalls === 1) {
          resolveFirstFlushStarted();
          await new Promise<void>((resolve) => {
            releaseFirstFlush = resolve;
          });
        }
        activeFlushes -= 1;
        return { id: flushCalls, acknowledgedBy: "provider" };
      },
      async finish() {},
      async cancel() {},
    };
    const input = new IncrementalTtsInput({ openSession: async () => session });

    const first = input.pushToken("First.");
    await firstFlushStarted;
    const second = input.pushToken("Second.");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sent).toEqual(["First."]);

    releaseFirstFlush();
    await Promise.all([first, second]);
    await input.finish();

    expect(sent).toEqual(["First.", "Second."]);
    expect(maxActiveFlushes).toBe(1);
  });

  it("retains a settled flush failure until finish observes it", async () => {
    const input = new IncrementalTtsInput({
      openSession: async () => ({
        events: emptyEvents(),
        async sendText() {},
        async flush(): Promise<{ readonly id: number; readonly acknowledgedBy: "provider" }> {
          throw new Error("flush failed");
        },
        async finish() {},
        async cancel() {},
      }),
    });

    await input.pushToken("Hello. ");
    await Promise.resolve();
    await expect(input.finish()).rejects.toThrow("flush failed");
  });

  it("does not open a provider session for an empty response", async () => {
    let opens = 0;
    const input = new IncrementalTtsInput({
      async openSession() {
        opens += 1;
        return makeSession().session;
      },
    });
    const events = collect(input.events);

    await input.finish();

    expect(await events).toEqual([]);
    expect(opens).toBe(0);
  });

  it("stops forwarding a pending provider event iterator on cancellation", async () => {
    let markNextStarted!: () => void;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    let returnCalls = 0;
    let cancelCalls = 0;
    const events: AsyncIterable<TtsEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            markNextStarted();
            return await new Promise<IteratorResult<TtsEvent>>(() => undefined);
          },
          return: async () => {
            returnCalls += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const session: TtsSession = {
      events,
      async sendText() {},
      async flush() {
        return { id: 1, acknowledgedBy: "provider" };
      },
      async finish() {},
      async cancel() {
        cancelCalls += 1;
      },
    };
    const input = new IncrementalTtsInput({ openSession: async () => session });
    await input.pushToken("Hello");
    const pending = input.events[Symbol.asyncIterator]().next();
    await nextStarted;

    await input.cancel();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(cancelCalls).toBe(1);
    expect(returnCalls).toBe(1);
  });

  it("bounds an active provider cancellation that never settles", async () => {
    vi.useFakeTimers();
    try {
      let cancelCalls = 0;
      const session: TtsSession = {
        events: emptyEvents(),
        async sendText() {},
        async flush() {
          return { id: 1, acknowledgedBy: "provider" };
        },
        async finish() {},
        async cancel() {
          cancelCalls += 1;
          await new Promise<void>(() => undefined);
        },
      };
      const input = new IncrementalTtsInput({ openSession: async () => session });
      await input.pushToken("Hello");

      const cancellation = input.cancel();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(cancellation).resolves.toBeUndefined();
      expect(cancelCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels promptly while provider session startup is still pending", async () => {
    let opens = 0;
    let resolveOpen!: (session: TtsSession) => void;
    const input = new IncrementalTtsInput({
      openSession: () => {
        opens += 1;
        return new Promise<TtsSession>((resolve) => {
          resolveOpen = resolve;
        });
      },
    });
    const pushing = input.pushToken("Hello. ");

    await input.cancel();

    await expect(pushing).rejects.toThrow(/closed/i);
    expect(opens).toBe(1);

    const lateSession = makeSession();
    resolveOpen(lateSession.session);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateSession.cancelCalls).toBe(1);
  });

  it("times out startup and cancels a session that arrives late", async () => {
    let resolveLate!: (session: TtsSession) => void;
    const opening = new Promise<TtsSession>((resolve) => {
      resolveLate = resolve;
    });
    const fake = makeSession();
    const input = new IncrementalTtsInput({
      openTimeoutMs: 20,
      openSession: () => opening,
    });

    await expect(input.pushToken("Hello. ")).rejects.toMatchObject({
      code: "tts.open_timeout",
    });
    resolveLate(fake.session);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.cancelCalls).toBe(1);
  });

  it("bounds incremental provider commands instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      let cancelCalls = 0;
      const input = new IncrementalTtsInput({
        sendTimeoutMs: 10,
        openSession: async () => ({
          events: emptyEvents(),
          async sendText() {
            return new Promise<void>(() => {});
          },
          async flush() {
            return { id: 1, acknowledgedBy: "provider" } as const;
          },
          async finish() {},
          async cancel() {
            cancelCalls += 1;
          },
        }),
      });
      const pushing = input.pushToken("Hello. ");
      const failure = expect(pushing).rejects.toMatchObject({
        code: "tts.send_timeout",
        category: "timeout",
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      await failure;
      await input.cancel();
      expect(cancelCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a punctuation-free input buffer by UTF-8 bytes", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });

    await input.pushToken("x".repeat(MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES));
    await expect(input.pushToken("y")).rejects.toMatchObject({
      code: "provider.stream_buffer_overflow",
      provider: "tvic-runtime",
    });
    expect(fake.sent).toEqual([]);
    await input.cancel();
  });

  it("counts UTF-8 bytes correctly when a surrogate pair arrives across token boundaries", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });

    await input.pushToken("\ud83d".repeat(10_000));
    await input.pushToken(`${"\ude00".repeat(10_000)}!`);
    await expect(input.pushToken("x".repeat(1_030_000))).resolves.toBeUndefined();

    await input.cancel();
  });
});

function makeSession() {
  const sent: string[] = [];
  let flushCalls = 0;
  let finishCalls = 0;
  let cancelCalls = 0;
  const session: TtsSession = {
    events: emptyEvents(),
    async sendText(text) {
      sent.push(text);
    },
    async flush() {
      flushCalls += 1;
      return { id: flushCalls, acknowledgedBy: "provider" };
    },
    async finish() {
      finishCalls += 1;
    },
    async cancel() {
      cancelCalls += 1;
    },
  };
  return {
    session,
    sent,
    get flushCalls() {
      return flushCalls;
    },
    get finishCalls() {
      return finishCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

async function* emptyEvents(): AsyncIterable<TtsEvent> {
  return;
}

async function collect(events: AsyncIterable<TtsEvent>): Promise<TtsEvent[]> {
  const result: TtsEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
