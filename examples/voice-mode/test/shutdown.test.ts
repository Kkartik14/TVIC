import { describe, expect, it } from "vitest";

import { stopOperationBeforeDeadline, waitForRuntimeCleanup } from "../src/shutdown.js";

describe("voice-mode shutdown", () => {
  it("bounds external service shutdown when a close operation hangs", async () => {
    const startedAt = Date.now();
    const result = await stopOperationBeforeDeadline(20, () => new Promise<void>(() => undefined));

    expect(result).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("reports external service shutdown failures", async () => {
    const result = await stopOperationBeforeDeadline(100, async () => {
      throw new Error("close failed");
    });

    expect(result).toBe("failed");
  });

  it("keeps its cleanup wait bounded when health checks hang", async () => {
    const startedAt = Date.now();
    const result = await waitForRuntimeCleanup(20, {
      healthCheck: () => new Promise(() => undefined),
      hasActiveSessions: () => false,
    });

    expect(result).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("returns once cleanup is clear and final sessions have settled", async () => {
    await expect(
      waitForRuntimeCleanup(100, {
        healthCheck: async () => ({
          checks: { cleanup: { details: { lateCleanupPending: false } } },
        }),
        hasActiveSessions: () => false,
      }),
    ).resolves.toBe(true);
  });
});
