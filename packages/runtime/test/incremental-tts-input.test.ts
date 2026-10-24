import { describe, expect, it, vi } from "vitest";

import { ttsTextPartsToPlainText } from "@tvic/core";
import type { TtsEvent, TtsSession, TtsTextPart } from "@tvic/core";

import { IncrementalTtsInput } from "../src/incremental-tts-input.js";
import { MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES } from "../src/pipeline-constants.js";
import { TtsOperationBoundaryMatcher } from "../src/tts-operation-boundaries.js";

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

  it("sends a complete host-authored text operation as one typed part", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async (_parts: readonly TtsTextPart[]) => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [
        { type: "spell", match: "A7B9" },
        { type: "pause_after", match: "A7B9", durationMs: 500 },
      ],
    });

    await input.pushToken("Your code is A7B9. Please wait.");

    expect(sendTextParts).toHaveBeenCalledWith([
      { type: "text", text: "Your code is " },
      { type: "spell", text: "A7B9" },
      { type: "pause", durationMs: 500 },
      { type: "text", text: ". " },
    ]);
    expect(fake.sent).toEqual(["Please wait."]);
    await input.finish();
  });

  it("sends long punctuation-free speech in bounded batches without splitting an operation", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async (_parts: readonly TtsTextPart[]) => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A7B9" }],
    });
    const text = `${"x".repeat(19_998)}A7B9${"y".repeat(10)}`;

    await input.pushToken(text);
    await input.finish();

    const batches = sendTextParts.mock.calls.map(([parts]) => parts);
    expect(batches).toHaveLength(2);
    expect(batches.map(ttsTextPartsToPlainText).join("")).toBe(text);
    expect(batches.flat().filter((part) => part.type === "spell")).toEqual([
      { type: "spell", text: "A7B9" },
    ]);
  });

  it("holds sentence boundaries that would split a host-authored operation", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A7B9. Next" }],
    });

    await input.pushToken("Code A7B9.");
    expect(sendTextParts).not.toHaveBeenCalled();

    await input.pushToken(" Next please.");
    expect(sendTextParts).toHaveBeenCalledWith([
      { type: "text", text: "Code " },
      { type: "spell", text: "A7B9. Next" },
      { type: "text", text: " please." },
    ]);
    await input.finish();
  });

  it("keeps every sentence inside a host-authored operation in one typed send", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A7B9. More. End" }],
    });

    await input.pushToken("Code A7B9.");
    await input.pushToken(" More.");
    expect(sendTextParts).not.toHaveBeenCalled();

    await input.pushToken(" End.");

    expect(sendTextParts).toHaveBeenCalledWith([
      { type: "text", text: "Code " },
      { type: "spell", text: "A7B9. More. End" },
      { type: "text", text: "." },
    ]);
    await input.finish();
  });

  it("does not repeatedly segment a held operation prefix", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const matcher = new TtsOperationBoundaryMatcher([{ type: "spell", match: "A. B" }]);
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A. B" }],
      operationBoundaryMatcher: matcher,
    });
    const text = `A. B${"x".repeat(512)}`;

    await input.pushToken("A.");
    for (const character of text.slice(2)) await input.pushToken(character);

    const segmentationWork = segment.mock.calls.reduce(
      (total, [scannedText]) => total + scannedText.length,
      0,
    );
    expect(segmentationWork).toBeLessThanOrEqual(text.length * 4);

    await input.finish();
    expect(sendTextParts).toHaveBeenCalledWith([
      { type: "spell", text: "A. B" },
      { type: "text", text: "x".repeat(512) },
    ]);
    segment.mockRestore();
  });

  it("keeps cursor typed-array storage bounded when a response has no sentence boundaries", async () => {
    const fake = makeSession();
    const matcher = new TtsOperationBoundaryMatcher([{ type: "spell", match: "A7B9" }]);
    const allocationLengths: number[] = [];
    const trackAllocations = <T extends Uint32ArrayConstructor | Uint16ArrayConstructor>(
      constructor: T,
    ): T =>
      new Proxy(constructor, {
        construct(target, args) {
          if (typeof args[0] === "number") allocationLengths.push(args[0]);
          return Reflect.construct(target, args);
        },
      });
    vi.stubGlobal("Uint32Array", trackAllocations(Uint32Array));
    vi.stubGlobal("Uint16Array", trackAllocations(Uint16Array));
    try {
      const input = new IncrementalTtsInput({
        openSession: async () => fake.session,
        textOperations: [{ type: "spell", match: "A7B9" }],
        operationBoundaryMatcher: matcher,
      });

      await input.pushToken("x".repeat(128 * 1024));

      expect(Math.max(0, ...allocationLengths)).toBeLessThanOrEqual(4);
      await input.finish();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not allocate boundary-sized range arrays for a large sentence batch", async () => {
    const fake = makeSession();
    const matcher = new TtsOperationBoundaryMatcher([{ type: "spell", match: "A7B9" }]);
    const allocationLengths: number[] = [];
    const trackAllocations = <T extends Int32ArrayConstructor>(constructor: T): T =>
      new Proxy(constructor, {
        construct(target, args) {
          if (typeof args[0] === "number") allocationLengths.push(args[0]);
          return Reflect.construct(target, args);
        },
      });
    vi.stubGlobal("Int32Array", trackAllocations(Int32Array));
    try {
      const input = new IncrementalTtsInput({
        openSession: async () => fake.session,
        textOperations: [{ type: "spell", match: "A7B9" }],
        operationBoundaryMatcher: matcher,
      });

      await input.pushToken("Yes. ".repeat(10_000));

      expect(fake.sent).toHaveLength(10_000);
      expect(Math.max(0, ...allocationLengths)).toBeLessThanOrEqual(32);
      await input.finish();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports unmatched operations without blocking otherwise speakable text", async () => {
    const fake = makeSession();
    const unmatchedOperations: number[] = [];
    const input = new IncrementalTtsInput({
      openSession: async () => fake.session,
      textOperations: [{ type: "spell", match: "A7B9" }],
      onTextOperationsNotApplied: (count) => unmatchedOperations.push(count),
    });

    await input.pushToken("Your code is B3C4.");
    await expect(input.finish()).resolves.toBeUndefined();
    expect(fake.sent).toEqual(["Your code is B3C4."]);
    expect(unmatchedOperations).toEqual([1]);
  });

  it("fails rather than applying one operation twice across sentence sends", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A7B9" }],
    });

    await expect(input.pushToken("A7B9. A7B9.")).rejects.toThrow(/matched more than once/u);
    expect(sendTextParts).not.toHaveBeenCalled();
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

  it("keeps a partial operation suffix across a tool boundary", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A7B9" }],
    });

    await input.pushToken("Before A7");
    await input.flushBoundary();
    expect(fake.sent).toEqual(["Before "]);

    await input.pushToken("B9. ");
    expect(sendTextParts).toHaveBeenCalledWith([
      { type: "spell", text: "A7B9" },
      { type: "text", text: ". " },
    ]);
    await input.finish();
  });

  it("retains a bordered operation intact across a tool boundary", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "level" }],
    });

    await input.pushToken("level");
    await input.flushBoundary();

    expect(sendTextParts).not.toHaveBeenCalled();
    expect(fake.flushCalls).toBe(0);
    await input.finish();

    expect(sendTextParts).toHaveBeenCalledWith([{ type: "spell", text: "level" }]);
  });

  it("does not flush a boundary made only of an incomplete operation prefix", async () => {
    const fake = makeSession();
    const sendTextParts = vi.fn(async () => undefined);
    const session = Object.assign(fake.session, { sendTextParts });
    const input = new IncrementalTtsInput({
      openSession: async () => session,
      textOperations: [{ type: "spell", match: "A7B9" }],
    });

    await input.pushToken("A7");
    await input.flushBoundary();

    expect(fake.sent).toEqual([]);
    expect(fake.flushCalls).toBe(0);
    expect(sendTextParts).not.toHaveBeenCalled();

    await input.pushToken("B9");
    await input.finish();
    expect(sendTextParts).toHaveBeenCalledWith([{ type: "spell", text: "A7B9" }]);
  });

  it("segments a supplementary sentence terminal split across token chunks", async () => {
    const fake = makeSession();
    const input = new IncrementalTtsInput({ openSession: async () => fake.session });
    const terminal = "𐩖";

    await input.pushToken("hello");
    await input.pushToken(terminal.slice(0, 1));
    await input.pushToken(`${terminal.slice(1)} `);

    expect(fake.sent).toEqual([`hello${terminal} `]);
    await input.finish();
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
