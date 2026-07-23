import { describe, expect, it } from "vitest";

import { counterIdGenerator, createDefaultIdGenerator } from "../src/index.js";

describe("id generator uniqueness", () => {
  it("produces no duplicate ids across many generator instances", () => {
    const sessions = new Set<string>();
    const turns = new Set<string>();
    const toolCalls = new Set<string>();
    const instances = 200;
    const perInstance = 50;

    for (let i = 0; i < instances; i += 1) {
      const gen = createDefaultIdGenerator();
      for (let j = 0; j < perInstance; j += 1) {
        sessions.add(gen.session());
        turns.add(gen.turn());
        toolCalls.add(gen.toolCall());
      }
    }

    const total = instances * perInstance;
    expect(sessions.size).toBe(total);
    expect(turns.size).toBe(total);
    expect(toolCalls.size).toBe(total);
  });

  it("namespaces are disjoint across generator instances", () => {
    const a = createDefaultIdGenerator();
    const b = createDefaultIdGenerator();
    const aSessions = new Set([a.session(), a.session(), a.session()]);
    for (const session of [b.session(), b.session(), b.session()]) {
      expect(aSessions.has(session)).toBe(false);
    }
  });

  it("is sequential and deterministic within a single instance", () => {
    const gen = createDefaultIdGenerator();
    const first = gen.session();
    const second = gen.session();
    expect(first).not.toBe(second);
    // Same instance namespace; the trailing counter increments.
    expect(first.replace(/_\d+$/, "")).toBe(second.replace(/_\d+$/, ""));
  });

  it("counterIdGenerator stays a plain deterministic counter (for injected test generators)", () => {
    const counter = counterIdGenerator("session");
    expect(counter.next()).toBe("session_1");
    expect(counter.next()).toBe("session_2");
  });
});
