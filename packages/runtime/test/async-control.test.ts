import { describe, expect, it } from "vitest";

import { raceStartup } from "../src/async-control.js";

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
});
