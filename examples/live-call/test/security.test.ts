import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { createStreamTokenStore, readFormBody, validTwilioSignature } from "../src/security.js";

describe("createStreamTokenStore", () => {
  const identity = { from: "+15551234567", to: "+15557654321", twilioCallSid: "CA123" };

  it("accepts a freshly issued token exactly once and returns the bound identity", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);

    expect(store.consume(callId, token, String(expMs))).toEqual(identity);
    expect(store.consume(callId, token, String(expMs))).toBeNull(); // replay rejected
  });

  it("rejects wrong, missing, or tampered tokens", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);

    expect(store.consume(callId, null, String(expMs))).toBeNull();
    expect(store.consume(callId, "deadbeef", String(expMs))).toBeNull();
    expect(store.consume("call_unknown", token, String(expMs))).toBeNull();
    expect(store.consume(callId, token, String(expMs + 1))).toBeNull(); // exp mismatch
  });

  it("rejects expired tokens", () => {
    let now = 1_000;
    const store = createStreamTokenStore("secret", 5_000, () => now);
    const { callId, token, expMs } = store.issue(identity);
    now = expMs + 1;
    expect(store.consume(callId, token, String(expMs))).toBeNull();
  });

  it("rejects non-canonical expiry strings", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);
    expect(store.consume(callId, token, `${expMs}abc`)).toBeNull();
    expect(store.consume(callId, token, " ")).toBeNull();
  });
});

describe("validTwilioSignature", () => {
  const authToken = "test-auth-token";
  const url = "https://example.test/twiml";
  const params = { CallSid: "CA123", From: "+15551234567", To: "+15557654321" };

  function sign(): string {
    let data = url;
    for (const key of Object.keys(params).sort()) {
      data += key + params[key as keyof typeof params];
    }
    return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  }

  it("accepts a correct signature", () => {
    expect(validTwilioSignature(authToken, url, params, sign())).toBe(true);
  });

  it("rejects an incorrect signature or wrong token", () => {
    expect(validTwilioSignature(authToken, url, params, "bogus")).toBe(false);
    expect(validTwilioSignature("other-token", url, params, sign())).toBe(false);
  });
});

function fakeRequest(options: {
  method?: string;
  contentType?: string;
  contentLength?: string;
  chunks?: string[];
}): IncomingMessage {
  const chunks = options.chunks ?? [];
  const headers: Record<string, string> = {};
  if (options.contentType !== undefined) {
    headers["content-type"] = options.contentType;
  }
  if (options.contentLength !== undefined) {
    headers["content-length"] = options.contentLength;
  }
  return {
    method: options.method ?? "POST",
    headers,
    destroy() {
      /* no-op */
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield Buffer.from(chunk, "utf8");
      }
    },
  } as unknown as IncomingMessage;
}

describe("readFormBody", () => {
  it("parses a small form-encoded POST body", async () => {
    const result = await readFormBody(
      fakeRequest({
        contentType: "application/x-www-form-urlencoded",
        chunks: ["CallSid=CA1&From=%2B15551234567"],
      }),
      1024,
    );
    expect(result).toEqual({ ok: true, params: { CallSid: "CA1", From: "+15551234567" } });
  });

  it("rejects non-POST and wrong content-type", async () => {
    expect((await readFormBody(fakeRequest({ method: "GET" }), 1024)).ok).toBe(false);
    expect((await readFormBody(fakeRequest({ contentType: "application/json" }), 1024)).ok).toBe(
      false,
    );
  });

  it("rejects oversized bodies by Content-Length before buffering", async () => {
    const result = await readFormBody(
      fakeRequest({ contentType: "application/x-www-form-urlencoded", contentLength: "99999" }),
      1024,
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects bodies that exceed the cap mid-stream", async () => {
    const big = "x".repeat(2048);
    const result = await readFormBody(
      fakeRequest({ contentType: "application/x-www-form-urlencoded", chunks: [big] }),
      1024,
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
  });
});
