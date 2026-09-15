import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { TwilioParams } from "@tvic/providers";

/** Verified Twilio call identity, bound to a stream token at issue time. */
export interface CallIdentity {
  readonly from: string;
  readonly to: string;
  readonly twilioCallSid?: string;
  readonly accountSid?: string;
  /** Internal key used to mark the initial TwiML token consumed. */
  readonly replayKey?: string;
}

export interface IssuedStreamToken {
  readonly callId: string;
  readonly token: string;
  readonly expMs: number;
}

export interface StreamTokenStore {
  issue(identity: CallIdentity): IssuedStreamToken;
  /** Returns the bound identity if the token is valid and unused, else null. */
  consume(callId: string, token: string | null, exp: string | null): CallIdentity | null;
  prune(): void;
}

export type TwimlReplayAcquire =
  | {
      readonly kind: "owner";
      readonly complete: (response: string) => Promise<void>;
      readonly abort: () => Promise<void>;
    }
  | { readonly kind: "replayed"; readonly response: string }
  | { readonly kind: "consumed" }
  | { readonly kind: "conflict" }
  | { readonly kind: "busy" };

/**
 * Atomic replay boundary for a TwiML webhook.
 *
 * The store reserves a request key before the caller creates a stream token.
 * That ordering matters: two concurrent deliveries must not both allocate
 * call state. A replay returns the original response, while a different body
 * for the same key is rejected as a conflict.
 */
export interface TwimlReplayStore {
  /** `shared` is required by the production gateway; `process` is for dev/tests. */
  readonly scope: "process" | "shared";
  acquire(key: string, requestHash: string, ttlMs: number): Promise<TwimlReplayAcquire>;
  /** Marks the stored response unusable after its single-use stream token is consumed. */
  markConsumed(key: string): Promise<void>;
  prune(): void;
}

interface MemoryReplayEntry {
  readonly key: string;
  readonly requestHash: string;
  readonly owner: string;
  readonly expiresAtMs: number;
  response?: string;
  consumed?: boolean;
  resolve: (response: string | null) => void;
  readonly ready: Promise<string | null>;
}

const REPLAY_WAIT_MS = 5_000;

/**
 * A deterministic single-process replay store for local development and tests.
 * Multi-instance production deployments must inject a store with `scope:
 * "shared"`, such as `createRedisTwimlReplayStore` below.
 */
export function createInMemoryTwimlReplayStore(now: () => number = Date.now): TwimlReplayStore {
  const entries = new Map<string, MemoryReplayEntry>();

  const validTtl = (ttlMs: number): number => {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("Twiml replay TTL must be a positive safe integer");
    }
    return ttlMs;
  };

  const waitForResponse = async (entry: MemoryReplayEntry): Promise<string | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        entry.ready,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), REPLAY_WAIT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return {
    scope: "process",
    async acquire(key, requestHash, ttlMs) {
      validTtl(ttlMs);
      const existing = entries.get(key);
      if (existing && now() > existing.expiresAtMs) {
        entries.delete(key);
        existing.resolve(null);
      }
      const current = entries.get(key);
      if (!current) {
        let resolve!: (response: string | null) => void;
        const ready = new Promise<string | null>((promiseResolve) => {
          resolve = promiseResolve;
        });
        const owner = randomUUID();
        const entry: MemoryReplayEntry = {
          key,
          requestHash,
          owner,
          expiresAtMs: now() + ttlMs,
          resolve,
          ready,
        };
        entries.set(key, entry);
        return ownerLease(entries, entry);
      }
      if (current.requestHash !== requestHash) return { kind: "conflict" };
      if (current.consumed) return { kind: "consumed" };
      if (current.response !== undefined) {
        return { kind: "replayed", response: current.response };
      }
      const response = await waitForResponse(current);
      if (response !== null) return { kind: "replayed", response };
      return { kind: "busy" };
    },
    async markConsumed(key) {
      const entry = entries.get(key);
      if (!entry) return;
      if (now() > entry.expiresAtMs) {
        entries.delete(key);
        entry.resolve(null);
        return;
      }
      if (entry.response !== undefined) entry.consumed = true;
    },
    prune() {
      const timestamp = now();
      for (const [key, entry] of entries) {
        if (timestamp > entry.expiresAtMs) {
          entries.delete(key);
          entry.resolve(null);
        }
      }
    },
  };
}

