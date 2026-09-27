import { describe, expect, it } from "vitest";

import { RUNTIME_OBSERVATION_NAMES, type RuntimeObservation, type SessionId } from "@tvic/core";
import { RuntimeObservationCoordinator } from "../src/runtime-observation.js";

const SESSION_ID = "observation-session" as SessionId;

function flushObservationQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RuntimeObservationCoordinator", () => {
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

  it("counts observations admitted after the sink circuit opens", async () => {
    const received: RuntimeObservation[] = [];
    const coordinator = new RuntimeObservationCoordinator({
      enqueue(observation) {
        received.push(observation);
        const started = Date.now();
        while (Date.now() - started < 205) {
          // Exercise the documented enqueue budget with a deliberately bad sink.
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
    expect(laterDrop?.factId).not.toBe(firstDrop?.factId);
    expect(laterDrop?.epoch).not.toBe(firstDrop?.epoch);
  });
});
