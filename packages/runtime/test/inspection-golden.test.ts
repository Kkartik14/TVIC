import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import { deriveCallInspection } from "@tvic/tracing";
import type { NormalizedError, TraceEvent } from "@tvic/core";

import { createRuntime, PipelineVoiceLoop } from "../src/index.js";
import {
  audioChunk,
  bargeIn,
  buildAgent,
  committed,
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
 * Golden inspection fixtures: each scenario is driven through the REAL pipeline loop,
 * then the emitted traces are run through `deriveCallInspection`. This proves the
 * analyzer derives the right inspection model from traces the runtime actually emits
 * (not hand-written JSONL), per the Observability Surface v1 plan's fixture rule.
 */
describe("golden inspection (driven through the real loop)", () => {
  it("G1 happy path: completed turn, response latency, heard playout, no failure", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "Sure, " }),
      llmEvent(req, 3, { type: "llm.token", text: "booked." }),
      llmEvent(req, 4, { type: "llm.completed", text: "Sure, booked.", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1), audioChunk(req, 2)], { endStream: true });

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
      memory: createInMemoryMemory(),
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book a table for two");
    await until(() => call.sent.length >= 2, "agent audio");
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const call_ = deriveCallInspection(events, {
      inputTrackAvailable: true,
      outputTrackAvailable: true,
    });

    expect(call_.status).toBe("completed");
    expect(call_.turns).toHaveLength(1);
    const turn = call_.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.callerText).toBe("book a table for two");
    expect(turn.agentText).toBe("Sure, booked.");
    expect(turn.failure).toBeUndefined();
    expect(turn.incidents).toHaveLength(0);
    expect(typeof turn.latency.firstAudioMs).toBe("number");
    expect(turn.latency.llmPasses).toHaveLength(1);
    expect(turn.latency.llmPasses[0]!.kind).toBe("initial");
    expect(turn.playout.state).toBe("heard");
    expect(call_.summary.primaryFailure).toBeUndefined();
  });

  it("G2 tool retry: completed turn shows a retry incident, not a terminal failure", async () => {
    const runtime = createRuntime();
    await runtime.start();
    let attempts = 0;
    const agent = buildAgent({
      tools: [
        {
          id: "tool_flaky" as never,
          name: "check_availability" as never,
          description: "flaky",
          version: "0.1.0",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          timeout: { timeoutMs: 1000, onTimeout: "fail" },
          retry: {
            maxAttempts: 3,
            initialDelayMs: 0,
            maxDelayMs: 0,
            backoff: "fixed",
            jitter: false,
          },
          idempotency: { enabled: false },
          async execute() {
            attempts += 1;
            if (attempts < 2) {
              throw new Error("transient");
            }
            return { available: true };
          },
        },
      ],
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const toolCall = { callRef: "c1", toolName: "check_availability" as never, input: {} };
    let llmCalls = 0;
    const llm = makeLlm((req) => {
      llmCalls += 1;
      return llmCalls === 1
        ? [
            llmEvent(req, 1, { type: "llm.started", model: req.model }),
            llmEvent(req, 2, { type: "llm.tool_call", call: toolCall }),
            llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [toolCall] }),
          ]
        : [
            llmEvent(req, 1, { type: "llm.started", model: req.model }),
            llmEvent(req, 2, { type: "llm.token", text: "booked" }),
            llmEvent(req, 3, { type: "llm.completed", text: "booked", toolCalls: [] }),
          ];
    });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "table for two");
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const call_ = deriveCallInspection(events);
    const turn = call_.turns[0]!;

    expect(turn.status).toBe("completed");
    expect(turn.failure).toBeUndefined();
    expect(turn.tools[0]!.status).toBe("succeeded");
    expect(turn.tools[0]!.attempts).toBeGreaterThanOrEqual(2);
    expect(turn.incidents.some((i) => i.kind === "tool_retry")).toBe(true);
    expect(call_.summary.retryCount).toBeGreaterThanOrEqual(1);
    expect(turn.latency.turnTags).toContain("tool");
    // Two LLM passes: initial (tool call) then post-tool continuation.
    expect(turn.latency.llmPasses.length).toBeGreaterThanOrEqual(2);
  });

  it("G3 barge-in: cancelled turn explained as interrupted, sent-not-heard agent audio", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "a long answer", toolCalls: [] }),
    ]);
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
    stt.pushFinal(session.id, "tell me everything");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(bargeIn(session.id));
    await until(() => call.cancelOutputCalls >= 1, "interrupt handled");
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const call_ = deriveCallInspection(events, { outputTrackAvailable: true });
    const turn = call_.turns[0]!;

    expect(turn.status).toBe("cancelled");
    expect(turn.failure?.kind).toBe("interrupted");
    expect(turn.interruptions).toHaveLength(1);
    expect(turn.interruptions[0]!.wasSpeaking).toBe(true);
    expect(call_.summary.interruptionCount).toBe(1);
    const heard = turn.replaySegments.find((s) => s.kind === "agent_heard");
    expect(heard?.available).toBe(false);
  });

  it("G4 playout unconfirmed: frames sent but never heard -> cancelled/not-heard", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ playout: "dropped" });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "your table is booked", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1), committed(req)], { endStream: true });

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
      memory: createInMemoryMemory(),
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book it");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled (not heard)",
    );
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const turn = deriveCallInspection(events).turns[0]!;
    expect(turn.status).toBe("cancelled");
    expect(turn.playout.state).toBe("unconfirmed");
    expect(turn.failure?.kind).toBe("playout_unconfirmed");
    expect(turn.memoryWrites).toHaveLength(0); // no memory write for an unheard reply
  });

  it("G6 LLM stalled: failed turn explained as provider stall, with stall-trace evidence", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tts = makeTts(() => [], { endStream: true });

    const result = await (async () => {
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
      return running;
    })();

    // Embedder contract: a degraded run ends the session failed (mirrors the example).
    await runtime.endSession(session.id, {
      reason: "failed",
      error: result.firstTurnError as NormalizedError,
    });

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const call_ = deriveCallInspection(events);
    const turn = call_.turns[0]!;

    expect(call_.status).toBe("failed");
    expect(turn.status).toBe("failed");
    expect(turn.failure?.kind).toBe("provider_stalled");
    expect(call_.summary.failedTurns).toBe(1);
    // The stall left explicit evidence the analyzer can point at.
    const evidence = turn.failure!.evidenceEventIds.map((id) => call_.eventsById[String(id)]);
    expect(evidence.some((e) => e?.type === "runtime.timeout")).toBe(true);
    // No agent audio was produced.
    expect(turn.replaySegments.some((s) => s.kind === "agent_sent")).toBe(false);
  });

  it("G6b TTS interrupt-timeout: cancelled turn explained as provider stall, evidence is runtime.timeout", async () => {
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
    const tts = makeControlledTts(); // resolves, never streams → TTS stall

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
    await runtime.endSession(session.id, { reason: "completed" });

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const call_ = deriveCallInspection(events);
    const turn = call_.turns[0]!;

    expect(turn.status).toBe("cancelled");
    expect(turn.failure?.kind).toBe("provider_stalled");
    // The explanation points at the runtime.timeout stall, not just output.cancelled.
    const evidence = turn.failure!.evidenceEventIds.map((id) => call_.eventsById[String(id)]);
    expect(evidence.some((e) => e?.type === "runtime.timeout")).toBe(true);
  });
});
