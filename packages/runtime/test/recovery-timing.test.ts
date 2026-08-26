import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryAwareTiming } from "../src/recovery-timing.js";

describe("RecoveryAwareTiming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses an active endpoint budget during recovery and resumes the remainder", () => {
    vi.useFakeTimers();
    let now = 0;
    let endpoints = 0;
    const timing = new RecoveryAwareTiming({
      now: () => now,
      endpointTimeoutMs: 50,
      maxDurationMs: 500,
      onEndpoint: () => {
        endpoints += 1;
      },
    });

    timing.armEndpointTimers(true);
    now = 20;
    timing.setState("recovering", true);
    now = 1_000;
    vi.advanceTimersByTime(500);
    expect(endpoints).toBe(0);

    timing.setState("healthy", true);
    vi.advanceTimersByTime(29);
    expect(endpoints).toBe(0);
    vi.advanceTimersByTime(1);
    expect(endpoints).toBe(1);
  });

  it("starts a fresh semantic budget when finals arrive during probation", () => {
    vi.useFakeTimers();
    let endpoints = 0;
    const timing = new RecoveryAwareTiming({
      now: () => 0,
      endpointTimeoutMs: 25,
      maxDurationMs: 100,
      onEndpoint: () => {
        endpoints += 1;
      },
    });

    timing.setState("probationary", true);
    timing.setState("healthy", true);
    vi.advanceTimersByTime(24);
    expect(endpoints).toBe(0);
    vi.advanceTimersByTime(1);
    expect(endpoints).toBe(1);
  });

  it("pauses commit evidence grace while the generation is not healthy", async () => {
    vi.useFakeTimers();
    let now = 0;
    let endpointEvidence = false;
    const timing = new RecoveryAwareTiming({
      now: () => now,
      endpointTimeoutMs: 50,
      maxDurationMs: 100,
      onEndpoint: () => undefined,
    });

    const grace = timing.waitForActive(() => endpointEvidence, 25);
    timing.setState("recovering", false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.race([grace, Promise.resolve("pending")])).toBe("pending");

    now = 100;
    timing.setState("healthy", false);
    now = 124;
    await vi.advanceTimersByTimeAsync(5);
    expect(await Promise.race([grace, Promise.resolve("pending")])).toBe("pending");
    now = 125;
    await vi.advanceTimersByTimeAsync(5);
    await expect(grace).resolves.toBe(false);
  });
});
