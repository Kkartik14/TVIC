import { describe, expect, it, vi } from "vitest";

import type { TtsEvent, TtsSession } from "@tvic/core";

import { IncrementalTtsInput } from "../src/incremental-tts-input.js";
import { MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES } from "../src/pipeline-constants.js";

describe("IncrementalTtsInput", () => {
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
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(cancellation).resolves.toBeUndefined();
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
