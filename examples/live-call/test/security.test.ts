import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import {
  createInMemoryTwimlReplayStore,
  createStreamTokenStore,
  readFormBody,
} from "../src/security.js";
import { verifyTwilioSignature } from "@tvic/providers";

describe("createStreamTokenStore", () => {
  const identity = { from: "+15551234567", to: "+15557654321", twilioCallSid: "CA123" };

  it("restores a reserved token after a failed WebSocket handshake", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);
    const reservation = store.reserve(callId, token, String(expMs));
    expect(reservation).not.toBeNull();
    if (!reservation) return;

    expect(store.reserve(callId, token, String(expMs))).toBeNull();
    store.restore(reservation);
    const retryReservation = store.reserve(callId, token, String(expMs));
    expect(retryReservation).not.toBeNull();
    if (!retryReservation) return;

    store.restore(reservation); // A stale reservation must not release the newer reservation.
    expect(store.reserve(callId, token, String(expMs))).toBeNull();
    expect(store.commit(retryReservation)).toEqual(identity);
    expect(store.reserve(callId, token, String(expMs))).toBeNull();
  });

  it("accepts a freshly issued token once and returns the bound identity on commit", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);
    const reservation = store.reserve(callId, token, String(expMs));

    expect(reservation?.identity).toEqual(identity);
    expect(store.reserve(callId, token, String(expMs))).toBeNull(); // concurrent replay rejected
    if (!reservation) return;
    expect(store.commit(reservation)).toEqual(identity);
    expect(store.reserve(callId, token, String(expMs))).toBeNull(); // consumed replay rejected
  });

  it("rejects wrong, missing, or tampered tokens", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);

    expect(store.reserve(callId, null, String(expMs))).toBeNull();
    expect(store.reserve(callId, "deadbeef", String(expMs))).toBeNull();
    expect(store.reserve("call_unknown", token, String(expMs))).toBeNull();
    expect(store.reserve(callId, token, String(expMs + 1))).toBeNull(); // exp mismatch
  });

  it("rejects a valid token with trailing non-hex characters", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);
    expect(store.reserve(callId, `${token}zz`, String(expMs))).toBeNull();
  });

  it("rejects expired tokens", () => {
    let now = 1_000;
    const store = createStreamTokenStore("secret", 5_000, () => now);
    const { callId, token, expMs } = store.issue(identity);
    now = expMs;
    expect(store.reserve(callId, token, String(expMs))).toBeNull();
  });

  it("uses an exclusive expiry boundary for reservation lifecycle operations", () => {
    let now = 1_000;
    const store = createStreamTokenStore("secret", 5_000, () => now);
    const atReserve = store.issue(identity);
    const atCommit = store.issue(identity);
    const atRestore = store.issue(identity);
    const atPrune = store.issue(identity);
    const commitReservation = store.reserve(
      atCommit.callId,
      atCommit.token,
      String(atCommit.expMs),
    );
    const restoreReservation = store.reserve(
      atRestore.callId,
      atRestore.token,
      String(atRestore.expMs),
    );
    const pruneReservation = store.reserve(atPrune.callId, atPrune.token, String(atPrune.expMs));

    expect(commitReservation).not.toBeNull();
    expect(restoreReservation).not.toBeNull();
    expect(pruneReservation).not.toBeNull();
    if (!commitReservation || !restoreReservation || !pruneReservation) return;

    now = atReserve.expMs;
    expect(store.reserve(atReserve.callId, atReserve.token, String(atReserve.expMs))).toBeNull();
    expect(store.commit(commitReservation)).toBeNull();
    store.restore(restoreReservation);
    store.prune();

    // These clock rewinds make exact-deadline deletion observable without exposing store internals.
    now = atReserve.expMs - 1;
    expect(store.reserve(atRestore.callId, atRestore.token, String(atRestore.expMs))).toBeNull();
    expect(store.reserve(atPrune.callId, atPrune.token, String(atPrune.expMs))).toBeNull();
  });

  it("rejects non-canonical expiry strings", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);
    expect(store.reserve(callId, token, `${expMs}abc`)).toBeNull();
    expect(store.reserve(callId, token, " ")).toBeNull();
  });

  it("releases an issued token that was never delivered", () => {
    const store = createStreamTokenStore("secret", 60_000);
    const { callId, token, expMs } = store.issue(identity);

    store.release(callId);

    expect(store.reserve(callId, token, String(expMs))).toBeNull();
  });
});

