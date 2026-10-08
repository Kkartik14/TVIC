import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { createVoiceMintRateLimiter, readJsonBody } from "../src/gateway.js";

describe("voice gateway resource bounds", () => {
  it("removes inactive user keys from the mint limiter", () => {
    let now = 1_000;
    const limiter = createVoiceMintRateLimiter({
      limitPerMinute: 2,
      maxTrackedUsers: 1,
      now: () => now,
    });
    expect(limiter.allow("old-user")).toBe("allowed");
    expect(limiter.trackedUsers).toBe(1);
    expect(limiter.allow("new-user")).toBe("capacity_exceeded");
    now += 60_001;
    expect(limiter.allow("current-user")).toBe("allowed");
    expect(limiter.trackedUsers).toBe(1);
  });

  it("applies the configured mint rate limit per user", () => {
    const limiter = createVoiceMintRateLimiter({ limitPerMinute: 1 });
    expect(limiter.allow("user-1")).toBe("allowed");
    expect(limiter.allow("user-1")).toBe("rate_limited");
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

  it("accepts case-insensitive JSON media types with parameters", async () => {
    const request = fakeRequest({
      contentLength: "2",
      contentType: "Application/JSON; charset=utf-8",
      body: "{}",
    });

    await expect(readJsonBody(request, 4096)).resolves.toEqual({ ok: true, value: {} });
  });

  it.each(["application/jsonp", "text/application/json"])(
    "rejects a non-JSON media type that contains JSON-like text (%s)",
    async (contentType) => {
      const request = fakeRequest({ contentLength: "2", contentType, body: "{}" });

      await expect(readJsonBody(request, 4096)).resolves.toEqual({
        ok: false,
        status: 415,
        error: "unsupported_media_type",
      });
    },
  );

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
  readonly contentType?: string;
  readonly body?: string;
  readonly onIterate?: () => void;
  readonly onDestroy?: () => void;
}): IncomingMessage {
  return {
    headers: {
      "content-type": options.contentType ?? "application/json",
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
