import { randomUUID } from "node:crypto";

import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisTwimlReplayStore } from "../src/security.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const clientA = createClient({ url: redisUrl });
const clientB = createClient({ url: redisUrl });
const testPrefix = `tvic:test:twiml:${randomUUID()}:`;

beforeAll(async () => {
  if (!process.env.REDIS_URL) return;
  await Promise.all([clientA.connect(), clientB.connect()]);
});

afterAll(async () => {
  if (!process.env.REDIS_URL) return;
  await Promise.all([clientA.quit(), clientB.quit()]);
});

describe("Redis TwiML replay store", () => {
  it("fails closed when replay state is missing at consumption", async () => {
    const store = createRedisTwimlReplayStore({
      async get() {
        return null;
      },
      async eval() {
        return 0;
      },
    });

    await expect(store.markConsumed("missing-key")).rejects.toThrow(
      "TwiML replay state is unavailable before consumption",
    );
  });

  it("cleans up an ambiguous reservation before rethrowing a Redis error", async () => {
    const failure = new Error("Redis connection reset after reserve");
    let reservation: string | null = null;
    let evalCalls = 0;
    const store = createRedisTwimlReplayStore({
      async get() {
        return reservation;
      },
      async eval(_script, _keys, args) {
        evalCalls += 1;
        if (evalCalls === 1) {
          reservation = args[0] ?? null;
          throw failure;
        }
        if (reservation && JSON.parse(reservation).owner === args[0]) reservation = null;
        return 1;
      },
    });

    await expect(store.acquire("ambiguous-key", "request-hash", 10_000)).rejects.toBe(failure);
    expect(reservation).toBeNull();
    expect(evalCalls).toBe(2);
  });

  it("aborts a pending Redis reservation command with the HTTP request", async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    let cleanupCalls = 0;
    let evalCalls = 0;
    const store = createRedisTwimlReplayStore(
      {
        async get() {
          return null;
        },
        async eval(_script, _keys, _args, signal) {
          evalCalls += 1;
          if (evalCalls === 2) {
            cleanupCalls += 1;
            return 1;
          }
          operationSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
      "test:twiml:",
      { commandTimeoutMs: 50 },
    );
    const pending = store.acquire("cancel-key", "request-hash", 10_000, controller.signal);
    controller.abort();
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);

    expect(result).toEqual({ kind: "busy" });
    expect(operationSignal?.aborted).toBe(true);
    expect(cleanupCalls).toBe(1);
  });

  it("stops polling a pending duplicate replay when its request is aborted", async () => {
    const controller = new AbortController();
    const pendingRecord = JSON.stringify({
      hash: "request-hash",
      owner: "existing-owner",
      status: "pending",
    });
    let resolvePollStarted: () => void = () => undefined;
    const pollStarted = new Promise<void>((resolve) => {
      resolvePollStarted = resolve;
    });
    let pollSignal: AbortSignal | undefined;
    const store = createRedisTwimlReplayStore({
      async get(_key, signal) {
        pollSignal = signal;
        resolvePollStarted();
        return new Promise<string | null>((resolve) => {
          signal?.addEventListener("abort", () => resolve(pendingRecord), { once: true });
        });
      },
      async eval() {
        return pendingRecord;
      },
    });
    const pending = store.acquire("waiting-key", "request-hash", 10_000, controller.signal);
    await pollStarted;
    controller.abort();

    await expect(pending).resolves.toEqual({ kind: "busy" });
    expect(pollSignal?.aborted).toBe(true);
  });

  it("bounds a Redis read that does not settle", async () => {
    const pendingRecord = JSON.stringify({
      hash: "request-hash",
      owner: "existing-owner",
      status: "pending",
    });
    const store = createRedisTwimlReplayStore(
      {
        async get() {
          return new Promise<string | null>(() => undefined);
        },
        async eval() {
          return pendingRecord;
        },
      },
      "test:twiml:",
      { commandTimeoutMs: 20 },
    );
    const startedAt = Date.now();

    await expect(store.acquire("timeout-key", "request-hash", 10_000)).resolves.toEqual({
      kind: "busy",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it.skipIf(!process.env.REDIS_URL)(
    "serializes a cross-client retry behind one reservation and replays the response",
    async () => {
      const first = createRedisTwimlReplayStore(clientAdapter(clientA), testPrefix);
      const second = createRedisTwimlReplayStore(clientAdapter(clientB), testPrefix);
      const owner = await first.acquire("call-key", "request-hash", 10_000);
      expect(owner.kind).toBe("owner");
      if (owner.kind !== "owner") return;

      const retry = second.acquire("call-key", "request-hash", 10_000);
      await owner.complete("<Response />");
      await expect(retry).resolves.toEqual({ kind: "replayed", response: "<Response />" });
      await expect(first.acquire("call-key", "request-hash", 10_000)).resolves.toEqual({
        kind: "replayed",
        response: "<Response />",
      });
      await first.markConsumed("call-key");
      await expect(first.acquire("call-key", "request-hash", 10_000)).resolves.toEqual({
        kind: "consumed",
      });
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "fails closed when the Redis replay key is missing at consumption",
    async () => {
      const store = createRedisTwimlReplayStore(clientAdapter(clientA), testPrefix);

      await expect(store.markConsumed(`missing-key:${randomUUID()}`)).rejects.toThrow(
        "TwiML replay state is unavailable before consumption",
      );
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "starts completed replay retention when the response is published",
    async () => {
      const store = createRedisTwimlReplayStore(clientAdapter(clientA), testPrefix);
      const key = `ttl-origin:${randomUUID()}`;
      const ttlMs = 2_000;
      const owner = await store.acquire(key, "request-hash", ttlMs);
      expect(owner.kind).toBe("owner");
      if (owner.kind !== "owner") return;

      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      await owner.complete("<Response />");

      const remainingTtlMs = await clientA.pTTL(`${testPrefix}${key}`);
      expect(remainingTtlMs).toBeGreaterThan(ttlMs - 100);
      expect(remainingTtlMs).toBeLessThanOrEqual(ttlMs);
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "rejects completion after the pending reservation expires",
    async () => {
      const store = createRedisTwimlReplayStore(clientAdapter(clientA), testPrefix);
      const key = `expired-pending:${randomUUID()}`;
      const owner = await store.acquire(key, "request-hash", 50);
      expect(owner.kind).toBe("owner");
      if (owner.kind !== "owner") return;

      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      await expect(owner.complete("<Response />")).rejects.toThrow(
        "TwiML replay reservation was lost before completion",
      );
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "preserves a committed replay when completion acknowledgement is lost",
    async () => {
      let evalCalls = 0;
      const first = createRedisTwimlReplayStore(
        clientAdapter(clientA, async (result) => {
          evalCalls += 1;
          if (evalCalls === 2) throw new Error("simulated lost completion acknowledgement");
          return result;
        }),
        testPrefix,
      );
      const second = createRedisTwimlReplayStore(clientAdapter(clientB), testPrefix);
      const owner = await first.acquire("ambiguous-completion-key", "request-hash", 10_000);
      expect(owner.kind).toBe("owner");
      if (owner.kind !== "owner") return;

      await expect(owner.complete("<Response />")).rejects.toThrow(
        "simulated lost completion acknowledgement",
      );
      await owner.complete("<Response />");

      await expect(
        second.acquire("ambiguous-completion-key", "request-hash", 10_000),
      ).resolves.toEqual({ kind: "replayed", response: "<Response />" });
      expect(evalCalls).toBe(3);
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "rejects a different request body for a key that is still reserved",
    async () => {
      const first = createRedisTwimlReplayStore(clientAdapter(clientA), testPrefix);
      const second = createRedisTwimlReplayStore(clientAdapter(clientB), testPrefix);
      const owner = await first.acquire("conflict-key", "hash-a", 10_000);
      expect(owner.kind).toBe("owner");
      await expect(second.acquire("conflict-key", "hash-b", 10_000)).resolves.toEqual({
        kind: "conflict",
      });
      if (owner.kind === "owner") await owner.abort();
    },
  );

  it.skipIf(!process.env.REDIS_URL)(
    "reports consumed when a waiting retry loses the replay response to stream consumption",
    async () => {
      const first = createRedisTwimlReplayStore(clientAdapter(clientA), testPrefix);
      let releaseReservation!: () => void;
      let reservationStarted!: () => void;
      const reservationPaused = new Promise<void>((resolve) => {
        releaseReservation = resolve;
      });
      const reservationObserved = new Promise<void>((resolve) => {
        reservationStarted = resolve;
      });
      let firstEval = true;
      const second = createRedisTwimlReplayStore(
        clientAdapter(clientB, async (result) => {
          if (firstEval) {
            firstEval = false;
            reservationStarted();
            await reservationPaused;
          }
          return result;
        }),
        testPrefix,
      );
      const owner = await first.acquire("consumed-key", "request-hash", 10_000);
      expect(owner.kind).toBe("owner");
      if (owner.kind !== "owner") return;

      const retry = second.acquire("consumed-key", "request-hash", 10_000);
      await reservationObserved;
      await owner.complete("<Response />");
      await first.markConsumed("consumed-key");
      releaseReservation();
      await expect(retry).resolves.toEqual({ kind: "consumed" });
    },
  );
});

function clientAdapter(
  client: ReturnType<typeof createClient>,
  afterEval?: (result: unknown) => Promise<unknown>,
) {
  return {
    get: (key: string) => client.get(key),
    eval: async (script: string, keys: readonly string[], args: readonly string[]) => {
      const result = await client.eval(script, { keys: [...keys], arguments: [...args] });
      return afterEval ? afterEval(result) : result;
    },
  };
}
