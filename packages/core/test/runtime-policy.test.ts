import { describe, expect, it } from "vitest";

import { DEFAULT_DURABLE_RUNTIME_POLICY } from "../src/runtime.js";

describe("default durable runtime policy", () => {
  it("allows measured remote-database critical write latency", () => {
    expect(DEFAULT_DURABLE_RUNTIME_POLICY.criticalWriteTimeoutMs).toBe(2_000);
  });
});
