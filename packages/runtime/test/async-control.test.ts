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

  it("does not accept work that settles after its absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const deadlineMs = Date.now() + 20;
      await expect(
        settleBy(async () => {
          vi.setSystemTime(deadlineMs + 1);
          return "late";
        }, deadlineMs),
      ).resolves.toEqual({ status: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats work rejected after its absolute deadline as timed out", async () => {
    vi.useFakeTimers();
    try {
      const deadlineMs = Date.now() + 20;
      await expect(
        settleBy(async () => {
          vi.setSystemTime(deadlineMs + 1);
          throw new Error("late failure");
        }, deadlineMs),
      ).resolves.toEqual({ status: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a far-future settlement deadline from overflowing the timer delay", async () => {
    vi.useFakeTimers();
    try {
      const maximumTimerDelayMs = 2_147_483_647;
      const deadlineMs = Date.now() + maximumTimerDelayMs + 10;
      let settled = false;
      const pending = settleBy(() => new Promise<string>(() => undefined), deadlineMs).then(
        (result) => {
          settled = true;
          return result;
        },
      );

      await vi.advanceTimersByTimeAsync(maximumTimerDelayMs);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toEqual({ status: "timeout" });
    } finally {
      vi.useRealTimers();
    }
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

  it("chunks a backoff longer than the maximum timer delay", async () => {
    vi.useFakeTimers();
    try {
      const maximumTimerDelayMs = 2_147_483_647;
      const attempt = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("ready");
      const result = pollUntil({
        deadlineMs: Date.now() + maximumTimerDelayMs + 200,
        attempt,
        nextDelayMs: () => maximumTimerDelayMs + 100,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(maximumTimerDelayMs);
      expect(attempt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(99);
      expect(attempt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe("ready");
      expect(attempt).toHaveBeenCalledTimes(2);
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

  it("does not invoke an attempt when abort precedes its queued callback", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => "too late");
    const result = pollUntil({
      deadlineMs: Date.now() + 1_000,
      signal: controller.signal,
      attempt,
      nextDelayMs: () => 1,
    });

    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not invoke an attempt when the deadline passes before its queued callback", async () => {
    vi.useFakeTimers();
    try {
      const deadlineMs = Date.now() + 20;
      const attempt = vi.fn(async () => "too late");
      const result = pollUntil({
        deadlineMs,
        attempt,
        nextDelayMs: () => 1,
      });

      vi.setSystemTime(deadlineMs + 1);
      await expect(result).resolves.toBeNull();
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for an attempt when the absolute deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const attempt = vi.fn(() => new Promise<string | null>(() => undefined));
      const result = pollUntil({
        deadlineMs: Date.now() + 20,
        attempt,
        nextDelayMs: () => 1,
      });

      await vi.advanceTimersByTimeAsync(20);
      await expect(result).resolves.toBeNull();
      expect(attempt).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a result returned after its absolute deadline", async () => {
    vi.useFakeTimers();
    try {
      const deadlineMs = Date.now() + 20;
      await expect(
        pollUntil({
          deadlineMs,
          attempt: async () => {
            vi.setSystemTime(deadlineMs + 1);
            return "late";
          },
          nextDelayMs: () => 1,
        }),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an attempt rejected after its deadline as timed out", async () => {
    vi.useFakeTimers();
    try {
      const deadlineMs = Date.now() + 20;
      await expect(
        pollUntil({
          deadlineMs,
          attempt: async () => {
            vi.setSystemTime(deadlineMs + 1);
            throw new Error("late attempt failure");
          },
          nextDelayMs: () => 1,
        }),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for an attempt when aborted and observes its late rejection", async () => {
    const controller = new AbortController();
    let rejectAttempt: ((error: Error) => void) | undefined;
    const attempt = vi.fn(
      () =>
        new Promise<string | null>((_resolve, reject) => {
          rejectAttempt = reject;
        }),
    );
    const result = pollUntil({
      deadlineMs: Date.now() + 1_000,
      signal: controller.signal,
      attempt,
      nextDelayMs: () => 1,
    });

    await Promise.resolve();
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(attempt).toHaveBeenCalledOnce();
    rejectAttempt?.(new Error("late attempt failure"));
    await Promise.resolve();
  });

  it("propagates an attempt failure", async () => {
    const failure = new Error("inspection failed");
    await expect(
      pollUntil({
        deadlineMs: Date.now() + 1_000,
        attempt: async () => Promise.reject(failure),
        nextDelayMs: () => 1,
      }),
    ).rejects.toBe(failure);
  });
});
