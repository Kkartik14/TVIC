import { describe, expect, it, vi } from "vitest";

import {
  InvalidArgumentError,
  RUNTIME_OBSERVATION_NAMES,
  type RuntimeObservation,
  type SessionId,
  type TurnId,
} from "@tvic/core";
import { RuntimeObservationCoordinator } from "../src/runtime-observation.js";

const SESSION_ID = "observation-session" as SessionId;

function flushObservationQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RuntimeObservationCoordinator", () => {
  it("rejects observation queue capacities above the supported maximum", () => {
    expect(() => new RuntimeObservationCoordinator({ enqueue: () => undefined }, 4_097)).toThrow(
      InvalidArgumentError,
    );
  });

  it("delivers asynchronously, preserves per-session sequence, and counts sink failures", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
        if (observation.name === RUNTIME_OBSERVATION_NAMES.TURN_START) {
          throw new Error("sink failed after receiving the fact");
        }
      },
    });

    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 12,
      attributes: { turn_sequence: 1 },
    });

    expect(received).toHaveLength(0);
    await flushObservationQueue();

    expect(received.map((observation) => observation.name)).toEqual([
      RUNTIME_OBSERVATION_NAMES.SESSION_START,
      RUNTIME_OBSERVATION_NAMES.TURN_START,
    ]);
    expect(received.map((observation) => observation.sequence)).toEqual([1, 2]);
    expect(new Set(received.map((observation) => observation.epoch)).size).toBe(1);
    expect(coordinator.diagnostics().sinkFailures).toBe(1);
  });

  it("leaves a detectable sequence gap when the sink rejects an observation", async () => {
    const received: RuntimeObservation[] = [];
    let rejectTurnStart = true;
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        if (observation.name === RUNTIME_OBSERVATION_NAMES.TURN_START && rejectTurnStart) {
          rejectTurnStart = false;
          throw new Error("sink rejected observation");
        }
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await coordinator.flush(1_000);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      turnId: "turn-1" as TurnId,
      atMs: 1,
    });
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_END,
      sessionId: SESSION_ID,
      turnId: "turn-1" as TurnId,
      atMs: 2,
    });
    await coordinator.flush(1_000);

    expect(received.map((observation) => observation.sequence)).toEqual([1, 3]);
    expect(coordinator.diagnostics().sinkFailures).toBe(1);
  });

  it("allowlists bounded metadata and never forwards transcript-like fields", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await flushObservationQueue();
    received.length = 0;

    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_END,
      sessionId: SESSION_ID,
      atMs: 4,
      attributes: {
        status: "completed",
        total_ms: 4,
        transcript: "secret customer transcript",
        audio: "raw audio must not cross this seam",
        audio_error_code: "x".repeat(128),
      },
    });
    await flushObservationQueue();

    expect(received[0]?.attributes).toEqual({
      status: "completed",
      total_ms: 4,
      audio_error_code: "x".repeat(128),
    });
  });

  it("does not enumerate or read attributes outside the event allowlist", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await flushObservationQueue();
    received.length = 0;

    let rejectedAttributeReads = 0;
    const attributes = Object.create(null) as Record<string, string | number | boolean>;
    Object.defineProperties(attributes, {
      status: { enumerable: true, value: "completed" },
      total_ms: { enumerable: true, value: 4 },
    });
    for (let index = 0; index < 2_000; index += 1) {
      Object.defineProperty(attributes, `private_${index}`, {
        enumerable: true,
        get() {
          rejectedAttributeReads += 1;
          return "must not be inspected";
        },
      });
    }

    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_END,
      sessionId: SESSION_ID,
      turnId: "turn-a" as never,
      atMs: 4,
      attributes,
    });
    await flushObservationQueue();

    expect(rejectedAttributeReads).toBe(0);
    expect(received[0]?.attributes).toEqual({ status: "completed", total_ms: 4 });
  });

  it("records queue overflow as an ordered, aggregated observation", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator(
      {
        enqueue(observation) {
          received.push(observation);
        },
      },
      1,
    );
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await flushObservationQueue();
    received.length = 0;

    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 1,
    });
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
      sessionId: SESSION_ID,
      atMs: 2,
      attributes: { cause: "barge_in" },
    });
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
      sessionId: SESSION_ID,
      atMs: 3,
      attributes: { cause: "dtmf" },
    });
    await flushObservationQueue();

    expect(received.map((observation) => observation.name)).toEqual([
      RUNTIME_OBSERVATION_NAMES.TURN_START,
      RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
    ]);
    expect(received[1]?.attributes).toEqual({
      dropped_count: 2,
      drop_reason: "queue_overflow",
      queue_capacity: 1,
    });
    expect(coordinator.diagnostics().queueDrops).toBe(2);
    expect(received[0]?.sequence).toBeLessThan(received[1]?.sequence ?? 0);
  });

  it("anchors coalesced drops after admitted facts between losses", async () => {
    vi.useFakeTimers();
    try {
      const received: RuntimeObservation[] = [];
      const capacity = 64;
      const coordinator = new RuntimeObservationCoordinator(
        { enqueue: (observation) => received.push(observation) },
        capacity,
      );
      coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
      await vi.runAllTimersAsync();
      received.length = 0;

      const recordTurn = (turnId: string, atMs: number) =>
        coordinator.record({
          name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
          sessionId: SESSION_ID,
          atMs,
          turnId: turnId as TurnId,
          attributes: { cause: "barge_in" },
        });

      for (let index = 0; index < capacity; index += 1) {
        recordTurn(`backlog-${index}`, index + 1);
      }
      recordTurn("first-overflow", 100);

      // This timer runs after one 32-item drain slice has freed queue slots,
      // but before the next drain slice reaches the pending drop marker.
      setTimeout(() => {
        recordTurn("between-losses", 200);
        for (let index = 0; index < capacity / 2 - 1; index += 1) {
          recordTurn(`refill-${index}`, 201 + index);
        }
        recordTurn("second-overflow", 300);
      }, 0);

      await vi.runAllTimersAsync();

      const intervening = received.find((observation) => observation.turnId === "between-losses");
      const dropped = received.find(
        (observation) => observation.name === RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
      );
      expect(intervening).toBeDefined();
      expect(dropped?.attributes?.dropped_count).toBe(2);
      expect(dropped?.atMs).toBeGreaterThan(intervening?.atMs ?? 0);
      expect(dropped?.sequence).toBeGreaterThan(intervening?.sequence ?? 0);
      expect(received.indexOf(dropped!)).toBeGreaterThan(received.indexOf(intervening!));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps runtime-wide overflow in diagnostics instead of routing it through a session sink", async () => {
    const received: RuntimeObservation[] = [];
    const capacity = 64;
    const coordinator = new RuntimeObservationCoordinator(
      { enqueue: (observation) => received.push(observation) },
      capacity,
    );
    const sessions = Array.from(
      { length: capacity + 1_024 + 1 },
      (_, index) => `observation-session-${index}` as SessionId,
    );
    const knownSessionIds = new Set(sessions);
    for (const sessionId of sessions) {
      coordinator.start({ id: sessionId, agentId: "agent" as never, channel: "simulated" }, 100);
    }

    expect(await coordinator.flush(5_000)).toBe(true);

    expect(received.length).toBeGreaterThan(capacity);
    expect(received.every((observation) => knownSessionIds.has(observation.sessionId))).toBe(true);
    expect(coordinator.diagnostics().queueDrops).toBe(1_025);
  });

  it("flushes lifecycle facts on shutdown", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 1,
    });

    await expect(coordinator.shutdown(1_000)).resolves.toBe(true);
    expect(received.map((observation) => observation.sequence)).toEqual([1, 2]);
  });

  it("counts a valid observation rejected after shutdown begins", async () => {
    const coordinator = new RuntimeObservationCoordinator({ enqueue: () => undefined });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);

    const shutdown = coordinator.shutdown(1_000);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      turnId: "turn-late" as TurnId,
      atMs: 1,
    });
    await expect(shutdown).resolves.toBe(true);

    expect(coordinator.diagnostics().shutdownDrops).toBe(1);
  });

  it("clamps caller timestamp regressions to the session clock", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await flushObservationQueue();
    received.length = 0;
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 20,
    });
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
      sessionId: SESSION_ID,
      atMs: 1,
      attributes: { cause: "dtmf" },
    });
    await flushObservationQueue();

    expect(received.map((observation) => observation.atMs)).toEqual([20, 20]);
  });

  it("keeps detached-session sequence state until a terminal end", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await flushObservationQueue();
    coordinator.forget(SESSION_ID);
    coordinator.resume(SESSION_ID, 100, 20, 5);
    coordinator.forget(SESSION_ID);
    coordinator.resume(SESSION_ID, 100, 20, 5);
    await flushObservationQueue();

    expect(received.map((observation) => observation.sequence)).toEqual([1, 2, 3]);
    expect(received[1]?.factId).not.toBe(received[2]?.factId);
  });

  it("emits a terminal fact after detached recovery cleanup", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await flushObservationQueue();
    coordinator.forget(SESSION_ID);
    coordinator.end(
      { id: SESSION_ID, status: "completed", terminalSource: "normal_completion" } as never,
      { monotonicMs: () => 130 } as never,
    );
    await flushObservationQueue();

    expect(received.map((observation) => observation.name)).toEqual([
      RUNTIME_OBSERVATION_NAMES.SESSION_START,
      RUNTIME_OBSERVATION_NAMES.SESSION_END,
    ]);
  });

  it("estimates terminal elapsed time when local observation start state is absent", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
      },
    });

    coordinator.end(
      {
        id: SESSION_ID,
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:00.750Z",
        terminalSource: "runtime_recovery",
      } as never,
      { monotonicMs: () => 90_000 } as never,
      [
        {
          id: "turn-1",
          sessionId: SESSION_ID,
          status: "completed",
          sequence: 1,
          startedAt: "2026-01-01T00:00:00.100Z",
          endedAt: "2026-01-01T00:00:00.700Z",
          latency: { totalMs: 600 },
          input: { mediaEventIds: [] },
          output: { mediaEventIds: [] },
          toolCallIds: [],
        } as never,
      ],
    );
    await flushObservationQueue();

    expect(received.map((observation) => observation.name)).toEqual([
      RUNTIME_OBSERVATION_NAMES.TURN_END,
      RUNTIME_OBSERVATION_NAMES.SESSION_END,
    ]);
    expect(received[0]?.atMs).toBe(750);
    expect(received[0]?.attributes).toMatchObject({
      total_ms: 600,
      at_ms_estimated: true,
    });
    expect(received[1]?.atMs).toBe(750);
    expect(received[1]?.attributes).toMatchObject({
      at_ms_estimated: true,
      sequence_discontinuity: true,
    });
  });

  it("recovers a sink circuit after one slow enqueue and a cooldown", async () => {
    const received: RuntimeObservation[] = [];
    let now = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    let slowOnce = true;
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
        if (slowOnce) {
          slowOnce = false;
          now += 205;
        }
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await coordinator.flush(1_000);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 1,
    });

    expect(coordinator.diagnostics().sinkDisabled).toBe(true);
    expect(coordinator.diagnostics().sinkDisabledDrops).toBeGreaterThanOrEqual(1);
    expect(received).toHaveLength(1);

    now += 10_000;
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 2,
    });
    await coordinator.flush(1_000);

    expect(coordinator.diagnostics().sinkDisabled).toBe(false);
    expect(received).toHaveLength(2);
    expect(received.map((observation) => observation.sequence)).toEqual([1, 3]);
    nowSpy.mockRestore();
  });

  it("opens a sink cooldown when a slow enqueue throws", async () => {
    const received: RuntimeObservation[] = [];
    let now = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    let slowOnce = true;
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        if (slowOnce) {
          slowOnce = false;
          now += 205;
          throw new Error("slow sink failed");
        }
        received.push(observation);
      },
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      turnId: "turn-1" as TurnId,
      atMs: 1,
    });
    await coordinator.flush(1_000);

    expect(coordinator.diagnostics().sinkFailures).toBe(1);
    expect(coordinator.diagnostics().sinkDisabled).toBe(true);
    expect(coordinator.diagnostics().sinkDisabledDrops).toBeGreaterThan(0);
    expect(received).toHaveLength(0);

    now += 10_000;
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      turnId: "turn-2" as TurnId,
      atMs: 2,
    });
    await coordinator.flush(1_000);

    expect(coordinator.diagnostics().sinkDisabled).toBe(false);
    expect(received).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("yields between drain tasks when cumulative sink work exceeds its budget", async () => {
    const received: RuntimeObservation[] = [];
    const taskEnds: number[] = [];
    let fakeNow = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
    try {
      const coordinator = new RuntimeObservationCoordinator({
        enqueue(observation) {
          received.push(observation);
          if (observation.name !== RUNTIME_OBSERVATION_NAMES.SESSION_START) fakeNow += 30;
          queueMicrotask(() => {
            const taskEnd = received.length;
            if (taskEnds.at(-1) !== taskEnd) taskEnds.push(taskEnd);
          });
        },
      });
      coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
      await coordinator.flush(1_000);
      received.length = 0;
      taskEnds.length = 0;
      fakeNow = 0;

      for (let index = 0; index < 4; index += 1) {
        coordinator.record({
          name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
          sessionId: SESSION_ID,
          turnId: `turn-${index}` as never,
          atMs: index + 1,
          attributes: { cause: "barge_in" },
        });
      }
      await coordinator.flush(1_000);

      expect(received).toHaveLength(4);
      expect(taskEnds).toEqual([1, 2, 3, 4]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps dropped-fact identity distinct across eviction epochs", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator(
      {
        enqueue(observation) {
          received.push(observation);
        },
      },
      1,
    );
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 100);
    await coordinator.flush(1_000);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 1,
    });
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
      sessionId: SESSION_ID,
      atMs: 2,
      attributes: { cause: "barge_in" },
    });
    await coordinator.flush(1_000);
    const firstDropIndex = received.findIndex(
      (observation) =>
        observation.sessionId === SESSION_ID &&
        observation.name === RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
    );
    const firstDrop = received[firstDropIndex];
    coordinator.forget(SESSION_ID);

    for (let index = 0; index < 1_024; index += 1) {
      const sessionId = `detached-${index}` as SessionId;
      coordinator.start({ id: sessionId, agentId: "agent" as never, channel: "simulated" }, 0);
      coordinator.forget(sessionId);
    }
    await coordinator.flush(2_000);
    coordinator.resume(SESSION_ID, 0, 1, 0);
    await coordinator.flush(1_000);
    const resumed = received.find(
      (observation, index) =>
        index > firstDropIndex &&
        observation.sessionId === SESSION_ID &&
        observation.name === RUNTIME_OBSERVATION_NAMES.SESSION_RESUME,
    );
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: SESSION_ID,
      atMs: 1,
    });
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION,
      sessionId: SESSION_ID,
      atMs: 2,
      attributes: { cause: "barge_in" },
    });
    await coordinator.flush(1_000);
    const laterDrop = received.find(
      (observation, index) =>
        index > firstDropIndex &&
        observation.sessionId === SESSION_ID &&
        observation.name === RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
    );

    expect(firstDrop).toBeDefined();
    expect(laterDrop).toBeDefined();
    expect(resumed?.attributes?.sequence_discontinuity).toBe(true);
    expect(laterDrop?.factId).not.toBe(firstDrop?.factId);
    expect(resumed?.epoch).not.toBe(firstDrop?.epoch);
    expect(laterDrop?.epoch).toBe(resumed?.epoch);
  });

  it("does not rotate an unrelated active session when detached state is evicted", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator(
      { enqueue: (observation) => received.push(observation) },
      4_096,
      "runtime-seed",
    );
    const activeSessionId = "active-session" as SessionId;
    coordinator.start({ id: activeSessionId, agentId: "agent" as never, channel: "simulated" }, 0);
    await coordinator.flush(1_000);
    const activeStart = received[0];

    for (let index = 0; index < 1_025; index += 1) {
      const sessionId = `detached-epoch-${index}` as SessionId;
      coordinator.start({ id: sessionId, agentId: "agent" as never, channel: "simulated" }, 0);
      coordinator.forget(sessionId);
    }
    await coordinator.flush(5_000);
    coordinator.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: activeSessionId,
      turnId: "active-turn" as TurnId,
      atMs: 1,
    });
    await coordinator.flush(1_000);

    const activeTurn = received.find(
      (observation) =>
        observation.sessionId === activeSessionId &&
        observation.name === RUNTIME_OBSERVATION_NAMES.TURN_START,
    );
    expect(activeTurn?.epoch).toBe(activeStart?.epoch);
    expect(activeTurn?.sequence).toBe(2);
  });

  it("gives provisional and persisted terminal facts distinct identities", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue: (observation) => received.push(observation),
    });
    coordinator.start({ id: SESSION_ID, agentId: "agent" as never, channel: "simulated" }, 0);
    await coordinator.flush(1_000);
    received.length = 0;

    coordinator.recordPipeline({
      name: RUNTIME_OBSERVATION_NAMES.TURN_END,
      sessionId: SESSION_ID,
      turnId: "turn-provisional" as TurnId,
      atMs: 10,
      attributes: { status: "failed", terminal_persisted: false },
    });
    coordinator.recordPipeline({
      name: RUNTIME_OBSERVATION_NAMES.TURN_END,
      sessionId: SESSION_ID,
      turnId: "turn-provisional" as TurnId,
      atMs: 20,
      attributes: { status: "cancelled", terminal_persisted: true },
    });
    await coordinator.flush(1_000);

    expect(received).toHaveLength(2);
    expect(received[0]?.factId).not.toBe(received[1]?.factId);
  });

  it("keeps epoch identifiers bounded after repeated detached-session evictions", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator(
      {
        enqueue(observation) {
          received.push(observation);
        },
      },
      4_096,
      "runtime-seed",
    );
    const originalSessionId = "original-session" as SessionId;
    coordinator.start(
      { id: originalSessionId, agentId: "agent" as never, channel: "simulated" },
      0,
    );
    await coordinator.flush(1_000);
    coordinator.forget(originalSessionId);

    for (let index = 0; index < 1_056; index += 1) {
      const sessionId = `detached-${index}` as SessionId;
      coordinator.start({ id: sessionId, agentId: "agent" as never, channel: "simulated" }, 0);
      coordinator.forget(sessionId);
    }
    await coordinator.flush(5_000);
    coordinator.resume(originalSessionId, 0, 1, 0);
    await coordinator.flush(1_000);

    const observation = received.find(
      (item) =>
        item.sessionId === originalSessionId &&
        item.name === RUNTIME_OBSERVATION_NAMES.SESSION_RESUME,
    );
    expect(coordinator.diagnostics().detachedSessionEvictions).toBeGreaterThan(26);
    expect(observation?.epoch.length).toBeLessThanOrEqual(256);
    expect(observation?.attributes?.sequence_discontinuity).toBe(true);
  });
});
