import { describe, expect, it } from "vitest";

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