describe("createInMemoryTwimlReplayStore", () => {
  it("rejects publication after a replay reservation expires", async () => {
    let now = 1_000;
    const store = createInMemoryTwimlReplayStore(() => now);
    const owner = await store.acquire("expiring-key", "request-hash", 100);
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") return;

    now = 1_100;
    await expect(owner.complete("<Response />")).rejects.toThrow(
      "TwiML replay reservation was lost before completion",
    );
  });

  it("starts completed replay retention when the response is published", async () => {
    let now = 1_000;
    const store = createInMemoryTwimlReplayStore(() => now);
    const owner = await store.acquire("completion-ttl-key", "request-hash", 100);
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") return;

    now = 1_050;
    await owner.complete("<Response />");
    now = 1_149;
    await expect(store.acquire("completion-ttl-key", "request-hash", 100)).resolves.toEqual({
      kind: "replayed",
      response: "<Response />",
    });

    now = 1_150;
    const replacement = await store.acquire("completion-ttl-key", "request-hash", 100);
    expect(replacement.kind).toBe("owner");
    if (replacement.kind === "owner") await replacement.abort();
  });

  it("does not let an expired owner publish over a replacement reservation", async () => {
    let now = 1_000;
    const store = createInMemoryTwimlReplayStore(() => now);
    const original = await store.acquire("replacement-key", "request-hash", 100);
    expect(original.kind).toBe("owner");
    if (original.kind !== "owner") return;

    now = 1_100;
    store.prune();
    const replacement = await store.acquire("replacement-key", "request-hash", 100);
    expect(replacement.kind).toBe("owner");
    if (replacement.kind !== "owner") return;

    await expect(original.complete("<Response />")).rejects.toThrow(
      "TwiML replay reservation was lost before completion",
    );
    await replacement.abort();
  });

  it("fails closed when replay state is missing or incomplete at consumption", async () => {
    const store = createInMemoryTwimlReplayStore();

    await expect(store.markConsumed("missing-key")).rejects.toThrow(
      "TwiML replay state is unavailable before consumption",
    );

    const owner = await store.acquire("pending-key", "request-hash", 10_000);
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") return;
    await expect(store.markConsumed("pending-key")).rejects.toThrow(
      "TwiML replay state is unavailable before consumption",
    );
    await owner.abort();
  });

  it("fails closed when replay state expires before consumption", async () => {
    let now = 1_000;
    const store = createInMemoryTwimlReplayStore(() => now);
    const owner = await store.acquire("expired-key", "request-hash", 100);
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") return;

    await owner.complete("<Response />");
    now = 1_100;
    await expect(store.markConsumed("expired-key")).rejects.toThrow(
      "TwiML replay state is unavailable before consumption",
    );
  });

  it("releases an expired response so a later delivery can claim the key", async () => {
    let now = 1_000;
    const store = createInMemoryTwimlReplayStore(() => now);
    const first = await store.acquire("call-key", "request-hash", 100);
    expect(first.kind).toBe("owner");
    if (first.kind !== "owner") return;

    await first.complete("<Response />");
    await expect(store.acquire("call-key", "request-hash", 100)).resolves.toEqual({
      kind: "replayed",
      response: "<Response />",
    });

    now = 1_101;
    store.prune();
    const next = await store.acquire("call-key", "request-hash", 100);
    expect(next.kind).toBe("owner");
    if (next.kind === "owner") await next.abort();
  });

  it("stops waiting for a duplicate claim when its request is aborted", async () => {
    const store = createInMemoryTwimlReplayStore();
    const owner = await store.acquire("cancel-key", "request-hash", 10_000);
    expect(owner.kind).toBe("owner");
    if (owner.kind !== "owner") return;

    const controller = new AbortController();
    const waiting = store.acquire("cancel-key", "request-hash", 10_000, controller.signal);
    controller.abort();
    const result = await Promise.race([
      waiting,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    await owner.abort();

    expect(result).toEqual({ kind: "busy" });
  });
});

describe("verifyTwilioSignature", () => {
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
    expect(verifyTwilioSignature({ signature: sign(), url, params, authToken })).toBe(true);
  });

  it("rejects an incorrect signature or wrong token", () => {
    expect(verifyTwilioSignature({ signature: "bogus", url, params, authToken })).toBe(false);
    expect(
      verifyTwilioSignature({ signature: sign(), url, params, authToken: "other-token" }),
    ).toBe(false);
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

  it("preserves repeated form keys for Twilio signature verification", async () => {
    const result = await readFormBody(
      fakeRequest({
        contentType: "Application/X-WWW-Form-Urlencoded; charset=utf-8",
        chunks: ["RecordingChannels=1&RecordingChannels=2"],
      }),
      1024,
    );
    expect(result).toEqual({
      ok: true,
      params: { RecordingChannels: ["1", "2"] },
    });
  });

  it("rejects non-POST and wrong content-type", async () => {
    expect((await readFormBody(fakeRequest({ method: "GET" }), 1024)).ok).toBe(false);
    expect((await readFormBody(fakeRequest({ contentType: "application/json" }), 1024)).ok).toBe(
      false,
    );
  });

  it.each([
    "application/x-www-form-urlencoded-evil",
    "text/plain; note=application/x-www-form-urlencoded",
    "application/x-www-form-urlencoded, application/x-www-form-urlencoded",
  ])("rejects non-form media types and duplicate values (%s)", async (contentType) => {
    const result = await readFormBody(fakeRequest({ contentType, chunks: ["CallSid=CA1"] }), 1024);

    expect(result).toEqual({ ok: false, status: 415, message: "unsupported media type" });
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
