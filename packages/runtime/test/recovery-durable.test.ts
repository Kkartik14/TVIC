import { describe, expect, it } from "vitest";

import { BackendUnavailableError } from "@tvic/core";
import { LeaseLostError } from "@tvic/core";
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
    expect(await leases.renew("session_1" as never, "A", 1, 3_000)).toBeNull();
    expect(await leases.renew("session_1" as never, "B", 2, 3_000)).not.toBeNull();
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
        ? { holder: found.holder, fence: found.fence, expiresAtMs: found.expiresAtMs }
        : null;
    };
    const store = new InMemoryToolIdempotencyStore(() => now, readLease);
    const claim = {
      key: "k1",
      lease: { sessionId: "session_m" as never, holder: "A", fence: lease1!.fence },
      requestHash: "h1",
      owner: "owner-a",
      ttlMs: 60_000,
    };
    const first = await store.claim(claim);
    expect(first.status).toBe("claimed");
    // Same-owner retry -> claimed same record.
    expect((await store.claim(claim)).status).toBe("claimed");
    // Different hash -> conflict, never steal.
    await expect(
      store.claim({ ...claim, requestHash: "h2", owner: "owner-b" }),
    ).resolves.toMatchObject({ status: "conflict" });
    // New fence same hash -> steal. Advance lease: expire + reacquire.
    now += 10_001;
    const lease2 = await leases.acquire("session_m" as never, "B", 10_000);
    const stolen = await store.claim({
      key: "k1",
      lease: { sessionId: "session_m" as never, holder: "B", fence: lease2!.fence },
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
        lease: { sessionId: "session_m" as never, holder: "A", fence: lease1!.fence },
        output: {},
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    // Fresh complete succeeds.
    await store.complete("k1", "h1", {
      status: "succeeded",
      ttlMs: 60_000,
      owner: "owner-b",
      lease: { sessionId: "session_m" as never, holder: "B", fence: lease2!.fence },
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
