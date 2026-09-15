import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisTwimlReplayStore } from "../src/security.js";

const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const clientA = createClient({ url: redisUrl });
const clientB = createClient({ url: redisUrl });

beforeAll(async () => {
  if (!process.env.REDIS_URL) return;
  await Promise.all([clientA.connect(), clientB.connect()]);
  await clientA.flushDb();
});

afterAll(async () => {
  if (!process.env.REDIS_URL) return;
  await Promise.all([clientA.quit(), clientB.quit()]);
});

describe("Redis TwiML replay store", () => {
  it.skipIf(!process.env.REDIS_URL)(
    "serializes a cross-client retry behind one reservation and replays the response",
    async () => {
      const first = createRedisTwimlReplayStore(clientAdapter(clientA), "test:twiml:");
      const second = createRedisTwimlReplayStore(clientAdapter(clientB), "test:twiml:");
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
    "rejects a different request body for a key that is still reserved",
    async () => {
      const first = createRedisTwimlReplayStore(clientAdapter(clientA), "test:twiml:");
      const second = createRedisTwimlReplayStore(clientAdapter(clientB), "test:twiml:");
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
      const first = createRedisTwimlReplayStore(clientAdapter(clientA), "test:twiml:");
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
        "test:twiml:",
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
