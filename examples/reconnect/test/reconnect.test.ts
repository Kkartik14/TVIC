import { describe, expect, it } from "vitest";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The example's TokenStore uses HMAC-SHA256 with timingSafeEqual. This
 * test exercises the same crypto primitives to assert the verify path
 * is robust to tampering.
 */
class TestTokenStore {
  private readonly secret: string;
  private readonly tokens = new Map<
    string,
    { userId: string; sessionId: string; expiresAtMs: number }
  >();

  constructor(secret: string) {
    this.secret = secret;
  }

  mint(userId: string, sessionId: string, ttlMs: number): string {
    const expiresAtMs = Date.now() + ttlMs;
    const payload = `${userId}:${sessionId}:${expiresAtMs}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("hex");
    const token = `${Buffer.from(payload).toString("base64url")}.${signature}`;
    this.tokens.set(token, { userId, sessionId, expiresAtMs });
    return token;
  }

  verify(token: string): { userId: string; sessionId: string } | null {
    const dotIndex = token.indexOf(".");
    if (dotIndex < 0) return null;
    const encodedPayload = token.slice(0, dotIndex);
    const providedSignatureHex = token.slice(dotIndex + 1);
    if (providedSignatureHex.length !== 64) return null;
    const payload = Buffer.from(encodedPayload, "base64url").toString();
    const expectedSignature = createHmac("sha256", this.secret).update(payload).digest();
    const providedSignature = Buffer.from(providedSignatureHex, "hex");
    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      return null;
    }
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) return null;
    return { userId: entry.userId, sessionId: entry.sessionId };
  }
}

describe("reconnect token store", () => {
  it("accepts a freshly-minted token", () => {
    const store = new TestTokenStore("test-secret");
    const token = store.mint("user-1", "session-1", 60_000);
    const verified = store.verify(token);
    expect(verified).toEqual({ userId: "user-1", sessionId: "session-1" });
  });

  it("rejects a token with a tampered signature", () => {
    const store = new TestTokenStore("test-secret");
    const token = store.mint("user-1", "session-1", 60_000);
    const tampered = token.replace(/[0-9a-f]$/, (c) => (c === "0" ? "1" : "0"));
    const verified = store.verify(tampered);
    expect(verified).toBeNull();
  });

  it("rejects an expired token", () => {
    const store = new TestTokenStore("test-secret");
    const token = store.mint("user-1", "session-1", -1);
    const verified = store.verify(token);
    expect(verified).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const a = new TestTokenStore("secret-a");
    const b = new TestTokenStore("secret-b");
    const token = a.mint("user-1", "session-1", 60_000);
    const verified = b.verify(token);
    expect(verified).toBeNull();
  });

  it("rejects a malformed token (no separator)", () => {
    const store = new TestTokenStore("test-secret");
    expect(store.verify("not-a-valid-token")).toBeNull();
  });
});
