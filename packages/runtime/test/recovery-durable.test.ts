import { describe, expect, it, vi } from "vitest";

import { BackendUnavailableError } from "@tvic/core";
import { LeaseLostError } from "@tvic/core";
import type {
  AgentId,
  Clock,
  DurableSessionTransaction,
  FailedSession,
  Runtime,
  SessionLease,
  SessionId,
  StoredSessionRecord,
  Timestamp,
  TextToSpeechProvider,
  TtsStream,
} from "@tvic/core";
import { createInMemoryDurableRuntimeStore, InMemorySessionLeaseStore } from "@tvic/dal";
import { InMemoryToolIdempotencyStore } from "@tvic/tools";
import { createRuntime, PipelineVoiceLoop, type VoiceEvent } from "../src/index.js";
import { SessionRecoveryCoordinator, SessionReaper } from "../src/session-recovery.js";
import {
  audioChunk,
  buildAgent,
  llmEvent,
  makeCallHandle,
  makeLlm,
  makeStt,
  makeTts,
  pushable,
  streamEnded,
  streamStarted,
  TEST_PROVIDER_CAPABILITIES,
  until,
  withPipelineProviders,
} from "./harness.js";

describe("R2-06 recovery and durable correctness", () => {
  it("reports when coordinator stop times out before an in-flight poll drains", async () => {
    vi.useFakeTimers();
    const store = createInMemoryDurableRuntimeStore();
    const sessionId = "recovery_stop_drain_timeout" as SessionId;
    const timestamp = new Date().toISOString() as Timestamp;
    const record: StoredSessionRecord = {
      session: {
        id: sessionId,
        agentId: "recovery_stop_agent" as AgentId,
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 0 },
    };
    const candidate = { sessionId, fence: 1, generationId: "stop_drain_generation" };
    store.leases.listRecoveryCandidates = async () => ({ candidates: [candidate] });
    vi.spyOn(store.sessions, "get").mockResolvedValue(record);
    let resolveTransportCheck!: (hasTransport: boolean) => void;
    const transportCheck = new Promise<boolean>((resolve) => {
      resolveTransportCheck = resolve;
    });
    let resolveTransportEntered!: () => void;
    const transportEntered = new Promise<void>((resolve) => {
      resolveTransportEntered = resolve;
    });
    const coordinator = new SessionRecoveryCoordinator({
      runtime: createRuntime({ durableStore: store }),
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => {
        resolveTransportEntered();
        return transportCheck;
      },
      activator: { activate: async () => undefined },
      holderId: "recovery_stop_drain_test",
    });
    let poll: Promise<unknown> | undefined;

    try {
      poll = coordinator.pollOnce();
      await transportEntered;
      const stopping = coordinator.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(stopping).resolves.toBe(false);

      resolveTransportCheck(true);
      await poll;
      await expect(coordinator.stop()).resolves.toBe(true);
    } finally {
      resolveTransportCheck(true);
      await poll?.catch(() => undefined);
      await coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("reports coordinator poll failures from its timer and retries on the next interval", async () => {
    vi.useFakeTimers();
    const store = createInMemoryDurableRuntimeStore();
    const failure = new BackendUnavailableError("recovery store unavailable");
    let polls = 0;
    store.leases.listRecoveryCandidates = async () => {
      polls += 1;
      if (polls === 1) throw failure;
      return { candidates: [] };
    };
    const onError = vi.fn();
    const metrics: Array<{ readonly name: string; readonly value: number }> = [];
    const coordinator = new SessionRecoveryCoordinator({
      runtime: createRuntime({ durableStore: store }),
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      activator: { activate: async () => undefined },
      holderId: "recovery_timer_error_test",
      policy: { recoveryPollMs: 10 },
      onError,
      onMetric: (metric) => metrics.push(metric),
    });

    try {
      coordinator.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(polls).toBe(2);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(metrics).toContainEqual({ name: "session.recovery.poll_failed", value: 1 });
    } finally {
      await coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("reports reaper poll failures from its timer and retries on the next interval", async () => {
    vi.useFakeTimers();
    const store = createInMemoryDurableRuntimeStore();
    const failure = new BackendUnavailableError("reaper store unavailable");
    let polls = 0;
    store.leases.listRecoveryCandidates = async () => {
      polls += 1;
      if (polls === 1) throw failure;
      return { candidates: [] };
    };
    const onError = vi.fn();
    const metrics: Array<{ readonly name: string; readonly value: number }> = [];
    const reaper = new SessionReaper({
      runtime: createRuntime({ durableStore: store }),
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      holderId: "reaper_timer_error_test",
      policy: { recoveryPollMs: 10 },
      onError,
      onMetric: (metric) => metrics.push(metric),
    });

    try {
      reaper.start();
      await vi.advanceTimersByTimeAsync(20);
      expect(polls).toBe(2);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(failure);
      expect(metrics).toContainEqual({ name: "session.reaper.poll_failed", value: 1 });
    } finally {
      await reaper.stop();
      vi.useRealTimers();
    }
  });

  it("reports a shared in-flight poll failure once per worker", async () => {
    vi.useFakeTimers();
    const recoveryStore = createInMemoryDurableRuntimeStore();
    const reaperStore = createInMemoryDurableRuntimeStore();
    const failure = new BackendUnavailableError("recovery poll unavailable");
    const recoveryQuery = vi.fn();
    const reaperQuery = vi.fn();
    let rejectRecovery!: (error: unknown) => void;
    let rejectReaper!: (error: unknown) => void;
    const recoveryPage: ReturnType<typeof recoveryStore.leases.listRecoveryCandidates> =
      new Promise((_resolve, reject) => {
        rejectRecovery = reject;
      });
    const reaperPage: ReturnType<typeof reaperStore.leases.listRecoveryCandidates> = new Promise(
      (_resolve, reject) => {
        rejectReaper = reject;
      },
    );
    recoveryStore.leases.listRecoveryCandidates = () => {
      recoveryQuery();
      return recoveryPage;
    };
    reaperStore.leases.listRecoveryCandidates = () => {
      reaperQuery();
      return reaperPage;
    };
    const recoveryOnError = vi.fn();
    const recoveryMetrics = vi.fn();
    const reaperOnError = vi.fn();
    const reaperMetrics = vi.fn();
    const coordinator = new SessionRecoveryCoordinator({
      runtime: createRuntime({ durableStore: recoveryStore }),
      durableStore: recoveryStore,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      activator: { activate: async () => undefined },
      holderId: "recovery_shared_poll_test",
      policy: { recoveryPollMs: 10 },
      onError: recoveryOnError,
      onMetric: recoveryMetrics,
    });
    const reaper = new SessionReaper({
      runtime: createRuntime({ durableStore: reaperStore }),
      durableStore: reaperStore,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      holderId: "reaper_shared_poll_test",
      policy: { recoveryPollMs: 10 },
      onError: reaperOnError,
      onMetric: reaperMetrics,
    });

    try {
      coordinator.start();
      reaper.start();
      await vi.advanceTimersByTimeAsync(30);
      expect(recoveryQuery).toHaveBeenCalledTimes(1);
      expect(reaperQuery).toHaveBeenCalledTimes(1);
      const recoveryPoll = coordinator.pollOnce();
      const reaperPoll = reaper.reapOnce();

      rejectRecovery(failure);
      rejectReaper(failure);
      await Promise.all([recoveryPoll.catch(() => undefined), reaperPoll.catch(() => undefined)]);

      expect(recoveryOnError).toHaveBeenCalledTimes(1);
      expect(recoveryMetrics).toHaveBeenCalledWith({
        name: "session.recovery.poll_failed",
        value: 1,
      });
      expect(recoveryMetrics).toHaveBeenCalledTimes(1);
      expect(reaperOnError).toHaveBeenCalledTimes(1);
      expect(reaperMetrics).toHaveBeenCalledWith({
        name: "session.reaper.poll_failed",
        value: 1,
      });
      expect(reaperMetrics).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([coordinator.stop(), reaper.stop()]);
      vi.useRealTimers();
    }
  });

  it("retains continuation cursors across empty recovery and reaper pages", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const runtime = createRuntime({ durableStore: store });
    const seenCursors: Array<string | undefined> = [];
    let page = 0;
    store.leases.listRecoveryCandidates = async ({ cursor }) => {
      seenCursors.push(cursor);
      page += 1;
      return page === 1 ? { candidates: [], nextCursor: "continue" } : { candidates: [] };
    };

    const coordinator = new SessionRecoveryCoordinator({
      runtime,
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      activator: { activate: async () => undefined },
      holderId: "recovery_cursor_test",
    });
    await coordinator.pollOnce();
    await coordinator.pollOnce();
    expect(seenCursors).toEqual([undefined, "continue"]);

    seenCursors.length = 0;
    page = 0;
    const reaper = new SessionReaper({
      runtime,
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      holderId: "reaper_cursor_test",
    });
    await reaper.reapOnce();
    await reaper.reapOnce();
    expect(seenCursors).toEqual([undefined, "continue"]);
  });

  it("acknowledges only candidates confirmed missing, not candidates with read failures", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const missingId = "missing_recovery_session" as SessionId;
    const unavailableId = "unavailable_recovery_session" as SessionId;
    const confirmedMissing = { sessionId: missingId, fence: 1, generationId: "missing_generation" };
    const unreadable = {
      sessionId: unavailableId,
      fence: 2,
      generationId: "unavailable_generation",
    };
    const acknowledge = vi.fn(async () => undefined);
    const readFailure = new Error("temporary session store failure");
    const onError = vi.fn();
    store.leases.listRecoveryCandidates = async () => ({
      candidates: [confirmedMissing, unreadable],
    });
    store.leases.acknowledgeRecoveryCandidate = acknowledge;
    vi.spyOn(store.sessions, "get").mockImplementation(async (sessionId) => {
      if (sessionId === missingId) return null;
      throw readFailure;
    });

    const coordinator = new SessionRecoveryCoordinator({
      runtime: createRuntime({ durableStore: store }),
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      activator: { activate: async () => undefined },
      holderId: "recovery_ack_test",
      onError,
    });

    await coordinator.pollOnce();

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(confirmedMissing);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(readFailure);
  });

  it("reports reaper candidate failures without acknowledging them", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const candidate = {
      sessionId: "unreadable_reaper_session" as SessionId,
      fence: 3,
      generationId: "unreadable_reaper_generation",
    };
    const failure = new Error("temporary reaper store failure");
    const acknowledge = vi.fn(async () => undefined);
    const onError = vi.fn();
    store.leases.listRecoveryCandidates = async () => ({ candidates: [candidate] });
    store.leases.acknowledgeRecoveryCandidate = acknowledge;
    vi.spyOn(store.sessions, "get").mockRejectedValue(failure);

    const reaper = new SessionReaper({
      runtime: createRuntime({ durableStore: store }),
      durableStore: store,
      resolveAgent: async () => null,
      hasReconnectableTransport: async () => false,
      holderId: "reaper_candidate_error_test",
      onError,
    });

    await expect(reaper.reapOnce()).resolves.toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("retires the lease after the reaper terminalizes its session", async () => {
    let now = 50_000;
    const store = createInMemoryDurableRuntimeStore({ nowMs: () => now });
    const clock: Clock = {
      now: () => new Date(now).toISOString() as Timestamp,
      monotonicMs: () => now,
    };
    const runtime = createRuntime({ durableStore: store, clock });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    await attachment.detach();

    const reaper = new SessionReaper({
      runtime,
      durableStore: store,
      resolveAgent: async () => agent,
      holderId: "reaper_ack_test",
      hasReconnectableTransport: async () => false,
      policy: { recoveryGraceMs: 0 },
      nowMs: () => now,
    });

    try {
      expect(await reaper.reapOnce()).toBe(1);
      await expect(store.leases.listRecoveryCandidates({ nowMs: now, limit: 10 })).resolves.toEqual(
        { candidates: [] },
      );
    } finally {
      await runtime.stop();
    }
  });

  it("1. expired lease cannot commit fenced; steal goes lease_lost immediately", async () => {
    let now = 1_000_000;
    const leases = new InMemorySessionLeaseStore(() => now);
    const a = await leases.acquire("session_1" as never, "A", 3_000);
    expect(a?.fence).toBe(1);
    expect((await leases.acquire("session_1" as never, "A", 3_000))?.fence).toBe(1);
    now += 3_001;
    expect(await leases.get("session_1" as never)).toBeNull();
    const b = await leases.acquire("session_1" as never, "B", 3_000);
    expect(b?.fence).toBe(2);
    expect(await leases.renew("session_1" as never, "A", 1, 3_000, a!.generationId)).toBeNull();
    expect(await leases.renew("session_1" as never, "B", 2, 3_000, b!.generationId)).not.toBeNull();
  });

  it("3. unfenced write against a live fenced owner is rejected (never last-writer-wins)", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const runtime = createRuntime({ durableStore: store });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const id = attachment.session.id;
    await expect(store.runUnfencedSessionTransaction!(id, async () => {})).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await attachment.detach();
    await runtime.stop();
  });

  it("4. outbox dedupes by id; in-memory outbox bounded at 512", async () => {
    const store = createInMemoryDurableRuntimeStore();
    const runtime = createRuntime({ durableStore: store });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    expect(store.outbox.length).toBeGreaterThan(0);
    expect(store.outbox.length).toBeLessThanOrEqual(512);
    for (let i = 0; i < 130; i += 1) {
      const turn = await runtime.startTurn({
        sessionId: session.id,
        input: { transcript: `flood ${i}`, mediaEventIds: [] },
      });
      await runtime.endTurn(session.id, turn.id, {
        reason: "completed",
        output: { text: `reply ${i}`, mediaEventIds: [] },
      });
    }
    expect(store.outbox.length).toBeLessThanOrEqual(512);
    await runtime.endSession(session.id, { reason: "completed" });
    expect(store.outbox.length).toBeLessThanOrEqual(512);
    expect(store.outbox.at(-1)?.sessionId).toBe(session.id);
    await runtime.stop();
  });

  it("5. idempotency takeover matrix (same-owner retry / steal / conflict / stale complete)", async () => {
    let now = 7_000_000;
    const leases = new InMemorySessionLeaseStore(() => now);
    const lease1 = await leases.acquire("session_m" as never, "A", 10_000);
    const readLease = () => {
      const found = leases.getCurrent("session_m" as never);
      return found
        ? {
            holder: found.holder,
            fence: found.fence,
            generationId: found.generationId,
            expiresAtMs: found.expiresAtMs,
          }
        : null;
    };
    const store = new InMemoryToolIdempotencyStore(() => now, readLease);
    const claim = {
      key: "k1",
      lease: {
        sessionId: "session_m" as never,
        holder: "A",
        fence: lease1!.fence,
        generationId: lease1!.generationId,
      },
      requestHash: "h1",
      owner: "owner-a",
      ttlMs: 60_000,
    };
    const first = await store.claim(claim);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("expected the first claim to be acquired");
    await expect(store.claim(claim)).resolves.toEqual({
      status: "in_progress",
      record: first.record,
    });
    await expect(
      store.claim({ ...claim, requestHash: "h2", owner: "owner-b" }),
    ).resolves.toMatchObject({ status: "conflict" });
    now += 10_001;
    const lease2 = await leases.acquire("session_m" as never, "B", 10_000);
    const stolen = await store.claim({
      key: "k1",
      lease: {
        sessionId: "session_m" as never,
        holder: "B",
        fence: lease2!.fence,
        generationId: lease2!.generationId,
      },
      requestHash: "h1",
      owner: "owner-b",
      ttlMs: 60_000,
    });
    expect(stolen.status).toBe("claimed");
    await expect(
      store.complete("k1", "h1", {
        status: "succeeded",
        ttlMs: 60_000,
        owner: "owner-a",
        lease: {
          sessionId: "session_m" as never,
          holder: "A",
          fence: lease1!.fence,
          generationId: lease1!.generationId,
        },
        output: {},
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await store.complete("k1", "h1", {
      status: "succeeded",
      ttlMs: 60_000,
      owner: "owner-b",
      lease: {
        sessionId: "session_m" as never,
        holder: "B",
        fence: lease2!.fence,
        generationId: lease2!.generationId,
      },
      output: { ok: true },
    });
    await store.claim({
      key: "k2",
      requestHash: "h9",
      owner: "owner-b",
      ttlMs: 60_000,
    });
    await store.complete("k2", "h9", {
      status: "succeeded",
      ttlMs: 60_000,
      owner: "owner-b",
      output: { a: 1, b: 2 },
    });
  });

  it("8+11. reaper vs coordinator: exactly one wins on an expired session", async () => {
    let now = 50_000_000;
    const store = createInMemoryDurableRuntimeStore({ nowMs: () => now });
    const runtimeA = createRuntime({ durableStore: store });
    const runtimeB = createRuntime({ durableStore: store });
    await runtimeA.start();
    await runtimeB.start();
    const agent = buildAgent();
    const attachment = await runtimeA.startAttachedSession(agent, { channel: "simulated" });
    const sessionId = attachment.session.id;
    await attachment.detach();
    now += 30_000;
    let activated = 0;
    const coordinator = new SessionRecoveryCoordinator({
      runtime: runtimeA,
      durableStore: store,
      resolveAgent: async () => agent,
      hasReconnectableTransport: async () => true,
      activator: {
        activate: async () => {
          activated += 1;
        },
      },
      holderId: "holder-a",
      policy: { recoveryGraceMs: 0 },
      nowMs: () => now,
    });
    const reaper = new SessionReaper({
      runtime: runtimeB,
      durableStore: store,
      resolveAgent: async () => agent,
      holderId: "holder-b",
      hasReconnectableTransport: async () => false,
      policy: { recoveryGraceMs: 0 },
      nowMs: () => now,
    });
    const [poll, reaped] = await Promise.all([coordinator.pollOnce(), reaper.reapOnce()]);
    expect(poll.attached + reaped).toBe(1);
    expect(activated + reaped).toBe(1);
    const terminal = await runtimeA.getSession(sessionId).catch(() => null);
    void terminal;
    await runtimeA.stop();
    await runtimeB.stop();
  });

  it("deactivates partial host registration when recovery activation fails", async () => {
    let now = 50_000_000;
    const store = createInMemoryDurableRuntimeStore({ nowMs: () => now });
    const runtime = createRuntime({ durableStore: store });
    await runtime.start();
    const agent = buildAgent();
    const original = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const sessionId = original.session.id;
    await original.detach();
    now += 30_000;

    const activationError = new Error("host activation failed after registration");
    const activate = vi.fn(async () => {
      throw activationError;
    });
    const deactivate = vi.fn(async () => undefined);
    const onError = vi.fn();
    const coordinator = new SessionRecoveryCoordinator({
      runtime,
      durableStore: store,
      resolveAgent: async () => agent,
      hasReconnectableTransport: async () => true,
      activator: { activate, deactivate },
      holderId: "recovery_activation_rollback",
      policy: { recoveryGraceMs: 0 },
      nowMs: () => now,
      onError,
    });

    try {
      await expect(coordinator.pollOnce()).resolves.toMatchObject({ attached: 0, failed: 1 });
      expect(activate).toHaveBeenCalledTimes(1);
      expect(deactivate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, agent, attachment: expect.any(Object) }),
      );
      expect(onError).toHaveBeenCalledWith(activationError);
    } finally {
      await runtime.stop();
    }
  });

  it("10. stop mid-flight leaves no post-stop writes and clears clocks", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "hi", mediaEventIds: [] },
    });
    await runtime.stop();
    const stats = runtime as unknown as { debugStats(): { activeSessionClocks: number } };
    expect(stats.debugStats().activeSessionClocks).toBe(0);
  });

  it("rejected turn write surfaces durable.write.failure degradation once", async () => {
    const store = createInMemoryDurableRuntimeStore();
    let failNext = false;
    const sessions = store.sessions;
    const originalGet = sessions.get.bind(sessions);
    sessions.get = (async (id: never) => {
      if (failNext) {
        failNext = false;
        throw new BackendUnavailableError("db down");
      }
      return originalGet(id);
    }) as typeof sessions.get;
    const runtime = createRuntime({ durableStore: store });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    failNext = true;
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "admit me");
    stt.pushFinal(session.id, "ignored after failure");
    call.push(streamEnded(session.id, "completed"));
    await running.catch(() => undefined);
    await draining;
    const terminal = await runtime.getSession(session.id);
    expect(terminal?.status).toBe("failed");
    const errors = seen.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const event of errors) {
      if (event.kind === "error") {
        expect(event.error.code).toBe("durable.write.failure");
        expect(event.error.metadata).toMatchObject({ degraded: true });
      }
    }
    await runtime.stop();
  });

  it("ends the call when write failures follow a late committed and cancelled turn", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let putTurnCalls = 0;
    let writesBroken = false;
    let signalFirstPutEntered!: () => void;
    let releaseFirstPut!: () => void;
    const firstPutEntered = new Promise<void>((resolve) => {
      signalFirstPutEntered = resolve;
    });
    const firstPutRelease = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) =>
      runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "putTurn") {
              return async (...args: Parameters<DurableSessionTransaction["putTurn"]>) => {
                putTurnCalls += 1;
                if (putTurnCalls === 1) {
                  signalFirstPutEntered();
                  await firstPutRelease;
                }
                if (writesBroken) throw new BackendUnavailableError("injected write-only outage");
                return target.putTurn(...args);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });

    const runtime = createRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 75, persistenceRecoveryGraceMs: 500 },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    const closeCall = vi.spyOn(call.handle, "close");
    const stt = makeStt();
    let llmCalls = 0;
    const llm = makeLlm((request) => {
      llmCalls += 1;
      return [
        llmEvent(request, llmCalls, { type: "llm.completed", text: "unexpected", toolCalls: [] }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "the first turn commits after its timeout");
      await firstPutEntered;
      await until(() => attachment.health === "persistence_degraded", "first write timeout");
      releaseFirstPut();
      await until(() => attachment.health === "healthy", "late first write recovery");
      await until(async () => {
        const snapshot = await runtime.inspectSession(session.id);
        return snapshot.turns.some((turn) => turn.status === "cancelled");
      }, "late turn cancellation");

      writesBroken = true;
      stt.pushFinal(session.id, "the next turn cannot be written");
      await until(
        () => closeCall.mock.calls.length > 0,
        "call closure after the write-only outage",
      );
      await running.catch(() => undefined);
      await draining;

      const snapshot = await runtime.inspectSession(session.id);
      expect(putTurnCalls).toBe(2);
      expect(closeCall).toHaveBeenCalledWith("error");
      expect(snapshot.session).toMatchObject({
        status: "failed",
        error: { code: "durable.write.failure" },
      });
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]).toMatchObject({ sequence: 1, status: "cancelled" });
      expect(llmCalls).toBe(0);
      expect(seen.some((event) => event.kind === "call_ended" && event.reason === "failed")).toBe(
        true,
      );
    } finally {
      releaseFirstPut();
      call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);

  it.each(["immediate", "late"] as const)(
    "does not recover a host-created terminal turn after a %s pipeline start failure",
    async (failureMode) => {
      const durableStore = createInMemoryDurableRuntimeStore();
      const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
      let putTurnCalls = 0;
      let writesBroken = false;
      let releasePipelinePut!: () => void;
      const pipelinePutRelease = new Promise<void>((resolve) => {
        releasePipelinePut = resolve;
      });
      durableStore.runSessionTransaction = async <T>(
        sessionId: SessionId,
        lease: SessionLease,
        operation: (transaction: DurableSessionTransaction) => Promise<T>,
      ) =>
        runSessionTransaction(sessionId, lease, async (transaction) => {
          const wrapped = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === "putTurn") {
                return async (...args: Parameters<DurableSessionTransaction["putTurn"]>) => {
                  putTurnCalls += 1;
                  if (failureMode === "late" && putTurnCalls === 2) {
                    await pipelinePutRelease;
                  }
                  if (writesBroken) throw new BackendUnavailableError("injected write-only outage");
                  return target.putTurn(...args);
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return operation(wrapped);
        });

      const runtime = createRuntime({
        durableStore,
        durablePolicy: { criticalWriteTimeoutMs: 75, persistenceRecoveryGraceMs: 100 },
      });
      await runtime.start();
      const agent = buildAgent();
      const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
      const session = attachment.session;
      const call = makeCallHandle();
      const closeCall = vi.spyOn(call.handle, "close");
      const stt = makeStt();
      let llmCalls = 0;
      const llm = makeLlm((request) => {
        llmCalls += 1;
        return [
          llmEvent(request, llmCalls, { type: "llm.completed", text: "unexpected", toolCalls: [] }),
        ];
      });
      const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
      const loop = new PipelineVoiceLoop({
        runtime,
        session,
        attachment,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      });
      const running = loop.start();
      const seen: VoiceEvent[] = [];
      const draining = (async () => {
        for await (const event of running) seen.push(event);
      })();

      try {
        call.push(streamStarted(session.id));
        const hostTurn = await runtime.startTurn({
          sessionId: session.id,
          input: { transcript: "host-created turn", mediaEventIds: [] },
        });
        await runtime.endTurn(session.id, hostTurn.id, { reason: "completed" });
        if (failureMode === "immediate") writesBroken = true;
        stt.pushFinal(session.id, "caller speaks after the host turn");
        await until(() => putTurnCalls === 2, "pipeline startTurn");
        if (failureMode === "late") {
          await until(() => attachment.health === "persistence_degraded", "pipeline write timeout");
          writesBroken = true;
          releasePipelinePut();
        }
        await until(
          () => closeCall.mock.calls.length > 0,
          "call closure after the write-only outage",
        );
        await running.catch(() => undefined);
        await draining;

        const snapshot = await runtime.inspectSession(session.id);
        expect(closeCall).toHaveBeenCalledWith("error");
        expect(snapshot.session).toMatchObject({
          status: "failed",
          error: { code: "durable.write.failure" },
        });
        expect(snapshot.turns).toHaveLength(1);
        expect(snapshot.turns[0]).toMatchObject({
          sequence: 1,
          status: "completed",
          input: { transcript: "host-created turn" },
        });
        expect(llmCalls).toBe(0);
        expect(seen.some((event) => event.kind === "call_ended" && event.reason === "failed")).toBe(
          true,
        );
      } finally {
        call.push(streamEnded(session.id, "completed"));
        releasePipelinePut();
        await running.catch(() => undefined);
        await draining;
        await runtime.stop();
      }
    },
    15_000,
  );

  it("holds a barge-in final through a short store outage and resumes after terminal persistence", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let outageUntilMs = 0;
    let outageStarted = false;
    let cancelledWriteFailures = 0;
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) =>
      runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "updateTurn") {
              return async (
                turnSessionId: SessionId,
                turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
              ) =>
                target.updateTurn(turnSessionId, turnId, (record) => {
                  const next = updater(record);
                  if (next.turn.status === "interrupted" && !outageStarted) {
                    outageStarted = true;
                    outageUntilMs = Date.now() + 300;
                    throw new BackendUnavailableError("injected 300 ms store outage");
                  }
                  if (Date.now() < outageUntilMs) {
                    if (next.turn.status === "cancelled") cancelledWriteFailures += 1;
                    throw new BackendUnavailableError("injected 300 ms store outage");
                  }
                  return next;
                });
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });

    const runtime = createRuntime({
      durableStore,
      durablePolicy: {
        criticalWriteTimeoutMs: 75,
        persistenceRecoveryGraceMs: 500,
        bargeCheckpointRetryBudgetMs: 0,
        bargeCheckpointMaxAttempts: 1,
      },
    });
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    const stt = makeStt();
    let llmCalls = 0;
    const llm = makeLlm((request) => {
      llmCalls += 1;
      return [
        llmEvent(request, llmCalls, {
          type: "llm.completed",
          text: llmCalls === 1 ? "first answer" : "recovered answer",
          toolCalls: [],
        }),
      ];
    });
    let ttsCalls = 0;
    const tts: TextToSpeechProvider = {
      name: "recovery-test-tts",
      kind: "tts",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      supportsTtsLanguage: () => true,
      supportsTtsSpeed: () => true,
      async synthesize(request): Promise<TtsStream> {
        ttsCalls += 1;
        const queue = pushable<ReturnType<typeof audioChunk>>();
        queue.push(audioChunk(request, ttsCalls));
        if (ttsCalls > 1) queue.end();
        return {
          events: queue.iterable as TtsStream["events"],
          async cancel() {
            queue.end();
          },
        };
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    let streamEndedSent = false;
    const endStream = () => {
      if (streamEndedSent) return;
      streamEndedSent = true;
      call.push(streamEnded(session.id, "completed"));
    };

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn");
      await until(
        () => call.sent.some((event) => event.type === "media.audio.chunk"),
        "first turn audio",
      );
      stt.pushSpeechStarted(session.id);
      stt.pushFinal(session.id, "held caller final");
      await until(() => outageStarted, "barge-in store outage");
      await until(() => cancelledWriteFailures > 0, "cancelled terminal write failure");
      expect(llmCalls).toBe(1);
      await until(() => llmCalls === 2, "held final resumes after persistence recovery");
      await until(() => attachment.health === "healthy", "persistence health recovery");
      endStream();
      const result = await running;
      await draining;
      const persisted = await runtime.inspectSession(session.id);

      expect(cancelledWriteFailures).toBeGreaterThan(0);
      expect(llmCalls).toBe(2);
      expect(result.turnsHandled).toBe(2);
      expect(persisted.turns.some((turn) => turn.input.transcript === "held caller final")).toBe(
        true,
      );
      await expect(runtime.endSession(session.id, { reason: "completed" })).resolves.toMatchObject({
        status: "completed",
      });
      expect(
        seen.some(
          (event) => event.kind === "error" && event.error.code === "durable.write.failure",
        ),
      ).toBe(true);
    } finally {
      endStream();
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);

  it("retries failed-turn persistence after a transient store outage and resumes held transcripts", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let outageStarted = false;
    let outageUntilMs = 0;
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) =>
      runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "updateTurn") {
              return async (
                turnSessionId: SessionId,
                turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
              ) =>
                target.updateTurn(turnSessionId, turnId, (record) => {
                  const next = updater(record);
                  if (next.turn.status === "thinking" && !outageStarted) {
                    outageStarted = true;
                    outageUntilMs = Date.now() + 100;
                    throw new BackendUnavailableError("injected transient store outage");
                  }
                  if (Date.now() < outageUntilMs) {
                    throw new BackendUnavailableError("injected transient store outage");
                  }
                  return next;
                });
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });

    const runtime = createRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 2_000, persistenceRecoveryGraceMs: 2_000 },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    const stt = makeStt();
    let llmCalls = 0;
    const llm = makeLlm((request) => {
      llmCalls += 1;
      return [
        llmEvent(request, llmCalls, {
          type: "llm.completed",
          text: "the held turn resumes",
          toolCalls: [],
        }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn encounters the outage");
      stt.pushFinal(session.id, "held transcript after recovery");
      await until(() => llmCalls === 1, "held transcript resumes after terminal write retry");
      await until(() => attachment.health === "healthy", "persistence health recovery");
      call.push(streamEnded(session.id, "completed"));
      await running;
      await draining;
      const snapshot = await runtime.inspectSession(session.id);

      expect(outageStarted).toBe(true);
      expect(llmCalls).toBe(1);
      expect(snapshot.turns[0]).toMatchObject({ status: "failed" });
      expect(
        snapshot.turns.some((turn) => turn.input.transcript === "held transcript after recovery"),
      ).toBe(true);
      expect(
        seen.some(
          (event) => event.kind === "error" && event.error.code === "durable.write.failure",
        ),
      ).toBe(true);
      await expect(runtime.endSession(session.id, { reason: "completed" })).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);

  it("does not overlap a failed-turn retry with a timed-out transaction", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let failThinkingAfterCommit = false;
    let failedThinkingErrorSent = false;
    let failedTurnWriteAttempts = 0;
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) => {
      let thinkingWriteCommitted = false;
      const result = await runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "updateTurn") {
              return async (
                turnSessionId: SessionId,
                turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
              ) => {
                const current = await target.getTurn(turnSessionId, turnId);
                if (!current) throw new Error(`missing turn during injection: ${turnId}`);
                const next = updater(current);
                if (next.turn.status === "thinking" && failThinkingAfterCommit) {
                  thinkingWriteCommitted = true;
                  failThinkingAfterCommit = false;
                }
                if (next.turn.status === "failed") {
                  failedTurnWriteAttempts += 1;
                  await new Promise<void>((resolve) => setTimeout(resolve, 300));
                }
                return target.updateTurn(turnSessionId, turnId, () => next);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });
      if (thinkingWriteCommitted && !failedThinkingErrorSent) {
        failedThinkingErrorSent = true;
        throw new BackendUnavailableError("injected post-commit status failure");
      }
      return result;
    };

    const runtime = createRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 200, persistenceRecoveryGraceMs: 250 },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    const closeCall = vi.spyOn(call.handle, "close");
    const stt = makeStt();
    let llmCalls = 0;
    const llm = makeLlm((request) => {
      llmCalls += 1;
      return [
        llmEvent(request, llmCalls, {
          type: "llm.completed",
          text: "the caller turn resumes after the late commit",
          toolCalls: [],
        }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();

    try {
      call.push(streamStarted(session.id));
      failThinkingAfterCommit = true;
      stt.pushFinal(session.id, "the status write reports a late failure");
      stt.pushFinal(session.id, "held until the terminal write commits");
      await until(
        () => closeCall.mock.calls.length > 0,
        "call closure after terminal write timeout",
      );
      await running.catch(() => undefined);
      await draining;
      const snapshot = await runtime.inspectSession(session.id);

      expect(failedThinkingErrorSent).toBe(true);
      expect(failedTurnWriteAttempts).toBe(1);
      expect(llmCalls).toBe(0);
      expect(snapshot.session).toMatchObject({
        status: "failed",
        error: { code: "durable.write.failure" },
      });
      expect(snapshot.turns[0]).toMatchObject({ status: "failed" });
      expect(
        seen.some(
          (event) => event.kind === "error" && event.error.code === "durable.write.failure",
        ),
      ).toBe(true);
      expect(seen.some((event) => event.kind === "call_ended" && event.reason === "failed")).toBe(
        true,
      );
      expect(closeCall).toHaveBeenCalledWith("error");
    } finally {
      call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);

  it("recovers a single slow transaction after it commits instead of leaving the call degraded", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let delayedWrite = false;
    let delayedWriteCommitted = false;
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) =>
      runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "updateTurn") {
              return async (
                turnSessionId: SessionId,
                turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
              ) => {
                const current = await target.getTurn(turnSessionId, turnId);
                if (!current) throw new Error(`missing turn during injection: ${turnId}`);
                const next = updater(current);
                if (!delayedWrite && next.turn.status === "thinking") {
                  delayedWrite = true;
                  await new Promise<void>((resolve) => setTimeout(resolve, 150));
                  const updated = await target.updateTurn(turnSessionId, turnId, () => next);
                  delayedWriteCommitted = updated.turn.status === "thinking";
                  return updated;
                }
                return target.updateTurn(turnSessionId, turnId, () => next);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });

    const runtime = createRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 75, persistenceRecoveryGraceMs: 500 },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    const stt = makeStt();
    let llmCalls = 0;
    const llm = makeLlm((request) => {
      llmCalls += 1;
      return [
        llmEvent(request, llmCalls, {
          type: "llm.completed",
          text: "second turn answer",
          toolCalls: [],
        }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn with slow status write");
      stt.pushFinal(session.id, "second turn after recovery");
      await until(() => delayedWriteCommitted, "late thinking status commit");
      await until(() => llmCalls === 1, "held second final resumes");
      await until(() => attachment.health === "healthy", "persistence health recovery");
      call.push(streamEnded(session.id, "completed"));
      const result = await running;
      await draining;
      const persisted = await runtime.inspectSession(session.id);

      expect(delayedWrite).toBe(true);
      expect(delayedWriteCommitted).toBe(true);
      expect(llmCalls).toBe(1);
      expect(result.turnsHandled).toBe(1);
      expect(
        persisted.turns.some((turn) => turn.input.transcript === "second turn after recovery"),
      ).toBe(true);
      await expect(runtime.endSession(session.id, { reason: "completed" })).resolves.toMatchObject({
        status: "completed",
      });
      expect(
        seen.some(
          (event) => event.kind === "error" && event.error.code === "durable.write.failure",
        ),
      ).toBe(true);
    } finally {
      call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);

  it.each([
    {
      closeMode: "abort" as const,
      failureStatus: "thinking" as const,
      description: "transport close aborts input",
    },
    {
      closeMode: "media_end" as const,
      failureStatus: "thinking" as const,
      description: "transport close emits a media end",
    },
    {
      closeMode: "media_end" as const,
      failureStatus: "speaking" as const,
      description: "transport close emits a media end during an active turn",
    },
  ])(
    "ends the session as failed when turn persistence stays unavailable and $description",
    async ({ closeMode, failureStatus }) => {
      const durableStore = createInMemoryDurableRuntimeStore();
      const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
      let outageUntilMs = 0;
      let outageStarted = false;
      durableStore.runSessionTransaction = async <T>(
        sessionId: SessionId,
        lease: SessionLease,
        operation: (transaction: DurableSessionTransaction) => Promise<T>,
      ) =>
        runSessionTransaction(sessionId, lease, async (transaction) => {
          let sessionEndTransaction = false;
          const wrapped = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === "listTurns") {
                return async (...args: Parameters<DurableSessionTransaction["listTurns"]>) => {
                  sessionEndTransaction = true;
                  return target.listTurns(...args);
                };
              }
              if (property === "updateTurn") {
                return async (
                  turnSessionId: SessionId,
                  turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                  updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
                ) =>
                  target.updateTurn(turnSessionId, turnId, (record) => {
                    const next = updater(record);
                    if (next.turn.status === failureStatus && !outageStarted) {
                      outageStarted = true;
                      outageUntilMs = Date.now() + 100;
                    }
                    if (Date.now() < outageUntilMs && !sessionEndTransaction) {
                      throw new BackendUnavailableError("injected bounded store outage");
                    }
                    return next;
                  });
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return operation(wrapped);
        });

      const runtime = createRuntime({
        durableStore,
        durablePolicy: { criticalWriteTimeoutMs: 10, persistenceRecoveryGraceMs: 50 },
      });
      await runtime.start();
      const agent = buildAgent();
      const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
      const session = attachment.session;
      const call = makeCallHandle();
      const closeCall = vi.spyOn(call.handle, "close");
      if (closeMode === "abort") {
        closeCall.mockRejectedValue(new Error("injected transport close failure"));
      } else {
        closeCall.mockImplementation(async () => {
          call.push(streamEnded(session.id, "completed"));
        });
      }
      const stt = makeStt();
      const llm = makeLlm((request) => {
        if (failureStatus === "thinking") {
          throw new Error("the turn must not reach the model while persistence is unavailable");
        }
        return [llmEvent(request, 1, { type: "llm.completed", text: "answer", toolCalls: [] })];
      });
      const tts = makeTts(() => [], { endStream: true });
      const loop = new PipelineVoiceLoop({
        runtime,
        session,
        attachment,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      });
      const running = loop.start();
      const seen: VoiceEvent[] = [];
      const draining = (async () => {
        for await (const event of running) seen.push(event);
      })();

      try {
        const startedAt = Date.now();
        call.push(streamStarted(session.id));
        stt.pushFinal(session.id, "cannot persist this turn");
        await until(() => outageStarted, "turn-write outage");
        await until(
          async () => (await runtime.inspectSession(session.id)).session.status === "failed",
          "explicit failed session end",
        );
        const snapshot = await runtime.inspectSession(session.id);
        expect(snapshot.session).toMatchObject({
          status: "failed",
          error: { code: "durable.write.failure" },
        });
        expect(snapshot.turns[0]?.status).toBe("failed");
        expect(Date.now() - startedAt).toBeLessThan(500);
        expect(
          seen.some(
            (event) => event.kind === "error" && event.error.code === "durable.write.failure",
          ),
        ).toBe(true);
        expect(seen.some((event) => event.kind === "call_ended" && event.reason === "failed")).toBe(
          true,
        );
        expect(closeCall).toHaveBeenCalledWith("error");
        expect(
          seen.some(
            (event) =>
              event.kind === "error" && event.error.code === "voice_runtime.call_close_failed",
          ),
        ).toBe(closeMode === "abort");
        const result = await running.catch(() => undefined);
        await draining;
        if (closeMode === "media_end") {
          expect(result).toMatchObject({
            terminalReason: "failed",
            terminalSource: "provider_runtime",
          });
        }
      } finally {
        call.push(streamEnded(session.id, "error"));
        await running.catch(() => undefined);
        await draining;
        await runtime.stop();
      }
    },
    15_000,
  );

  it("closes the call on the recovery deadline when store reads stall", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const getSession = durableStore.sessions.get.bind(durableStore.sessions);
    let armDelayedReads = false;
    let delayedReadsRemaining = 0;
    let delayedReadsPending = 0;
    durableStore.sessions.get = async (sessionId) => {
      if (armDelayedReads) {
        armDelayedReads = false;
        delayedReadsRemaining = 2;
      }
      if (delayedReadsRemaining > 0) {
        delayedReadsRemaining -= 1;
        delayedReadsPending += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        delayedReadsPending -= 1;
      }
      return getSession(sessionId);
    };

    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    let failedThinkingWrite = false;
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) =>
      runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "updateTurn") {
              return async (
                turnSessionId: SessionId,
                turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
              ) =>
                target.updateTurn(turnSessionId, turnId, (record) => {
                  const next = updater(record);
                  if (!failedThinkingWrite && next.turn.status === "thinking") {
                    failedThinkingWrite = true;
                    armDelayedReads = true;
                    throw new BackendUnavailableError("injected durable write failure");
                  }
                  return next;
                });
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });

    const runtime = createRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 10, persistenceRecoveryGraceMs: 50 },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    const closeCall = vi.spyOn(call.handle, "close");
    const stt = makeStt();
    const llm = makeLlm(() => {
      throw new Error("the turn must not reach the model while persistence is unavailable");
    });
    const tts = makeTts(() => [], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const draining = (async () => {
      for await (const _event of running) {
      }
    })();

    try {
      const startedAt = Date.now();
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "the store read will stall");
      await until(() => failedThinkingWrite, "thinking status write failure");
      await until(() => closeCall.mock.calls.length > 0, "call closure at the recovery deadline");

      expect(Date.now() - startedAt).toBeLessThan(300);
      expect(closeCall).toHaveBeenCalledWith("error");

      await until(() => delayedReadsPending === 0, "stalled store reads settle");
      const snapshot = await runtime.inspectSession(session.id);
      expect(snapshot.session.status).toBe("failed");
    } finally {
      call.push(streamEnded(session.id, "error"));
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);

  it.each([
    {
      scenario: "the checkpoint is the only failed write",
      failIndependentWrite: false,
      expectedHealth: false,
    },
    {
      scenario: "an unrelated terminal write also fails",
      failIndependentWrite: true,
      expectedHealth: false,
    },
  ])(
    "recovers transcript admission after checkpoint recovery when $scenario",
    async ({ failIndependentWrite, expectedHealth }) => {
      const health: boolean[] = [];
      const durableStore = createInMemoryDurableRuntimeStore();
      let checkpointAttempts = 0;
      let resolveCheckpointRecoveryStarted!: () => void;
      const checkpointRecoveryStarted = new Promise<void>((resolve) => {
        resolveCheckpointRecoveryStarted = resolve;
      });
      let allowCheckpointRecovery!: () => void;
      const checkpointRecoveryAllowed = new Promise<void>((resolve) => {
        allowCheckpointRecovery = resolve;
      });
      let resolveCheckpointRecoveryFinished!: () => void;
      const checkpointRecoveryFinished = new Promise<void>((resolve) => {
        resolveCheckpointRecoveryFinished = resolve;
      });
      const originalRunSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
      durableStore.runSessionTransaction = async <T>(
        sessionId: SessionId,
        lease: SessionLease,
        operation: (transaction: DurableSessionTransaction) => Promise<T>,
      ) => {
        let interruptionCheckpoint = false;
        let holdCheckpointRecovery = false;
        const result = await originalRunSessionTransaction(
          sessionId,
          lease,
          async (transaction) => {
            const instrumented = new Proxy(transaction, {
              get(target, property, receiver) {
                if (property === "updateTurn") {
                  return async (...args: Parameters<DurableSessionTransaction["updateTurn"]>) => {
                    const updated = await target.updateTurn(...args);
                    if (updated.turn.status === "interrupted") interruptionCheckpoint = true;
                    return updated;
                  };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            const value = await operation(instrumented);
            if (interruptionCheckpoint) {
              checkpointAttempts += 1;
              if (checkpointAttempts <= 3) {
                throw new BackendUnavailableError("transient checkpoint transaction outage");
              }
              if (checkpointAttempts === 4) {
                holdCheckpointRecovery = true;
              }
            }
            return value;
          },
        );
        if (holdCheckpointRecovery) {
          // Keep the checkpoint promise pending while releasing the store's
          // per-session transaction queue so the cancelled turn can finish.
          resolveCheckpointRecoveryStarted();
          await checkpointRecoveryAllowed;
          resolveCheckpointRecoveryFinished();
        }
        return result;
      };
      const runtime = createRuntime({ durableStore });
      await runtime.start();
      const agent = buildAgent({
        interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
      });
      const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
      const session = attachment.session;
      const call = makeCallHandle();
      const stt = makeStt();
      const runtimeWithProbe = runtime as Runtime & {
        endTurn: Runtime["endTurn"];
        setPersistenceHealth: Runtime["setPersistenceHealth"];
      };
      const originalSetPersistenceHealth = runtimeWithProbe.setPersistenceHealth.bind(runtime);
      runtimeWithProbe.setPersistenceHealth = (sessionId, degraded) => {
        health.push(degraded);
        originalSetPersistenceHealth(sessionId, degraded);
      };
      let independentWriteFailed = false;
      let resolveInterruptedTurnPersisted!: () => void;
      const interruptedTurnPersisted = new Promise<void>((resolve) => {
        resolveInterruptedTurnPersisted = resolve;
      });
      const originalEndTurn = runtimeWithProbe.endTurn.bind(runtime);
      runtimeWithProbe.endTurn = async (sessionId, turnId, request) => {
        if (failIndependentWrite && !independentWriteFailed && request.reason === "cancelled") {
          independentWriteFailed = true;
          throw new BackendUnavailableError("independent terminal write outage");
        }
        const result = await originalEndTurn(sessionId, turnId, request);
        if (
          request.reason === "cancelled" ||
          (failIndependentWrite && request.reason === "failed")
        ) {
          resolveInterruptedTurnPersisted();
        }
        return result;
      };

      let llmCalls = 0;
      let resolveSecondTurn!: () => void;
      const secondTurnStarted = new Promise<void>((resolve) => {
        resolveSecondTurn = resolve;
      });
      const llm = makeLlm((request) => {
        llmCalls += 1;
        if (llmCalls === 2) resolveSecondTurn();
        return [llmEvent(request, 1, { type: "llm.completed", text: "hello", toolCalls: [] })];
      });
      let ttsCalls = 0;
      let releaseTtsCancellation!: () => void;
      const ttsCancellationReleased = new Promise<void>((resolve) => {
        releaseTtsCancellation = resolve;
      });
      let resolveTtsCancellationStarted!: () => void;
      const ttsCancellationStarted = new Promise<void>((resolve) => {
        resolveTtsCancellationStarted = resolve;
      });
      const tts: TextToSpeechProvider = {
        name: "controlled-recovery-tts",
        kind: "tts",
        version: "0.1.0",
        capabilities: TEST_PROVIDER_CAPABILITIES,
        supportsTtsLanguage: () => true,
        supportsTtsSpeed: () => true,
        async synthesize(request): Promise<TtsStream> {
          ttsCalls += 1;
          const queue = pushable<ReturnType<typeof audioChunk>>();
          queue.push(audioChunk(request, ttsCalls));
          if (ttsCalls > 1) queue.end();
          return {
            events: queue.iterable as TtsStream["events"],
            async cancel() {
              if (ttsCalls === 1) {
                resolveTtsCancellationStarted();
                await ttsCancellationReleased;
              }
              queue.end();
            },
          };
        },
      };
      const loop = new PipelineVoiceLoop({
        runtime,
        session,
        attachment,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      });
      const running = loop.start();
      const seen: VoiceEvent[] = [];
      const draining = (async () => {
        for await (const event of running) seen.push(event);
      })();
      let streamEndedSent = false;
      const endStream = () => {
        if (streamEndedSent) return;
        streamEndedSent = true;
        call.push(streamEnded(session.id, "completed"));
      };

      try {
        call.push(streamStarted(session.id));
        stt.pushFinal(session.id, "first turn");
        await until(
          () => call.sent.some((event) => event.type === "media.audio.chunk"),
          "first audio",
        );
        stt.pushSpeechStarted(session.id);
        await Promise.all([
          until(() => checkpointAttempts === 4, "fourth checkpoint transaction"),
          ttsCancellationStarted,
        ]);
        releaseTtsCancellation();
        await until(
          () => !failIndependentWrite || independentWriteFailed,
          "independent terminal write failure",
        );
        await until(
          () => attachment.health === "persistence_degraded",
          "checkpoint degradation during recovery grace",
        );
        await checkpointRecoveryStarted;
        await interruptedTurnPersisted;
        await until(
          () => seen.some((event) => event.kind === "turn_completed"),
          "interrupted turn completion event",
        );
        const deliveredBeforeSecondFinal = stt.deliveredEvents;
        stt.pushFinal(session.id, "second turn");
        await until(
          () => stt.deliveredEvents >= deliveredBeforeSecondFinal + 2,
          "barge-in final consumed during checkpoint recovery",
        );
        // The error event is the host-visible degraded health signal while
        // this final waits behind the unresolved checkpoint.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          seen.some(
            (event) => event.kind === "error" && event.error.code === "durable.write.failure",
          ),
        ).toBe(true);
        if (attachment.health === "persistence_degraded") expect(llmCalls).toBe(1);
        allowCheckpointRecovery();
        await checkpointRecoveryFinished;
        await until(() => attachment.health === "healthy", "checkpoint health recovery");
        await until(() => llmCalls === 2, "second turn after terminal persistence");

        let timeout: ReturnType<typeof setTimeout> | undefined;
        const resumed = await Promise.race([
          secondTurnStarted.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 1_000);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        endStream();
        const result = await running;
        await draining;

        expect(checkpointAttempts).toBe(4);
        expect(health).toContain(true);
        expect(health.at(-1)).toBe(expectedHealth);
        expect(resumed).toBe(true);
        expect(llmCalls).toBe(2);
        expect(result.turnsHandled).toBe(2);
        expect(result.turnsFailed).toBe(failIndependentWrite ? 1 : 0);
        expect(
          seen.some(
            (event) => event.kind === "error" && event.error.code === "durable.write.failure",
          ),
        ).toBe(true);
      } finally {
        releaseTtsCancellation();
        allowCheckpointRecovery();
        endStream();
        await running.catch(() => undefined);
        await draining;
        await runtime.stop();
      }
    },
    15_000,
  );

  it("does not confirm a competing failed session with a different error", async () => {
    const durableStore = createInMemoryDurableRuntimeStore();
    const runSessionTransaction = durableStore.runSessionTransaction.bind(durableStore);
    const runUnfencedSessionTransaction =
      durableStore.runUnfencedSessionTransaction?.bind(durableStore);
    if (!runUnfencedSessionTransaction) {
      throw new Error("Test store does not support unfenced session transactions");
    }
    const outageDurationMs = 100;
    let outageStarted = false;
    let outageUntilMs = 0;
    let shouldInsertCompetingFailure = false;
    let competingFailureInserted = false;
    durableStore.runSessionTransaction = async <T>(
      sessionId: SessionId,
      lease: SessionLease,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) => {
      if (outageStarted && Date.now() < outageUntilMs) {
        throw new BackendUnavailableError("injected bounded store outage");
      }
      return runSessionTransaction(sessionId, lease, async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "updateTurn") {
              return async (
                turnSessionId: SessionId,
                turnId: Parameters<DurableSessionTransaction["updateTurn"]>[1],
                updater: Parameters<DurableSessionTransaction["updateTurn"]>[2],
              ) =>
                target.updateTurn(turnSessionId, turnId, (record) => {
                  const next = updater(record);
                  if (next.turn.status === "thinking" && !outageStarted) {
                    outageStarted = true;
                    outageUntilMs = Date.now() + outageDurationMs;
                    throw new BackendUnavailableError("injected bounded store outage");
                  }
                  return next;
                });
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      });
    };
    durableStore.runUnfencedSessionTransaction = async <T>(
      sessionId: SessionId,
      operation: (transaction: DurableSessionTransaction) => Promise<T>,
    ) => {
      if (outageStarted && Date.now() < outageUntilMs) {
        throw new BackendUnavailableError("injected bounded store outage");
      }
      return runUnfencedSessionTransaction(sessionId, async (transaction) => {
        if (shouldInsertCompetingFailure && !competingFailureInserted) {
          competingFailureInserted = true;
          const endedAt = new Date().toISOString() as Timestamp;
          await transaction.updateSession(sessionId, (record) => ({
            ...record,
            session: {
              ...record.session,
              status: "failed",
              startedAt: "startedAt" in record.session ? record.session.startedAt : endedAt,
              endedAt,
              error: {
                name: "InternalError",
                code: "test.competing_session_failure",
                category: "internal",
                message: "another writer failed this session first",
                retriable: false,
              },
            } as FailedSession,
          }));
        }
        return operation(transaction);
      });
    };

    const runtime = createRuntime({
      durableStore,
      durablePolicy: { criticalWriteTimeoutMs: 300, persistenceRecoveryGraceMs: 20 },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const session = attachment.session;
    const call = makeCallHandle();
    vi.spyOn(call.handle, "close").mockImplementation(async () => {
      shouldInsertCompetingFailure = true;
    });
    const stt = makeStt();
    const llm = makeLlm(() => {
      throw new Error("the turn must not reach the model while persistence is unavailable");
    });
    const tts = makeTts(() => [], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })().catch(() => undefined);

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "a competing writer fails the session");
      await running.catch(() => undefined);
      await draining;
      const snapshot = await runtime.inspectSession(session.id);

      expect(outageStarted).toBe(true);
      expect(competingFailureInserted).toBe(true);
      expect(snapshot.session).toMatchObject({
        status: "failed",
        error: { code: "test.competing_session_failure" },
      });
      expect(
        seen.some(
          (event) =>
            event.kind === "error" &&
            event.error.code === "durable.write.failure" &&
            event.error.metadata?.sessionTerminalizationConfirmed === false &&
            event.error.metadata?.sessionTerminalizationOutcome === "failed" &&
            event.recoverable === false,
        ),
      ).toBe(true);
    } finally {
      call.push(streamEnded(session.id, "error"));
      await running.catch(() => undefined);
      await draining;
      await runtime.stop();
    }
  }, 15_000);
});
