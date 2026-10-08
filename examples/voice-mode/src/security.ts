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
  | {
      readonly ok: false;
      readonly reason: "cap_exceeded" | "invalid_supersedes" | "session_store_capacity";
    };

export interface VoiceSessionStore {
  reserve(userId: string, mode: VoiceMode, supersedes?: string): ReserveVoiceSessionResult;
  consume(
    sessionRef: string,
    token: string | null,
    exp: string | null,
  ): VoiceSessionIdentity | null;
  commitSupersede(sessionRef: string): void;
  rollbackSupersede(sessionRef: string): void;
  release(sessionRef: string): void;
  /** Prunes a bounded portion of the session store; reserve also reclaims the caller's expired slots. */
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
  readonly maxTrackedSessions?: number;
  readonly maxSessionDurationMs?: number;
  readonly now?: () => number;
}): VoiceSessionStore {
  const MAX_CONCURRENT_SESSION_CAP = 20;
  const DEFAULT_MAX_TRACKED_SESSIONS = 10_000;
  const MAX_TRACKED_SESSIONS_LIMIT = 100_000;
  const EXPIRY_PRUNE_BUDGET = 64;
  const now = options.now ?? Date.now;
  const cap = options.concurrentSessionCap ?? 1;
  const maxTrackedSessions = options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_CONCURRENT_SESSION_CAP) {
    throw new RangeError(
      `concurrentSessionCap must be between 1 and ${MAX_CONCURRENT_SESSION_CAP}`,
    );
  }
  if (
    !Number.isSafeInteger(maxTrackedSessions) ||
    maxTrackedSessions < 1 ||
    maxTrackedSessions > MAX_TRACKED_SESSIONS_LIMIT
  ) {
    throw new RangeError(`maxTrackedSessions must be between 1 and ${MAX_TRACKED_SESSIONS_LIMIT}`);
  }
  const slots = new Map<string, VoiceSessionSlot>();
  const slotsByUser = new Map<string, Set<string>>();
  const pendingSupersedes = new Map<
    string,
    { readonly priorSessionRef: string; readonly prior: VoiceSessionSlot }
  >();
  const replacementByPrior = new Map<string, string>();
  let expiryCursor = slots.keys();
  const sign = (sessionRef: string, expMs: number): string =>
    createHmac("sha256", options.tokenSecret).update(`${sessionRef}.${expMs}`).digest("hex");

  const clearPending = (sessionRef: string): void => {
    const pending = pendingSupersedes.get(sessionRef);
    if (pending) {
      pendingSupersedes.delete(sessionRef);
      replacementByPrior.delete(pending.priorSessionRef);
    }
    const replacement = replacementByPrior.get(sessionRef);
    if (replacement) {
      replacementByPrior.delete(sessionRef);
      pendingSupersedes.delete(replacement);
    }
  };

  const removeSlot = (sessionRef: string): void => {
    const slot = slots.get(sessionRef);
    if (slot) {
      slots.delete(sessionRef);
      const userSlots = slotsByUser.get(slot.identity.userId);
      userSlots?.delete(sessionRef);
      if (userSlots?.size === 0) slotsByUser.delete(slot.identity.userId);
    }
    clearPending(sessionRef);
  };

  const addSlot = (slot: VoiceSessionSlot): void => {
    const sessionRef = slot.identity.sessionRef;
    slots.set(sessionRef, slot);
    let userSlots = slotsByUser.get(slot.identity.userId);
    if (!userSlots) {
      userSlots = new Set();
      slotsByUser.set(slot.identity.userId, userSlots);
    }
    userSlots.add(sessionRef);
  };

  const pruneUser = (userId: string, time: number): void => {
    const userSlots = slotsByUser.get(userId);
    if (!userSlots) return;
    for (const sessionRef of userSlots) {
      const slot = slots.get(sessionRef);
      if (!slot || time >= slot.slotExpMs) removeSlot(sessionRef);
    }
  };

  const pruneSome = (time: number): void => {
    let inspected = 0;
    while (slots.size > 0 && inspected < EXPIRY_PRUNE_BUDGET) {
      const next = expiryCursor.next();
      if (next.done) {
        expiryCursor = slots.keys();
        continue;
      }
      inspected += 1;
      const slot = slots.get(next.value);
      if (slot && time >= slot.slotExpMs) removeSlot(next.value);
    }
  };

  const prune = (): void => {
    pruneSome(now());
  };

  return {
    reserve(userId, mode, supersedes) {
      const time = now();
      pruneUser(userId, time);
      pruneSome(time);
      const prior = supersedes ? slots.get(supersedes) : undefined;
      if (supersedes) {
        if (!prior || prior.identity.userId !== userId || pendingSupersedes.has(supersedes))
          return { ok: false, reason: "invalid_supersedes" };
      }
      const active = (slotsByUser.get(userId)?.size ?? 0) - (supersedes ? 1 : 0);
      if (active >= cap) return { ok: false, reason: "cap_exceeded" };
      if (slots.size - (supersedes ? 1 : 0) >= maxTrackedSessions) {
        return { ok: false, reason: "session_store_capacity" };
      }
      if (supersedes) removeSlot(supersedes);
      const sessionRef = `voice_${randomUUID()}`;
      const expMs = time + options.ttlMs;
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
      const slot = {
        identity,
        tokenExpMs: expMs,
        // If the replacement request stalls past its token TTL, keep its
        // capacity reservation through the old live call's known expiry.
        slotExpMs: Math.max(expMs, prior?.slotExpMs ?? expMs),
        token,
      };
      addSlot(slot);
      if (supersedes && prior) {
        pendingSupersedes.set(sessionRef, { priorSessionRef: supersedes, prior });
        replacementByPrior.set(supersedes, sessionRef);
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
      const consumedAt = now();
      if (!slot || !slot.token || slot.tokenExpMs !== expMs || consumedAt >= expMs) return null;
      // The token is single-use while its reserved/active slot remains until release.
      addSlot({
        ...slot,
        token: "",
        slotExpMs: consumedAt + (options.maxSessionDurationMs ?? 45 * 60_000),
      });
      return slot.identity;
    },
    commitSupersede(sessionRef) {
      const pending = pendingSupersedes.get(sessionRef);
      if (pending) {
        pendingSupersedes.delete(sessionRef);
        replacementByPrior.delete(pending.priorSessionRef);
        const replacement = slots.get(sessionRef);
        if (replacement?.token) {
          addSlot({ ...replacement, slotExpMs: replacement.tokenExpMs });
        }
        return;
      }
      clearPending(sessionRef);
    },
    rollbackSupersede(sessionRef) {
      const pending = pendingSupersedes.get(sessionRef);
      removeSlot(sessionRef);
      if (!pending || now() >= pending.prior.slotExpMs || slots.has(pending.priorSessionRef))
        return;
      addSlot(pending.prior);
    },
    release(sessionRef) {
      removeSlot(sessionRef);
    },
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
