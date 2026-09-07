import { describe, expect, it } from "vitest";

import { createRuntime, defineTool, PipelineVoiceLoop, type VoiceEvent } from "../src/index.js";
import {
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
  withPipelineProviders,
  audioChunk,
} from "./harness.js";

describe("PipelineVoiceLoop dual protocol", () => {
  it("emits lifecycle and audio events while remaining awaitable", async () => {
    const requestedIterations = Number(process.env.TVIC_DUAL_PROTOCOL_ITERATIONS ?? "1");
    const iterations =
      Number.isInteger(requestedIterations) && requestedIterations > 0 ? requestedIterations : 1;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await runDualProtocolScenario();
    }
  }, 120_000);

  async function runDualProtocolScenario(): Promise<void> {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.token", text: "Done" }),
      llmEvent(request, 3, { type: "llm.completed", text: "Done", toolCalls: [] }),
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
    const eventsPromise = (async () => {
      const events: VoiceEvent[] = [];
      for await (const event of running) events.push(event);
      return events;
    })();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => call.sent.length === 1, "audio output");
    call.push(streamEnded(session.id, "completed"));

    const [events, result] = await Promise.all([eventsPromise, running]);
    expect(result.turnsHandled).toBe(1);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.kind)).toEqual([
      "turn_started",
      "transcript_delta",
      "audio_output",
      "turn_completed",
      "call_ended",
    ]);
    expect(events.find((event) => event.kind === "audio_output")).toMatchObject({
      turnId: expect.any(String),
      sequence: 1,
    });
    expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "completed" });
  }

  it("emits tool call and tool result events with the durable turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const tool = defineTool({
      id: "dual_protocol_tool",
      name: "check_availability",
      description: "Checks availability.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { available: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let completions = 0;
    const llm = makeLlm((request) => {
      completions += 1;
      if (completions === 1) {
        const call = {
          callRef: "availability_call",
          toolName: "check_availability" as never,
          input: { date: "tomorrow" },
        };
        return [
          llmEvent(request, 1, { type: "llm.started", model: request.model }),
          llmEvent(request, 2, { type: "llm.tool_call", call }),
          llmEvent(request, 3, { type: "llm.completed", text: "", toolCalls: [call] }),
        ];
      }
      return [
        llmEvent(request, 4, { type: "llm.started", model: request.model }),
        llmEvent(request, 5, { type: "llm.completed", text: "It is available.", toolCalls: [] }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.start();
    const eventsPromise = (async () => {
      const events: VoiceEvent[] = [];
      for await (const event of running) events.push(event);
      return events;
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "is tomorrow available?");
    await until(() => call.sent.length === 1, "tool response audio");
    call.push(streamEnded(session.id, "completed"));

    const [events, result] = await Promise.all([eventsPromise, running]);
    expect(result.turnsHandled).toBe(1);
    expect(events.find((event) => event.kind === "tool_call")).toMatchObject({
      toolName: "check_availability",
      input: { date: "tomorrow" },
    });
    expect(events.find((event) => event.kind === "tool_result")).toMatchObject({
      output: { available: true },
    });
    expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "completed" });
  });

  it("cancels an active run when the per-call signal aborts", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "A long answer", toolCalls: [] }),
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
    stt.pushFinal(session.id, "cancel this");
    await until(() => tts.ready, "tts opened");
    controller.abort();

    await expect(running).rejects.toMatchObject({ category: "cancelled" });
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("cancelled");
  });

  it("cancels when an event consumer breaks without awaiting the result", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "A long answer", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.start();
    const eventsPromise = (async () => {
      for await (const event of running) {
        if (event.kind === "turn_started") break;
      }
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "break now");
    await eventsPromise;
    await expect(running).rejects.toMatchObject({ category: "cancelled" });
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("cancelled");
  });
});
