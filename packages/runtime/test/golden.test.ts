import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import { deriveCallTimeline } from "@tvic/tracing";
import type { TraceEvent } from "@tvic/core";

import { createRuntime, PipelineVoiceLoop } from "../src/index.js";
import {
  audioChunk,
  bargeIn,
  buildAgent,
  llmEvent,
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
 * Golden trace fixtures: representative scenarios are driven through the real loop, and
 * the emitted traces are run through deriveCallTimeline. Asserts the timeline spans,
 * latency metrics, transcript/response, and interruption summaries the viewer renders.
 */
describe("golden traces", () => {
  it("happy path: one completed turn with full span tree + latency metrics", async () => {
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
    const memory = createInMemoryMemory();

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
      memory,
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book a table for two");
    await until(() => call.sent.length >= 2, "agent audio");
    call.push(streamEnded(session.id));
    await running;

    const events = (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[];
    const timeline = deriveCallTimeline(events);

    expect(timeline.turns).toHaveLength(1);
    expect(timeline.interruptions).toBe(0);
    const turn = timeline.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.transcript).toBe("book a table for two");
    expect(turn.response).toBe("Sure, booked.");
    expect(turn.interrupted).toBe(false);
    expect(turn.spans.map((s) => s.kind).sort()).toEqual([
      "audio.output",
      "llm",
      "stt",
      "tts",
      "turn",
    ]);
    expect(typeof turn.metrics.ttftMs).toBe("number");
    expect(typeof turn.metrics.ttfbMs).toBe("number");
    expect(turn.metrics.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("barge-in: cancelled turn surfaces an interruption in the timeline", async () => {
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

    const timeline = deriveCallTimeline(
      (await runtime.inspectSession(session.id)).traceEvents as TraceEvent[],
    );
    expect(timeline.interruptions).toBe(1);
    const turn = timeline.turns[0]!;
    expect(turn.status).toBe("cancelled");
    expect(turn.interrupted).toBe(true);
    expect(turn.interruptions).toHaveLength(1);
  });

  it("tool retry: a runtime.retry trace appears between tool start and completion", async () => {
    const runtime = createRuntime();
    await runtime.start();
    let attempts = 0;
    const flakyAgent = buildAgent({
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
    const session = await runtime.startSession(flakyAgent, { channel: "simulated" });
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
            llmEvent(req, 2, { type: "llm.completed", text: "booked", toolCalls: [] }),
          ];
    });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: flakyAgent,
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

    const types = (await runtime.inspectSession(session.id)).traceEvents.map((e) => e.type);
    expect(types).toContain("tool.started");
    expect(types).toContain("runtime.retry");
    expect(types).toContain("tool.completed");
  });
});
