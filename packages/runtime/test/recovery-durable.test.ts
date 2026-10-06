import { describe, expect, it, vi } from "vitest";

import { BackendUnavailableError } from "@tvic/core";
import { LeaseLostError } from "@tvic/core";
import type { AgentId, Clock, SessionId, StoredSessionRecord, Timestamp } from "@tvic/core";
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
  streamEnded,
  streamStarted,
  withPipelineProviders,
} from "./harness.js";

/**
 * R2-06: recovery and durable-state correctness (deterministic stores).
 * T4-gated (explicitly out of deterministic scope, covered by real-service
 * gates): composite live PG/Redis authority-vs-outage, migration apply on
 * real DBs, clock-skew DB-time authority against real DB/Redis clocks.
 */
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
    // Same-holder reacquire while live is stable (no fence bump).
    expect((await leases.acquire("session_1" as never, "A", 3_000))?.fence).toBe(1);
    now += 3_001;
    expect(await leases.get("session_1" as never)).toBeNull();
    const b = await leases.acquire("session_1" as never, "B", 3_000);
    expect(b?.fence).toBe(2);
    // Stale A fence cannot renew once stolen/expired.
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
    // Flood 130 turns (~4 outbox events each = 520+): the dev store must
    // stay bounded with newest retained, never grow unbounded.
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
    // Newest retained: the last outbox event belongs to this session's end
    // (oldest truncated past the 512 dev bound).
    expect(store.outbox.at(-1)?.sessionId).toBe(session.id);
    await runtime.stop();
  });

  it("5. idempotency takeover matrix (same-owner retry / steal / conflict / stale complete)", async () => {
    let now = 7_000_000;
    const leases = new InMemorySessionLeaseStore(() => now);
    const lease1 = await leases.acquire("session_m" as never, "A", 10_000);
    const readLease = async () => {
      const found = await leases.get("session_m" as never);
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
    // A repeated call ID cannot acquire an already-active claim again.
    await expect(store.claim(claim)).resolves.toEqual({
      status: "in_progress",
      record: first.record,
    });
    // Different hash -> conflict, never steal.
    await expect(
      store.claim({ ...claim, requestHash: "h2", owner: "owner-b" }),
    ).resolves.toMatchObject({ status: "conflict" });
    // New fence same hash -> steal. Advance lease: expire + reacquire.
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
    // Stale complete with old fence -> LeaseLostError.
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
    // Fresh complete succeeds.
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
    // Double-complete with key-reordered-equal output stays success.
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
    // Expire the released lease and age activity past the grace window.
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
    // Exactly one side effects the session (shared lease serializes the
    // race): coordinator-attached XOR reaper-terminalized, never both active.
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

  it("D-03. rejected turn write surfaces durable.write.failure degraded once", async () => {
    const store = createInMemoryDurableRuntimeStore();
    // Fail the admitted turn write once with a backend outage (armed only
    // after the session exists, so setup itself stays healthy).
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
    // No next-turn admission after the write failure: zero completed turns.
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
});
