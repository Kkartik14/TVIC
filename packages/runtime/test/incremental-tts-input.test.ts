import { describe, expect, it, vi } from "vitest";

import type { TtsEvent, TtsSession } from "@tvic/core";

import { IncrementalTtsInput } from "../src/incremental-tts-input.js";

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

  it("bounds a hanging provider session cancel", async () => {
    const input = new IncrementalTtsInput({
      openSession: async () => ({
        events: emptyEvents(),
        async sendText() {},
        async flush() {
          return { id: 1, acknowledgedBy: "provider" } as const;
        },
        async finish() {},
        async cancel(): Promise<never> {
          return new Promise<never>(() => {});
        },
      }),
    });
    await input.pushToken("Hello. ");
    const startedAt = Date.now();
    await input.cancel();
    // Bounded by the 5s cancel budget, not forever.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 20_000);

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
