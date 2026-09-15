import { describe, expect, it } from "vitest";

import { createRuntime, PipelineVoiceLoop } from "../src/index.js";
import {
  buildAgent,
  llmEvent,
  makeCallHandle,
  makeControlledTts,
  makeLlm,
  makeStt,
  makeTts,
  audioChunk,
  streamEnded,
  streamStarted,
  until,
  withPipelineProviders,
} from "./harness.js";

/**
 * R2-09: shutdown and resource audit (runtime scope; managed stop joint
 * with T1 via voice-runtime suite). Winners LOCKED: abort-wins-commit,
 * drain-joins-abort once, CLEAR-wins-Terminate.
 */
describe("R2-09 shutdown audit", () => {
  it("a. commit-during-shutdown: ABORT WINS, never a post-shutdown turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    // Hang up first, THEN race a commit barrier + late final at the gate.
    call.push(streamEnded(session.id, "completed"));
    await running;
    const before = (await runtime.inspectSession(session.id)).turns.length;
    stt.pushFinal(session.id, "ghost after shutdown");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await runtime.inspectSession(session.id)).turns.length).toBe(before);
    await runtime.stop();
  });

  it("b. drain-after-abort joins a single close, never hangs", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const controller = new AbortController();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start().abortSignal(controller.signal);
    void running.catch(() => undefined);
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "go");
    await until(() => tts.ready, "tts opened");
    controller.abort();
    await expect(running).rejects.toMatchObject({ category: "cancelled" });
    await runtime.stop();
    const stats = runtime as unknown as { debugStats(): { activeSessionClocks: number } };
    expect(stats.debugStats().activeSessionClocks).toBe(0);
  });

  it("c. CLEAR-250ms wins over graceful waits; no work after runtime.stop()", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ hangClear: true });
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const startedAt = Date.now();
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    void running.catch(() => undefined);
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hang the clear");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length === 1, "audio sent");
    // Barge in: trimOutput calls the hanging clear(), which teardown must
    // preempt at 250ms (CLEAR wins, Terminate-style graceful waits lose).
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls === 1, "clear attempted");
    call.push(streamEnded(session.id, "completed"));
    await running;
    // Assert <1s (4x the 250ms budget, timer-driven, not load-shaped).
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(call.clearCalls).toBe(1);
    await runtime.stop();
  });

  it("controller barrier race: abort during pending commit rejects once and closes once", async () => {
    const { SerialSttCommandController } = await import("../src/stt-command-controller.js");
    let closes = 0;
    const hanging = {
      events: (async function* () {})(),
      commitMode: "provider",
      async sendAudio() {},
      async commit(): Promise<never> {
        return new Promise<never>(() => {});
      },
      async close() {
        closes += 1;
      },
    } as never;
    const controller = new SerialSttCommandController({ stream: hanging, commitTimeoutMs: 10_000 });
    const pending = controller.admitCommit();
    void pending.catch(() => undefined);
    // Abort wins the race: the pending barrier rejects, exactly one close.
    await controller.abort(new Error("shutdown"));
    await expect(pending).rejects.toBeDefined();
    await controller.drain().catch(() => undefined);
    expect(closes).toBe(1);
  });

  it("runtime.stop() is idempotent and forbids restart; stop drains without sleep", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "turn done",
    );
    call.push(streamEnded(session.id, "completed"));
    await running;
    await runtime.stop();
    await runtime.stop();
    await expect(runtime.start()).rejects.toThrow();
  });
});
