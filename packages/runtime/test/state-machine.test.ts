import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import type { SessionId } from "@tvic/core";

import { createRuntime, defineAgent, PipelineVoiceLoop } from "../src/index.js";
import {
  audioChunk,
  buildAgent,
  committed,
  llmEvent,
  makeCallHandle,
  makeControlledTts,
  makeLlm,
  makeStt,
  makeTts,
  streamEnded,
  streamStarted,
  until,
  withPipelineProviders,
} from "./harness.js";

/** Deterministic PRNG so a failing seed is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type TurnOutcome = "ok" | "fail";
type Playout = "heard" | "dropped" | "none";

interface Scenario {
  readonly outcomes: readonly TurnOutcome[];
  readonly playout: Playout;
}

function scenario(rng: () => number): Scenario {
  const turnCount = 1 + Math.floor(rng() * 3); // 1..3 turns
  const outcomes: TurnOutcome[] = [];
  for (let i = 0; i < turnCount; i += 1) {
    outcomes.push(rng() < 0.3 ? "fail" : "ok");
  }
  const playout = (["heard", "dropped", "none"] as const)[Math.floor(rng() * 3)]!;
  return { outcomes, playout };
}

async function run(spec: Scenario): Promise<void> {
  const runtime = createRuntime();
  await runtime.start();
  const agent = buildAgent();
  const session = await runtime.startSession(agent, { channel: "simulated" });
  const sid = session.id as SessionId;

  const call = makeCallHandle(spec.playout === "none" ? {} : { playout: spec.playout });
  const stt = makeStt();
  let turnIndex = -1;
  const llm = makeLlm((req) => {
    turnIndex += 1;
    if (spec.outcomes[turnIndex] === "fail") {
      return [
        llmEvent(req, 1, { type: "llm.started", model: req.model }),
        llmEvent(req, 2, {
          type: "llm.failed",
          error: { code: "llm.boom", message: "boom", category: "provider", retriable: false },
        }),
      ];
    }
    return [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: `reply ${turnIndex}`, toolCalls: [] }),
    ];
  });
  const tts = makeTts((req) => [audioChunk(req, 1), committed(req)], { endStream: true });
  const memory = createInMemoryMemory();

  const running = new PipelineVoiceLoop({
    runtime,
    session,
    agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
    callHandle: call.handle,
    llmModel: "gpt-test",
    memory,
  }).run();

  call.push(streamStarted(sid));
  for (let i = 0; i < spec.outcomes.length; i += 1) {
    stt.pushFinal(sid, `turn ${i}`);
    await until(async () => {
      const turns = (await runtime.inspectSession(sid)).turns;
      const status = turns[i]?.status;
      return (
        turns.length > i &&
        (status === "completed" || status === "cancelled" || status === "failed")
      );
    }, `turn ${i} terminal`);
  }
  call.push(streamEnded(sid));
  const result = await running;
  await runtime.endSession(sid, { reason: "completed" });

  // ---- Invariants ----
  const snapshot = await runtime.inspectSession(sid);
  const heard = spec.playout !== "dropped";

  // 1. Every started turn reached a terminal state.
  expect(snapshot.turns).toHaveLength(spec.outcomes.length);
  for (const turn of snapshot.turns) {
    expect(["completed", "cancelled", "failed"]).toContain(turn.status);
  }

  // 2. Per-turn outcome matches the contract: fail → failed; ok+heard → completed;
  //    ok+dropped → cancelled (never completed when unheard).
  const expectedCompleted = spec.outcomes.filter((o) => o === "ok" && heard).length;
  const expectedFailed = spec.outcomes.filter((o) => o === "fail").length;
  const completed = snapshot.turns.filter((t) => t.status === "completed").length;
  const failed = snapshot.turns.filter((t) => t.status === "failed").length;
  expect(completed).toBe(expectedCompleted);
  expect(failed).toBe(expectedFailed);
  if (!heard) {
    expect(completed).toBe(0); // nothing the caller never heard is "completed"
  }

  // 3. The loop reports the failures.
  expect(result.turnsFailed).toBe(expectedFailed);

  // 4. Memory holds exactly one exchange per completed (heard) turn, never for
  //    failed/cancelled/unheard turns.
  const stored = await memory.get({ scope: "session", sessionId: sid }, "exchanges");
  const exchanges = (stored?.value as unknown[] | undefined) ?? [];
  expect(exchanges).toHaveLength(expectedCompleted);
}

describe("runtime state-machine model", () => {
  it("upholds turn/heard/memory invariants across randomized scenarios", async () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const spec = scenario(mulberry32(seed));
      await run(spec).catch((error) => {
        throw new Error(`seed ${seed} (${JSON.stringify(spec)}): ${String(error)}`);
      });
    }
  });

  it.each([
    { delivery: "delivered" as const, expected: "completed" },
    { delivery: "dropped" as const, expected: "cancelled" },
  ])(
    "uses successful text delivery in the terminal-state decision",
    async ({ delivery, expected }) => {
      const runtime = createRuntime();
      await runtime.start();
      const base = buildAgent();
      const { tts: _tts, ...providers } = base.providers;
      const stt = makeStt();
      const llm = makeLlm((request) => [
        llmEvent(request, 1, { type: "llm.completed", text: "Text answer.", toolCalls: [] }),
      ]);
      const agent = defineAgent({ ...base, providers: { ...providers, stt: stt.provider, llm } });
      const session = await runtime.startSession(agent, { channel: "simulated" });
      const call = makeCallHandle({ textDelivery: delivery });
      const running = new PipelineVoiceLoop({
        runtime,
        session,
        agent,
        callHandle: call.handle,
        llmModel: "gpt-test",
      }).run();
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "question");
      await until(
        async () => (await runtime.inspectSession(session.id)).turns[0]?.status === expected,
        `text delivery ${expected}`,
      );
      call.push(streamEnded(session.id));
      await running;
      expect(call.deliveredTexts).toEqual(["Text answer."]);
    },
  );

  it("keeps auto mode audio-only after successful TTS delivery", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Spoken answer.", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1), committed(request)], {
      endStream: true,
    });
    const agent = withPipelineProviders(base, { stt: stt.provider, llm, tts });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ textDelivery: "delivered" });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "question");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "audio turn completed",
    );
    call.push(streamEnded(session.id));
    await running;
    expect(call.deliveredTexts).toEqual([]);
  });

  it("suppresses full text delivery after a barge-in cancellation", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Unspoken ending.", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const agent = withPipelineProviders(base, { stt: stt.provider, llm, tts: tts.provider });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ textDelivery: "delivered" });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      llmModel: "gpt-test",
      textDelivery: "always",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "start");
    await until(() => tts.ready, "TTS opened");
    tts.pushChunk(1);
    await until(() => call.sent.length === 1, "audio sent");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls === 1, "barge-in cleared output");
    call.push(streamEnded(session.id));
    await running;
    expect(call.deliveredTexts).toEqual([]);
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("cancelled");
  });
});
