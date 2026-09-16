import { describe, expect, it } from "vitest";

import { createRuntime, PipelineVoiceLoop, type VoiceEvent } from "../src/index.js";
import {
  audioChunk,
  buildAgent,
  committed,
  llmEvent,
  makeCallHandle,
  makeIncrementalTts,
  makeLlm,
  makeStt,
  makeTts,
  streamEnded,
  streamStarted,
  until,
  withPipelineProviders,
} from "./harness.js";

/**
 * R2-02: event ordering and terminal delivery (corrected grammar:
 * audio interleaves tool events; dual payloads locked by R2-08).
 */
describe("R2-02 event ordering", () => {
  async function runTwoTurns(): Promise<{ events: VoiceEvent[]; turnsHandled: number }> {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let completions = 0;
    const llm = makeLlm((request) => {
      completions += 1;
      return [
        llmEvent(request, completions * 10 + 1, { type: "llm.started", model: request.model }),
        llmEvent(request, completions * 10 + 2, {
          type: "llm.completed",
          text: `reply ${completions}`,
          toolCalls: [],
        }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1), committed(request)], {
      endStream: true,
    });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const collected: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) collected.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "first");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length >= 1,
      "first turn",
    );
    stt.pushFinal(session.id, "second");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length >= 2,
      "second turn",
    );
    call.push(streamEnded(session.id, "completed"));
    const result = await running;
    await draining;
    await runtime.stop();
    return { events: collected, turnsHandled: result.turnsHandled };
  }

  it("orders turn spans and ends with call_ended", async () => {
    const { events, turnsHandled } = await runTwoTurns();
    expect(turnsHandled).toBe(2);
    const kinds = events.map((event) => event.kind);
    expect(kinds.at(-1)).toBe("call_ended");
    expect(kinds.filter((kind) => kind === "turn_started")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "turn_completed")).toHaveLength(2);
    for (let i = 0; i < kinds.length; i += 1) {
      if (kinds[i] === "turn_started") expect(kinds[i + 1]).toBe("transcript_delta");
    }
    const firstCompleted = kinds.indexOf("turn_completed");
    const secondStarted = kinds.indexOf("turn_started", 1);
    expect(firstCompleted).toBeLessThan(secondStarted);
    expect(kinds.lastIndexOf("turn_completed")).toBe(kinds.length - 2);
  });

  it("emits contiguous audio sequence numbers per turn", async () => {
    const { events } = await runTwoTurns();
    const byTurn = new Map<string, number[]>();
    for (const event of events) {
      if (event.kind === "audio_output") {
        const list = byTurn.get(event.turnId) ?? [];
        list.push(event.sequence);
        byTurn.set(event.turnId, list);
      }
    }
    expect(byTurn.size).toBe(2);
    for (const sequences of byTurn.values()) {
      expect(sequences[0]).toBe(1);
      for (let i = 1; i < sequences.length; i += 1) {
        expect(sequences[i]).toBe(sequences[i - 1]! + 1);
      }
    }
  });

  it("allows audio to interleave tool events (incremental TTS)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const { defineTool } = await import("../src/index.js");
    const tool = defineTool({
      id: "tool_interleave",
      name: "lookup",
      description: "lookup",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { ok: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let n = 0;
    const llm = makeLlm((request) => {
      n += 1;
      if (n === 1) {
        const c = { callRef: "c1", toolName: "lookup" as never, input: {} };
        return [
          llmEvent(request, 1, { type: "llm.started", model: request.model }),
          llmEvent(request, 2, { type: "llm.token", text: "partial " }),
          llmEvent(request, 3, { type: "llm.tool_call", call: c }),
          llmEvent(request, 4, { type: "llm.completed", text: "partial", toolCalls: [c] }),
        ];
      }
      return [
        llmEvent(request, 5, { type: "llm.started", model: request.model }),
        llmEvent(request, 6, { type: "llm.completed", text: "done", toolCalls: [] }),
      ];
    });
    const tts = makeIncrementalTts({ autoAudio: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const events: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) events.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "go");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "turn done",
    );
    call.push(streamEnded(session.id, "completed"));
    await running;
    await draining;
    // Tool pair sequential; audio allowed anywhere after turn_started.
    const kinds = events.map((e) => e.kind);
    const toolCallIdx = kinds.indexOf("tool_call");
    const toolResultIdx = kinds.indexOf("tool_result");
    expect(toolCallIdx).toBeGreaterThan(-1);
    expect(toolResultIdx).toBe(toolCallIdx + 1);
    await runtime.stop();
  });

  it("shares one execution; call_ended observed before settle; nothing after", async () => {
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
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const events: VoiceEvent[] = [];
    let seenCallEnded = false;
    const draining = (async () => {
      for await (const event of running) {
        events.push(event);
        if (event.kind === "call_ended") seenCallEnded = true;
      }
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(() => call.sent.length === 1, "audio");
    call.push(streamEnded(session.id, "completed"));
    await running;
    await draining;
    expect(seenCallEnded).toBe(true);
    const count = events.length;
    // Quiescence bound: nothing may arrive after terminal settlement.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events.length).toBe(count);
    await runtime.stop();
  });
});
