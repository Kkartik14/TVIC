import { describe, expect, it } from "vitest";
import type { Clock, SessionId, Timestamp } from "@tvic/core";

import { createNodeMediaPlane, createRuntime, matchPath } from "../src/index.js";
import { InMemoryRuntime } from "../src/create-runtime.js";
import { buildAgent } from "./harness.js";

describe("createRuntime", () => {
  it("owns the session and turn lifecycle", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "A table for four", mediaEventIds: [] },
    });

    await runtime.endTurn(session.id, turn.id, {
      reason: "completed",
      output: { text: "Certainly", mediaEventIds: [] },
      latency: { firstTokenMs: 20, firstAudioMs: 50 },
    });
    await runtime.endSession(session.id, { reason: "completed" });

    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({
      status: "completed",
      output: { text: "Certainly" },
      latency: { firstTokenMs: 20, firstAudioMs: 50 },
    });
  });

  it("maintains one monotonic clock per active session", async () => {
    const clock = new ManualClock();
    const runtime = createRuntime({ clock });
    await runtime.start();

    expect(() => runtime.sessionClockMs("session_missing" as SessionId)).toThrow();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    clock.advance(42);
    expect(runtime.sessionClockMs(session.id)).toBe(42);

    await runtime.endSession(session.id, { reason: "completed" });
    expect(() => runtime.sessionClockMs(session.id)).toThrow();
  });

  it("releases all per-session runtime state when calls end", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 1 });
    await runtime.endSession(session.id, { reason: "completed" });
    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });
  });

  it("configures a WebSocket media plane with path params", () => {
    const plane = createNodeMediaPlane({
      host: "127.0.0.1",
      port: 0,
      path: "/media/:callId",
      onConnection() {},
    });

    expect(plane.isRunning).toBe(false);
    expect(matchPath("/media/:callId", "/media/call_123")).toEqual({ callId: "call_123" });
    expect(matchPath("/media/:callId", "/wrong/call_123")).toBeNull();
  });
});

class ManualClock implements Clock {
  #ms = 0;

  now(): Timestamp {
    return new Date(this.#ms).toISOString() as Timestamp;
  }

  monotonicMs(): number {
    return this.#ms;
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}
