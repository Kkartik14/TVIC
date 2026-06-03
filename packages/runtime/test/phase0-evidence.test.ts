import { describe, expect, it } from "vitest";

import { isNormalizedError, type NormalizedError, type RuntimeTimeoutTrace } from "@tvic/core";

import { createRuntime, PipelineVoiceLoop } from "../src/index.js";
import {
  buildAgent,
  llmEvent,
  makeBlockingLlm,
  makeCallHandle,
  makeControlledTts,
  makeLlm,
  makeStt,
  makeTts,
  streamEnded,
  streamStarted,
  until,
} from "./harness.js";

/**
 * Phase 0 (Observability Surface v1): provider stalls and loop-level failures must
 * leave explicit trace evidence, not only a thrown promise or a bare terminal error.
 * These prove the evidence the analyzer (deriveCallInspection) relies on actually
 * exists in the emitted trace.
 */
describe("phase 0: provider stall evidence", () => {
  it("emits a runtime.timeout (stage llm, policy fail) before failing the turn on an LLM stall", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent(); // default timeoutPolicy onTimeout: "fail"
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm(); // emits llm.started, then never streams → stalls
    const tts = makeTts(() => [], { endStream: true });

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm: llm.provider,
      tts,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 30,
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed on stall",
    );
    call.push(streamEnded(session.id));
    await running;

    const events = (await runtime.inspectSession(session.id)).traceEvents;
    const stall = events.find(
      (event): event is RuntimeTimeoutTrace => event.type === "runtime.timeout",
    );
    expect(stall).toBeDefined();
    expect(stall?.stage).toBe("llm");
    expect(stall?.policyAction).toBe("fail");
    expect(stall?.timeoutMs).toBe(30);
    // Attributed to the turn so the analyzer can place the stall on a turn's evidence.
    expect(stall?.turnId).toBeDefined();
  });

  it("emits a runtime.timeout (stage tts) when TTS connects then sends no audio", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "your table is booked", toolCalls: [] }),
    ]);
    // Controlled TTS resolves synthesize but is never pushed/ended → mid-stream stall.
    const tts = makeControlledTts();

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts: tts.provider,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 30,
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book a table");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed on tts stall",
    );
    call.push(streamEnded(session.id));
    await running;

    const events = (await runtime.inspectSession(session.id)).traceEvents;
    const stall = events.find(
      (event): event is RuntimeTimeoutTrace =>
        event.type === "runtime.timeout" && event.stage === "tts",
    );
    expect(stall).toBeDefined();
    expect(stall?.policyAction).toBe("fail");
    expect(stall?.turnId).toBeDefined();
  });

  it("records policyAction interrupt when onTimeout is 'interrupt'", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({ timeoutPolicy: { timeoutMs: 30, onTimeout: "interrupt" } });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tts = makeTts(() => [], { endStream: true });

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm: llm.provider,
      tts,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled on interrupt-timeout",
    );
    call.push(streamEnded(session.id));
    await running;

    const events = (await runtime.inspectSession(session.id)).traceEvents;
    const stall = events.find(
      (event): event is RuntimeTimeoutTrace => event.type === "runtime.timeout",
    );
    expect(stall?.policyAction).toBe("interrupt");
  });

  it("emits a tts-stage stall trace with policyAction interrupt when TTS stalls under interrupt policy", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({ timeoutPolicy: { timeoutMs: 30, onTimeout: "interrupt" } });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "your table is booked", toolCalls: [] }),
    ]);
    // Resolves synthesize but never streams audio → mid-stream TTS stall.
    const tts = makeControlledTts();

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts: tts.provider,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book a table");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled on tts interrupt-timeout",
    );
    call.push(streamEnded(session.id));
    await running;

    const events = (await runtime.inspectSession(session.id)).traceEvents;
    const stall = events.find(
      (event): event is RuntimeTimeoutTrace =>
        event.type === "runtime.timeout" && event.stage === "tts",
    );
    expect(stall).toBeDefined();
    expect(stall?.policyAction).toBe("interrupt");
    expect(stall?.turnId).toBeDefined();
  });
});

describe("phase 0: loop-level failure reaches session.failed (embedder contract)", () => {
  it("STT closing mid-call throws from run(); the embedder ends the session failed", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm: makeLlm(() => []),
      tts: makeTts(() => [], { endStream: true }),
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    // STT socket closes while the caller is still connected and no turn was opened.
    stt.endStream();

    // The loop surfaces this as a thrown error — never a clean result.
    let thrown: unknown;
    await running.catch((error: unknown) => {
      thrown = error;
    });
    expect(isNormalizedError(thrown)).toBe(true);
    expect((thrown as NormalizedError).code).toBe("stt.closed_unexpectedly");

    // The embedder contract: end the session failed so the failure is in the trace.
    await runtime.endSession(session.id, { reason: "failed", error: thrown as NormalizedError });

    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns).toHaveLength(0); // no fake turn was created
    expect(snapshot.traceEvents.some((event) => event.type === "session.failed")).toBe(true);
  });
});
