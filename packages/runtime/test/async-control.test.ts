import { describe, expect, it, vi } from "vitest";

import { pollUntil, raceStartup, settleBy } from "../src/async-control.js";

describe("async control", () => {
  it("treats a pre-aborted signal as authoritative and cancels a settled startup", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = {};
    let cancelCalls = 0;

    await expect(
      raceStartup(Promise.resolve(handle), controller.signal, async (candidate) => {
        expect(candidate).toBe(handle);
        cancelCalls += 1;
      }),
    ).resolves.toBeNull();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelCalls).toBe(1);
  });

  it("classifies work settled before its absolute deadline", async () => {
    await expect(settleBy(async () => "saved", Date.now() + 1_000)).resolves.toEqual({
      status: "completed",
      value: "saved",
    });
    await expect(
      settleBy(async () => Promise.reject(new Error("write failed")), Date.now() + 1_000),
    ).resolves.toMatchObject({ status: "rejected", error: new Error("write failed") });
  });

  it("returns timeout immediately after an expired absolute deadline", async () => {
    await expect(settleBy(async () => "too late", Date.now() - 1)).resolves.toEqual({
      status: "timeout",
    });
  });

  it("polls with the requested delay until an attempt returns a value", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const result = pollUntil({
        deadlineMs: Date.now() + 100,
        attempt: async () => (++attempts === 3 ? "ready" : null),
        nextDelayMs: () => 10,
      });

      await vi.advanceTimersByTimeAsync(20);
      await expect(result).resolves.toBe("ready");
      expect(attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when its signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(async () => null);

    await expect(
      pollUntil({
        deadlineMs: Date.now() + 1_000,
        signal: controller.signal,
        attempt,
        nextDelayMs: () => 1,
      }),
    ).resolves.toBeNull();
    expect(attempt).not.toHaveBeenCalled();
  });
});
