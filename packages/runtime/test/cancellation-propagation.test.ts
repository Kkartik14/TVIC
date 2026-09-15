import { describe, expect, it } from "vitest";

import { AsyncQueue } from "@tvic/media";
import { createMediaEvent, PCM16_16K_MONO, type TextToSpeechProvider } from "@tvic/core";
import { createRuntime, defineTool, PipelineVoiceLoop, type VoiceEvent } from "../src/index.js";
import {
  audioChunk,
  buildAgent,
  dtmf,
  llmEvent,
  makeBlockingLlm,
  makeCallHandle,
  makeControlledTts,
  makeLlm,
  makeStt,
  makeTts,
  streamEnded,
  streamStarted,
  TS,
  until,
  withPipelineProviders,
} from "./harness.js";

/**
 * R2-04: cancellation and interruption propagation (LOCKED taxonomy:
 * abort-during-tool -> cancelled turn; lease-loss -> failed(lease_lost);
 * barge-in gate active && !outputDelivered; DTMF any-state).
 */
describe("R2-04 cancellation propagation", () => {
  it("1. AbortSignal mid-TTS rejects cancelled with frozen audio; loop never closes transport", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "long answer", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    let closeCalls = 0;
    const trackingHandle = {
      ...call.handle,
      async close(reason: never) {
        closeCalls += 1;
        return call.handle.close(reason);
      },
    };
    const controller = new AbortController();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: trackingHandle as never,
      llmModel: "gpt-test",
    });
    const running = loop.start().abortSignal(controller.signal);
    void running.catch(() => undefined);
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "cancel me");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length === 1, "audio sent");
    const sentBefore = call.sent.length;
    controller.abort();
    await expect(running).rejects.toMatchObject({ category: "cancelled" });
    // Quiescence: no frames after the boundary (200ms bound, not 25ms).
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(call.sent.length).toBe(sentBefore);
    // Transport close is host-owned: the loop never calls callHandle.close on
    // cancel (only on STT-input failure). Managed closeCall-once is proven in
    // voice-runtime (managed-agent stop test).
    expect(closeCalls).toBe(0);
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("cancelled");
    await runtime.stop();
  });

  it("2. barge-in interrupts before first audio (deaf window closed) with clear", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "spoken", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "start");
    // Interrupt while TTS session is open but NO audio sent yet.
    await until(() => tts.ready, "tts opened");
    expect(call.sent.length).toBe(0);
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls === 1, "cleared before audio");
    call.push(streamEnded(session.id));
    await running;
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("cancelled");
    await runtime.stop();
  });

  it("3. in-flight tool observes abort and terminalizes cancelled", async () => {
    const runtime = createRuntime();
    await runtime.start();
    let toolSignalAborted = false;
    const tool = defineTool({
      id: "tool_abort",
      name: "slow_tool",
      description: "slow",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute(_input: unknown, ctx: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            toolSignalAborted = true;
            resolve();
            return;
          }
          ctx.signal.addEventListener("abort", () => {
            toolSignalAborted = true;
            resolve();
          });
        });
        throw Object.assign(new Error("cancelled"), { category: "cancelled" });
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, {
        type: "llm.tool_call",
        call: { callRef: "c1", toolName: "slow_tool" as never, input: {} },
      }),
      llmEvent(request, 3, {
        type: "llm.completed",
        text: "",
        toolCalls: [{ callRef: "c1", toolName: "slow_tool" as never, input: {} }],
      }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const controller = new AbortController();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.start().abortSignal(controller.signal);
    void running.catch(() => undefined);
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "run tool");
    await until(async () => (await runtime.inspectSession(session.id)).turns.length === 1, "turn");
    controller.abort();
    await expect(running).rejects.toMatchObject({ category: "cancelled" });
    expect(toolSignalAborted).toBe(true);
    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("cancelled");
    await runtime.stop();
  });

  it("4. outcomes matrix: completed, remote_hangup, failed", async () => {
    // completed: heard audio through a confirming transport.
    {
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
      const events: string[] = [];
      const draining = (async () => {
        for await (const event of running) events.push(event.kind);
      })();
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "hi");
      await until(() => call.sent.length === 1, "audio");
      call.push(streamEnded(session.id, "completed"));
      const result = await running;
      await draining;
      expect(events.at(-1)).toBe("call_ended");
      expect(result.turnsHandled).toBe(1);
      expect(result.terminalReason).toBe("completed");
      expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("completed");
      await runtime.stop();
    }
    // remote_hangup: transport ends mid-idle with no turns.
    {
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
      const reasons: string[] = [];
      const draining = (async () => {
        for await (const event of running) {
          if (event.kind === "call_ended") reasons.push(event.reason);
        }
      })();
      call.push(streamStarted(session.id));
      call.push(streamEnded(session.id, "remote_hangup"));
      await running;
      await draining;
      expect(reasons).toEqual(["remote_hangup"]);
      await runtime.stop();
    }
    // failed: llm.failed terminalizes the turn failed; the run resolves
    // with turnsFailed (turn-level failure, not run rejection).
    {
      const runtime = createRuntime();
      await runtime.start();
      const agent = buildAgent();
      const session = await runtime.startSession(agent, { channel: "simulated" });
      const call = makeCallHandle();
      const stt = makeStt();
      const llm = makeLlm((request) => [
        llmEvent(request, 1, { type: "llm.started", model: request.model }),
        llmEvent(request, 2, {
          type: "llm.failed",
          error: { code: "llm.boom", message: "boom", category: "provider", retriable: false },
        }),
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
      const kinds: string[] = [];
      const draining = (async () => {
        for await (const event of running) kinds.push(event.kind);
      })();
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "fail me");
      await until(
        async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
        "turn failed",
      );
      call.push(streamEnded(session.id, "completed"));
      const result = await running;
      await draining;
      expect(result.turnsFailed).toBe(1);
      expect(result.terminalReason).toBe("failed");
      expect(kinds).toContain("error");
      expect(kinds.at(-1)).toBe("call_ended");
      await runtime.stop();
    }
  });

  it("5. transport-close mid-idle creates no turn and ends remote_hangup", async () => {
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
    let closeCalls = 0;
    const trackingHandle = {
      ...call.handle,
      async close(reason: never) {
        closeCalls += 1;
        return call.handle.close(reason);
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: trackingHandle as never,
      llmModel: "gpt-test",
    });
    const running = loop.start();
    const events: string[] = [];
    const draining = (async () => {
      for await (const event of running) events.push(event.kind);
    })();
    call.push(streamStarted(session.id));
    call.push(streamEnded(session.id, "remote_hangup"));
    const result = await running;
    await draining;
    expect(result.turnsHandled).toBe(0);
    expect(result.terminalReason).toBe("remote_hangup");
    expect(events).toEqual(["call_ended"]);
    // Transport close is host-owned: the loop never calls callHandle.close
    // on remote hangup (only on STT-input failure), so zero calls here.
    expect(closeCalls).toBe(0);
    await runtime.stop();
  });

  it("6. DTMF interrupts from thinking state; ignore-mode swallows barge-in but not explicit", async () => {
    // DTMF during thinking (LLM blocked) interrupts with dtmf.
    {
      const runtime = createRuntime();
      await runtime.start();
      const agent = buildAgent();
      const session = await runtime.startSession(agent, { channel: "simulated" });
      const call = makeCallHandle();
      const stt = makeStt();
      const blocking = makeBlockingLlm();
      const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
      const running = new PipelineVoiceLoop({
        runtime,
        session,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm: blocking.provider, tts }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      }).run();
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "thinking...");
      await until(
        async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "thinking",
        "turn thinking",
      );
      call.push(dtmf(session.id));
      await until(
        async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
        "dtmf cancelled turn",
      );
      call.push(streamEnded(session.id));
      await running;
      await runtime.stop();
    }
    // ignore-mode swallows barge-in speech but honors explicit interrupts.
    {
      const runtime = createRuntime();
      await runtime.start();
      const agent = buildAgent({
        interruptionPolicy: { mode: "ignore", minSpeechMs: 0, trimOutputOnInterrupt: true },
      });
      const session = await runtime.startSession(agent, { channel: "simulated" });
      const call = makeCallHandle();
      const stt = makeStt();
      const llm = makeLlm((request) => [
        llmEvent(request, 1, { type: "llm.completed", text: "spoken", toolCalls: [] }),
      ]);
      const tts = makeControlledTts();
      const running = new PipelineVoiceLoop({
        runtime,
        session,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      }).run();
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "start");
      await until(() => tts.ready, "tts opened");
      tts.pushChunk(1);
      await until(() => call.sent.length === 1, "audio sent");
      stt.pushSpeechStarted(session.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Barge-in swallowed: still speaking, no clear.
      expect(call.clearCalls).toBe(0);
      call.push(
        createMediaEvent({
          id: "in_interrupt" as never,
          type: "media.interrupt.requested",
          sessionId: session.id,
          sequence: 4,
          direction: "input",
          timestamp: TS,
          monotonicOffsetMs: 20,
        }),
      );
      await until(
        async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
        "explicit cancelled turn",
      );
      call.push(streamEnded(session.id));
      await running;
      await runtime.stop();
    }
  });

  it("7. non-cooperative provider cancel is bounded with degraded report (P-11)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "spoken", toolCalls: [] }),
    ]);
    // TTS whose cancel() never settles: teardown must still settle at the
    // 5s cancel budget with a degraded report, never hang.
    let opened = false;
    const hangingCancelTts: TextToSpeechProvider = {
      name: "hanging-cancel-tts",
      kind: "tts",
      version: "0.1.0",
      capabilities: {
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, output: false, buffer: false, truncation: false },
        transports: ["websocket"],
        audio: { output: [PCM16_16K_MONO] },
      },
      async synthesize() {
        opened = true;
        const events = new AsyncQueue<never>();
        return {
          events,
          async cancel(): Promise<never> {
            return new Promise<never>(() => {});
          },
        };
      },
    } as never;
    const controller = new AbortController();
    const startedAt = Date.now();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm,
        tts: hangingCancelTts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 60_000,
    });
    const running = loop.start().abortSignal(controller.signal);
    void running.catch(() => undefined);
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of running) seen.push(event);
    })();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "cancel me");
    while (!opened) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    // Bounded abort (5s budget + margin), not the 60s stall and not forever.
    await expect(running).rejects.toMatchObject({ category: "cancelled" });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    await draining.catch(() => undefined);
    const degraded = seen.find(
      (event) =>
        event.kind === "error" &&
        (event.error as { code?: string }).code === "voice_runtime.cancellation_timeout",
    );
    expect(degraded?.kind).toBe("error");
    if (degraded?.kind === "error") {
      expect(degraded.error.metadata).toMatchObject({ degraded: true });
    }
    await runtime.stop();
  }, 20_000);
});
