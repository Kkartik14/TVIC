import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { UserId } from "voice-runtime";

export type VoiceMode = "push_to_talk" | "continuous";

export interface VoiceSessionIdentity {
  readonly sessionRef: string;
  readonly userId: string;
  readonly memoryUserId: UserId;
  readonly safetyIdentifier: string;
  readonly mode: VoiceMode;
}

export interface IssuedVoiceToken {
  readonly identity: VoiceSessionIdentity;
  readonly token: string;
  readonly expMs: number;
}

export type ReserveVoiceSessionResult =
  | { readonly ok: true; readonly issued: IssuedVoiceToken }
  | { readonly ok: false; readonly reason: "cap_exceeded" | "invalid_supersedes" };

export interface VoiceSessionStore {
  canSupersede(userId: string, sessionRef: string): boolean;
  reserve(userId: string, mode: VoiceMode, supersedes?: string): ReserveVoiceSessionResult;
  consume(
    sessionRef: string,
    token: string | null,
    exp: string | null,
  ): VoiceSessionIdentity | null;
  /** Finalizes a replacement after the old live session was terminated. */
  commitSupersede(sessionRef: string): void;
  /** Restores the old reservation if terminating it failed. */
  rollbackSupersede(sessionRef: string): void;
  release(sessionRef: string): void;
  prune(): void;
}

interface VoiceSessionSlot {
  readonly identity: VoiceSessionIdentity;
  readonly tokenExpMs: number;
  readonly slotExpMs: number;
  readonly token: string;
}

export function createVoiceSessionStore(options: {
  readonly tokenSecret: string;
  readonly safetyIdentifierSecret: string;
  readonly ttlMs: number;
  readonly concurrentSessionCap?: number;
  readonly maxSessionDurationMs?: number;
  readonly now?: () => number;
}): VoiceSessionStore {
  const now = options.now ?? Date.now;
  const cap = options.concurrentSessionCap ?? 1;
  const slots = new Map<string, VoiceSessionSlot>();
  const pendingSupersedes = new Map<
    string,
    { readonly priorSessionRef: string; readonly prior: VoiceSessionSlot }
  >();
  const sign = (sessionRef: string, expMs: number): string =>
    createHmac("sha256", options.tokenSecret).update(`${sessionRef}.${expMs}`).digest("hex");

  const release = (sessionRef: string): void => {
    slots.delete(sessionRef);
    pendingSupersedes.delete(sessionRef);
    for (const [replacement, pending] of pendingSupersedes) {
      if (pending.priorSessionRef === sessionRef) pendingSupersedes.delete(replacement);
    }
  };
  const prune = (): void => {
    const time = now();
    for (const [sessionRef, slot] of slots) if (time > slot.slotExpMs) slots.delete(sessionRef);
    for (const [replacement] of pendingSupersedes) {
      if (!slots.has(replacement)) pendingSupersedes.delete(replacement);
    }
  };

  return {
    canSupersede(userId, sessionRef) {
      prune();
      const prior = slots.get(sessionRef);
      return prior?.identity.userId === userId;
    },
    reserve(userId, mode, supersedes) {
      prune();
      const prior = supersedes ? slots.get(supersedes) : undefined;
      if (supersedes) {
        if (!prior || prior.identity.userId !== userId)
          return { ok: false, reason: "invalid_supersedes" };
      }
      const active = [...slots.entries()].filter(
        ([sessionRef, slot]) => sessionRef !== supersedes && slot.identity.userId === userId,
      ).length;
      if (active >= cap) return { ok: false, reason: "cap_exceeded" };
      if (supersedes) slots.delete(supersedes);
      const sessionRef = `voice_${randomUUID()}`;
      const expMs = now() + options.ttlMs;
      const identity: VoiceSessionIdentity = {
        sessionRef,
        userId,
        memoryUserId: userId as UserId,
        safetyIdentifier: createHmac("sha256", options.safetyIdentifierSecret)
          .update(userId)
          .digest("hex"),
        mode,
      };
      const token = sign(sessionRef, expMs);
      const slot = { identity, tokenExpMs: expMs, slotExpMs: expMs, token };
      slots.set(sessionRef, slot);
      if (supersedes && prior) {
        pendingSupersedes.set(sessionRef, { priorSessionRef: supersedes, prior });
      }
      return { ok: true, issued: { identity, token, expMs } };
    },
    consume(sessionRef, token, exp) {
      if (typeof token !== "string" || typeof exp !== "string" || !/^\d+$/.test(exp)) return null;
      if (!/^[0-9a-fA-F]{64}$/.test(token)) return null;
      const expMs = Number(exp);
      if (!Number.isSafeInteger(expMs) || expMs < 0) return null;
      const slot = slots.get(sessionRef);
      const expected = Buffer.from(sign(sessionRef, expMs), "hex");
      const provided = Buffer.from(token, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
      if (!slot || !slot.token || slot.tokenExpMs !== expMs || now() > expMs) return null;
      // The token is single-use while its reserved/active slot remains until release.
      slots.set(sessionRef, {
        ...slot,
        token: "",
        slotExpMs: now() + (options.maxSessionDurationMs ?? 45 * 60_000),
      });
      return slot.identity;
    },
    commitSupersede(sessionRef) {
      pendingSupersedes.delete(sessionRef);
    },
    rollbackSupersede(sessionRef) {
      const pending = pendingSupersedes.get(sessionRef);
      pendingSupersedes.delete(sessionRef);
      slots.delete(sessionRef);
      if (!pending || now() > pending.prior.slotExpMs || slots.has(pending.priorSessionRef)) return;
      slots.set(pending.priorSessionRef, pending.prior);
    },
    release,
    prune,
  };
}

export function originAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

export function constantTimeStringEqual(left: string | null, right: string): boolean {
  if (left === null) return false;
  const provided = Buffer.from(left, "utf8");
  const expected = Buffer.from(right, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Minimal example app-auth token; production roots may replace this with their IdP verifier. */
export function createAppUserToken(userId: string, secret: string): string {
  const subject = Buffer.from(userId, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(subject).digest("hex");
  return `${subject}.${signature}`;
}

export function verifyAppUserToken(token: string | null, secret: string): string | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const subject = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return null;
  const provided = Buffer.from(signature, "hex");
  const expected = Buffer.from(createHmac("sha256", secret).update(subject).digest("hex"), "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const userId = Buffer.from(subject, "base64url").toString("utf8");
    return userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
}
