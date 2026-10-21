import { describe, expect, it, vi } from "vitest";
import type {
  Clock,
  DurableRuntimeStore,
  DurableSessionTransaction,
  ProviderCapabilities,
  RuntimeObservation,
  RuntimePipelineObservationInput,
  AudioTapSummary,
  SessionId,
  SessionLease,
  Timestamp,
  ToolCallId,
  ToolId,
  ToolName,
  TurnId,
} from "@tvic/core";
import {
  DEFAULT_DURABLE_RUNTIME_POLICY,
  InvalidArgumentError,
  LeaseLostError,
  LeaseUnavailableError,
  RUNTIME_OBSERVATION_NAMES,
  isNormalizedError,
} from "@tvic/core";
import {
  createInMemoryDurableRuntimeStore,
  createInMemorySessionStore,
  createInMemoryToolCallStore,
  createInMemoryTurnStore,
} from "@tvic/dal";

import {
  SessionRecoveryCoordinator,
  SessionReaper,
  createNodeMediaPlane,
  createRuntime,
  defineAgent,
  defineTool,
  matchPath,
} from "../src/index.js";
import { InMemoryRuntime } from "../src/create-runtime.js";
import { recordRuntimePipelineObservation } from "../src/runtime-observation-capability.js";
import { renewLease } from "../src/runtime-support.js";
import type { RuntimeAttachmentState } from "../src/runtime-support.js";
import { TEST_PROVIDER_CAPABILITIES, buildAgent, stubTts, until } from "./harness.js";

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;

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

  it("preserves audio-tap finalization across concurrent endSession calls", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const clock = new ManualClock();
    const summary: AudioTapSummary = {
      enabled: true,
      droppedFrames: 2,
      droppedEvents: 1,
      callbackErrors: 0,
    };
    let sessionEndAudioTap: AudioTapSummary | undefined;
    const runtime = createRuntime({
      clock,
      durableStore,
      onSessionEnd: (event) => {
        sessionEndAudioTap = event.audioTap;
      },
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    clock.advance(42);
    let finalizerCalls = 0;
    let finalizerClockMs: number | undefined;
    const runtimeWithTapHooks = runtime as typeof runtime & {
      registerAudioTapFinalizer?(
        id: SessionId,
        finalize: () => AudioTapSummary | Promise<AudioTapSummary>,
      ): void;
      reportAudioTapSummary?(id: SessionId, value: AudioTapSummary): void;
    };
    runtimeWithTapHooks.registerAudioTapFinalizer?.(attachment.session.id, () => {
      finalizerCalls += 1;
      finalizerClockMs = runtime.sessionClockMs(attachment.session.id);
      return summary;
    });
    runtimeWithTapHooks.reportAudioTapSummary?.(attachment.session.id, summary);

    const originalRunSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let signalFirstWriteStarted!: () => void;
    let releaseFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let transactionCalls = 0;
    vi.spyOn(durableStore, "runSessionTransaction").mockImplementation(
      async <T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          signalFirstWriteStarted();
          await firstWriteGate;
        }
        return originalRunSessionTransaction(sessionId, lease, operation);
      },
    );

    const firstEnd = runtime.endSession(attachment.session.id, { reason: "completed" });
    let concurrentEnd: Promise<Awaited<typeof firstEnd>> | undefined;
    try {
      await firstWriteStarted;
      concurrentEnd = runtime.endSession(attachment.session.id, {
        reason: "cancelled",
        cancelReason: "operator_requested",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(transactionCalls).toBe(1);
      expect(finalizerCalls).toBe(0);
    } finally {
      releaseFirstWrite();
    }
    await firstEnd;
    if (concurrentEnd) await concurrentEnd;

    expect(finalizerCalls).toBe(1);
    expect(finalizerClockMs).toBe(42);
    expect(sessionEndAudioTap).toEqual(summary);
    await runtime.stop();
  });

  it("releases tap hooks and the session clock after terminalization fails", async () => {
    const clock = new ManualClock();
    const baseStore = createInMemoryDurableRuntimeStore();
    let failNextEnd = false;
    const durableStore: DurableRuntimeStore = {
      ...baseStore,
      async runUnfencedSessionTransaction<T>(
        sessionId: SessionId,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        if (failNextEnd) {
          failNextEnd = false;
          throw new Error("temporary storage failure");
        }
        return baseStore.runUnfencedSessionTransaction!(sessionId, operation);
      },
    };
    const runtime = createRuntime({ clock, durableStore });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    let finalizerCalls = 0;
    const runtimeWithTapHooks = runtime as typeof runtime & {
      registerAudioTapFinalizer?(
        id: SessionId,
        finalize: () => AudioTapSummary | Promise<AudioTapSummary>,
      ): void;
    };
    runtimeWithTapHooks.registerAudioTapFinalizer?.(session.id, () => {
      finalizerCalls += 1;
      return { enabled: true, droppedFrames: 0, droppedEvents: 0, callbackErrors: 0 };
    });
    clock.advance(42);
    failNextEnd = true;

    await expect(runtime.endSession(session.id, { reason: "completed" })).rejects.toThrow(
      "temporary storage failure",
    );
    clock.advance(10);
    expect(finalizerCalls).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(() => runtime.sessionClockMs(session.id)).toThrow();

    await runtime.endSession(session.id, { reason: "completed" });
    expect(finalizerCalls).toBe(1);
  });

  it("releases the session clock after a timed-out terminal write", async () => {
    vi.useFakeTimers();
    let releaseTransaction!: () => void;
    let signalTransactionStarted!: () => void;
    let signalTransactionSettled!: () => void;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionStarted = new Promise<void>((resolve) => {
      signalTransactionStarted = resolve;
    });
    const transactionSettled = new Promise<void>((resolve) => {
      signalTransactionSettled = resolve;
    });
    const baseStore = createInMemoryDurableRuntimeStore();
    let failNextEnd = false;
    const durableStore: DurableRuntimeStore = {
      ...baseStore,
      async runUnfencedSessionTransaction<T>(
        sessionId: SessionId,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        if (failNextEnd) {
          failNextEnd = false;
          signalTransactionStarted();
          try {
            await transactionGate;
            throw new Error("late storage failure");
          } finally {
            signalTransactionSettled();
          }
        }
        return baseStore.runUnfencedSessionTransaction!(sessionId, operation);
      },
    };
    const clock = new ManualClock();
    const runtime = createRuntime({
      clock,
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 1 },
    });

    try {
      await runtime.start();
      const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
      clock.advance(42);
      failNextEnd = true;

      const ending = runtime.endSession(session.id, { reason: "completed" });
      const endingRejected = expect(ending).rejects.toThrow("Durable write exceeded 1ms");
      await transactionStarted;
      await vi.advanceTimersByTimeAsync(1);
      await endingRejected;
      expect(() => runtime.sessionClockMs(session.id)).toThrow();

      clock.advance(10);
      releaseTransaction();
      await transactionSettled;
      await vi.advanceTimersByTimeAsync(0);
      expect(() => runtime.sessionClockMs(session.id)).toThrow();
      await runtime.stop();
    } finally {
      releaseTransaction();
      vi.useRealTimers();
    }
  });

  it("releases an attached session clock as soon as a terminal write times out", async () => {
    vi.useFakeTimers();
    let releaseTransaction!: () => void;
    let signalTransactionStarted!: () => void;
    let signalTransactionSettled!: () => void;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const transactionStarted = new Promise<void>((resolve) => {
      signalTransactionStarted = resolve;
    });
    const transactionSettled = new Promise<void>((resolve) => {
      signalTransactionSettled = resolve;
    });
    const baseStore = createInMemoryDurableRuntimeStore();
    let failNextEnd = false;
    const durableStore: DurableRuntimeStore = {
      ...baseStore,
      async runSessionTransaction<T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        if (failNextEnd) {
          failNextEnd = false;
          signalTransactionStarted();
          try {
            await transactionGate;
            throw new Error("late storage failure");
          } finally {
            signalTransactionSettled();
          }
        }
        return baseStore.runSessionTransaction(sessionId, lease, operation);
      },
    };
    const clock = new ManualClock();
    const runtime = new InMemoryRuntime({
      clock,
      durableStore,
      durablePolicy: { ...DEFAULT_DURABLE_RUNTIME_POLICY, criticalWriteTimeoutMs: 1 },
    });

    try {
      await runtime.start();
      const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
      clock.advance(42);
      failNextEnd = true;

      const ending = runtime.endSession(attachment.session.id, { reason: "completed" });
      const endingRejected = expect(ending).rejects.toThrow("Durable write exceeded 1ms");
      await transactionStarted;
      await vi.advanceTimersByTimeAsync(1);
      await endingRejected;
      expect(() => runtime.sessionClockMs(attachment.session.id)).toThrow();
      expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });

      clock.advance(10);
      releaseTransaction();
      await transactionSettled;
      await vi.advanceTimersByTimeAsync(0);
      expect(() => runtime.sessionClockMs(attachment.session.id)).toThrow();
      expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });

      await runtime.stop();
    } finally {
      releaseTransaction();
      vi.useRealTimers();
    }
  });

  it("rejects pipeline registration while a timed-out terminal write remains unresolved", async () => {
    const baseStore = createInMemoryDurableRuntimeStore();
    let failNextEnd = false;
    let signalWriteStarted!: () => void;
    let releaseWrite!: () => void;
    let signalWriteSettled!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeSettled = new Promise<void>((resolve) => {
      signalWriteSettled = resolve;
    });
    const durableStore: DurableRuntimeStore = {
      ...baseStore,
      async runSessionTransaction<T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        if (failNextEnd) {
          failNextEnd = false;
          signalWriteStarted();
          try {
            await writeGate;
            throw new Error("late terminal write failure");
          } finally {
            signalWriteSettled();
          }
        }
        return baseStore.runSessionTransaction(sessionId, lease, operation);
      },
    };
    const runtime = new InMemoryRuntime({
      durableStore,
      durablePolicy: { ...DEFAULT_DURABLE_RUNTIME_POLICY, criticalWriteTimeoutMs: 10 },
    });

    try {
      await runtime.start();
      const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
      failNextEnd = true;
      const ending = runtime.endSession(attachment.session.id, { reason: "completed" });
      const endingRejected = expect(ending).rejects.toThrow("Durable write exceeded 10ms");
      await writeStarted;
      await endingRejected;
      await new Promise<void>((resolve) => setImmediate(resolve));

      let finishPipeline!: () => void;
      const pipelineRun = new Promise<void>((resolve) => {
        finishPipeline = resolve;
      });
      let pipelineCancelled = false;
      runtime.registerPipelineRun(
        pipelineRun,
        () => {
          pipelineCancelled = true;
          finishPipeline();
        },
        attachment.session.id,
      );
      expect(pipelineCancelled).toBe(true);

      releaseWrite();
      await writeSettled;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await runtime.stop();
    } finally {
      releaseWrite();
      await runtime.stop().catch(() => undefined);
    }
  });

  it("keeps session admission closed until timed-out terminal cleanup settles", async () => {
    vi.useFakeTimers();
    const baseStore = createInMemoryDurableRuntimeStore();
    let holdFirstEndWrite = true;
    let signalFirstEndWriteStarted!: () => void;
    let releaseFirstEndWrite!: () => void;
    let signalFirstEndWriteSettled!: () => void;
    const firstEndWriteStarted = new Promise<void>((resolve) => {
      signalFirstEndWriteStarted = resolve;
    });
    const firstEndWriteGate = new Promise<void>((resolve) => {
      releaseFirstEndWrite = resolve;
    });
    const firstEndWriteSettled = new Promise<void>((resolve) => {
      signalFirstEndWriteSettled = resolve;
    });
    const durableStore: DurableRuntimeStore = {
      ...baseStore,
      async runSessionTransaction<T>(
        sessionId: SessionId,
        lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
        operation: (tx: DurableSessionTransaction) => Promise<T>,
      ): Promise<T> {
        if (holdFirstEndWrite) {
          holdFirstEndWrite = false;
          signalFirstEndWriteStarted();
          try {
            await firstEndWriteGate;
            throw new Error("late terminal write failure");
          } finally {
            signalFirstEndWriteSettled();
          }
        }
        return baseStore.runSessionTransaction(sessionId, lease, operation);
      },
    };
    const runtime = new InMemoryRuntime({
      durableStore,
      durablePolicy: { ...DEFAULT_DURABLE_RUNTIME_POLICY, criticalWriteTimeoutMs: 1 },
    });
    let signalFinalizerStarted!: () => void;
    let releaseFinalizer!: () => void;
    const finalizerStarted = new Promise<void>((resolve) => {
      signalFinalizerStarted = resolve;
    });
    const finalizerGate = new Promise<void>((resolve) => {
      releaseFinalizer = resolve;
    });
    let finalizerCalls = 0;

    try {
      await runtime.start();
      const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
      const runtimeWithTapHooks = runtime as typeof runtime & {
        registerAudioTapFinalizer?(
          id: SessionId,
          finalize: () => AudioTapSummary | Promise<AudioTapSummary>,
        ): void;
      };
      runtimeWithTapHooks.registerAudioTapFinalizer?.(attachment.session.id, async () => {
        finalizerCalls += 1;
        signalFinalizerStarted();
        await finalizerGate;
        return { enabled: true, droppedFrames: 0, droppedEvents: 0, callbackErrors: 0 };
      });

      const firstEnd = runtime.endSession(attachment.session.id, { reason: "completed" });
      const firstEndRejected = expect(firstEnd).rejects.toThrow("Durable write exceeded 1ms");
      await firstEndWriteStarted;
      await vi.advanceTimersByTimeAsync(1);
      await firstEndRejected;
      await finalizerStarted;
      expect(finalizerCalls).toBe(1);
      expect(() => runtime.sessionClockMs(attachment.session.id)).toThrow();
      expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });

      const expectPipelineRejected = (): void => {
        let finishPipeline!: () => void;
        const pipelineRun = new Promise<void>((resolve) => {
          finishPipeline = resolve;
        });
        let pipelineCancelled = false;
        runtime.registerPipelineRun(
          pipelineRun,
          () => {
            pipelineCancelled = true;
            finishPipeline();
          },
          attachment.session.id,
        );
        expect(pipelineCancelled).toBe(true);
      };
      expectPipelineRejected();

      const acquireSpy = vi.spyOn(durableStore.leases, "acquire");
      const reattachment = runtime.attachSession(buildAgent(), attachment.session.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(acquireSpy).not.toHaveBeenCalled();

      releaseFirstEndWrite();
      await firstEndWriteSettled;
      await vi.advanceTimersByTimeAsync(0);
      expect(acquireSpy).not.toHaveBeenCalled();
      expectPipelineRejected();

      releaseFinalizer();
      await reattachment;
      expect(() => runtime.sessionClockMs(attachment.session.id)).not.toThrow();
      expect(finalizerCalls).toBe(1);
      await runtime.stop();
    } finally {
      releaseFirstEndWrite();
      releaseFinalizer();
      vi.useRealTimers();
    }
  });

  it("uses runtime organization and workflow defaults for new sessions", async () => {
    const runtime = createRuntime({
      defaultOrganizationId: "org_default" as never,
      defaultWorkflowId: "workflow_default" as never,
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });

    expect(session.metadata).toMatchObject({
      organizationId: "org_default",
      workflowId: "workflow_default",
    });
  });

  it("keeps legacy aggregate stores connected to the durable compatibility facade", async () => {
    const sessionStore = createInMemorySessionStore();
    const turnStore = createInMemoryTurnStore();
    const toolCallStore = createInMemoryToolCallStore();
    const runtime = createRuntime({ sessionStore, turnStore, toolCallStore });
    await runtime.start();

    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({ sessionId: session.id });

    await expect(sessionStore.get(session.id)).resolves.toMatchObject({
      session: { state: { currentTurnId: turn.id } },
    });
    await expect(turnStore.get(session.id, turn.id)).resolves.toMatchObject({
      turn: { id: turn.id },
    });
  });

  it("keeps pre-attachment lifecycle writes in the durable aggregate", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "before attach", mediaEventIds: [] },
    });
    await runtime.updateTurnStatus(session.id, turn.id, "thinking");
    await runtime.endTurn(session.id, turn.id, {
      reason: "completed",
      output: { text: "done", mediaEventIds: [] },
    });
    await runtime.endSession(session.id, { reason: "completed" });

    expect(
      durableStore.outbox.map(
        (event) =>
          `${event.aggregateType}:${(event.envelope.payload as { readonly status: string }).status}`,
      ),
    ).toEqual([
      "session:active",
      "turn:started",
      "session:active",
      "turn:thinking",
      "session:active",
      "turn:completed",
      "session:active",
      "session:completed",
    ]);
  });

  it("releases all per-session runtime state when calls end", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 1 });
    await runtime.endSession(session.id, { reason: "completed" });
    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });
  });

  it("bounds observation state across ordinary attachment detaches", async () => {
    const runtime = new InMemoryRuntime({ observationSink: { enqueue: () => undefined } });
    await runtime.start();

    for (let index = 0; index < 1_025; index += 1) {
      const attachment = await runtime.startAttachedSession(buildAgent(), {
        channel: "simulated",
      });
      await attachment.detach();
    }
    await runtime.stop();

    expect(runtime.observationStats().detachedSessionEvictions).toBeGreaterThan(0);
  });

  it("keeps observation writing internal and validates pipeline facts before changing chronology", async () => {
    const observations: RuntimeObservation[] = [];
    const runtime = new InMemoryRuntime({
      observationSink: { enqueue: (observation) => observations.push(observation) },
    });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    expect("recordObservation" in runtime).toBe(false);
    const recordPipelineObservation = (input: unknown): void =>
      recordRuntimePipelineObservation(runtime, input as RuntimePipelineObservationInput);
    const invalidInputs: unknown[] = [
      {
        name: "unknown.event",
        sessionId: session.id,
        atMs: 1,
      },
      {
        name: RUNTIME_OBSERVATION_NAMES.SESSION_END,
        sessionId: session.id,
        atMs: 1,
        attributes: { status: "completed" },
      },
      {
        name: RUNTIME_OBSERVATION_NAMES.TURN_START,
        sessionId: session.id,
        turnId: "turn id with spaces",
        atMs: 1,
      },
      {
        name: RUNTIME_OBSERVATION_NAMES.TURN_START,
        sessionId: session.id,
        turnId: "t".repeat(9_000),
        atMs: 1,
      },
      {
        name: RUNTIME_OBSERVATION_NAMES.TURN_START,
        sessionId: session.id,
        turnId: "turn-valid",
        atMs: 1e300,
      },
    ];

    for (const invalid of invalidInputs) {
      expect(() => recordPipelineObservation(invalid)).toThrow(InvalidArgumentError);
    }
    recordPipelineObservation({
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: session.id,
      turnId: "turn-valid" as TurnId,
      atMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.endSession(session.id, { reason: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observations.map((observation) => observation.sequence)).toEqual([1, 2, 3]);
    expect(observations.map((observation) => observation.name)).toEqual([
      RUNTIME_OBSERVATION_NAMES.SESSION_START,
      RUNTIME_OBSERVATION_NAMES.TURN_START,
      RUNTIME_OBSERVATION_NAMES.SESSION_END,
    ]);
    await runtime.stop();
  });

  it("counts pipeline facts that arrive after runtime observation shutdown", async () => {
    const runtime = new InMemoryRuntime({ observationSink: { enqueue: () => undefined } });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    await runtime.stop();

    recordRuntimePipelineObservation(runtime, {
      name: RUNTIME_OBSERVATION_NAMES.TURN_START,
      sessionId: session.id,
      turnId: "late-turn" as TurnId,
      atMs: 1,
    });

    expect(runtime.observationStats().shutdownDrops).toBe(1);
  });

  it("only cancels pipeline runs registered to the session being ended", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const agent = buildAgent();
    const first = await runtime.startSession(agent, { channel: "simulated" });
    const second = await runtime.startSession(agent, { channel: "simulated" });
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondRun = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const cancelled: SessionId[] = [];
    runtime.registerPipelineRun(
      firstRun,
      () => {
        cancelled.push(first.id);
        finishFirst();
      },
      first.id,
    );
    runtime.registerPipelineRun(
      secondRun,
      () => {
        cancelled.push(second.id);
        finishSecond();
      },
      second.id,
    );

    await runtime.endSession(first.id, { reason: "cancelled", cancelReason: "caller_hangup" });

    expect(cancelled).toEqual([first.id]);
    finishSecond();
    await secondRun;
    await runtime.endSession(second.id, { reason: "completed" });
    await runtime.stop();
  });

  it("cancels pipeline runs registered while session terminalization is in flight", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const persist = durableStore.runSessionTransaction.bind(durableStore);
    vi.spyOn(durableStore, "runSessionTransaction").mockImplementation(async (...args) => {
      signalWriteStarted();
      await writeGate;
      return persist(...args);
    });

    const ending = runtime.endSession(attachment.session.id, {
      reason: "cancelled",
      cancelReason: "caller_hangup",
    });
    await writeStarted;
    let finishRun!: () => void;
    const run = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let cancelled = false;
    runtime.registerPipelineRun(
      run,
      () => {
        cancelled = true;
        finishRun();
      },
      attachment.session.id,
    );

    expect(cancelled).toBe(true);
    releaseWrite();
    await ending;
    await run;
    await runtime.stop();
  });

  it("keeps pipeline admission closed while session-end hooks are running", async () => {
    let signalHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      signalHookStarted = resolve;
    });
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const runtime = new InMemoryRuntime({
      sessionMemoryFinalizeTimeoutMs: 20,
      onSessionEnd: async () => {
        signalHookStarted();
        await hookGate;
      },
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const ending = runtime.endSession(attachment.session.id, { reason: "completed" });
    let finishRun!: () => void;
    const run = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    let cancelled = false;

    try {
      await hookStarted;
      runtime.registerPipelineRun(
        run,
        () => {
          cancelled = true;
          finishRun();
        },
        attachment.session.id,
      );

      expect(cancelled).toBe(true);
    } finally {
      releaseHook();
      finishRun();
      await ending;
      await run;
      await runtime.stop();
    }
  });

  it("releases a failed-end session clock after its active pipeline settles", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore, durableStoreOwnership: "caller" });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    let finishRun!: () => void;
    const run = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    runtime.registerPipelineRun(run, () => undefined, attachment.session.id);
    vi.spyOn(durableStore, "runSessionTransaction").mockRejectedValueOnce(
      new Error("terminal write failed"),
    );

    await expect(
      runtime.endSession(attachment.session.id, { reason: "completed" }),
    ).rejects.toThrow("terminal write failed");
    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 1 });

    finishRun();
    await run;
    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });
    await runtime.stop();
  });

  it("releases a failed unattached session clock immediately", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore, durableStoreOwnership: "caller" });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const transactionStore = durableStore as typeof durableStore & {
      runUnfencedSessionTransaction: NonNullable<typeof durableStore.runUnfencedSessionTransaction>;
    };
    vi.spyOn(transactionStore, "runUnfencedSessionTransaction").mockRejectedValueOnce(
      new Error("terminal write failed"),
    );

    await expect(runtime.endSession(session.id, { reason: "completed" })).rejects.toThrow(
      "terminal write failed",
    );

    expect(runtime.debugStats()).toEqual({ activeSessionClocks: 0 });
    await runtime.stop();
  });

  it("retains a timed-out end clock until its active pipeline settles", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({
      durableStore,
      durableStoreOwnership: "caller",
      durablePolicy: { ...DEFAULT_DURABLE_RUNTIME_POLICY, criticalWriteTimeoutMs: 10 },
    });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    let finishPipeline!: () => void;
    const pipelineRun = new Promise<void>((resolve) => {
      finishPipeline = resolve;
    });
    runtime.registerPipelineRun(pipelineRun, () => undefined, attachment.session.id);
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let markWriteSettled!: () => void;
    const writeSettled = new Promise<void>((resolve) => {
      markWriteSettled = resolve;
    });
    let finishWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    vi.spyOn(durableStore, "runSessionTransaction").mockImplementation(async () => {
      markWriteStarted();
      try {
        await writeGate;
        throw new Error("late terminal write failed");
      } finally {
        markWriteSettled();
      }
    });

    try {
      const ending = runtime.endSession(attachment.session.id, { reason: "completed" });
      await writeStarted;
      await expect(ending).rejects.toThrow();
      expect(runtime.debugStats()).toEqual({ activeSessionClocks: 1 });

      finishWrite();
      await writeSettled;
      expect(runtime.debugStats()).toEqual({ activeSessionClocks: 1 });
      finishPipeline();
      await pipelineRun;
      await until(() => runtime.debugStats().activeSessionClocks === 0, "pipeline clock cleanup");
    } finally {
      finishWrite();
      finishPipeline();
      await runtime.stop();
    }
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

  it("rejects an agent whose declared provider cannot execute its policies", () => {
    const capabilities = {
      ...TEST_PROVIDER_CAPABILITIES,
      cancellation: { ...TEST_PROVIDER_CAPABILITIES.cancellation, request: false },
    } satisfies ProviderCapabilities;

    let failure: unknown;
    try {
      buildAgent({ providers: { tts: { ...stubTts, capabilities } } });
    } catch (error) {
      failure = error;
    }

    expect(isNormalizedError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "agent.provider_incompatible",
      category: "validation",
      metadata: {
        provider: "stub-tts",
        issues: [
          {
            code: "cancellation.unsupported",
            requirement: "cancellation.request",
          },
        ],
      },
    });
  });

  it("reserves the runtime-managed memory tool name", () => {
    const memoryTool = defineTool({
      id: "custom_memory_tool",
      name: "remember_fact",
      description: "custom",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });

    expect(() =>
      defineAgent({
        ...buildAgent(),
        tools: [memoryTool],
      }),
    ).toThrow(/managed by the runtime/i);
  });

  it("requires LLM function calling when the runtime injects remember_fact", () => {
    const baseAgent = buildAgent();
    const capabilities = {
      ...TEST_PROVIDER_CAPABILITIES,
      tools: { ...TEST_PROVIDER_CAPABILITIES.tools, functionCalling: false },
    } satisfies ProviderCapabilities;

    let failure: unknown;
    try {
      defineAgent({
        ...baseAgent,
        tools: [],
        memoryPolicy: {
          enabled: true,
          scopes: ["session"],
          canLlmWrite: true,
        },
        providers: {
          ...baseAgent.providers,
          llm: { ...baseAgent.providers.llm, capabilities },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(isNormalizedError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "agent.provider_incompatible",
      category: "validation",
      metadata: {
        provider: "stub-llm",
        issues: [
          {
            code: "tools.unsupported",
            requirement: "functionCalling",
          },
        ],
      },
    });
  });

  it("allows TTS request cancellation plus transport clearing without native output stop", () => {
    const capabilities = {
      ...TEST_PROVIDER_CAPABILITIES,
      cancellation: { ...TEST_PROVIDER_CAPABILITIES.cancellation, output: false },
    } satisfies ProviderCapabilities;

    expect(() => buildAgent({ providers: { tts: { ...stubTts, capabilities } } })).not.toThrow();
  });

  it("persists the queued, running, and terminal tool lifecycle under a lease", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "book it", mediaEventIds: [] },
    });
    const queued = {
      status: "queued" as const,
      toolCallId: "tool_lifecycle" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: timestamp,
    };
    const running = await runtime.startToolCall(queued);
    expect(running.status).toBe("running");
    await runtime.finishToolCall({
      ...running,
      status: "succeeded",
      endedAt: timestamp,
      output: { ok: true },
    });
    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      toolCalls: [{ status: "succeeded", output: { ok: true } }],
    });
    await attachment.detach();
  });

  it("terminalizes open turns and tools when a session ends", async () => {
    const runtime = new InMemoryRuntime({ holderId: "end_open_children" });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: attachment.session.id,
      input: { transcript: "stop now", mediaEventIds: [] },
    });
    const queued: Parameters<typeof runtime.startToolCall>[0] = {
      status: "queued",
      toolCallId: "open_tool" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: timestamp,
    };
    await runtime.startToolCall(queued);

    await runtime.endSession(attachment.session.id, {
      reason: "cancelled",
      cancelReason: "caller_hangup",
    });

    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      session: { status: "cancelled", state: { pendingToolCallIds: [] } },
      turns: [{ id: turn.id, status: "cancelled", reason: "transport_lost" }],
      toolCalls: [
        {
          toolCallId: "open_tool",
          status: "cancelled",
          error: { code: "tool.session_ended" },
        },
      ],
    });

    await expect(
      runtime.endTurn(attachment.session.id, turn.id, {
        reason: "completed",
        output: { text: "late", mediaEventIds: [] },
      }),
    ).resolves.toMatchObject({ status: "cancelled", reason: "transport_lost" });
    await expect(
      runtime.finishToolCall({
        ...queued,
        status: "succeeded",
        startedAt: timestamp,
        endedAt: timestamp,
        output: { late: true },
      }),
    ).resolves.toMatchObject({ status: "cancelled", error: { code: "tool.session_ended" } });
  });

  it("keeps the legacy recordToolCall path in the session aggregate", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore });
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({ sessionId: session.id });
    const queued: Parameters<typeof runtime.recordToolCall>[0] = {
      status: "queued",
      toolCallId: "legacy_recorded" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: timestamp,
    };

    await runtime.recordToolCall(queued);

    await expect(runtime.inspectSession(session.id)).resolves.toMatchObject({
      session: { state: { pendingToolCallIds: ["legacy_recorded"] } },
      toolCalls: [{ toolCallId: "legacy_recorded", status: "queued" }],
    });
  });

  it("rejects a terminal tool payload that changes persisted call identity", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({ sessionId: attachment.session.id });
    const queued: Parameters<typeof runtime.startToolCall>[0] = {
      status: "queued",
      toolCallId: "identity_tool" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: { original: true },
      attempts: 1,
      queuedAt: timestamp,
    };
    await runtime.startToolCall(queued);

    await expect(
      runtime.finishToolCall({
        ...queued,
        turnId: "different_turn" as TurnId,
        status: "succeeded",
        startedAt: timestamp,
        endedAt: timestamp,
        output: { shouldNotPersist: true },
      }),
    ).rejects.toMatchObject({ code: "RECORD_CONFLICT" });
    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      toolCalls: [{ toolCallId: "identity_tool", status: "running", turnId: turn.id }],
    });
    await attachment.detach();
  });

  it("does not let a stale queued tool snapshot downgrade a running call", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    const turn = await runtime.startTurn({ sessionId: attachment.session.id });
    const queued = {
      status: "queued" as const,
      toolCallId: "stale_tool" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: attachment.session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: timestamp,
    };

    await runtime.startToolCall(queued);
    await runtime.recordToolCall(queued);

    await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
      toolCalls: [{ toolCallId: "stale_tool", status: "running" }],
    });
    await attachment.detach();
  });

  it("rejects a duplicate attachment while the first attachment is starting", async () => {
    const runtime = new InMemoryRuntime();
    await runtime.start();
    const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
    const first = runtime.attachSession(buildAgent(), session.id, { holderId: "duplicate_guard" });

    await expect(
      runtime.attachSession(buildAgent(), session.id, { holderId: "duplicate_guard" }),
    ).rejects.toBeInstanceOf(Error);
    const attachment = await first;
    await attachment.detach();
  });

  it("rejects session end while an attachment is finalizing", async () => {
    const clock = new ManualClock();
    const durableStore = createInMemoryDurableRuntimeStore({
      nowMs: () => Date.parse(clock.now()),
    });
    const runtime = new InMemoryRuntime({ durableStore, clock });
    let holdAttachResponse = false;
    let signalAttachCommit!: () => void;
    let releaseAttachResponse!: () => void;
    const attachCommitted = new Promise<void>((resolve) => {
      signalAttachCommit = resolve;
    });
    const attachResponseGate = new Promise<void>((resolve) => {
      releaseAttachResponse = resolve;
    });
    const persist = durableStore.runSessionTransaction.bind(durableStore);
    vi.spyOn(durableStore, "runSessionTransaction").mockImplementation(async (...args) => {
      const result = await persist(...args);
      if (holdAttachResponse) {
        holdAttachResponse = false;
        signalAttachCommit();
        await attachResponseGate;
      }
      return result;
    });
    let attachment: Promise<unknown> | undefined;

    try {
      await runtime.start();
      const session = await runtime.startSession(buildAgent(), { channel: "simulated" });
      holdAttachResponse = true;
      attachment = runtime.attachSession(buildAgent(), session.id);
      await attachCommitted;
      const lease = durableStore.currentLease(session.id);
      expect(lease).not.toBeNull();
      clock.advance(lease!.expiresAtMs - Date.parse(clock.now()));

      await expect(runtime.endSession(session.id, { reason: "completed" })).rejects.toBeInstanceOf(
        LeaseUnavailableError,
      );
      await expect(runtime.getSession(session.id)).resolves.toMatchObject({ status: "active" });

      releaseAttachResponse();
      await expect(attachment).rejects.toBeInstanceOf(LeaseLostError);
      await expect(runtime.getSession(session.id)).resolves.toMatchObject({ status: "active" });
      const terminal = await runtime.endSession(session.id, { reason: "completed" });
      expect(terminal.status).toBe("completed");
      expect(() => runtime.sessionClockMs(session.id)).toThrow();
    } finally {
      releaseAttachResponse();
      await attachment?.catch(() => undefined);
      await runtime.stop();
    }
  });

  it("creates the first lease and session outbox event in one durable operation", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runtime = new InMemoryRuntime({ durableStore, holderId: "runtime_test" });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), {
      channel: "simulated",
    });
    expect(attachment.lease?.fence).toBe(1);
    expect(durableStore.outbox).toHaveLength(1);
    expect(durableStore.outbox[0]).toMatchObject({
      aggregateType: "session",
      version: 1,
      fence: 1,
    });
    await attachment.detach();
  });

  it("reports persistence degradation without stopping lease renewal", async () => {
    const runtime = new InMemoryRuntime({ holderId: "health_test" });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildAgent(), { channel: "simulated" });
    runtime.setPersistenceHealth(attachment.session.id, true);
    expect(attachment.health).toBe("persistence_degraded");
    runtime.setPersistenceHealth(attachment.session.id, false);
    expect(attachment.health).toBe("healthy");
    await attachment.detach();
  });

  it("marks a hung renewal lost as soon as its lease expires", async () => {
    vi.useFakeTimers();
    const sessionId = "hung_renewal_session" as SessionId;
    let wallNowMs = 0;
    let monotonicNowMs = 0;
    const clock: Clock = {
      now: () => new Date(wallNowMs).toISOString() as Timestamp,
      monotonicMs: () => monotonicNowMs,
    };
    const lease: SessionLease = {
      sessionId,
      holder: "hung_renewal_holder",
      fence: 1,
      generationId: "hung_renewal_generation",
      acquiredAtMs: 0,
      renewedAtMs: 0,
      expiresAtMs: 1_000,
    };
    const state: RuntimeAttachmentState = {
      agent: buildAgent(),
      controller: new AbortController(),
      lease,
      holder: lease.holder,
      health: "healthy",
    };
    const durableStore = createInMemoryDurableRuntimeStore();
    const neverRenew = new Promise<SessionLease | null>(() => undefined);
    vi.spyOn(durableStore.leases, "renew").mockReturnValue(neverRenew);
    const context = {
      clock,
      durableStore: durableStore as DurableRuntimeStore,
      policy: {
        ...DEFAULT_DURABLE_RUNTIME_POLICY,
        leaseTtlMs: 2_000,
        leaseHeartbeatMs: 100,
        persistenceRecoveryGraceMs: 10_000,
      },
      emitMetric: () => undefined,
    };

    try {
      const firstRenewal = renewLease(sessionId, state, context);
      monotonicNowMs = 75;
      await vi.advanceTimersByTimeAsync(75);
      await firstRenewal;
      expect(state.health).toBe("healthy");
      expect(state.renewalInFlight).toBeDefined();

      wallNowMs = lease.expiresAtMs;
      monotonicNowMs = 80;
      await renewLease(sessionId, state, context);

      expect(state.health).toBe("lease_lost");
      expect(state.controller.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("coordinates expired-session attach and reaps sessions without a transport", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const first = new InMemoryRuntime({ durableStore, holderId: "recovery_first" });
    await first.start();
    const session = await first.startAttachedSession(buildAgent(), { channel: "simulated" });
    await session.detach();

    const second = new InMemoryRuntime({ durableStore, holderId: "recovery_second" });
    await second.start();
    const coordinator = new SessionRecoveryCoordinator({
      runtime: second,
      durableStore,
      resolveAgent: async () => buildAgent(),
      hasReconnectableTransport: async () => true,
      activator: {
        activate: async ({ attachment }) => attachment.detach(),
      },
      holderId: "recovery_second",
      policy: { recoveryGraceMs: 0 },
    });
    await expect(coordinator.pollOnce()).resolves.toEqual({
      candidates: 1,
      attached: 1,
      failed: 0,
    });

    const reaper = new SessionReaper({
      runtime: second,
      durableStore,
      resolveAgent: async () => buildAgent(),
      holderId: "recovery_second",
      hasReconnectableTransport: async () => false,
      policy: { recoveryGraceMs: 0 },
    });
    await expect(reaper.reapOnce()).resolves.toBe(1);
    await expect(second.getSession(session.session.id)).resolves.toMatchObject({
      status: "cancelled",
      cancelReason: "recovery_expired",
    });
  });

  it("repairs orphaned turns and running tools in the attach transaction", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const first = new InMemoryRuntime({ durableStore, holderId: "first" });
    await first.start();
    const session = await first.startSession(buildAgent(), { channel: "simulated" });
    const attachment = await first.attachSession(buildAgent(), session.id, {
      holderId: "first",
    });
    const turn = await first.startTurn({
      sessionId: session.id,
      input: { transcript: "orphan", mediaEventIds: [] },
    });
    const queued = {
      status: "queued" as const,
      toolCallId: "queued_recovery" as ToolCallId,
      toolId: "tool" as ToolId,
      toolName: "tool" as ToolName,
      sessionId: session.id,
      turnId: turn.id,
      input: {},
      attempts: 1,
      queuedAt: timestamp,
    };
    await durableStore.toolCalls.put({
      toolCall: queued,
      runtime: { monotonicQueuedAtMs: 0 },
    });
    await first.startToolCall({ ...queued, toolCallId: "running_recovery" as ToolCallId });
    await attachment.detach();

    const second = new InMemoryRuntime({ durableStore, holderId: "second" });
    await second.start();
    const recovered = await second.attachSession(buildAgent(), session.id, {
      holderId: "second",
    });
    expect(recovered.snapshot.turns[0]).toMatchObject({
      status: "cancelled",
      reason: "runtime_restarted",
    });
    expect(recovered.snapshot.session.state.pendingToolCallIds).toEqual(["queued_recovery"]);
    expect(recovered.snapshot.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "running_recovery",
          status: "failed",
          metadata: { recovery: "ambiguous" },
        }),
      ]),
    );
    await recovered.detach();
  });

  it("derives recovered turn duration from persisted timestamps, not the new runtime clock", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const firstClock: Clock = {
      now: () => "2026-05-20T00:00:00.000Z" as Timestamp,
      monotonicMs: () => 100_000,
    };
    const first = new InMemoryRuntime({
      durableStore,
      holderId: "duration_first",
      clock: firstClock,
    });
    await first.start();
    const session = await first.startSession(buildAgent(), { channel: "simulated" });
    const attachment = await first.attachSession(buildAgent(), session.id, {
      holderId: "duration_first",
    });
    await first.startTurn({
      sessionId: session.id,
      input: { transcript: "recover duration", mediaEventIds: [] },
    });
    await attachment.detach();

    const secondClock: Clock = {
      now: () => "2026-05-20T00:00:12.000Z" as Timestamp,
      monotonicMs: () => 10,
    };
    const second = new InMemoryRuntime({
      durableStore,
      holderId: "duration_second",
      clock: secondClock,
    });
    await second.start();
    const recovered = await second.attachSession(buildAgent(), session.id, {
      holderId: "duration_second",
    });

    expect(recovered.snapshot.turns[0]).toMatchObject({
      status: "cancelled",
      reason: "runtime_restarted",
      latency: { totalMs: 12_000 },
    });
    await recovered.detach();
    await Promise.all([first.stop(), second.stop()]);
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
