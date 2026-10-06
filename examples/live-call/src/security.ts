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

export interface StreamTokenReservation {
  readonly callId: string;
  readonly reservationId: string;
  readonly identity: CallIdentity;
}

export interface StreamTokenStore {
  issue(identity: CallIdentity): IssuedStreamToken;
  /** Validates and reserves a token until the WebSocket handshake commits or aborts. */
  reserve(callId: string, token: string | null, exp: string | null): StreamTokenReservation | null;
  /** Consumes an authorization reservation after the WebSocket handshake succeeds. */
  commit(reservation: StreamTokenReservation): CallIdentity | null;
  /** Restores a reserved token if the WebSocket handshake aborts before it succeeds. */
  restore(reservation: StreamTokenReservation): void;
  /** Removes a token when its TwiML response was never delivered. */
  release(callId: string): void;
  prune(): void;
}

export type TwimlReplayAcquire =
  | {
      readonly kind: "owner";
      readonly complete: (response: string) => Promise<void>;
      /** Deletes a reservation only while it is pending; completed replays remain available. */
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
  /** Stops a duplicate wait or storage polling when the HTTP request is cancelled. */
  acquire(
    key: string,
    requestHash: string,
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<TwimlReplayAcquire>;
  /** Marks the stored response unusable after its single-use stream token is consumed. */
  markConsumed(key: string): Promise<void>;
  prune(): void;
}

interface MemoryReplayEntry {
  readonly key: string;
  readonly requestHash: string;
  readonly owner: string;
  expiresAtMs: number;
  response?: string;
  consumed?: boolean;
  resolve: (response: string | null) => void;
  readonly ready: Promise<string | null>;
}

const REPLAY_WAIT_MS = 5_000;
const REDIS_COMMAND_TIMEOUT_MS = 1_000;
const REDIS_CLEANUP_TIMEOUT_MS = 250;

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

  const waitForResponse = async (
    entry: MemoryReplayEntry,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        entry.ready,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), REPLAY_WAIT_MS);
        }),
        new Promise<null>((resolve) => {
          if (!signal) return;
          if (signal.aborted) {
            resolve(null);
            return;
          }
          onAbort = () => resolve(null);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    scope: "process",
    async acquire(key, requestHash, ttlMs, signal) {
      if (signal?.aborted) return { kind: "busy" };
      validTtl(ttlMs);
      const existing = entries.get(key);
      if (existing && now() >= existing.expiresAtMs) {
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
        return ownerLease(entries, entry, now, ttlMs);
      }
      if (current.requestHash !== requestHash) return { kind: "conflict" };
      if (current.consumed) return { kind: "consumed" };
      if (current.response !== undefined) {
        return { kind: "replayed", response: current.response };
      }
      const response = await waitForResponse(current, signal);
      if (signal?.aborted) return { kind: "busy" };
      if (response !== null) return { kind: "replayed", response };
      return { kind: "busy" };
    },
    async markConsumed(key) {
      const entry = entries.get(key);
      if (!entry) throw new Error(REPLAY_STATE_UNAVAILABLE);
      if (now() >= entry.expiresAtMs) {
        entries.delete(key);
        entry.resolve(null);
        throw new Error(REPLAY_STATE_UNAVAILABLE);
      }
      if (entry.response === undefined) throw new Error(REPLAY_STATE_UNAVAILABLE);
      entry.consumed = true;
    },
    prune() {
      const timestamp = now();
      for (const [key, entry] of entries) {
        if (timestamp >= entry.expiresAtMs) {
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
  now: () => number,
  ttlMs: number,
): Extract<TwimlReplayAcquire, { readonly kind: "owner" }> {
  let settled = false;
  return {
    kind: "owner",
    async complete(response) {
      if (settled) return;
      const current = entries.get(entry.key);
      const completedAtMs = now();
      if (current !== entry || completedAtMs >= entry.expiresAtMs) {
        if (current === entry) entries.delete(entry.key);
        settled = true;
        entry.resolve(null);
        throw new Error(REPLAY_RESERVATION_LOST);
      }
      settled = true;
      entry.expiresAtMs = completedAtMs + ttlMs;
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
  /** Adapters should pass the signal to the client's command queue when supported. */
  get(key: string, signal?: AbortSignal): Promise<string | null>;
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface RedisTwimlReplayStoreOptions {
  /**
   * Per-command bound. Acquisition uses a 5-second deadline, with up to 250 ms
   * of best-effort cleanup if reservation outcome is ambiguous.
   */
  readonly commandTimeoutMs?: number;
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
if record.status == 'completed' then
  if record.response ~= ARGV[2] then return 0 end
  return 1
end
if record.status ~= 'pending' then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
local completed = cjson.encode({hash = record.hash, owner = record.owner, status = 'completed', response = ARGV[2]})
redis.call('SET', KEYS[1], completed, 'PX', ARGV[3])
return 1
`;

const REDIS_ABORT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local record = cjson.decode(current)
if record.owner ~= ARGV[1] or record.status ~= 'pending' then return 0 end
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

const REPLAY_STATE_UNAVAILABLE = "TwiML replay state is unavailable before consumption";
const REPLAY_RESERVATION_LOST = "TwiML replay reservation was lost before completion";

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
  options: RedisTwimlReplayStoreOptions = {},
): TwimlReplayStore {
  const commandTimeoutMs = options.commandTimeoutMs ?? REDIS_COMMAND_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(commandTimeoutMs) ||
    commandTimeoutMs < 1 ||
    commandTimeoutMs > REPLAY_WAIT_MS
  ) {
    throw new RangeError(`commandTimeoutMs must be an integer from 1 to ${REPLAY_WAIT_MS}`);
  }
  const keyFor = (key: string): string => `${prefix}${key}`;
  const validTtl = (ttlMs: number): number => {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("Twiml replay TTL must be a positive safe integer");
    }
    return ttlMs;
  };

  return {
    scope: "shared",
    async acquire(key, requestHash, ttlMs, signal) {
      if (signal?.aborted) return { kind: "busy" };
      const ttl = validTtl(ttlMs);
      const redisKey = keyFor(key);
      const owner = randomUUID();
      const pending: RedisReplayRecord = { hash: requestHash, owner, status: "pending" };
      const deadline = Date.now() + REPLAY_WAIT_MS;
      const remainingCommandBudget = (): number =>
        Math.max(1, Math.min(commandTimeoutMs, deadline - Date.now()));
      let result: unknown;
      try {
        result = await runRedisCommand(
          (operationSignal) =>
            client.eval(
              REDIS_RESERVE_SCRIPT,
              [redisKey],
              [JSON.stringify(pending), String(ttl)],
              operationSignal,
            ),
          signal,
          remainingCommandBudget(),
        );
      } catch (error) {
        await abortRedisReservation(client, redisKey, owner);
        if (!isAbortOrTimeout(error, signal)) throw error;
        return { kind: "busy" };
      }

      const ownsReservation = result === "__tvic_replay_owner__" || result === 1;
      if (signal?.aborted) {
        if (ownsReservation) await abortRedisReservation(client, redisKey, owner);
        return { kind: "busy" };
      }
      if (ownsReservation) return redisOwnerLease(client, redisKey, owner, ttl, commandTimeoutMs);

      let raw = typeof result === "string" ? result : null;
      if (raw === null) {
        try {
          raw = await runRedisCommand(
            (operationSignal) => client.get(redisKey, operationSignal),
            signal,
            remainingCommandBudget(),
          );
        } catch (error) {
          if (isAbortOrTimeout(error, signal)) return { kind: "busy" };
          throw error;
        }
      }
      if (signal?.aborted) return { kind: "busy" };
      const current = parseRedisReplayRecord(raw);
      if (!current || current.hash !== requestHash) return { kind: "conflict" };
      if (current.status === "consumed") return { kind: "consumed" };
      if (current.status === "completed" && current.response !== undefined) {
        return { kind: "replayed", response: current.response };
      }
      while (Date.now() < deadline) {
        await waitForDelay(Math.min(25, deadline - Date.now()), signal);
        if (signal?.aborted) return { kind: "busy" };
        let latestRaw: string | null;
        try {
          latestRaw = await runRedisCommand(
            (operationSignal) => client.get(redisKey, operationSignal),
            signal,
            remainingCommandBudget(),
          );
        } catch (error) {
          if (isAbortOrTimeout(error, signal)) return { kind: "busy" };
          throw error;
        }
        if (signal?.aborted) return { kind: "busy" };
        const latest = parseRedisReplayRecord(latestRaw);
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
      const result = await runRedisCommand(
        (signal) => client.eval(REDIS_CONSUME_SCRIPT, [keyFor(key)], [], signal),
        undefined,
        commandTimeoutMs,
      );
      if (result !== 1 && result !== "1") {
        throw new Error(REPLAY_STATE_UNAVAILABLE);
      }
    },
    prune() {
      // Pending reservations expire from acquisition; completed replay expires from publication.
    },
  };
}

function redisOwnerLease(
  client: TwimlReplayRedisClient,
  key: string,
  owner: string,
  ttlMs: number,
  commandTimeoutMs: number,
): Extract<TwimlReplayAcquire, { readonly kind: "owner" }> {
  let settled = false;
  return {
    kind: "owner",
    async complete(response) {
      if (settled) return;
      const result = await runRedisCommand(
        (signal) =>
          client.eval(REDIS_COMPLETE_SCRIPT, [key], [owner, response, String(ttlMs)], signal),
        undefined,
        commandTimeoutMs,
      );
      if (result !== 1 && result !== "1") {
        throw new Error(REPLAY_RESERVATION_LOST);
      }
      settled = true;
    },
    async abort() {
      if (settled) return;
      settled = true;
      await abortRedisReservation(client, key, owner, commandTimeoutMs);
    },
  };
}

function runRedisCommand<T>(
  command: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(() => {
    const error = new Error("Redis replay command timed out");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(controller.signal.reason);
      return;
    }
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  let operation: Promise<T>;
  try {
    operation = command(controller.signal);
  } catch (error) {
    operation = Promise.reject(error);
  }
  return Promise.race([operation, aborted]).finally(() => {
    clearTimeout(timeout);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    parentSignal?.removeEventListener("abort", onParentAbort);
  });
}

async function abortRedisReservation(
  client: TwimlReplayRedisClient,
  key: string,
  owner: string,
  timeoutMs = REDIS_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  await runRedisCommand(
    (signal) => client.eval(REDIS_ABORT_SCRIPT, [key], [owner], signal),
    undefined,
    timeoutMs,
  ).catch(() => undefined);
}

function isAbortOrTimeout(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, delayMs);
    if (signal) {
      onAbort = finish;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Single-use, TTL-bounded HMAC stream tokens. The gateway also applies a bounded
 * CallSid replay guard before minting, while this store prevents stream-token reuse.
 */
export function createStreamTokenStore(
  secret: string,
  ttlMs: number,
  now: () => number = Date.now,
): StreamTokenStore {
  const issued = new Map<
    string,
    { readonly expMs: number; readonly identity: CallIdentity; readonly reservationId?: string }
  >();
  const sign = (callId: string, expMs: number): string =>
    createHmac("sha256", secret).update(`${callId}.${expMs}`).digest("hex");

  return {
    issue(identity): IssuedStreamToken {
      const callId = `call_${randomUUID()}`;
      const expMs = now() + ttlMs;
      issued.set(callId, { expMs, identity });
      return { callId, token: sign(callId, expMs), expMs };
    },
    reserve(callId, token, exp): StreamTokenReservation | null {
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
      if (!entry || entry.expMs !== expMs || entry.reservationId || now() >= expMs) {
        return null;
      }
      const expectedHex = sign(callId, expMs);
      const provided = Buffer.from(token, "hex");
      const expected = Buffer.from(expectedHex, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return null;
      }
      const reservationId = randomUUID();
      issued.set(callId, { ...entry, reservationId });
      return { callId, reservationId, identity: entry.identity };
    },
    commit(reservation): CallIdentity | null {
      const entry = issued.get(reservation.callId);
      if (!entry || entry.reservationId !== reservation.reservationId || now() >= entry.expMs) {
        return null;
      }
      issued.delete(reservation.callId);
      return entry.identity;
    },
    restore(reservation): void {
      const entry = issued.get(reservation.callId);
      if (entry?.reservationId !== reservation.reservationId) return;
      if (now() >= entry.expMs) {
        issued.delete(reservation.callId);
        return;
      }
      issued.set(reservation.callId, { expMs: entry.expMs, identity: entry.identity });
    },
    release(callId): void {
      issued.delete(callId);
    },
    prune(): void {
      const t = now();
      for (const [callId, entry] of issued) {
        if (t >= entry.expMs) {
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
  signal?: AbortSignal,
): Promise<ReadFormBodyResult> {
  signal?.throwIfAborted();
  if ((request.method ?? "GET").toUpperCase() !== "POST") {
    return { ok: false, status: 405, message: "method not allowed" };
  }
  const contentType = request.headers["content-type"];
  const mediaType =
    typeof contentType === "string"
      ? contentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
  if (mediaType !== "application/x-www-form-urlencoded") {
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
  const destroyOnAbort = (): void => {
    request.destroy();
  };
  signal?.addEventListener("abort", destroyOnAbort, { once: true });
  try {
    for await (const chunk of request) {
      signal?.throwIfAborted();
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) {
        request.destroy();
        return { ok: false, status: 413, message: "payload too large" };
      }
      chunks.push(buffer);
    }
  } finally {
    signal?.removeEventListener("abort", destroyOnAbort);
  }
  signal?.throwIfAborted();

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