function ownerLease(
  entries: Map<string, MemoryReplayEntry>,
  entry: MemoryReplayEntry,
): Extract<TwimlReplayAcquire, { readonly kind: "owner" }> {
  let settled = false;
  return {
    kind: "owner",
    async complete(response) {
      if (settled) return;
      const current = entries.get(entry.key);
      if (current !== entry) {
        settled = true;
        return;
      }
      settled = true;
      entry.response = response;
      entry.resolve(response);
    },
    async abort() {
      if (settled) return;
      const current = entries.get(entry.key);
      if (current === entry) entries.delete(entry.key);
      settled = true;
      entry.resolve(null);
    },
  };
}

/** Minimal Redis surface needed for an atomic shared replay store. */
export interface TwimlReplayRedisClient {
  get(key: string): Promise<string | null>;
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

const REDIS_RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then return current end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return '__tvic_replay_owner__'
`;

const REDIS_COMPLETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.owner ~= ARGV[1] then return 0 end
local completed = cjson.encode({hash = record.hash, owner = record.owner, status = 'completed', response = ARGV[2]})
redis.call('SET', KEYS[1], completed, 'PX', ARGV[3])
return 1
`;

const REDIS_ABORT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.owner ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

const REDIS_CONSUME_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.status == 'consumed' then return 1 end
if record.status ~= 'completed' then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
local consumed = cjson.encode({hash = record.hash, owner = record.owner, status = 'consumed'})
redis.call('SET', KEYS[1], consumed, 'PX', ttl)
return 1
`;

interface RedisReplayRecord {
  readonly hash: string;
  readonly owner: string;
  readonly status: "pending" | "completed" | "consumed";
  readonly response?: string;
}

function parseRedisReplayRecord(raw: string | null): RedisReplayRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.hash !== "string" ||
      typeof record.owner !== "string" ||
      (record.status !== "pending" && record.status !== "completed" && record.status !== "consumed")
    ) {
      return null;
    }
    return {
      hash: record.hash,
      owner: record.owner,
      status: record.status,
      ...(typeof record.response === "string" ? { response: record.response } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Redis-backed replay protection. Reservation, completion, and abort are all
 * compare-and-set Lua operations, so separate gateway processes cannot both
 * mint a response for one authenticated Twilio request.
 */
export function createRedisTwimlReplayStore(
  client: TwimlReplayRedisClient,
  prefix = "tvic:twiml-replay:",
): TwimlReplayStore {
  const keyFor = (key: string): string => `${prefix}${key}`;
  const validTtl = (ttlMs: number): number => {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("Twiml replay TTL must be a positive safe integer");
    }
    return ttlMs;
  };

  return {
    scope: "shared",
    async acquire(key, requestHash, ttlMs) {
      const ttl = validTtl(ttlMs);
      const redisKey = keyFor(key);
      const owner = randomUUID();
      const pending: RedisReplayRecord = { hash: requestHash, owner, status: "pending" };
      const result = await client.eval(
        REDIS_RESERVE_SCRIPT,
        [redisKey],
        [JSON.stringify(pending), String(ttl)],
      );
      if (result === "__tvic_replay_owner__" || result === 1) {
        return redisOwnerLease(client, redisKey, owner, ttl);
      }

      const current = parseRedisReplayRecord(
        typeof result === "string" ? result : await client.get(redisKey),
      );
      if (!current || current.hash !== requestHash) return { kind: "conflict" };
      if (current.status === "consumed") return { kind: "consumed" };
      if (current.status === "completed" && current.response !== undefined) {
        return { kind: "replayed", response: current.response };
      }
      for (let attempt = 0; attempt < REPLAY_WAIT_MS / 25; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const latest = parseRedisReplayRecord(await client.get(redisKey));
        if (!latest) return { kind: "busy" };
        if (latest.hash !== requestHash) return { kind: "conflict" };
        if (latest.status === "consumed") return { kind: "consumed" };
        if (latest.status === "completed" && latest.response !== undefined) {
          return { kind: "replayed", response: latest.response };
        }
      }
      return { kind: "busy" };
    },
    async markConsumed(key) {
      await client.eval(REDIS_CONSUME_SCRIPT, [keyFor(key)], []);
    },
    prune() {
      // Redis expires replay keys according to their reservation TTL.
    },
  };
}

function redisOwnerLease(
  client: TwimlReplayRedisClient,
  key: string,
  owner: string,
  ttlMs: number,
): Extract<TwimlReplayAcquire, { readonly kind: "owner" }> {
  let settled = false;
  return {
    kind: "owner",
    async complete(response) {
      if (settled) return;
      const result = await client.eval(
        REDIS_COMPLETE_SCRIPT,
        [key],
        [owner, response, String(ttlMs)],
      );
      if (result !== 1 && result !== "1") {
        throw new Error("TwiML replay reservation was lost before completion");
      }
      settled = true;
    },
    async abort() {
      if (settled) return;
      settled = true;
      await client.eval(REDIS_ABORT_SCRIPT, [key], [owner]);
    },
  };
}

/**
 * Single-use, TTL-bounded HMAC stream tokens. A token is minted per TwiML request
 * and consumed exactly once when the media WebSocket connects.
 */
export function createStreamTokenStore(
  secret: string,
  ttlMs: number,
  now: () => number = Date.now,
): StreamTokenStore {
  const issued = new Map<string, { readonly expMs: number; readonly identity: CallIdentity }>();
  const sign = (callId: string, expMs: number): string =>
    createHmac("sha256", secret).update(`${callId}.${expMs}`).digest("hex");

  return {
    issue(identity): IssuedStreamToken {
      const callId = `call_${randomUUID()}`;
      const expMs = now() + ttlMs;
      issued.set(callId, { expMs, identity });
      return { callId, token: sign(callId, expMs), expMs };
    },
    consume(callId, token, exp): CallIdentity | null {
      // Canonical parse: reject anything that isn't a pure integer (e.g. "123abc").
      if (
        typeof token !== "string" ||
        typeof exp !== "string" ||
        !/^\d+$/.test(exp) ||
        !/^[0-9a-fA-F]{64}$/.test(token)
      ) {
        return null;
      }
      const expMs = Number(exp);
      if (!Number.isSafeInteger(expMs) || expMs < 0) return null;
      const entry = issued.get(callId);
      if (!entry || entry.expMs !== expMs || now() > expMs) {
        return null;
      }
      const expectedHex = sign(callId, expMs);
      const provided = Buffer.from(token, "hex");
      const expected = Buffer.from(expectedHex, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return null;
      }
      issued.delete(callId); // single use
      return entry.identity;
    },
    prune(): void {
      const t = now();
      for (const [callId, entry] of issued) {
        if (t > entry.expMs) {
          issued.delete(callId);
        }
      }
    },
  };
}

export type ReadFormBodyResult =
  | { readonly ok: true; readonly params: TwilioParams }
  | { readonly ok: false; readonly status: number; readonly message: string };

/**
 * Reads a form-encoded POST body with hard limits applied BEFORE buffering, so an
 * unauthenticated public endpoint cannot be used for a memory-exhaustion DoS.
 */
export async function readFormBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<ReadFormBodyResult> {
  if ((request.method ?? "GET").toUpperCase() !== "POST") {
    return { ok: false, status: 405, message: "method not allowed" };
  }
  const contentType = String(request.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return { ok: false, status: 415, message: "unsupported media type" };
  }
  const lengthHeader = request.headers["content-length"];
  const declared = lengthHeader
    ? Number.parseInt(Array.isArray(lengthHeader) ? (lengthHeader[0] ?? "") : lengthHeader, 10)
    : undefined;
  if (declared !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, message: "payload too large" };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      request.destroy();
      return { ok: false, status: 413, message: "payload too large" };
    }
    chunks.push(buffer);
  }

  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    const previous = params[key];
    if (previous === undefined) {
      params[key] = value;
    } else if (typeof previous === "string") {
      params[key] = [previous, value];
    } else {
      previous.push(value);
    }
  }
  return { ok: true, params };
}
