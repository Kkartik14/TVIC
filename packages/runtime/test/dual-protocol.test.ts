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
    // R2-03/E-13: runtime queue/settlement stress ONLY (provider wire matrix
    // is T3 P3-04 + T4 live gates — this suite uses fakes and proves no hang,
    // no loss, no leak, terminal delivery per iteration). Deterministic LCG
    // seed (TVIC_DUAL_PROTOCOL_SEED, default 1) alternates promise-first and
    // iterator-first observation across iterations.
    const requestedIterations = Number(process.env.TVIC_DUAL_PROTOCOL_ITERATIONS ?? "1");
    const iterations =
      Number.isInteger(requestedIterations) && requestedIterations > 0 ? requestedIterations : 1;
    const seed = Number(process.env.TVIC_DUAL_PROTOCOL_SEED ?? "1");
    let state = Number.isInteger(seed) && seed >= 0 ? seed >>> 0 : 1;
    const nextRandom = (): number => {
      state = (1_664_525 * state + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
    const counters = {
      eventsObserved: 0,
      terminalEvents: 0,
      settlements: 0,
      duplicateTerminals: 0,
      lostEvents: 0,
    };
    const startedAt = Date.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      try {
        await runDualProtocolScenario({
          iteration,
          seed,
          variant: nextRandom() < 0.5 ? "promise-first" : "iterator-first",
          counters,
        });
      } catch (error) {
        throw new Error(
          `dual-protocol seed=${seed} iteration ${iteration + 1}/${iterations} failed: ${String(error)}`,
        );
      }
    }
    expect(counters.settlements).toBe(iterations);
    expect(counters.terminalEvents).toBe(iterations);
    expect(counters.duplicateTerminals).toBe(0);
    expect(counters.lostEvents).toBe(0);
    if (iterations >= 1000) {
      // eslint-disable-next-line no-console
      console.log(
        `dual-protocol stress: seed=${seed} ${iterations} iterations in ${Date.now() - startedAt}ms ` +
          `events=${counters.eventsObserved} terminals=${counters.terminalEvents}`,
      );
    }
  }, 120_000);

  async function runDualProtocolScenario(options?: {
    readonly iteration?: number;
    readonly seed?: number;
    readonly variant?: "promise-first" | "iterator-first";
    readonly counters?: {
      eventsObserved: number;
      terminalEvents: number;
      settlements: number;
      duplicateTerminals: number;
      lostEvents: number;
    };
  }): Promise<void> {
    const variant = options?.variant ?? "iterator-first";
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
    let events: VoiceEvent[];
    if (variant === "promise-first") {
      // Result-only observation first (starts the lazy producer without ever
      // claiming the event iterator); retained events stay drainable after
      // settlement because the queue is only closed, never failed, here.
      void running.catch(() => undefined);
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "hello");
      await until(() => call.sent.length === 1, "audio output");
      call.push(streamEnded(session.id, "completed"));
      const result = await running;
      expect(result.turnsHandled).toBe(1);
      events = [];
      for await (const event of running) events.push(event);
    } else {
      const eventsPromise = (async () => {
        const collected: VoiceEvent[] = [];
        for await (const event of running) collected.push(event);
        return collected;
      })();

      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "hello");
      await until(() => call.sent.length === 1, "audio output");
      call.push(streamEnded(session.id, "completed"));

      const [collected, result] = await Promise.all([eventsPromise, running]);
      expect(result.turnsHandled).toBe(1);
      events = collected;
    }
    if (options?.counters) {
      options.counters.settlements += 1;
      options.counters.eventsObserved += events.length;
      const terminals = events.filter((event) => event.kind === "call_ended");
      options.counters.terminalEvents += terminals.length;
      if (terminals.length > 1) options.counters.duplicateTerminals += terminals.length - 1;
      if (events.length === 0) options.counters.lostEvents += 1;
    }
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
    // Per-iteration leak assertion: no clocks survive the run.
    const stats = runtime as unknown as { debugStats(): { activeSessionClocks: number } };
    expect(stats.debugStats().activeSessionClocks).toBe(1);
    await runtime.stop();
    expect(stats.debugStats().activeSessionClocks).toBe(0);
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
    await runtime.stop();
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
    await runtime.stop();
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
    await runtime.stop();
  });

  it("rejects a second live iterator with events_already_consumed", async () => {
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
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const draining = (async () => {
      for await (const _ of running) {
        // First live consumer holds the claim.
      }
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "claim test");
    await until(() => tts.ready, "tts opened");
    // Awaiting concurrently never claims; a second iterator must throw sync.
    void running.catch(() => undefined);
    try {
      running[Symbol.asyncIterator]();
      expect.unreachable("second live iterator must throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("voice_runtime.events_already_consumed");
    }
    call.push(streamEnded(session.id));
    await draining.catch(() => undefined);
    await running.catch(() => undefined);
    await runtime.stop();
  });
});
