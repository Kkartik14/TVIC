import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createAppUserToken,
  createVoiceSessionStore,
  originAllowed,
  verifyAppUserToken,
} from "../src/security.js";

describe("voice session security", () => {
  it("uses single-use, TTL-bounded tokens", () => {
    let now = 1_000;
    const store = createStore(() => now);
    const result = store.reserve("user-1", "push_to_talk");
    if (!result.ok) throw new Error("reservation failed");
    const { identity, token, expMs } = result.issued;

    expect(store.consume(identity.sessionRef, token, String(expMs))).toEqual(identity);
    expect(store.consume(identity.sessionRef, token, String(expMs))).toBeNull();

    const expired = store.reserve("user-2", "continuous");
    if (!expired.ok) throw new Error("reservation failed");
    now = expired.issued.expMs + 1;
    expect(
      store.consume(
        expired.issued.identity.sessionRef,
        expired.issued.token,
        String(expired.issued.expMs),
      ),
    ).toBeNull();
  });

  it("binds a valid token to its exact session reference", () => {
    const store = createStore(Date.now);
    const issued = store.reserve("user-1", "continuous");
    if (!issued.ok) throw new Error("reservation failed");
    expect(
      store.consume("voice_wrong", issued.issued.token, String(issued.issued.expMs)),
    ).toBeNull();
  });

  it("reserves slots at mint time and atomically supersedes only the same user", () => {
    const store = createStore(Date.now);
    const first = store.reserve("user-1", "continuous");
    if (!first.ok) throw new Error("reservation failed");
    expect(store.reserve("user-1", "continuous")).toEqual({ ok: false, reason: "cap_exceeded" });
    expect(store.reserve("user-2", "continuous", first.issued.identity.sessionRef)).toEqual({
      ok: false,
      reason: "invalid_supersedes",
    });
    const replacement = store.reserve("user-1", "continuous", first.issued.identity.sessionRef);
    expect(replacement.ok).toBe(true);
    expect(
      store.consume(
        first.issued.identity.sessionRef,
        first.issued.token,
        String(first.issued.expMs),
      ),
    ).toBeNull();
  });

  it("keeps a consumed slot active beyond token expiry until session expiry or release", () => {
    let now = 1_000;
    const store = createVoiceSessionStore({
      tokenSecret: "token-secret",
      safetyIdentifierSecret: "safety-secret",
      ttlMs: 100,
      maxSessionDurationMs: 1_000,
      now: () => now,
    });
    const issued = store.reserve("user-1", "continuous");
    if (!issued.ok) throw new Error("reservation failed");
    expect(
      store.consume(
        issued.issued.identity.sessionRef,
        issued.issued.token,
        String(issued.issued.expMs),
      ),
    ).not.toBeNull();
    now = issued.issued.expMs + 1;
    store.prune();
    expect(store.reserve("user-1", "continuous")).toEqual({
      ok: false,
      reason: "cap_exceeded",
    });
    store.release(issued.issued.identity.sessionRef);
    expect(store.reserve("user-1", "continuous").ok).toBe(true);
  });

  it("lazily reclaims expired unconsumed slots", () => {
    let now = 1_000;
    const store = createStore(() => now);
    const first = store.reserve("user-1", "continuous");
    if (!first.ok) throw new Error("reservation failed");
    expect(store.reserve("user-1", "continuous").ok).toBe(false);
    now = first.issued.expMs + 1;
    expect(store.reserve("user-1", "continuous").ok).toBe(true);
  });

  it("supports configured caps above one", () => {
    const store = createVoiceSessionStore({
      tokenSecret: "token-secret",
      safetyIdentifierSecret: "safety-secret",
      ttlMs: 1_000,
      concurrentSessionCap: 2,
    });
    expect(store.reserve("user-1", "continuous").ok).toBe(true);
    expect(store.reserve("user-1", "continuous").ok).toBe(true);
    expect(store.reserve("user-1", "continuous")).toEqual({
      ok: false,
      reason: "cap_exceeded",
    });
  });

  it("allows only one racing supersede request to claim the old slot", async () => {
    const store = createStore(Date.now);
    const first = store.reserve("user-1", "continuous");
    if (!first.ok) throw new Error("reservation failed");
    const attempts = await Promise.all(
      [1, 2].map(async () =>
        store.reserve("user-1", "continuous", first.issued.identity.sessionRef),
      ),
    );
    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok)).toEqual([
      { ok: false, reason: "invalid_supersedes" },
    ]);
  });

  it("derives stable vendor safety identifiers with a separate secret", () => {
    const first = createStore(Date.now).reserve("user-1", "continuous");
    const second = createStore(Date.now).reserve("user-1", "continuous");
    if (!first.ok || !second.ok) throw new Error("reservation failed");
    expect(first.issued.identity.safetyIdentifier).toBe(second.issued.identity.safetyIdentifier);
    expect(first.issued.identity.safetyIdentifier).not.toContain("user-1");
    expect(first.issued.identity.safetyIdentifier).toBe(
      createHmac("sha256", "safety-secret").update("user-1").digest("hex"),
    );
    const other = createStore(Date.now).reserve("user-2", "continuous");
    if (!other.ok) throw new Error("reservation failed");
    expect(other.issued.identity.safetyIdentifier).not.toBe(first.issued.identity.safetyIdentifier);
    expect(first.issued.identity.memoryUserId).toBe("user-1");
  });

  it("enforces exact-match origins while allowing non-browser clients", () => {
    expect(originAllowed("https://app.example", ["https://app.example"])).toBe(true);
    expect(originAllowed("https://evil.example", ["https://app.example"])).toBe(false);
    expect(originAllowed(undefined, ["https://app.example"])).toBe(true);
  });

  it("binds app authentication to the signed user identity", () => {
    const token = createAppUserToken("user-1", "app-secret");
    expect(verifyAppUserToken(token, "app-secret")).toBe("user-1");
    expect(verifyAppUserToken(token, "wrong-secret")).toBeNull();
    expect(verifyAppUserToken(`${token}00`, "app-secret")).toBeNull();
  });
});

function createStore(now: () => number) {
  return createVoiceSessionStore({
    tokenSecret: "token-secret",
    safetyIdentifierSecret: "safety-secret",
    ttlMs: 1_000,
    concurrentSessionCap: 1,
    now,
  });
}
