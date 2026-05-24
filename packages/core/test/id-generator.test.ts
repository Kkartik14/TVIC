import { describe, expect, it } from "vitest";

import { counterIdGenerator, createDefaultIdGenerator } from "../src/index.js";

describe("id generator uniqueness", () => {
  it("produces no duplicate ids across many generator instances", () => {
    const spans = new Set<string>();
    const sessions = new Set<string>();
    const traces = new Set<string>();
    const correlations = new Set<string>();
    const instances = 200;
    const perInstance = 50;

    for (let i = 0; i < instances; i += 1) {
      const gen = createDefaultIdGenerator();
      for (let j = 0; j < perInstance; j += 1) {
        spans.add(gen.span());
        sessions.add(gen.session());
        traces.add(gen.trace());
        correlations.add(gen.correlation());
      }
    }

    const total = instances * perInstance;
    expect(spans.size).toBe(total);
    expect(sessions.size).toBe(total);
    expect(traces.size).toBe(total);
    expect(correlations.size).toBe(total);
  });

  it("namespaces are disjoint: two instances never share a span id", () => {
    const a = createDefaultIdGenerator();
    const b = createDefaultIdGenerator();
    const aSpans = new Set([a.span(), a.span(), a.span()]);
    for (const span of [b.span(), b.span(), b.span()]) {
      expect(aSpans.has(span)).toBe(false);
    }
  });

  it("is sequential and deterministic within a single instance", () => {
    const gen = createDefaultIdGenerator();
    const first = gen.span();
    const second = gen.span();
    expect(first).not.toBe(second);
    // Same instance namespace; the trailing counter increments.
    expect(first.replace(/_\d+$/, "")).toBe(second.replace(/_\d+$/, ""));
  });

  it("counterIdGenerator stays a plain deterministic counter (for injected test generators)", () => {
    const counter = counterIdGenerator("span");
    expect(counter.next()).toBe("span_1");
    expect(counter.next()).toBe("span_2");
  });
});
