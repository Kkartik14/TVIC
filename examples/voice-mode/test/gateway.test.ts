import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { createVoiceMintRateLimiter, readJsonBody } from "../src/gateway.js";

describe("voice gateway resource bounds", () => {
  it("removes inactive user keys from the mint limiter", () => {
    let now = 1_000;
    const limiter = createVoiceMintRateLimiter({ limitPerMinute: 2, now: () => now });
    expect(limiter.allow("old-user")).toBe(true);
    expect(limiter.trackedUsers).toBe(1);
    now += 60_001;
    expect(limiter.allow("current-user")).toBe(true);
    expect(limiter.trackedUsers).toBe(1);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    let iterated = false;
    const request = fakeRequest({
      contentLength: "4097",
      onIterate: () => {
        iterated = true;
      },
    });
    await expect(readJsonBody(request, 4096)).resolves.toEqual({
      ok: false,
      status: 413,
      error: "payload_too_large",
    });
    expect(iterated).toBe(false);
  });

  it("still rejects a lying Content-Length when the streamed body exceeds the cap", async () => {
    let destroyed = false;
    const request = fakeRequest({
      contentLength: "2",
      body: `{"value":"${"x".repeat(100)}"}`,
      onDestroy: () => {
        destroyed = true;
      },
    });
    await expect(readJsonBody(request, 32)).resolves.toMatchObject({ ok: false, status: 413 });
    expect(destroyed).toBe(true);
  });
});

function fakeRequest(options: {
  readonly contentLength: string;
  readonly body?: string;
  readonly onIterate?: () => void;
  readonly onDestroy?: () => void;
}): IncomingMessage {
  return {
    headers: {
      "content-type": "application/json",
      "content-length": options.contentLength,
    },
    destroy() {
      options.onDestroy?.();
      return this;
    },
    async *[Symbol.asyncIterator]() {
      options.onIterate?.();
      if (options.body) yield Buffer.from(options.body);
    },
  } as unknown as IncomingMessage;
}
