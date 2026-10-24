import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDurableRuntimeStore, createInMemoryMemory } from "@tvic/dal";
import { AsyncQueue } from "@tvic/media";
import {
  createMediaEvent,
  internalError,
  providerError,
  STT_ERROR_CODES,
  STT_STREAM_ENDED_REASON,
  timeoutError,
  toolError,
  type Clock,
  type LlmCompletionRequest,
  type LlmCompletion,
  type LlmStreamEvent,
  type LLMProvider,
  type SessionEndEvent,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
  type TtsSynthesisRequest,
  type SttStream,
  type TerminalTurn,
  type TranscriptEvent,
  type UserId,
} from "@tvic/core";

import {
  ConversationPolicy,
  createRuntime,
  defineAgent,
  defineTool,
  getSttRecoveryControl,
  PipelineVoiceLoop,
  withSttReconnect,
} from "../src/index.js";
import { InMemoryRuntime } from "../src/create-runtime.js";
import {
  AUDIO_TAP_FINALIZE_TIMEOUT_MS,
  CLEAR_TIMEOUT_MS,
  MAX_RUNTIME_LLM_OUTPUT_BYTES,
} from "../src/pipeline-constants.js";
import type { AssistantTextRecord } from "../src/index.js";
import type { AudioTapFrame } from "../src/index.js";
import { AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS } from "../src/audio-tap.js";
import {
  audioChunk,
  audioChunkIn,
  buildAgent,
  committed,
  dtmf,
  ignoreInterruptionPolicy,
  llmEvent,
  makeBlockingLlm,
  makeBlockingTts,
  makeCallHandle,
  makeControlledTts,
  makeIncrementalTts,
  makeLlm,
  makeStt,
  makeTts,
  pushable,
  streamEnded,
  streamStarted,
  TEST_PROVIDER_CAPABILITIES,
  TS,
  until,
  withPipelineProviders,
} from "./harness.js";

describe("PipelineVoiceLoop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves typed STT startup failures in the main pipeline path", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const startupFailure = timeoutError(
      "stt.provider.startup_timeout",
      "provider startup timed out",
    );
    const stt: SpeechToTextProvider = {
      name: "typed-startup-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async open(): Promise<SttStream> {
        throw startupFailure;
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt }),
      callHandle: makeCallHandle().handle,
      llmModel: "gpt-test",
    });

    await expect(loop.run()).rejects.toMatchObject({
      name: "TimeoutError",
      code: startupFailure.code,
      category: "timeout",
    });
  });

  it("cancels a hanging STT startup with the caller cancellation taxonomy", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const controller = new AbortController();
    const stt: SpeechToTextProvider = {
      name: "hanging-startup-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async open(): Promise<SttStream> {
        return new Promise<SttStream>(() => undefined);
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      attachment: {
        session,
        snapshot: { turns: [] },
        lease: null,
        signal: controller.signal,
        health: "healthy",
        detach: async () => undefined,
      } as never,
      agent: withPipelineProviders(agent, { stt }),
      callHandle: makeCallHandle().handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    controller.abort();
    await expect(running).rejects.toMatchObject({
      name: "CancelledError",
      code: "stt.open_cancelled",
      category: "cancelled",
    });
  });

  it("forwards the configured STT model to the provider", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      sttModel: "custom-stt-model",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT opened");

    expect(stt.openRequest?.model).toBe("custom-stt-model");
    call.push(streamEnded(session.id));
    await running;
  });

  it("does not add tool names to STT vocabulary by default", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const tool = defineTool({
      id: "tool_lookup_customer_account",
      name: "lookup_customer_account",
      description: "Look up a customer account.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { found: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT opened");

    expect(stt.openRequest?.vocabulary).toBeUndefined();
    call.push(streamEnded(session.id));
    await running;
  });

  it("rejects a loop memory adapter that differs from the runtime adapter", async () => {
    const runtimeMemory = createInMemoryMemory();
    const loopMemory = createInMemoryMemory();
    const runtime = createRuntime({ memory: runtimeMemory });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    let thrown: unknown;
    try {
      new PipelineVoiceLoop({
        runtime,
        session,
        agent,
        callHandle: makeCallHandle().handle,
        llmModel: "gpt-test",
        memory: loopMemory,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "memory.adapter_mismatch" });
    await runtime.endSession(session.id, { reason: "completed" });
  });

  it("runs a full turn: STT -> LLM -> TTS -> audio out, with latency and memory", async () => {
    const memory = createInMemoryMemory();
    const observations: import("@tvic/core").RuntimeObservation[] = [];
    const recordedTurns: TerminalTurn[] = [];
    const recordedMetrics: string[] = [];
    const tracedAudioTap: Array<{ readonly enabled: boolean; readonly droppedFrames: number }> = [];
    const tapFrames: AudioTapFrame[] = [];
    const sessionMetricsRecorder = {
      record: (name: string) => {
        recordedMetrics.push(name);
      },
      onTurn: (turn: TerminalTurn) => {
        recordedTurns.push(turn);
        throw new Error("metrics observer failure");
      },
      onSessionTrace: (trace: {
        readonly audioTap?: { readonly enabled: boolean; readonly droppedFrames: number };
      }) => {
        if (trace.audioTap) tracedAudioTap.push(trace.audioTap);
      },
    };
    const runtime = createRuntime({
      memory,
      sessionMetricsRecorder,
      observationSink: {
        enqueue(observation) {
          observations.push(observation);
        },
      },
    });
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

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
      sessionMetricsRecorder,
      audioTap: {
        onFrame: (frame) => {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run();

    call.push(streamStarted(session.id));
    call.push(audioChunkIn(session.id));
    stt.pushFinal(session.id, "book a table for two");

    await until(() => call.sent.length >= 2, "agent audio sent");
    call.push(streamEnded(session.id, "completed"));

    const result = await running;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(result.turnsHandled).toBe(1);
    expect(result.interruptions).toBe(0);
    expect(result.audioTap).toMatchObject({ enabled: true, droppedFrames: 0 });
    expect(call.sent.filter((event) => event.type === "media.audio.chunk")).toHaveLength(2);
    await until(() => tapFrames.length === 3, "caller and agent audio tapped");
    expect(tapFrames.map((frame) => frame.type)).toEqual(["audio", "audio", "audio"]);
    expect(
      tapFrames.filter((frame) => frame.type === "audio").map((frame) => frame.direction),
    ).toEqual(["caller", "agent", "agent"]);
    expect(tapFrames.map((frame) => frame.sequence)).toEqual([0, 1, 2]);

    const snapshot = await runtime.inspectSession(session.id);
    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("completed");
    expect(typeof turn?.latency.firstTokenMs).toBe("number");
    expect(typeof turn?.latency.firstAudioMs).toBe("number");
    expect(typeof turn?.latency.totalMs).toBe("number");
    expect(recordedTurns).toHaveLength(1);
    expect(recordedTurns[0]?.id).toBe(turn?.id);
    expect(recordedTurns[0]?.status).toBe("completed");
    expect(recordedMetrics).toEqual(["session.start", "turn.end"]);
    expect(observations.map((observation) => observation.name)).toEqual([
      "session.start",
      "turn.start",
      "turn.end",
    ]);
    expect(observations[1]?.turnId).toBe(turn?.id);
    expect(observations[2]?.attributes).toMatchObject({
      status: "completed",
    });
    expect(observations[2]?.attributes).not.toHaveProperty("transcript");
    expect(observations[2]?.attributes).not.toHaveProperty("audio");

    const stored = await memory.list(
      { scope: "session", sessionId: session.id },
      { prefix: `exchange:${session.id}:`, kind: "raw" },
    );
    expect(stored.map((entry) => entry.value)).toEqual([
      { user: "book a table for two", assistant: "Sure, booked." },
    ]);
    await runtime.endSession(session.id, { reason: "completed" });
    expect(tracedAudioTap).toEqual([expect.objectContaining({ enabled: true, droppedFrames: 0 })]);
  });

  it("timestamps turn.start at the speech endpoint, before durable writes finish", async () => {
    let now = 0;
    const observations: import("@tvic/core").RuntimeObservation[] = [];
    const runtime = createRuntime({
      clock: {
        now: () => TS,
        monotonicMs: () => now,
      },
      observationSink: { enqueue: (observation) => observations.push(observation) },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const startTurn = runtime.startTurn.bind(runtime);
    const updateTurnStatus = runtime.updateTurnStatus.bind(runtime);
    vi.spyOn(runtime, "startTurn").mockImplementation(async (request) => {
      const turn = await startTurn(request);
      now += 100;
      return turn;
    });
    vi.spyOn(runtime, "updateTurnStatus").mockImplementation(async (...args) => {
      const turn = await updateTurnStatus(...args);
      now += 100;
      return turn;
    });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "", toolCalls: [] }),
    ]);
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm,
        tts: makeTts(() => [], { endStream: true }),
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();

    call.push(streamStarted(session.id));
    now = 50;
    stt.pushFinal(session.id, "hello");
    await until(
      () => observations.some((observation) => observation.name === "turn.start"),
      "turn-start observation",
    );
    call.push(streamEnded(session.id));
    await running;

    const turnStart = observations.find((observation) => observation.name === "turn.start");
    expect(turnStart?.atMs).toBe(50);
    expect(now).toBeGreaterThanOrEqual(200);
    await runtime.stop();
  });

  it("keeps the audio tap disabled by default on a completed turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Hello.", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "say hello");
    await until(() => call.sent.some((event) => event.type === "media.audio.chunk"), "agent audio");
    call.push(streamEnded(session.id, "completed"));

    const result = await running;
    expect(result.audioTap).toMatchObject({
      enabled: false,
      droppedFrames: 0,
      droppedEvents: 0,
      callbackErrors: 0,
    });
    expect(call.sent.filter((event) => event.type === "media.audio.chunk")).toHaveLength(1);
    await runtime.endSession(session.id, { reason: "completed" });
  });

  it("uses the session-wide watermark when clearing output from an earlier turn", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ playout: "heard" });
    const stt = makeStt();
    const firstTurnLlm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "First answer", toolCalls: [] }),
    ]);
    const blockedLlm = makeBlockingLlm();
    let llmCalls = 0;
    const llm: LLMProvider = {
      ...firstTurnLlm,
      async complete(request) {
        llmCalls += 1;
        return llmCalls === 1
          ? firstTurnLlm.complete(request)
          : blockedLlm.provider.complete(request);
      },
    };
    const tts = makeTts((request) => [audioChunk(request, 1), committed(request)], {
      endStream: true,
    });
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "first turn");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "first turn completes after confirmed playout",
    );
    const snapshot = await runtime.inspectSession(session.id);
    const firstTurnId = snapshot.turns[0]!.id;
    const firstAudioFrame = tapFrames.find(
      (frame) =>
        frame.type === "audio" && frame.direction === "agent" && frame.turnId === firstTurnId,
    );
    expect(firstAudioFrame).toBeDefined();
    await until(
      () =>
        tapFrames.some(
          (frame) => frame.type === "playout" && frame.turnId === firstTurnId && frame.confirmed,
        ),
      "first turn playout is confirmed",
    );

    stt.pushFinal(session.id, "second turn");
    await until(() => blockedLlm.completeCalled, "second turn LLM starts");
    const secondTurnId = (await runtime.inspectSession(session.id)).turns[1]!.id;
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls === 1, "second turn interruption clears output");
    await until(
      () => tapFrames.some((frame) => frame.type === "cleared" && frame.turnId === secondTurnId),
      "global clear marker is tapped",
    );

    const clearFrame = tapFrames.find(
      (frame) => frame.type === "cleared" && frame.turnId === secondTurnId,
    );
    expect(clearFrame).toMatchObject({ throughSequence: firstAudioFrame?.sequence });
    call.push(streamEnded(session.id));
    await running;
  });

  it("completes a call while an asynchronous audio tap consumer is still pending", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Done.", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    let releaseConsumer!: () => void;
    let signalConsumerStarted!: () => void;
    const consumerGate = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const consumerStarted = new Promise<void>((resolve) => {
      signalConsumerStarted = resolve;
    });
    let blockedFirstFrame = false;
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      audioTap: {
        async onFrame() {
          if (blockedFirstFrame) return;
          blockedFirstFrame = true;
          signalConsumerStarted();
          await consumerGate;
        },
      },
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(audioChunkIn(session.id));
    await consumerStarted;
    stt.pushFinal(session.id, "finish the call");
    await until(
      () => call.sent.some((event) => event.type === "media.audio.chunk"),
      "agent audio sent",
    );
    call.push(streamEnded(session.id, "completed"));

    const result = await running;
    expect(result.terminalReason).toBe("completed");
    expect(result.audioTap).toMatchObject({ enabled: true });
    await runtime.endSession(session.id, { reason: "completed" });
    releaseConsumer();
  });

  it("includes dropped tap frames when turn startup terminalizes an attached session", async () => {
    const tracedTapSummaries: Array<{ readonly droppedFrames: number } | undefined> = [];
    const runtime = createRuntime({
      sessionMetricsRecorder: {
        record() {},
        onTurn() {},
        onSessionTrace(trace) {
          tracedTapSummaries.push(trace.audioTap);
        },
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    let turnStartAttempted = false;
    runtime.startTurn = async () => {
      turnStartAttempted = true;
      throw new Error("simulated durable turn start failure");
    };
    const call = makeCallHandle();
    const baseStt = makeStt();
    let sentAudioChunks = 0;
    let signalAudioPumped!: () => void;
    const audioPumped = new Promise<void>((resolve) => {
      signalAudioPumped = resolve;
    });
    const expectedAudioChunks = 160;
    const stt: SpeechToTextProvider = {
      ...baseStt.provider,
      async open(request) {
        const stream = await baseStt.provider.open(request);
        return {
          ...stream,
          async sendAudio(chunk) {
            await stream.sendAudio(chunk);
            sentAudioChunks += 1;
            if (sentAudioChunks === expectedAudioChunks) signalAudioPumped();
          },
        };
      },
    };
    let releaseFirstFrame!: () => void;
    let signalFirstFrame!: () => void;
    const firstFrameStarted = new Promise<void>((resolve) => {
      signalFirstFrame = resolve;
    });
    const firstFrameGate = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    let blockedFirstFrame = false;
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session: attachment.session,
      attachment,
      agent: withPipelineProviders(agent, { stt }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      audioTap: {
        async onFrame(frame) {
          tapFrames.push(frame);
          if (blockedFirstFrame) return;
          blockedFirstFrame = true;
          signalFirstFrame();
          await firstFrameGate;
        },
      },
    });

    const running = loop.run().catch(() => undefined);
    call.push(streamStarted(attachment.session.id));
    const template = audioChunkIn(attachment.session.id);
    for (let index = 0; index < expectedAudioChunks; index += 1) {
      call.push({
        ...template,
        id: `tap_input_${index}` as never,
        sequence: template.sequence + index,
        monotonicOffsetMs: template.monotonicOffsetMs + index * 20,
      });
    }
    await firstFrameStarted;
    await audioPumped;

    baseStt.pushFinal(attachment.session.id, "start a turn");
    await until(() => turnStartAttempted, "failed turn start");
    await until(() => tracedTapSummaries.length === 1, "failed turn emits session trace");
    releaseFirstFrame();
    await running;

    expect(tracedTapSummaries).toHaveLength(1);
    const summary = tracedTapSummaries[0];
    expect(summary).toBeDefined();
    if (!summary) return;
    await until(
      () =>
        tapFrames.filter((frame) => frame.type === "audio").length ===
        expectedAudioChunks - summary.droppedFrames,
      "all queued tap frames drain",
    );
    expect(summary.droppedFrames).toBeGreaterThan(0);
  });

  it("closes the tap without waiting for an attachment-abort clear", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const baseCall = makeCallHandle();
    let releaseClear!: () => void;
    let clearWasStarted = false;
    let clearFinished = false;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const callHandle = {
      ...baseCall.handle,
      async clear() {
        clearWasStarted = true;
        await clearGate;
        clearFinished = true;
      },
    };
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session: attachment.session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm: llm.provider }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run().catch(() => undefined);
    await until(() => stt.openRequest !== undefined, "STT session opens");
    baseCall.push(streamStarted(attachment.session.id));
    stt.pushFinal(attachment.session.id, "stay on the line");
    await until(() => llm.completeCalled, "LLM turn starts");

    const ending = runtime.endSession(attachment.session.id, { reason: "completed" });
    await until(() => clearWasStarted, "attachment abort clears transport output");
    const endedPromptly = await Promise.race([
      ending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    releaseClear();
    await ending;
    expect(tapFrames.some((frame) => frame.type === "cleared")).toBe(false);
    await until(() => clearFinished, "clear settles after the tap closes");
    await running;
    expect(endedPromptly).toBe(true);
    expect(tapFrames.some((frame) => frame.type === "cleared")).toBe(false);
  }, 10_000);

  it("ends an attached session promptly while an outbound send is stalled", async () => {
    let monotonicMs = 100;
    const clock: Clock = {
      now: () => "2026-10-16T00:00:00.000Z" as never,
      monotonicMs: () => monotonicMs,
    };
    const runtime = createRuntime({ clock });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const baseCall = makeCallHandle();
    let releaseClear!: () => void;
    let signalClearStarted!: () => void;
    let releaseSend!: () => void;
    let signalSendStarted!: () => void;
    let clearCalls = 0;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    let audioSendStarted = false;
    const callHandle = {
      ...baseCall.handle,
      async clear() {
        clearCalls += 1;
        if (clearCalls === 1) {
          signalClearStarted();
          await clearGate;
        }
        await baseCall.handle.clear();
      },
      async send(event: Parameters<typeof baseCall.handle.send>[0]) {
        if (event.type === "media.audio.chunk") {
          audioSendStarted = true;
          signalSendStarted();
          await sendGate;
        }
        return baseCall.handle.send(event);
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "Hello there.", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session: attachment.session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run().catch(() => undefined);
    await until(() => stt.openRequest !== undefined, "STT session opens");
    baseCall.push(streamStarted(attachment.session.id));
    stt.pushFinal(attachment.session.id, "say hello");
    await sendStarted;
    expect(audioSendStarted).toBe(true);

    monotonicMs = 150;
    const ending = runtime.endSession(attachment.session.id, { reason: "completed" });
    const endedPromptly = await Promise.race([
      ending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(endedPromptly).toBe(true);
    await ending;
    await clearStarted;
    const runSettledBeforeSendRelease = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    monotonicMs = 250;
    releaseSend();
    releaseClear();
    await running;
    await until(() => clearCalls === 1, "one session-end clear is issued");
    const agentFrames = tapFrames.filter(
      (frame) => frame.type === "audio" && frame.direction === "agent",
    );
    const clearFrames = tapFrames.filter((frame) => frame.type === "cleared");
    expect(runSettledBeforeSendRelease).toBe(true);
    expect(agentFrames).toHaveLength(0);
    expect(clearCalls).toBe(1);
    expect(clearFrames).toHaveLength(0);
  }, 10_000);

  it("keeps tap timestamps moving when an attachment detaches during a send", async () => {
    let monotonicMs = 100;
    const clock: Clock = {
      now: () => "2026-10-16T00:00:00.000Z" as never,
      monotonicMs: () => monotonicMs,
    };
    const runtime = createRuntime({ clock });
    await runtime.start();
    const agent = buildAgent();
    const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
    const baseCall = makeCallHandle();
    let releaseSend!: () => void;
    let signalSendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      signalSendStarted = resolve;
    });
    const callHandle = {
      ...baseCall.handle,
      async send(event: Parameters<typeof baseCall.handle.send>[0]) {
        if (event.type === "media.audio.chunk") {
          signalSendStarted();
          await sendGate;
        }
        return baseCall.handle.send(event);
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "Hello there.", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session: attachment.session,
      attachment,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run().catch(() => undefined);
    await until(() => stt.openRequest !== undefined, "STT session opens");
    baseCall.push(streamStarted(attachment.session.id));
    stt.pushFinal(attachment.session.id, "say hello");
    await sendStarted;

    monotonicMs = 200;
    await attachment.detach();
    monotonicMs = 300;
    releaseSend();
    await running;
    await until(
      () => tapFrames.some((frame) => frame.type === "audio" && frame.direction === "agent"),
      "successful agent send is tapped",
    );

    const agentFrame = tapFrames.find(
      (frame) => frame.type === "audio" && frame.direction === "agent",
    );
    expect(agentFrame?.timestampMs).toBeGreaterThan(100);
  }, 10_000);

  it("does not cancel an unattached pipeline from its tap finalizer", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const baseCall = makeCallHandle();
    let resolveConfirmation!: (confirmed: boolean) => void;
    let signalConfirmationStarted!: () => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const confirmationStarted = new Promise<void>((resolve) => {
      signalConfirmationStarted = resolve;
    });
    const callHandle = {
      ...baseCall.handle,
      confirmPlayout() {
        signalConfirmationStarted();
        return confirmation;
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "Hello there.", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1), committed(request)], {
      endStream: true,
    });
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run().catch(() => undefined);
    await until(() => stt.openRequest !== undefined, "STT session opens");
    baseCall.push(streamStarted(session.id));
    stt.pushFinal(session.id, "say hello");
    await confirmationStarted;

    const ending = runtime.endSession(session.id, { reason: "completed" });
    const endedPromptly = await Promise.race([
      ending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    await ending;
    const loopStillRunning = await Promise.race([
      running.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)),
    ]);
    expect(loopStillRunning).toBe(true);
    resolveConfirmation(true);
    baseCall.push(streamEnded(session.id, "completed"));
    await running;

    expect(endedPromptly).toBe(true);
    expect(tapFrames.some((frame) => frame.type === "playout")).toBe(false);
  }, 10_000);

  it("cancels an active session pipeline and emits its terminal turn before session end", async () => {
    const observations: import("@tvic/core").RuntimeObservation[] = [];
    const runtime = createRuntime({
      observationSink: {
        enqueue(observation) {
          observations.push(observation);
        },
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tts = makeTts(() => [], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm.provider,
        tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "please end this call");
      await until(() => llm.completeCalled, "the LLM to start the active turn");

      await runtime.endSession(session.id, {
        reason: "cancelled",
        cancelReason: "caller_hangup",
      });

      expect(llm.cancelled).toBe(true);
      await expect(running).rejects.toMatchObject({ code: "call.cancelled" });
      await runtime.stop();

      expect(observations.map((observation) => observation.name)).toEqual([
        "session.start",
        "turn.start",
        "turn.end",
        "session.end",
      ]);
      expect(observations[2]?.attributes).toMatchObject({
        status: "cancelled",
        cancel_reason: "transport_lost",
        terminal_persisted: true,
      });
    } finally {
      call.push(streamEnded(session.id));
      await running.catch(() => undefined);
      await runtime.stop();
    }
  });

  it("emits a persisted turn observation before a delayed memory write can race session end", async () => {
    const memory = createInMemoryMemory();
    const observations: import("@tvic/core").RuntimeObservation[] = [];
    const runtime = createRuntime({
      memory,
      observationSink: {
        enqueue(observation) {
          observations.push(observation);
        },
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    let announceMemoryWrite!: () => void;
    let releaseMemoryWrite!: () => void;
    const memoryWriteStarted = new Promise<void>((resolve) => {
      announceMemoryWrite = resolve;
    });
    const memoryWriteGate = new Promise<void>((resolve) => {
      releaseMemoryWrite = resolve;
    });
    const originalPut = memory.put.bind(memory);
    vi.spyOn(memory, "put").mockImplementation(async (...args) => {
      if (args[1].startsWith(`exchange:${session.id}:`)) {
        announceMemoryWrite();
        await memoryWriteGate;
      }
      return originalPut(...args);
    });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Done.", toolCalls: [] }),
    ]);
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm,
        tts: makeTts((request) => [audioChunk(request, 1)], { endStream: true }),
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
    });
    const running = loop.run();

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "hello");
      await memoryWriteStarted;
      await runtime.endSession(session.id, {
        reason: "cancelled",
        cancelReason: "caller_hangup",
      });
    } finally {
      releaseMemoryWrite();
      call.push(streamEnded(session.id));
      await running.catch(() => undefined);
      await runtime.stop();
    }

    const turnEndIndex = observations.findIndex((observation) => observation.name === "turn.end");
    const sessionEndIndex = observations.findIndex(
      (observation) => observation.name === "session.end",
    );
    expect(turnEndIndex).toBeGreaterThanOrEqual(0);
    expect(sessionEndIndex).toBeGreaterThan(turnEndIndex);
    expect(observations.filter((observation) => observation.name === "turn.end")).toHaveLength(1);
  });

  it("enforces the LLM output ceiling around a custom provider", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, {
        type: "llm.token",
        text: "x".repeat(MAX_RUNTIME_LLM_OUTPUT_BYTES + 1),
      }),
      llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [] }),
    ]);
    const tts = makeTts(() => [], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "trigger bounded output");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "bounded LLM turn failed",
    );
    call.push(streamEnded(session.id));
    const result = await running;

    expect(result.firstTurnError).toMatchObject({
      code: "provider.stream_buffer_overflow",
      provider: "tvic-runtime",
    });
  });

  it("completes a full turn through opt-in STT reconnect and closes every generation", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeReconnectablePipelineStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Recovered reply.", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      sttReconnect: {
        jitter: false,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        stableUptimeMs: 5,
        connectTimeoutMs: 20,
        commitTimeoutMs: 20,
        maxRecoveryDurationMs: 100,
      },
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openCalls === 1, "initial reconnectable STT opened");
    call.push(audioChunkIn(session.id));
    await until(() => stt.openCalls === 2, "recovered reconnectable STT opened");

    stt.pushFinal("recovered request");
    stt.pushEndpoint();
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "recovered turn completed",
    );

    call.push(streamEnded(session.id));
    const result = await running;

    expect(result.turnsHandled).toBe(1);
    expect(stt.generations).toHaveLength(2);
    expect(stt.generations[1]?.order).toEqual(["audio"]);
    expect(stt.generations.every((generation) => generation.closed)).toBe(true);
  });

  it("measures first token and audio without counting an STT recovery interval", async () => {
    let monotonicMs = 100;
    const runtime = createRuntime({
      clock: {
        now: () => TS,
        monotonicMs: () => monotonicMs,
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeReconnectablePipelineStt((openCalls) => {
      if (openCalls === 2) monotonicMs = 1_000;
    });
    const reconnectOptions = {
      jitter: false,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      stableUptimeMs: 5,
      connectTimeoutMs: 20,
      commitTimeoutMs: 20,
      maxRecoveryDurationMs: 100,
    } as const;
    const reconnectingProvider = withSttReconnect(stt.provider, reconnectOptions);
    let recoveryControl: ReturnType<typeof getSttRecoveryControl>;
    const capturingProvider: SpeechToTextProvider = {
      name: reconnectingProvider.name,
      kind: reconnectingProvider.kind,
      version: reconnectingProvider.version,
      capabilities: reconnectingProvider.capabilities,
      async open(request) {
        const stream = await reconnectingProvider.open(request);
        recoveryControl = getSttRecoveryControl(stream);
        return stream;
      },
    };
    const llm = makeLlm((request) => {
      monotonicMs = 1_017;
      return [
        llmEvent(request, 1, { type: "llm.started", model: request.model }),
        llmEvent(request, 2, { type: "llm.token", text: "Recovered reply." }),
        llmEvent(request, 3, {
          type: "llm.completed",
          text: "Recovered reply.",
          toolCalls: [],
        }),
      ];
    });
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: capturingProvider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openCalls === 1, "initial reconnectable STT opened");
    await until(() => recoveryControl !== undefined, "STT recovery control captured");
    call.push(audioChunkIn(session.id));
    await until(() => stt.openCalls === 2, "recovered reconnectable STT opened");
    await until(
      () => recoveryControl?.state() === "healthy",
      "recovered STT generation is healthy",
    );

    monotonicMs = 1_010;
    stt.pushFinal("recovered request");
    stt.pushEndpoint();
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "recovered turn completed",
    );
    call.push(streamEnded(session.id));
    await running;

    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.latency.firstTokenMs).toBe(7);
    expect(turn?.latency.firstAudioMs).toBe(7);
  });

  it("streams complete LLM sentences to incremental TTS before the model finishes", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const tts = makeIncrementalTts();
    const llmEvents = pushable<LlmStreamEvent>();
    let request: LlmCompletionRequest | null = null;
    const llm = {
      name: "controlled-llm",
      kind: "llm" as const,
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async complete(nextRequest: LlmCompletionRequest) {
        request = nextRequest;
        return {
          events: llmEvents.iterable,
          async cancel() {
            llmEvents.end();
          },
        };
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "say two sentences");
    await until(() => request !== null, "llm opened");
    const activeRequest = request;
    if (!activeRequest) {
      throw new Error("LLM request was not captured");
    }
    llmEvents.push(llmEvent(activeRequest, 1, { type: "llm.started", model: "gpt-test" }));
    llmEvents.push(llmEvent(activeRequest, 2, { type: "llm.token", text: "First sentence. " }));
    await until(() => tts.sentTexts.length === 1, "first sentence sent to tts");
    tts.pushChunk(1);
    await until(() => call.sent.length === 1, "audio sent before llm completion");

    llmEvents.push(llmEvent(activeRequest, 3, { type: "llm.token", text: "Second sentence." }));
    llmEvents.push(
      llmEvent(activeRequest, 4, {
        type: "llm.completed",
        text: "First sentence. Second sentence.",
        toolCalls: [],
      }),
    );
    llmEvents.end();
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "incremental turn completed",
    );
    call.push(streamEnded(session.id));

    await running;
    expect(tts.synthesizeCalls).toBe(0);
    expect(tts.openCalls).toBe(1);
    expect(tts.sentTexts).toEqual(["First sentence. ", "Second sentence."]);
    expect(tts.flushCalls).toBe(2);
  });

  it("submits one-shot TTS text as STT context immediately after synthesis starts", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const order: string[] = [];
    const contextProvider: SpeechToTextProvider = {
      ...stt.provider,
      supportsSttAgentContext: () => true,
      async open(request) {
        const stream = await stt.provider.open(request);
        return {
          ...stream,
          async updateAgentContext(context) {
            order.push(`context:${context}`);
          },
        };
      },
    };
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, {
        type: "llm.completed",
        text: "What date should I book?",
        toolCalls: [],
      }),
    ]);
    const tts = makeTts(
      (request) => {
        order.push(`synthesize:${request.text}`);
        return [audioChunk(request, 1), committed(request)];
      },
      { endStream: true },
    );
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: contextProvider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      sttConversationContext: true,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT session opens");
    stt.pushFinal(session.id, "ask for a date");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "one-shot turn completes",
    );
    call.push(streamEnded(session.id));
    await running;

    expect(order).toEqual([
      "synthesize:What date should I book?",
      "context:What date should I book?",
    ]);
  });

  it("submits the exact incremental TTS input at finish", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const contexts: string[] = [];
    const contextProvider: SpeechToTextProvider = {
      ...stt.provider,
      supportsSttAgentContext: () => true,
      async open(request) {
        const stream = await stt.provider.open(request);
        return {
          ...stream,
          async updateAgentContext(context) {
            contexts.push(context);
          },
        };
      },
    };
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.token", text: "What date " }),
      llmEvent(request, 3, { type: "llm.token", text: "should I book?" }),
      llmEvent(request, 4, {
        type: "llm.completed",
        text: "What date should I book?",
        toolCalls: [],
      }),
    ]);
    const tts = makeIncrementalTts({ autoAudio: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: contextProvider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      sttConversationContext: true,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT session opens");
    stt.pushFinal(session.id, "ask for a date");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "incremental turn completes",
    );
    call.push(streamEnded(session.id));
    await running;

    expect(tts.sentTexts.join("")).toBe("What date should I book?");
    expect(contexts).toEqual(["What date should I book?"]);
  });

  it("does not request TTS timestamps from providers that cannot provide them", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const tts = makeIncrementalTts({ autoFinish: false, timestamps: false });
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "No timestamps." }),
      llmEvent(req, 3, { type: "llm.completed", text: "No timestamps.", toolCalls: [] }),
    ]);
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "speak without alignment");
    await until(() => tts.ready, "incremental tts opened");

    expect(tts.openRequest?.timestamps).toBe(false);
    tts.pushChunk(1);
    tts.end();
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "completed",
      "timestamp-free turn completed",
    );
    call.push(streamEnded(session.id));
    await running;
  });

  it("does not let alignment events hide an incremental TTS audio stall", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const tts = makeIncrementalTts({ autoFinish: false });
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "Waiting for audio." }),
      llmEvent(req, 3, { type: "llm.completed", text: "Waiting for audio.", toolCalls: [] }),
    ]);
    const assistantRecords: AssistantTextRecord[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 30,
      onAssistantText: (record) => assistantRecords.push(record),
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "stall please");
    await until(() => tts.ready, "incremental tts opened");
    const alignmentNoise = setInterval(() => tts.pushAlignment(["waiting"], [10]), 5);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "tts audio stall cancelled turn",
    );
    clearInterval(alignmentNoise);
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.firstTurnError).toBeNull();
    expect(assistantRecords[0]?.audioError?.code).toBe("tts.stalled");
    expect(call.sent).toEqual([]);
  });

  it("handles barge-in mid-playout: cancels output and ends the turn cancelled", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "Let me explain in detail..." }),
      llmEvent(req, 3, {
        type: "llm.completed",
        text: "Let me explain in detail...",
        toolCalls: [],
      }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: false });
    const loopAgent = withPipelineProviders(agent, {
      stt: stt.provider,
      llm,
      tts,
    });
    const conversationPolicy = new ConversationPolicy({ agent: loopAgent });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: loopAgent,
      callHandle: call.handle,
      llmModel: "gpt-test",
      conversationPolicy,
    });

    const running = loop.run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "tell me everything");

    await until(() => call.sent.length >= 1, "first agent audio chunk");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls >= 1, "output cleared");
    call.push(streamEnded(session.id));

    const result = await running;

    expect(result.interruptions).toBe(1);
    expect(call.clearCalls).toBe(1);

    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
    expect(conversationPolicy.messagesForTranscript("continue")).toEqual(
      expect.arrayContaining([
        { role: "user", content: "tell me everything" },
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Response interrupted before completion"),
        }),
      ]),
    );
  });

  it("retains terminal LLM usage already buffered when barge-in interrupts the turn", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let signalLlmPending!: () => void;
    const llmPending = new Promise<void>((resolve) => {
      signalLlmPending = resolve;
    });
    let signalCancelled!: () => void;
    const llmCancelled = new Promise<void>((resolve) => {
      signalCancelled = resolve;
    });
    let resolveTerminal: ((result: IteratorResult<LlmStreamEvent>) => void) | undefined;
    const llm: LLMProvider = {
      name: "fake-llm",
      kind: "llm",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
        let nextCount = 0;
        const terminal = llmEvent(request, 2, {
          type: "llm.completed",
          text: "cancelled answer",
          toolCalls: [],
          usage: { inputTokens: 17, outputTokens: 4, cachedTokens: 3 },
        });
        return {
          events: {
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<LlmStreamEvent>> {
                  nextCount += 1;
                  if (nextCount === 1) {
                    return Promise.resolve({
                      done: false,
                      value: llmEvent(request, 1, { type: "llm.started", model: request.model }),
                    });
                  }
                  if (nextCount === 2) {
                    signalLlmPending();
                    return new Promise((resolve) => {
                      resolveTerminal = resolve;
                    });
                  }
                  return Promise.resolve({ done: true, value: undefined });
                },
                async return(): Promise<IteratorResult<LlmStreamEvent>> {
                  return { done: true, value: undefined };
                },
              };
            },
          },
          async cancel() {
            resolveTerminal?.({ done: false, value: terminal });
            signalCancelled();
          },
        };
      },
    };
    const loopAgent = withPipelineProviders(agent, {
      stt: stt.provider,
      llm,
      tts: makeTts(() => [], { endStream: true }),
    });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: loopAgent,
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "tell me everything");
    await llmPending;
    stt.pushSpeechStarted(session.id);
    await llmCancelled;
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "interrupted LLM turn finalized",
    );
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    expect(sessionEnds[0]?.usage?.entries).toContainEqual(
      expect.objectContaining({
        kind: "llm",
        metrics: {
          requestCount: { status: "measured", source: "runtime", unit: "requests", value: 1 },
          inputTokens: { status: "reported", source: "provider", unit: "tokens", value: 17 },
          outputTokens: { status: "reported", source: "provider", unit: "tokens", value: 4 },
          cachedTokens: { status: "reported", source: "provider", unit: "tokens", value: 3 },
        },
      }),
    );
  });

  it("counts STT audio once when the adapter measures physical writes", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let adapterWrites = 0;
    const sttProvider: SpeechToTextProvider = {
      ...stt.provider,
      usageAccounting: { reportsAudioWrites: true },
      async open(request) {
        const stream = await stt.provider.open(request);
        return {
          ...stream,
          async sendAudio(chunk) {
            await stream.sendAudio(chunk);
            adapterWrites += 1;
            request.usageReporter
              ?.beginAudioWrite({
                byteLength: chunk.audio.bytes.byteLength,
                format: chunk.audio.format,
              })
              .succeeded();
          },
        };
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: sttProvider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();

    call.push(streamStarted(session.id));
    call.push(audioChunkIn(session.id));
    await until(() => adapterWrites === 1, "adapter audio write");
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    expect(adapterWrites).toBe(1);
    expect(sessionEnds[0]?.usage?.entries).toContainEqual(
      expect.objectContaining({
        kind: "stt",
        provider: "fake-stt",
        metrics: {
          audioMsSent: {
            status: "measured",
            source: "runtime",
            unit: "milliseconds",
            value: 20,
          },
        },
      }),
    );
  });

  it.each([
    {
      usesRequestModelForUsage: true,
      expectedModel: "request-model",
      expectedModelSource: "request",
    },
    {
      usesRequestModelForUsage: false,
      expectedModel: "unknown",
      expectedModelSource: "not_reported",
    },
  ] as const)(
    "attributes wrapper TTS usage only when request-model attribution is declared",
    async ({ usesRequestModelForUsage, expectedModel, expectedModelSource }) => {
      const sessionEnds: SessionEndEvent[] = [];
      const runtime = createRuntime({
        onSessionEnd: (event) => {
          sessionEnds.push(event);
        },
      });
      await runtime.start();
      const agent = buildAgent();
      const session = await runtime.startSession(agent, { channel: "simulated" });
      const call = makeCallHandle();
      const stt = makeStt();
      const llm = makeLlm((request) => [
        llmEvent(request, 1, { type: "llm.started", model: request.model }),
        llmEvent(request, 2, { type: "llm.completed", text: "hello", toolCalls: [] }),
      ]);
      const tts: TextToSpeechProvider = {
        ...makeTts(
          (request) => {
            request.usageReporter?.reportTextCharacters([...request.text].length);
            return [audioChunk(request, 1)];
          },
          { endStream: true },
        ),
        name: "wrapped-tts",
        configuredModel: "configured-model",
        capabilities: {
          ...TEST_PROVIDER_CAPABILITIES,
          models: ["configured-model", "request-model"],
        },
        usageAccounting: {
          reportsTextCharacters: true,
          ...(usesRequestModelForUsage ? { usesRequestModelForUsage: true } : {}),
        },
      };
      const loop = new PipelineVoiceLoop({
        runtime,
        session,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
        callHandle: call.handle,
        llmModel: "gpt-test",
        ttsModel: "request-model",
      });
      const running = loop.run();

      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "say hello");
      await until(() => call.sent.length >= 1, "wrapped TTS audio delivered");
      call.push(streamEnded(session.id));
      await running;
      await runtime.endSession(session.id, { reason: "completed" });

      const ttsUsage = sessionEnds[0]?.usage?.entries.find((entry) => entry.kind === "tts");
      expect(ttsUsage).toMatchObject({
        provider: "wrapped-tts",
        model: expectedModel,
        modelSource: expectedModelSource,
        metrics: {
          charactersSent: {
            status: "measured",
            source: "runtime",
            unit: "unicode_code_points",
            value: 5,
          },
          audioMsReceived: {
            status: "measured",
            source: "runtime",
            unit: "milliseconds",
            value: 20,
          },
        },
      });
    },
  );

  it("uses the provider-declared model source for direct TTS usage", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "hello", toolCalls: [] }),
    ]);
    const tts: TextToSpeechProvider = {
      ...makeTts((request) => [audioChunk(request, 1)], { endStream: true }),
      name: "implicit-model-tts",
      configuredModel: "catalog-default",
      configuredModelSource: "not_reported",
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "say hello");
    await until(() => call.sent.length >= 1, "direct TTS audio delivered");
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    expect(sessionEnds[0]?.usage?.entries.find((entry) => entry.kind === "tts")).toMatchObject({
      provider: "implicit-model-tts",
      model: "catalog-default",
      modelSource: "not_reported",
    });
  });

  it("forwards call-scoped TTS language and speed to one-shot synthesis", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let synthesisRequest: TtsSynthesisRequest | undefined;
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "hello", toolCalls: [] }),
    ]);
    const tts = makeTts(
      (request) => {
        synthesisRequest = request;
        return [audioChunk(request, 1)];
      },
      { endStream: true },
    );
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      ttsLanguage: "hi-IN",
      ttsSpeed: 1.1,
    });
    const running = loop.run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "say hello");
    await until(() => call.sent.length >= 1, "one-shot TTS audio delivered");
    call.push(streamEnded(session.id));
    await running;

    expect(synthesisRequest).toMatchObject({ language: "hi-IN", speed: 1.1 });
  });

  it("forwards call-scoped TTS language and speed to incremental sessions", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const tts = makeIncrementalTts({ autoAudio: true });
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.completed", text: "hello.", toolCalls: [] }),
    ]);
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      ttsLanguage: "hi-IN",
      ttsSpeed: 1.1,
    });
    const running = loop.run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "say hello");
    await until(() => call.sent.length >= 1, "incremental TTS audio delivered");
    call.push(streamEnded(session.id));
    await running;

    expect(tts.request).toMatchObject({ language: "hi-IN", speed: 1.1 });
  });

  it("records a clear that succeeds after its call-path timeout", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    let releaseClear!: () => void;
    let signalClearStarted!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    let signalSecondAudio!: () => void;
    const secondAudioSent = new Promise<void>((resolve) => {
      signalSecondAudio = resolve;
    });
    let audioSendCount = 0;
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        const accepted = await call.handle.send(event);
        if (event.type === "media.audio.chunk") {
          audioSendCount += 1;
          if (audioSendCount === 2) signalSecondAudio();
        }
        return accepted;
      },
      async clear() {
        await call.handle.clear();
        signalClearStarted();
        await clearGate;
      },
    };
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "Let me explain in detail..." }),
      llmEvent(req, 3, {
        type: "llm.completed",
        text: "Let me explain in detail...",
        toolCalls: [],
      }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: false });
    const loopAgent = withPipelineProviders(agent, {
      stt: stt.provider,
      llm,
      tts,
    });
    const conversationPolicy = new ConversationPolicy({ agent: loopAgent });
    const tapFrames: AudioTapFrame[] = [];

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: loopAgent,
      callHandle,
      llmModel: "gpt-test",
      conversationPolicy,
      audioTap: {
        onFrame: (frame) => {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "tell me everything");

    await until(() => call.sent.length >= 1, "first agent audio chunk");
    stt.pushSpeechStarted(session.id);
    await clearStarted;
    await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS + 50);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "first turn interrupted before clear completes",
    );
    stt.pushFinal(session.id, "second turn while clear is pending");
    const secondAudioBeforeClear = Promise.race([
      secondAudioSent.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await secondAudioBeforeClear).toBe(true);
    expect(call.sent).toHaveLength(2);
    releaseClear();
    await until(() => call.sent.length >= 2, "second turn audio chunk after clear");
    const snapshotBeforeClear = await runtime.inspectSession(session.id);
    const firstTurnId = snapshotBeforeClear.turns[0]!.id;
    const firstAudioFrame = tapFrames.find(
      (frame) =>
        frame.type === "audio" && frame.direction === "agent" && frame.turnId === firstTurnId,
    );
    expect(firstAudioFrame).toBeDefined();
    await until(() => call.clearCalls >= 1, "output cleared");
    await until(
      () => tapFrames.some((frame) => frame.type === "cleared" && frame.turnId === firstTurnId),
      "late successful clear marker tapped",
    );
    const firstClearFrame = tapFrames.find(
      (frame) => frame.type === "cleared" && frame.turnId === firstTurnId,
    );
    const secondAudioFrame = tapFrames.find(
      (frame) =>
        frame.type === "audio" && frame.direction === "agent" && frame.turnId !== firstTurnId,
    );
    expect(secondAudioFrame).toBeDefined();
    expect(firstClearFrame).toMatchObject({
      type: "cleared",
      throughSequence: firstAudioFrame?.sequence,
    });
    expect(firstClearFrame!.sequence).toBeGreaterThan(secondAudioFrame!.sequence);
    call.push(streamEnded(session.id));

    const result = await running;

    expect(result.interruptions).toBe(1);
    expect(call.clearCalls).toBe(1);
    await until(() => tapFrames.some((frame) => frame.type === "cleared"), "clear marker tapped");
    expect(
      tapFrames.find((frame) => frame.type === "cleared" && frame.turnId === firstTurnId),
    ).toMatchObject({
      type: "cleared",
      direction: "agent",
      throughSequence: firstAudioFrame?.sequence,
    });

    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
    expect(conversationPolicy.messagesForTranscript("continue")).toEqual(
      expect.arrayContaining([
        { role: "user", content: "tell me everything" },
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Response interrupted before completion"),
        }),
      ]),
    );
  }, 20_000);

  it("uses TTS alignment to retain only the generated prefix after barge-in", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "Only heard before the long answer." }),
      llmEvent(req, 3, {
        type: "llm.completed",
        text: "Only heard before the long answer.",
        toolCalls: [],
      }),
    ]);
    const tts = makeIncrementalTts({ autoFinish: false });
    const loopAgent = withPipelineProviders(agent, {
      stt: stt.provider,
      llm,
      tts: tts.provider,
    });
    const conversationPolicy = new ConversationPolicy({ agent: loopAgent });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: loopAgent,
      callHandle: call.handle,
      llmModel: "gpt-test",
      conversationPolicy,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "start explaining");
    await until(() => tts.ready, "incremental tts opened");
    tts.pushAlignment(["Only", "heard"], [80, 160]);
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "aligned audio sent");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls >= 1, "aligned response interrupted");
    call.push(streamEnded(session.id));

    await running;
    const messages = conversationPolicy.messagesForTranscript("continue");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("Only heard"),
        }),
      ]),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("long answer"),
        }),
      ]),
    );
  });

  it("updates STT context with only the aligned assistant prefix after barge-in", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const endTurn = runtime.endTurn.bind(runtime);
    let markCancelledEndTurnStarted!: () => void;
    const cancelledEndTurnStarted = new Promise<void>((resolve) => {
      markCancelledEndTurnStarted = resolve;
    });
    let releaseCancelledEndTurn!: () => void;
    const cancelledEndTurnGate = new Promise<void>((resolve) => {
      releaseCancelledEndTurn = resolve;
    });
    vi.spyOn(runtime, "endTurn").mockImplementation(async (sessionId, turnId, request) => {
      if (request.reason === "cancelled") {
        markCancelledEndTurnStarted();
        await cancelledEndTurnGate;
      }
      return endTurn(sessionId, turnId, request);
    });
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const contexts: string[] = [];
    const contextProvider: SpeechToTextProvider = {
      ...stt.provider,
      supportsSttAgentContext: () => true,
      async open(request) {
        const stream = await stt.provider.open(request);
        return {
          ...stream,
          async updateAgentContext(context) {
            contexts.push(context);
          },
        };
      },
    };
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.token", text: "Only heard before the long answer." }),
      llmEvent(request, 3, {
        type: "llm.completed",
        text: "Only heard before the long answer.",
        toolCalls: [],
      }),
    ]);
    const tts = makeIncrementalTts({ autoFinish: false });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: contextProvider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      sttConversationContext: true,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT session opens");
    stt.pushFinal(session.id, "start explaining");
    await until(() => tts.ready, "incremental TTS opens");
    tts.pushAlignment(["Only", "heard"], [80, 160]);
    tts.pushChunk(1);
    await until(() => call.sent.length > 0, "aligned audio is sent");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls > 0, "aligned output is interrupted");
    await cancelledEndTurnStarted;
    const contextBeforeEndTurnSettled = contexts.at(-1);
    releaseCancelledEndTurn();
    await until(() => contexts.length > 1, "interrupted context update is submitted");
    call.push(streamEnded(session.id));
    await running;

    expect(contextBeforeEndTurnSettled).toBe("Only heard");
    expect(contexts.at(-1)).toBe("Only heard");
  });

  it("does not add unaligned generated text to STT context after barge-in", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const contexts: string[] = [];
    const contextProvider: SpeechToTextProvider = {
      ...stt.provider,
      supportsSttAgentContext: () => true,
      async open(request) {
        const stream = await stt.provider.open(request);
        return {
          ...stream,
          async updateAgentContext(context) {
            contexts.push(context);
          },
        };
      },
    };
    const reply = "This whole reply may not have played.";
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.started", model: request.model }),
      llmEvent(request, 2, { type: "llm.token", text: reply }),
      llmEvent(request, 3, { type: "llm.completed", text: reply, toolCalls: [] }),
    ]);
    const tts = makeIncrementalTts({ autoFinish: false });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: contextProvider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      sttConversationContext: true,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT session opens");
    stt.pushFinal(session.id, "start explaining");
    await until(() => tts.ready, "incremental TTS opens");
    tts.pushChunk(1);
    await until(() => call.sent.length > 0, "assistant audio is sent");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls > 0, "assistant output is interrupted");
    await until(() => contexts.length > 1, "interrupted context update is submitted");
    call.push(streamEnded(session.id));
    await running;

    expect(contexts).toEqual([reply, ""]);
  });

  it("reconstructs character alignment without spaces or repeated-letter loss", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "letter before the long answer" }),
      llmEvent(req, 3, {
        type: "llm.completed",
        text: "letter before the long answer",
        toolCalls: [],
      }),
    ]);
    const tts = makeIncrementalTts({ autoFinish: false });
    const loopAgent = withPipelineProviders(agent, {
      stt: stt.provider,
      llm,
      tts: tts.provider,
    });
    const conversationPolicy = new ConversationPolicy({ agent: loopAgent });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: loopAgent,
      callHandle: call.handle,
      llmModel: "gpt-test",
      conversationPolicy,
      memory,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "spell it");
    await until(() => tts.ready, "character-aligned tts opened");
    tts.pushAlignment(["l", "e", "t"], [20, 40, 60], {
      unit: "character",
      startMs: [0, 20, 40],
    });
    tts.pushAlignment(["t", "t", "e", "r"], [60, 80, 100, 120], {
      unit: "character",
      startMs: [40, 60, 80, 100],
    });
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "character-aligned audio sent");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls >= 1, "character-aligned response interrupted");
    call.push(streamEnded(session.id));

    await running;
    const messages = conversationPolicy.messagesForTranscript("continue");
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("letter"),
        }),
      ]),
    );
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("l e t"),
        }),
      ]),
    );
    const stored = await memory.list(
      { scope: "session", sessionId: session.id },
      { prefix: `exchange:${session.id}:`, kind: "raw" },
    );
    expect(stored.map((entry) => entry.value)).toEqual([
      { user: "spell it", assistant: "letter", interrupted: true },
    ]);
  });

  it("interrupts active playout on Twilio DTMF input", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "menu options", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "read the menu");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(dtmf(session.id));
    await until(() => call.clearCalls >= 1, "dtmf interruption handled");
    call.push(streamEnded(session.id));

    expect((await running).interruptions).toBe(1);
  });

  it("cancels a blocked LLM stream when the caller hangs up, without hanging", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm.provider,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => llm.completeCalled, "llm invoked");
    call.push(streamEnded(session.id));
    await until(() => llm.cancelled, "llm cancelled");

    const result = await running;
    expect(result.interruptions).toBe(0);
    expect(llm.cancelled).toBe(true);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("cancels a blocked tool when the caller hangs up", async () => {
    const runtime = createRuntime();
    await runtime.start();
    let toolStarted = false;
    const blockingTool = defineTool({
      id: "tool_block",
      name: "check_availability",
      description: "blocks forever",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        toolStarted = true;
        return new Promise<never>(() => {});
      },
    });
    const agent = buildAgent({ tools: [blockingTool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const toolCall = { callRef: "c1", toolName: "check_availability" as never, input: {} };
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.tool_call", call: toolCall }),
      llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [toolCall] }),
    ]);
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "do it");
    await until(() => toolStarted, "tool started");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it.each([false, true])(
    "terminalizes non-serializable tool input before admission (idempotency %s)",
    async (idempotencyEnabled) => {
      const durableStore = createInMemoryDurableRuntimeStore();
      const runtime = new InMemoryRuntime({
        durableStore,
        holderId: `invalid-input-${idempotencyEnabled}`,
      });
      await runtime.start();
      let executions = 0;
      const invalidInputTool = defineTool({
        id: "tool_invalid_input",
        name: "inspect_input",
        description: "Rejects malformed provider input before execution.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        ...(idempotencyEnabled ? { idempotency: { enabled: true } } : {}),
        async execute() {
          executions += 1;
          return { accepted: true };
        },
      });
      const agent = buildAgent({ tools: [invalidInputTool] });
      const attachment = await runtime.startAttachedSession(agent, { channel: "simulated" });
      const call = makeCallHandle();
      const stt = makeStt();
      const cyclicInput: Record<string, unknown> = { value: "never execute" };
      cyclicInput.self = cyclicInput;
      const toolCall = {
        callRef: "invalid-input",
        toolName: "inspect_input" as never,
        input: cyclicInput,
      };
      let llmCalls = 0;
      const llm = makeLlm((req) => {
        llmCalls += 1;
        if (llmCalls === 1) {
          return [
            llmEvent(req, 1, { type: "llm.started", model: req.model }),
            llmEvent(req, 2, { type: "llm.tool_call", call: toolCall }),
            llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [toolCall] }),
          ];
        }
        return [
          llmEvent(req, 1, { type: "llm.started", model: req.model }),
          llmEvent(req, 2, {
            type: "llm.completed",
            text: "I could not use that tool input.",
            toolCalls: [],
          }),
        ];
      });
      const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
      const loop = new PipelineVoiceLoop({
        runtime,
        session: attachment.session,
        attachment,
        agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
        callHandle: call.handle,
        llmModel: "gpt-test",
      });

      const running = loop.run();
      call.push(streamStarted(attachment.session.id));
      stt.pushFinal(attachment.session.id, "run the malformed tool");
      await until(() => call.sent.length >= 1, "typed tool failure response");
      call.push(streamEnded(attachment.session.id));
      await running;

      expect(executions).toBe(0);
      expect(llmCalls).toBe(2);
      await expect(runtime.inspectSession(attachment.session.id)).resolves.toMatchObject({
        session: { state: { pendingToolCallIds: [] } },
        toolCalls: [
          {
            status: "failed",
            input: { $tvic: "input_unavailable", reason: "not_serializable" },
            metadata: { inputRedacted: true },
            error: { code: "tool.input_not_serializable" },
          },
        ],
      });
      expect(
        durableStore.outbox.filter(
          (event) =>
            event.aggregateType === "tool_call" &&
            (event.envelope.payload as { readonly status: string }).status === "failed",
        ),
      ).toHaveLength(1);
      await attachment.detach();
    },
  );

  it("does not write session memory when the policy excludes the session scope", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
    await runtime.start();
    const agent = buildAgent({ memoryScopes: ["user"] });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "ok" }),
      llmEvent(req, 3, { type: "llm.completed", text: "ok", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(() => call.sent.length >= 1, "agent audio");
    call.push(streamEnded(session.id));
    await running;

    expect(
      await memory.list(
        { scope: "session", sessionId: session.id },
        { prefix: `exchange:${session.id}:`, kind: "raw" },
      ),
    ).toHaveLength(0);
  });

  it("does not expose the memory writer or write implicit memory in read-only mode", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
    await runtime.start();
    const baseAgent = buildAgent({ memoryScopes: ["session", "user"] });
    const call = makeCallHandle();
    const stt = makeStt();
    let requestedTools: readonly { readonly name: string }[] = [];
    const llm = makeLlm((req) => {
      requestedTools = req.tools ?? [];
      return [
        llmEvent(req, 1, { type: "llm.started", model: req.model }),
        llmEvent(req, 2, { type: "llm.completed", text: "read only", toolCalls: [] }),
      ];
    });
    const agent = defineAgent({
      ...baseAgent,
      memoryPolicy: { ...baseAgent.memoryPolicy, canLlmWrite: true, readOnly: true },
      providers: { ...baseAgent.providers, stt: stt.provider, llm },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: defineAgent({ ...agent, providers: { ...agent.providers, tts } }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "do not remember this");
    await until(() => call.sent.length >= 1, "read-only reply audio");
    call.push(streamEnded(session.id));
    await running;

    expect(requestedTools.some((tool) => tool.name === "remember_fact")).toBe(false);
    expect(
      await memory.list(
        { scope: "session", sessionId: session.id },
        { prefix: `exchange:${session.id}:`, kind: "raw" },
      ),
    ).toHaveLength(0);
  });

  it("aborts during TTS connection setup when the caller hangs up (before the stream exists)", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.token", text: "speaking" }),
      llmEvent(req, 3, { type: "llm.completed", text: "speaking", toolCalls: [] }),
    ]);
    const tts = makeBlockingTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => tts.synthesizeCalled, "tts setup started");
    call.push(streamEnded(session.id));

    const result = await running;
    await runtime.endSession(session.id, { reason: "completed" });
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
    expect(sessionEnds[0]?.usage?.entries).toContainEqual(
      expect.objectContaining({
        kind: "tts",
        metrics: expect.objectContaining({
          audioMsReceived: {
            status: "not_reported",
            source: "runtime",
            unit: "milliseconds",
            notReported: [{ reason: "interrupted", operations: 1 }],
          },
        }),
      }),
    );
  });

  it("bounds a slow telephony clear", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle({ hangClear: true });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: false });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => call.sent.length >= 1, "first agent chunk");
    stt.pushSpeechStarted(session.id);
    await until(() => call.clearCalls >= 1, "clear attempted");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("does not hold later audio behind an ordinary pending tap clear", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let releaseClear!: () => void;
    let releaseFirstPlayout!: (confirmed: boolean) => void;
    let signalFirstAudio!: () => void;
    let signalFirstPlayout!: () => void;
    let signalClearStarted!: () => void;
    let signalSecondAudio!: () => void;
    let signalSecondAudioTapped!: () => void;
    let signalClearMarker!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const firstPlayoutGate = new Promise<boolean>((resolve) => {
      releaseFirstPlayout = resolve;
    });
    const firstAudioSent = new Promise<void>((resolve) => {
      signalFirstAudio = resolve;
    });
    const firstPlayoutStarted = new Promise<void>((resolve) => {
      signalFirstPlayout = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    const secondAudioSent = new Promise<void>((resolve) => {
      signalSecondAudio = resolve;
    });
    const secondAudioTapped = new Promise<void>((resolve) => {
      signalSecondAudioTapped = resolve;
    });
    const clearMarker = new Promise<void>((resolve) => {
      signalClearMarker = resolve;
    });
    let audioSends = 0;
    let playoutCalls = 0;
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        const accepted = await call.handle.send(event);
        if (event.type === "media.audio.chunk") {
          audioSends += 1;
          if (audioSends === 1) signalFirstAudio();
          if (audioSends === 2) signalSecondAudio();
        }
        return accepted;
      },
      async confirmPlayout() {
        playoutCalls += 1;
        if (playoutCalls === 1) {
          signalFirstPlayout();
          return firstPlayoutGate;
        }
        return true;
      },
      async clear() {
        await call.handle.clear();
        signalClearStarted();
        await clearGate;
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1), committed(request)], {
      endStream: true,
    });
    let firstAudioSequence: number | undefined;
    let secondAudioSequence: number | undefined;
    let clearSequence: number | undefined;
    let clearThroughSequence: number | undefined;
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          if (frame.type === "audio" && frame.direction === "agent") {
            if (firstAudioSequence === undefined) firstAudioSequence = frame.sequence;
            else {
              secondAudioSequence = frame.sequence;
              signalSecondAudioTapped();
            }
          }
          if (frame.type === "cleared") {
            clearSequence = frame.sequence;
            clearThroughSequence = frame.throughSequence;
            signalClearMarker();
          }
        },
      },
    });

    const running = loop.run();
    let released = false;
    let ended = false;
    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn");
      await firstAudioSent;
      await firstPlayoutStarted;

      stt.pushSpeechStarted(session.id);
      await clearStarted;
      stt.pushFinal(session.id, "second turn");
      const secondAudioSentBeforeClear = await Promise.race([
        secondAudioSent.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(secondAudioSentBeforeClear).toBe(true);
      await secondAudioTapped;
      expect(secondAudioSequence).toBeDefined();
      expect(secondAudioSequence).toBeGreaterThan(firstAudioSequence!);
      expect(clearSequence).toBeUndefined();
      releaseClear();
      released = true;
      await clearMarker;
      expect(clearThroughSequence).toBe(firstAudioSequence);
      expect(clearSequence).toBeGreaterThan(secondAudioSequence!);

      call.push(streamEnded(session.id, "completed"));
      ended = true;
      const result = await running;
      expect(result.terminalReason).toBe("completed");
    } finally {
      if (!released) releaseClear();
      releaseFirstPlayout(false);
      if (!ended) call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
    }
  }, 20_000);

  it("does not wait for stalled audio sends during tap-off session finalization", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let releaseAudioSend!: () => void;
    let signalAudioSendStarted!: () => void;
    const audioSendGate = new Promise<void>((resolve) => {
      releaseAudioSend = resolve;
    });
    const audioSendStarted = new Promise<void>((resolve) => {
      signalAudioSendStarted = resolve;
    });
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        if (event.type === "media.audio.chunk") {
          signalAudioSendStarted();
          await audioSendGate;
        }
        return call.handle.send(event);
      },
    };
    const stt = makeStt();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: makeLlm((request) => [
          llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
        ]),
        tts: makeTts((request) => [audioChunk(request, 1)], { endStream: true }),
      }),
      callHandle,
      llmModel: "gpt-test",
    });
    const running = loop.run();

    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "start the response");
      await audioSendStarted;

      const ended = await Promise.race([
        runtime.endSession(session.id, { reason: "completed" }).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);

      expect(ended).toBe(true);
    } finally {
      releaseAudioSend();
      call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
      await runtime.stop();
    }
  }, 20_000);

  it("marks pending sends on one successful clear without issuing a follow-up clear", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let releaseFirstSend!: () => void;
    let releaseClear!: () => void;
    let signalFirstSend!: () => void;
    let signalSecondAudio!: () => void;
    let signalClearStarted!: () => void;
    let signalClearFinished!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const firstSendStarted = new Promise<void>((resolve) => {
      signalFirstSend = resolve;
    });
    const secondAudioSent = new Promise<void>((resolve) => {
      signalSecondAudio = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    let audioSends = 0;
    let clearCalls = 0;
    const clearFinished = new Promise<void>((resolve) => {
      signalClearFinished = resolve;
    });
    const tapFrames: AudioTapFrame[] = [];
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        if (event.type === "media.audio.chunk") {
          audioSends += 1;
          if (audioSends === 1) {
            signalFirstSend();
            await firstSendGate;
          }
          if (audioSends === 2) signalSecondAudio();
        }
        return call.handle.send(event);
      },
      async clear() {
        clearCalls += 1;
        if (clearCalls !== 1) throw new Error("one barge-in must issue one clear");
        await call.handle.clear();
        signalClearStarted();
        await clearGate;
        signalClearFinished();
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run();
    let ended = false;
    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn");
      await firstSendStarted;

      stt.pushSpeechStarted(session.id);
      await clearStarted;
      releaseFirstSend();
      await until(
        () => tapFrames.some((frame) => frame.type === "audio" && frame.direction === "agent"),
        "pending first send tapped before clear settles",
      );
      releaseClear();
      await clearFinished;
      await until(
        () => tapFrames.some((frame) => frame.type === "cleared"),
        "successful clear marker",
      );
      const clearMarker = tapFrames.find((frame) => frame.type === "cleared");
      expect(clearMarker).toMatchObject({
        hadPendingSends: true,
        pendingSendTurnIds: [(await runtime.inspectSession(session.id)).turns[0]!.id],
      });
      expect(clearMarker).not.toHaveProperty("throughSequence");

      await until(
        async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
        "interrupted send settles",
      );
      stt.pushFinal(session.id, "second turn");

      let sendDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          secondAudioSent,
          new Promise<never>((_resolve, reject) => {
            sendDeadline = setTimeout(
              () => reject(new Error("later output waited on tap-only clear work")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (sendDeadline !== undefined) clearTimeout(sendDeadline);
      }
      expect(clearCalls).toBe(1);

      call.push(streamEnded(session.id, "completed"));
      ended = true;
      const result = await running;
      expect(result.terminalReason).toBe("completed");
    } finally {
      releaseClear();
      releaseFirstSend();
      if (!ended) call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
    }
  }, 10_000);

  it("drops clear markers beyond the bounded pending-observer limit", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const runtime = createRuntime({
      clock: { now: () => TS, monotonicMs: () => Date.now() },
    });
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const tts = makeTts((request) => [audioChunk(request, 1), committed(request)], {
      endStream: true,
    });
    const interruptCount = AUDIO_TAP_MAX_BUFFERED_CONTROL_EVENTS + 1;
    const clearReleases: Array<() => void> = [];
    const audioWaiters = new Map<number, () => void>();
    const clearWaiters = new Map<number, () => void>();
    let audioSends = 0;
    let clearCalls = 0;
    const tapFrames: AudioTapFrame[] = [];
    const resolveCountWaiters = (waiters: Map<number, () => void>, count: number): void => {
      for (const [target, resolve] of waiters) {
        if (count >= target) {
          waiters.delete(target);
          resolve();
        }
      }
    };
    const waitForCount = (
      current: number,
      waiters: Map<number, () => void>,
      target: number,
    ): Promise<void> => {
      if (current >= target) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.set(target, resolve));
    };
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        const accepted = await call.handle.send(event);
        if (event.type === "media.audio.chunk") {
          audioSends += 1;
          resolveCountWaiters(audioWaiters, audioSends);
        }
        return accepted;
      },
      confirmPlayout() {
        return new Promise<boolean>(() => undefined);
      },
      clear() {
        clearCalls += 1;
        resolveCountWaiters(clearWaiters, clearCalls);
        return new Promise<void>((resolve) => clearReleases.push(resolve));
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: makeLlm((request) => [
          llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
        ]),
        tts,
      }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });
    const running = loop.run();
    let ended = false;

    try {
      call.push(streamStarted(session.id));
      for (let turnNumber = 1; turnNumber <= interruptCount; turnNumber += 1) {
        const audioSent = waitForCount(audioSends, audioWaiters, turnNumber);
        stt.pushFinal(session.id, `turn ${turnNumber}`);
        await audioSent;

        const clearStarted = waitForCount(clearCalls, clearWaiters, turnNumber);
        stt.pushSpeechStarted(session.id);
        await vi.advanceTimersByTimeAsync(0);
        await clearStarted;
        await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS);
        const turns = (await runtime.inspectSession(session.id)).turns;
        expect(turns[turnNumber - 1]?.status).toBe("cancelled");
      }

      const lastTurnId = (await runtime.inspectSession(session.id)).turns.at(-1)?.id;
      expect(lastTurnId).toBeDefined();
      clearReleases[interruptCount - 1]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.resolve();
      expect(
        tapFrames.some((frame) => frame.type === "cleared" && frame.turnId === lastTurnId),
      ).toBe(false);

      call.push(streamEnded(session.id, "completed"));
      ended = true;
      const resultPromise = running;
      await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS);
      const result = await resultPromise;
      expect(result.terminalReason).toBe("completed");
      expect(result.audioTap?.droppedEvents).toBeGreaterThanOrEqual(1);
    } finally {
      for (const release of clearReleases) release();
      if (!ended) call.push(streamEnded(session.id, "completed"));
      await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS + AUDIO_TAP_FINALIZE_TIMEOUT_MS + 1);
      await running.catch(() => undefined);
      await runtime.stop();
    }
  }, 20_000);

  it("continues after a clear times out while an interrupted send is in flight", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let releaseFirstSend!: () => void;
    let signalFirstSend!: () => void;
    let signalSecondAudio!: () => void;
    let signalClearStarted!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const firstSendStarted = new Promise<void>((resolve) => {
      signalFirstSend = resolve;
    });
    const secondAudioSent = new Promise<void>((resolve) => {
      signalSecondAudio = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    let audioSends = 0;
    let clearCalls = 0;
    let closeReason: Parameters<typeof call.handle.close>[0] | undefined;
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        if (event.type === "media.audio.chunk") {
          audioSends += 1;
          if (audioSends === 1) {
            signalFirstSend();
            await firstSendGate;
          } else if (audioSends === 2) {
            signalSecondAudio();
          }
        }
        return call.handle.send(event);
      },
      clear() {
        clearCalls += 1;
        signalClearStarted();
        return new Promise<void>(() => undefined);
      },
      async close(...args: Parameters<typeof call.handle.close>) {
        closeReason = args[0];
        await call.handle.close(...args);
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: { onFrame: () => undefined },
    });

    const running = loop.run();
    let ended = false;
    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn");
      await firstSendStarted;

      stt.pushSpeechStarted(session.id);
      await clearStarted;
      stt.pushFinal(session.id, "second turn");
      await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS + 50);
      releaseFirstSend();

      let sendDeadline: ReturnType<typeof setTimeout> | undefined;
      const secondAudioOutcome = Promise.race([
        secondAudioSent.then(() => "sent" as const),
        new Promise<"timed_out">((resolve) => {
          sendDeadline = setTimeout(() => resolve("timed_out"), 1_000);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      if (sendDeadline !== undefined) clearTimeout(sendDeadline);
      expect(await secondAudioOutcome).toBe("sent");
      expect(clearCalls).toBe(1);
      expect(closeReason).not.toBe("error");

      call.push(streamEnded(session.id, "completed"));
      ended = true;
      const resultPromise = running;
      await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS + AUDIO_TAP_FINALIZE_TIMEOUT_MS + 50);
      const result = await resultPromise;
      expect(result.terminalReason).toBe("completed");
    } finally {
      releaseFirstSend();
      if (!ended) call.push(streamEnded(session.id, "completed"));
      await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS + AUDIO_TAP_FINALIZE_TIMEOUT_MS + 1_000);
      await running.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("issues one transport clear for each overlapping barge-in", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let clearCalls = 0;
    let activeClears = 0;
    let maximumActiveClears = 0;
    let clearedMarkers = 0;
    const clearReleases: Array<() => void> = [];
    const callHandle = {
      ...call.handle,
      clear() {
        clearCalls += 1;
        activeClears += 1;
        maximumActiveClears = Math.max(maximumActiveClears, activeClears);
        return new Promise<void>((resolve) => {
          clearReleases.push(() => {
            activeClears -= 1;
            void call.handle.clear().then(resolve);
          });
        });
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: false });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          if (frame.type === "cleared") clearedMarkers += 1;
        },
      },
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "first turn");
    await until(() => call.sent.length === 1, "first turn audio sent");
    stt.pushSpeechStarted(session.id);
    await until(() => clearCalls === 1, "first clear attempted");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 1,
      "first turn interrupted",
    );

    stt.pushFinal(session.id, "second turn");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[1]?.status === "speaking",
      "second turn reached audio output",
    );
    stt.pushSpeechStarted(session.id);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[1]?.status === "cancelled",
      "second turn interrupted",
    );
    stt.pushFinal(session.id, "third turn");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[2]?.status === "speaking",
      "third turn reached audio output",
    );
    stt.pushSpeechStarted(session.id);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[2]?.status === "cancelled",
      "third turn interrupted",
    );
    expect(clearCalls).toBe(3);
    expect(maximumActiveClears).toBe(3);

    for (const release of clearReleases) release();
    await until(() => clearedMarkers === 3, "each successful clear is tapped");

    call.push(streamEnded(session.id, "completed"));
    await running;
    expect(activeClears).toBe(0);
  }, 20_000);

  it("ignores a rejected tap-observed clear without retrying or gating output", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let releaseFirstSend!: () => void;
    let signalFirstSend!: () => void;
    let signalClearStarted!: () => void;
    let clearCalls = 0;
    let audioSendCalls = 0;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const firstSendStarted = new Promise<void>((resolve) => {
      signalFirstSend = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    const callHandle = {
      ...call.handle,
      async clear() {
        clearCalls += 1;
        signalClearStarted();
        throw new Error("clear failed");
      },
      async send(event: Parameters<typeof call.handle.send>[0]) {
        if (event.type === "media.audio.chunk") {
          audioSendCalls += 1;
          if (audioSendCalls === 1) {
            signalFirstSend();
            await firstSendGate;
          }
        }
        return call.handle.send(event);
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run();
    let ended = false;
    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn");
      await firstSendStarted;
      stt.pushSpeechStarted(session.id);
      await clearStarted;
      stt.pushFinal(session.id, "second turn");
      releaseFirstSend();

      await until(() => audioSendCalls === 2, "later audio after rejected clear");
      expect(clearCalls).toBe(1);
      expect(audioSendCalls).toBe(2);
      expect(tapFrames.filter((frame) => frame.type === "cleared")).toHaveLength(0);

      call.push(streamEnded(session.id, "completed"));
      ended = true;
      const result = await running;
      expect(result.terminalReason).toBe("completed");
    } finally {
      releaseFirstSend();
      if (!ended) call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
    }
  }, 10_000);

  it("does not fail a call later because a tapped output clear never settles", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime({
      clock: {
        now: () => TS,
        monotonicMs: () => Date.now(),
      },
    });
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let signalAudioSent!: () => void;
    let signalClearStarted!: () => void;
    const audioSent = new Promise<void>((resolve) => {
      signalAudioSent = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    let closeReason: Parameters<typeof call.handle.close>[0] | undefined;
    const callHandle = {
      ...call.handle,
      async send(event: Parameters<typeof call.handle.send>[0]) {
        const accepted = await call.handle.send(event);
        if (event.type === "media.audio.chunk") signalAudioSent();
        return accepted;
      },
      clear() {
        signalClearStarted();
        return new Promise<void>(() => undefined);
      },
      async close(...args: Parameters<typeof call.handle.close>) {
        closeReason = args[0];
        await call.handle.close(...args);
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: false });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: { onFrame: () => undefined },
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "first turn");
    await audioSent;
    stt.pushSpeechStarted(session.id);
    await clearStarted;
    call.push(streamEnded(session.id, "completed"));

    const resultPromise = running;
    await vi.advanceTimersByTimeAsync(CLEAR_TIMEOUT_MS);
    const result = await resultPromise;
    expect(result.terminalReason).toBe("completed");
    expect(result.audioTap?.droppedEvents).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(AUDIO_TAP_FINALIZE_TIMEOUT_MS + 100);
    expect(closeReason).not.toBe("error");
  });

  it("counts a clear marker that is still pending when the tap closes", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    let releaseClear!: () => void;
    let signalClearStarted!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clearStarted = new Promise<void>((resolve) => {
      signalClearStarted = resolve;
    });
    const callHandle = {
      ...call.handle,
      async clear() {
        signalClearStarted();
        await clearGate;
        await call.handle.clear();
      },
    };
    const stt = makeStt();
    const llm = makeLlm((request) => [
      llmEvent(request, 1, { type: "llm.completed", text: "Answer", toolCalls: [] }),
    ]);
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: false });
    const tapFrames: AudioTapFrame[] = [];
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle,
      llmModel: "gpt-test",
      audioTap: {
        onFrame(frame) {
          tapFrames.push(frame);
        },
      },
    });

    const running = loop.run();
    let ended = false;
    try {
      call.push(streamStarted(session.id));
      stt.pushFinal(session.id, "first turn");
      await until(
        () => call.sent.some((event) => event.type === "media.audio.chunk"),
        "agent audio",
      );
      stt.pushSpeechStarted(session.id);
      await clearStarted;
      call.push(streamEnded(session.id, "completed"));
      ended = true;

      const result = await running;
      expect(result.terminalReason).toBe("completed");
      expect(result.audioTap).toMatchObject({ droppedEvents: 1 });
      releaseClear();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(tapFrames.some((frame) => frame.type === "cleared")).toBe(false);
    } finally {
      releaseClear();
      if (!ended) call.push(streamEnded(session.id, "completed"));
      await running.catch(() => undefined);
    }
  }, 10_000);

  it("interrupts on caller speech detected via STT while the agent is speaking", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 30, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "a long answer", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "tell me everything");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent speaking");

    vi.useFakeTimers();
    stt.pushSpeechStarted(session.id);
    await vi.advanceTimersByTimeAsync(10);
    expect(call.clearCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(call.clearCalls).toBeGreaterThanOrEqual(1);
    tts.end();
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("does not interrupt on caller speech during TTS startup (before any audio is sent)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "hello there", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(() => tts.ready, "tts opened");

    const deliveredBeforePartial = stt.deliveredEvents;
    stt.pushPartial(session.id, "are you there");
    await until(() => stt.deliveredEvents > deliveredBeforePartial, "partial transcript delivered");
    expect(call.clearCalls).toBe(0);

    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent audio sent");
    tts.end();
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("completed");
  });

  it("rejects an STT speech candidate shorter than minSpeechMs", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({
      interruptionPolicy: { mode: "graceful", minSpeechMs: 30, trimOutputOnInterrupt: true },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "still speaking", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "talk to me");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent speaking");

    const deliveredBeforeShortSpeech = stt.deliveredEvents;
    stt.pushSpeechStarted(session.id, 1_000);
    stt.pushEndpoint(session.id, 1_010);
    await until(
      () => stt.deliveredEvents >= deliveredBeforeShortSpeech + 2,
      "short speech and endpoint delivered",
    );
    expect(call.clearCalls).toBe(0);

    tts.end();
    call.push(streamEnded(session.id));
    expect((await running).interruptions).toBe(0);
  });

  it("ignores barge-in when interruption policy mode is 'ignore'", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({ interruptionPolicy: ignoreInterruptionPolicy() });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "full answer", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "first chunk played");
    stt.pushSpeechStarted(session.id);
    tts.pushChunk(2);
    tts.end();
    await until(() => call.sent.length >= 2, "playout finished");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("completed");
  });

  it("aborts an in-flight turn when the caller hangs up mid-response", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "here is a long answer", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "tell me about the menu");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent speaking");

    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("transport_lost");
  });

  it("keeps a turn completed when the caller hangs up after the reply is delivered", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "all set", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book it");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent speaking");

    tts.end();
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("completed");
    const stored = await memory.list(
      { scope: "session", sessionId: session.id },
      { prefix: `exchange:${session.id}:`, kind: "raw" },
    );
    expect(stored.map((entry) => entry.value)).toEqual([{ user: "book it", assistant: "all set" }]);
  });

  it("persists executed tool calls so the call is replayable", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const tool = defineTool({
      id: "tool_persist",
      name: "check_availability",
      description: "Check availability.",
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
    const toolCall = {
      callRef: "c1",
      toolName: "check_availability" as never,
      input: { partySize: 2 },
    };
    let llmCalls = 0;
    const llm = makeLlm((req) => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return [
          llmEvent(req, 1, { type: "llm.started", model: req.model }),
          llmEvent(req, 2, { type: "llm.tool_call", call: toolCall }),
          llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [toolCall] }),
        ];
      }
      return [
        llmEvent(req, 1, { type: "llm.started", model: req.model }),
        llmEvent(req, 2, { type: "llm.completed", text: "you're booked", toolCalls: [] }),
      ];
    });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "table for two");
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(streamEnded(session.id));

    await running;
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.toolCalls).toHaveLength(1);
    expect(snapshot.toolCalls[0]?.status).toBe("succeeded");
    expect(snapshot.toolCalls[0]?.sessionId).toBe(session.id);
  });

  it("fails fast when the STT stream errors, without waiting for a hangup", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const sttFailure = new Error("stt socket died");
    const stt: SpeechToTextProvider = {
      name: "failing-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async open(): Promise<SttStream> {
        return {
          events: (async function* (): AsyncIterable<TranscriptEvent> {
            throw sttFailure;
          })(),
          async sendAudio() {
            return;
          },
          async commit() {
            return;
          },
          async close() {
            return;
          },
        };
      },
    };
    const llm = makeLlm(() => []);
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await expect(running).rejects.toThrow("stt socket died");
  });

  it("preserves a provider stream error when the final audio send races socket death", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const events = new AsyncQueue<TranscriptEvent>();
    const sttFailure = providerError("stt.test_socket_failed", "provider socket failed", {
      provider: "racing-stt",
      retriable: false,
    });
    const streamEnded = providerError("stt.test_stream_ended", "provider stream has ended", {
      provider: "racing-stt",
      retriable: false,
      metadata: { reason: STT_STREAM_ENDED_REASON },
    });
    const stt: SpeechToTextProvider = {
      name: "racing-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async open(): Promise<SttStream> {
        return {
          events,
          async sendAudio() {
            events.fail(sttFailure);
            throw streamEnded;
          },
          async commit() {},
          async close() {},
        };
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(audioChunkIn(session.id));

    await expect(running).rejects.toMatchObject({
      name: "ProviderError",
      code: "stt.test_socket_failed",
      category: "provider",
      message: "provider socket failed",
    });
  });

  it("ignores a media-plane barge-in before any audio has played", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "hello there", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(() => tts.ready, "tts opened");

    const deliveredBeforeSpeech = stt.deliveredEvents;
    stt.pushSpeechStarted(session.id);
    await until(
      () => stt.deliveredEvents > deliveredBeforeSpeech,
      "speech-started transcript delivered",
    );
    expect(call.clearCalls).toBe(0);

    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "agent audio sent");
    tts.end();
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("completed");
  });

  it("fails the turn when the LLM emits llm.failed", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, {
        type: "llm.failed",
        error: internalError("llm.provider_failed", "model exploded"),
      }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed",
    );
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.turnsFailed).toBe(1);
    expect(result.firstTurnError?.code).toBe("llm.provider_failed");
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("failed");
  });

  it("marks LLM usage absent when iterator creation fails", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let cancelCalls = 0;
    const llm: LLMProvider = {
      name: "iterator-creation-failure-llm",
      kind: "llm",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async complete(): Promise<LlmCompletion> {
        return {
          events: {
            [Symbol.asyncIterator]() {
              throw new Error("iterator creation failed");
            },
          },
          async cancel() {
            cancelCalls += 1;
          },
        };
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm,
        tts: makeTts(() => [], { endStream: true }),
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hi");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed after iterator setup error",
    );
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    const llmUsage = sessionEnds[0]?.usage?.entries.find((entry) => entry.kind === "llm");
    expect(cancelCalls).toBe(1);
    expect(llmUsage?.metrics.requestCount).toMatchObject({ status: "measured", value: 1 });
    expect(llmUsage?.metrics.inputTokens).toMatchObject({
      status: "not_reported",
      notReported: [{ reason: "absent", operations: 1 }],
    });
  });

  it("cancels the turn (never completes) when output cannot be delivered", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle({ dropOutput: true });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "your table is booked", toolCalls: [] }),
    ]);
    const tts = makeControlledTts();

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts.provider,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book it");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled (undelivered)",
    );
    call.push(streamEnded(session.id));

    await running;
    const snapshot = await runtime.inspectSession(session.id);
    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("transport_lost");
  });

  it("commits buffered final speech after the endpoint wait expires", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "I heard you", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 15,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinalSegment(session.id, "speech without endpoint");
    await until(() => call.sent.length >= 1, "fallback turn audio");
    call.push(streamEnded(session.id));

    const result = await running;
    const snapshot = await runtime.inspectSession(session.id);
    expect(result.turnsHandled).toBe(1);
    expect(snapshot.turns[0]).toMatchObject({
      status: "completed",
      input: { transcript: "speech without endpoint" },
    });
  });

  it("debounces the endpoint fallback after every final segment", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Complete", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 80,
      turnMaxDurationMs: 1_000,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT opened");
    vi.useFakeTimers();
    stt.pushFinalSegment(session.id, "a table for four");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    stt.pushFinalSegment(session.id, "at eight tomorrow");
    await vi.advanceTimersByTimeAsync(0);
    expect(call.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(80);
    await vi.advanceTimersByTimeAsync(0);
    expect(call.sent.length).toBeGreaterThanOrEqual(1);
    call.push(streamEnded(session.id));

    await running;
    expect((await runtime.inspectSession(session.id)).turns[0]).toMatchObject({
      input: { transcript: "a table for four at eight tomorrow" },
    });
  });

  it("caps a continuously extended utterance at the maximum duration", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Capped", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 200,
      turnMaxDurationMs: 80,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    await until(() => stt.openRequest !== undefined, "STT opened");
    vi.useFakeTimers();
    stt.pushFinalSegment(session.id, "continuous");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(45);
    stt.pushFinalSegment(session.id, "speech");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(35);
    expect(call.sent.length).toBeGreaterThanOrEqual(1);
    call.push(streamEnded(session.id));

    await running;
    expect((await runtime.inspectSession(session.id)).turns[0]).toMatchObject({
      input: { transcript: "continuous speech" },
    });
  });

  it("cancels endpoint timers when the transcript stream fails", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const failure = new Error("STT socket failed");
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 15,
      turnMaxDurationMs: 30,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    vi.useFakeTimers();
    stt.pushFinalSegment(session.id, "must not become a turn");
    stt.failStream(failure);

    await expect(running).rejects.toMatchObject({ message: "STT socket failed" });
    await vi.advanceTimersByTimeAsync(40);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(0);
  });

  it("preempts a pending STT commit when the caller hangs up", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "Goodbye", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 1_000,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinalSegment(session.id, "unfinished goodbye");
    await new Promise<void>((resolve) => setImmediate(resolve));
    call.push(streamEnded(session.id));

    const result = await running;
    const snapshot = await runtime.inspectSession(session.id);
    expect(stt.commitCalls).toBe(0);
    expect(result.turnsHandled).toBeLessThanOrEqual(1);
    expect(snapshot.turns.length).toBeLessThanOrEqual(1);
  });

  it("handles two push-to-talk commits as separate turns without ending the session", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: stt.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();
    call.push(streamStarted(session.id));

    stt.pushFinalSegment(session.id, "first request");
    call.push(commitRequested(session.id, 1));
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 1,
      "first push-to-talk turn",
    );
    stt.pushFinalSegment(session.id, "second request");
    call.push(commitRequested(session.id, 2));
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 2,
      "second push-to-talk turn",
    );

    call.push(streamEnded(session.id));
    const result = await running;
    expect(result.turnsHandled).toBe(2);
    expect(
      (await runtime.inspectSession(session.id)).turns.map((turn) => turn.input.transcript),
    ).toEqual(["first request", "second request"]);
  });

  it("waits for all post-commit finals when no endpoint proves settlement", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime({
      clock: {
        now: () => TS,
        monotonicMs: () => Date.now(),
      },
    });
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const scripted = makeScriptedCommitStt(session.id, async (_call, events) => {
      events.push(finalTranscript(session.id, 1, "one"));
      events.push(finalTranscript(session.id, 2, "two"));
    });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: scripted.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(249);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(1);
    call.push(streamEnded(session.id));
    await running;
    expect((await runtime.inspectSession(session.id)).turns[0]?.input.transcript).toBe("one two");
  });

  it("uses a real endpoint for early settlement and preserves ordered audio boundaries", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const order: string[] = [];
    const scripted = makeScriptedCommitStt(
      session.id,
      async (_call, events) => {
        order.push("commit:start");
        events.push(finalTranscript(session.id, 1, "settled"));
        events.push(endpointTranscript(session.id, 2));
        order.push("commit:end");
      },
      () => order.push("audio"),
    );
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: scripted.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    call.push(audioChunkIn(session.id));
    await until(() => order.includes("audio"), "post-commit audio accepted");
    expect(order).toEqual(["commit:start", "commit:end", "audio"]);
    call.push(streamEnded(session.id));
    await running;
    expect(scripted.maxConcurrentCommits).toBe(1);
  });

  it("times out a silent commit and never overlaps it with teardown", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const scripted = makeScriptedCommitStt(session.id, async () => undefined);
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: scripted.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    call.push(streamEnded(session.id));
    const result = await running;
    expect(result.turnsHandled).toBe(0);
    expect(scripted.commitCalls).toBeLessThanOrEqual(1);
    expect(scripted.maxConcurrentCommits).toBe(1);
  });

  it("does not wait for the grace period when the provider has no commit primitive", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime({
      clock: {
        now: () => TS,
        monotonicMs: () => Date.now(),
      },
    });
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const scripted = makeScriptedCommitStt(session.id, async () => undefined, undefined, "none");
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: scripted.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    }).run();
    let settled = false;
    const completed = running.then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    call.push(streamEnded(session.id));

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    const result = await completed;
    expect(result.turnsHandled).toBe(0);
    expect(scripted.commitCalls).toBeLessThanOrEqual(1);
  });

  it("cancels a commit's stale endpoint timer without disabling the next utterance timer", async () => {
    vi.useFakeTimers();
    const runtime = createRuntime({
      clock: {
        now: () => TS,
        monotonicMs: () => Date.now(),
      },
    });
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const scripted = makeScriptedCommitStt(session.id, async (callNumber, events) => {
      if (callNumber === 1) events.push(finalTranscript(session.id, 1, "committed"));
    });
    const running = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: scripted.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      turnEndpointTimeoutMs: 80,
    }).run();
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(80);
    await vi.advanceTimersByTimeAsync(0);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(1);
    scripted.push(finalTranscript(session.id, 2, "fresh utterance"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(2);
    call.push(streamEnded(session.id));
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(0);
    await running;
    expect((await runtime.inspectSession(session.id)).turns[1]?.input.transcript).toBe(
      "fresh utterance",
    );
  });

  it("fails the call when STT ends cleanly mid-call (does not hang, not success)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm(() => []);
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.endStream();

    await expect(running).rejects.toMatchObject({ code: "stt.closed_unexpectedly" });
  });

  it("does not fail when STT ends after the caller hangs up (media ended first)", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeLlm(() => []);
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.turnsHandled).toBe(0);
  });

  it("fails the turn when the LLM stream stalls with no events", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm.provider,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      streamStallTimeoutMs: 40,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed on stall",
    );
    call.push(streamEnded(session.id));

    const result = await running;
    await runtime.endSession(session.id, { reason: "completed" });
    expect(result.turnsFailed).toBe(1);
    expect(result.firstTurnError?.code).toBe("llm.stalled");
    expect(llm.cancelled).toBe(true);
    expect(sessionEnds).toHaveLength(1);
    const llmUsage = sessionEnds[0]?.usage?.entries.find((entry) => entry.kind === "llm");
    expect(llmUsage?.metrics.requestCount).toMatchObject({ value: 1 });
    expect(llmUsage?.metrics.inputTokens).toMatchObject({
      status: "not_reported",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
    expect(llmUsage?.metrics.outputTokens).toMatchObject({
      status: "not_reported",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
    expect(llmUsage?.metrics.cachedTokens).toMatchObject({
      status: "not_reported",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
  });

  it("does not deliver or complete partial LLM output after a remote hangup", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ textDelivery: "delivered" });
    const stt = makeStt();
    const llmQueue = new AsyncQueue<LlmStreamEvent>();
    let llmStarted = false;
    const llm: LLMProvider = {
      name: "partial-then-hang-llm",
      kind: "llm",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async complete(request): Promise<LlmCompletion> {
        llmQueue.push(llmEvent(request, 1, { type: "llm.started", model: request.model }));
        llmQueue.push(llmEvent(request, 2, { type: "llm.token", text: "partial answer" }));
        llmStarted = true;
        return {
          events: llmQueue,
          async cancel() {
            llmQueue.close();
          },
        };
      },
    };
    const base = buildAgent();
    const { tts: _tts, ...providersWithoutTts } = base.providers;
    const noAudioAgent = defineAgent({
      ...agent,
      providers: { ...providersWithoutTts, stt: stt.provider, llm },
    });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: noAudioAgent,
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hang up now");
    await until(() => llmStarted, "partial LLM output");
    call.push(streamEnded(session.id, "remote_hangup"));

    await running;
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
    expect(snapshot.turns[0]?.output.delivery).toEqual({
      audio: "not_attempted",
      text: "not_attempted",
    });
    expect(call.deliveredTexts).toEqual([]);
  });

  it("does not complete a turn whose playout the caller never heard", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
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

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book it");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled (not heard)",
    );
    call.push(streamEnded(session.id));

    await running;
    const snapshot = await runtime.inspectSession(session.id);
    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("not_heard");
    expect(
      await memory.list(
        { scope: "session", sessionId: session.id },
        { prefix: `exchange:${session.id}:`, kind: "raw" },
      ),
    ).toHaveLength(0);
  });

  it("retries transient tool failures and persists the successful call", async () => {
    const runtime = createRuntime();
    await runtime.start();
    let attempts = 0;
    const flaky = defineTool({
      id: "tool_flaky",
      name: "check_availability",
      description: "fails once then succeeds",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoff: "fixed", jitter: false },
      async execute() {
        attempts += 1;
        if (attempts < 2) {
          throw toolError("tool.execution_failed", "transient", { retriable: true });
        }
        return { available: true };
      },
    });
    const agent = buildAgent({ tools: [flaky] });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const toolCall = { callRef: "c1", toolName: "check_availability" as never, input: {} };
    let llmCalls = 0;
    const llm = makeLlm((req) => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return [
          llmEvent(req, 1, { type: "llm.started", model: req.model }),
          llmEvent(req, 2, { type: "llm.tool_call", call: toolCall }),
          llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [toolCall] }),
        ];
      }
      return [
        llmEvent(req, 1, { type: "llm.started", model: req.model }),
        llmEvent(req, 2, { type: "llm.completed", text: "booked", toolCalls: [] }),
      ];
    });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "table for two");
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(streamEnded(session.id));

    await running;
    const snapshot = await runtime.inspectSession(session.id);
    expect(attempts).toBe(2);
    expect(snapshot.toolCalls).toHaveLength(1);
    expect(snapshot.toolCalls[0]).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("cancels the turn when the commit mark is dropped by the transport", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle({ dropCommit: true });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "all set", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1), committed(req)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book it");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled (commit dropped)",
    );
    call.push(streamEnded(session.id));

    await running;
    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("transport_lost");
  });

  it("executes tool calls delivered only on the llm.completed event", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    let executed = 0;
    const tool = defineTool({
      id: "tool_completed_only",
      name: "check_availability",
      description: "check",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        executed += 1;
        return { available: true };
      },
    });
    const agent = buildAgent({ tools: [tool] });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const toolCall = { callRef: "c1", toolName: "check_availability" as never, input: {} };
    let llmCalls = 0;
    const llm = makeLlm((req) => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return [
          llmEvent(req, 1, { type: "llm.started", model: req.model }),
          llmEvent(req, 2, {
            type: "llm.completed",
            text: "",
            toolCalls: [toolCall],
            providerModel: "gpt-effective",
            usage: { inputTokens: 11, outputTokens: 2, cachedTokens: 3 },
          }),
        ];
      }
      return [
        llmEvent(req, 1, { type: "llm.started", model: req.model }),
        llmEvent(req, 2, {
          type: "llm.completed",
          text: "booked",
          toolCalls: [],
          providerModel: "gpt-effective",
          usage: { inputTokens: 17, outputTokens: 4, cachedTokens: 5 },
        }),
      ];
    });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "table for two");
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(streamEnded(session.id));

    await running;
    expect(executed).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.toolCalls).toHaveLength(1);
    expect(snapshot.toolCalls[0]?.status).toBe("succeeded");
    await runtime.endSession(session.id, { reason: "completed" });
    expect(sessionEnds[0]?.usage?.entries).toContainEqual(
      expect.objectContaining({
        kind: "llm",
        provider: "fake-llm",
        model: "gpt-effective",
        modelSource: "provider_reported",
        metrics: {
          requestCount: { status: "measured", source: "runtime", unit: "requests", value: 2 },
          inputTokens: { status: "reported", source: "provider", unit: "tokens", value: 28 },
          outputTokens: { status: "reported", source: "provider", unit: "tokens", value: 6 },
          cachedTokens: { status: "reported", source: "provider", unit: "tokens", value: 8 },
        },
      }),
    );
  });

  it("treats llm.completed as terminal even when the provider leaves its iterator open", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let iteratorReturned = false;
    let cancelCalls = 0;
    const llm: LLMProvider = {
      name: "open-after-completed-llm",
      kind: "llm",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async complete(request): Promise<LlmCompletion> {
        const scripted = [
          llmEvent(request, 1, { type: "llm.started", model: request.model }),
          llmEvent(request, 2, { type: "llm.completed", text: "done", toolCalls: [] }),
        ];
        let index = 0;
        const iterator: AsyncIterator<LlmStreamEvent> = {
          next: async () => {
            const event = scripted[index++];
            if (event) return { done: false, value: event };
            return new Promise<IteratorResult<LlmStreamEvent>>(() => undefined);
          },
          return: async () => {
            iteratorReturned = true;
            return { done: true, value: undefined };
          },
        };
        return {
          events: { [Symbol.asyncIterator]: () => iterator },
          async cancel() {
            cancelCalls += 1;
          },
        };
      },
    };
    const tts = makeTts((request) => [audioChunk(request, 1)], { endStream: true });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "finish this");
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(streamEnded(session.id));

    await running;
    expect(iteratorReturned).toBe(true);
    expect(cancelCalls).toBe(0);
    await runtime.stop();
  });

  it("fails the turn when an LLM stream ends without a terminal event", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    let cancelCalls = 0;
    const llm: LLMProvider = {
      name: "early-eof-llm",
      kind: "llm",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async complete(request): Promise<LlmCompletion> {
        return {
          events: (async function* (): AsyncIterable<LlmStreamEvent> {
            yield llmEvent(request, 1, { type: "llm.started", model: request.model });
            yield llmEvent(request, 2, { type: "llm.token", text: "partial" });
          })(),
          async cancel() {
            cancelCalls += 1;
          },
        };
      },
    };
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "finish this");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "failed",
      "turn failed on early LLM EOF",
    );
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.turnsFailed).toBe(1);
    expect(result.firstTurnError?.code).toBe("llm.stream_ended");
    expect(cancelCalls).toBe(1);
    await runtime.stop();
  });

  it("surfaces a hallucinated (unknown) tool call instead of dropping it", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const bogus = { callRef: "c1", toolName: "make_reservation" as never, input: {} };
    let llmCalls = 0;
    const llm = makeLlm((req) => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return [
          llmEvent(req, 1, { type: "llm.started", model: req.model }),
          llmEvent(req, 2, { type: "llm.tool_call", call: bogus }),
          llmEvent(req, 3, { type: "llm.completed", text: "", toolCalls: [bogus] }),
        ];
      }
      return [
        llmEvent(req, 1, { type: "llm.started", model: req.model }),
        llmEvent(req, 2, { type: "llm.completed", text: "sorry", toolCalls: [] }),
      ];
    });
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "make me a reservation");
    await until(() => call.sent.length >= 1, "agent speaking");
    call.push(streamEnded(session.id));

    await running;
    const snapshot = await runtime.inspectSession(session.id);
    expect(llmCalls).toBe(2);
    expect(snapshot.toolCalls).toHaveLength(1);
    expect(snapshot.toolCalls[0]).toMatchObject({
      status: "failed",
      toolName: "make_reservation",
      error: { code: "tool.not_found" },
      metadata: { unknownTool: true },
    });
    expect(snapshot.turns[0]).toMatchObject({ status: "completed", output: { text: "sorry" } });
  });

  it("cancels (not fails) a stalled turn when onTimeout is 'interrupt'", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({ timeoutPolicy: { timeoutMs: 30, onTimeout: "interrupt" } });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm();
    const tts = makeTts(() => [], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm.provider,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled on interrupt-timeout",
    );
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.turnsFailed).toBe(0);
    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("timeout");
  });

  it("marks a confirming transport unheard when TTS emits no commit mark", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle({ playout: "heard" });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "all set", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, {
        stt: stt.provider,
        llm: llm,
        tts: tts,
      }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "book it");
    await until(
      async () => (await runtime.inspectSession(session.id)).turns[0]?.status === "cancelled",
      "turn cancelled (no commit mark)",
    );
    call.push(streamEnded(session.id));

    await running;
    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("not_heard");
  });

  it("rescues a TTS failure through default text delivery and reports the audio error", async () => {
    const sessionEnds: SessionEndEvent[] = [];
    const runtime = createRuntime({
      onSessionEnd: (event) => {
        sessionEnds.push(event);
      },
    });
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ textDelivery: "delivered" });
    const stt = makeStt();
    const records: AssistantTextRecord[] = [];
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.completed", text: "Text survives.", toolCalls: [] }),
    ]);
    const baseTts = agent.providers.tts;
    if (!baseTts) throw new Error("test requires TTS");
    const failingTts = {
      ...baseTts,
      async synthesize(): Promise<never> {
        throw new Error("speaker unavailable");
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(agent, { stt: stt.provider, llm, tts: failingTts }),
      callHandle: call.handle,
      llmModel: "gpt-test",
      onAssistantText: (record) => records.push(record),
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "answer in text");
    await until(() => call.deliveredTexts.length === 1, "fallback text delivered");
    call.push(streamEnded(session.id));
    await running;
    await runtime.endSession(session.id, { reason: "completed" });

    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("completed");
    expect(records[0]).toEqual(expect.objectContaining({ delivered: true, status: "completed" }));
    expect(records[0]?.audioError?.code).toBe("tts.delivery_failed");
    expect(sessionEnds[0]?.usage?.entries).toContainEqual(
      expect.objectContaining({
        kind: "tts",
        metrics: expect.objectContaining({
          audioMsReceived: {
            status: "not_reported",
            source: "runtime",
            unit: "milliseconds",
            notReported: [{ reason: "absent", operations: 1 }],
          },
        }),
      }),
    );
  });

  it("runs without TTS, forwards the safety identifier, and writes user memory", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
    await runtime.start();
    const base = buildAgent({ memoryScopes: ["session", "user"] });
    const { tts: _tts, ...providersWithoutTts } = base.providers;
    let safetyIdentifier: string | undefined;
    const llm = makeLlm((req) => {
      safetyIdentifier = req.safetyIdentifier;
      return [llmEvent(req, 1, { type: "llm.completed", text: "Text only.", toolCalls: [] })];
    });
    const stt = makeStt();
    const agent = defineAgent({
      ...base,
      providers: { ...providersWithoutTts, stt: stt.provider, llm },
    });
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const call = makeCallHandle({ textDelivery: "delivered" });
    const userId = "user_voice" as UserId;
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
      memoryUserId: userId,
      safetyIdentifier: "safe_hash",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "remember this");
    await until(() => call.deliveredTexts.length === 1, "text-only turn delivered");
    call.push(streamEnded(session.id));
    await running;

    expect(safetyIdentifier).toBe("safe_hash");
    expect(
      await memory.list(
        { scope: "session", sessionId: session.id },
        { prefix: `exchange:${session.id}:`, kind: "raw" },
      ),
    ).toHaveLength(1);
    expect(
      await memory.list(
        { scope: "user", userId },
        { prefix: `exchange:${session.id}:`, kind: "raw" },
      ),
    ).toHaveLength(1);
  });

  it("derives persisted memory identity from an attached session", async () => {
    const memory = createInMemoryMemory();
    const runtime = createRuntime({ memory });
    await runtime.start();
    const base = buildAgent({ memoryScopes: ["session", "user"] });
    const { tts: _tts, ...providersWithoutTts } = base.providers;
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.completed", text: "Identity carried forward.", toolCalls: [] }),
    ]);
    const stt = makeStt();
    const agent = defineAgent({
      ...base,
      providers: { ...providersWithoutTts, stt: stt.provider, llm },
    });
    const userId = "user_attached" as UserId;
    const attachment = await runtime.startAttachedSession(agent, {
      channel: "simulated",
      memoryUserId: userId,
    });
    const call = makeCallHandle({ textDelivery: "delivered" });
    const loop = new PipelineVoiceLoop({
      runtime,
      session: attachment.session,
      attachment,
      agent,
      callHandle: call.handle,
      llmModel: "gpt-test",
      memory,
    });

    const running = loop.run();
    call.push(streamStarted(attachment.session.id));
    stt.pushFinal(attachment.session.id, "use attached identity");
    await until(() => call.deliveredTexts.length === 1, "attached identity turn delivered");
    call.push(streamEnded(attachment.session.id));
    await running;
    await attachment.detach();

    expect(
      await memory.list(
        { scope: "user", userId },
        { prefix: `exchange:${attachment.session.id}:`, kind: "raw" },
      ),
    ).toHaveLength(1);
  });

  it("drains delayed trailing speech at a normal media end", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const transcripts = pushable<TranscriptEvent>();
    let closed = false;
    let commitStarted = false;
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const stt: SpeechToTextProvider = {
      name: "delayed-final-stt",
      kind: "stt",
      version: "0.1.0",
      capabilities: TEST_PROVIDER_CAPABILITIES,
      async open() {
        return {
          events: transcripts.iterable,
          async sendAudio() {},
          async commit() {
            commitStarted = true;
            await commitReleased;
            transcripts.push({
              id: "stt_delayed" as never,
              type: "stt.final",
              direction: "input",
              sessionId: session.id,
              sequence: 1,
              provider: "delayed-final-stt",
              text: "late words",
              startTimestamp: TS,
              endTimestamp: TS,
            });
            transcripts.push({
              id: "stt_delayed_endpoint" as never,
              type: "stt.endpoint",
              direction: "input",
              sessionId: session.id,
              sequence: 2,
              provider: "delayed-final-stt",
              reason: "manual",
              timestamp: TS,
            });
          },
          async close() {
            closed = true;
            transcripts.end();
          },
        };
      },
    };
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(streamEnded(session.id, "completed"));
    await until(() => commitStarted, "terminal STT commit started");
    releaseCommit();
    const result = await running;
    expect(result.turnsHandled).toBe(1);
    expect(closed).toBe(true);
  });

  it("honors explicit interruption under ignore mode", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent({ interruptionPolicy: ignoreInterruptionPolicy() });
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const stt = makeStt();
    const tts = makeControlledTts();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.completed", text: "Speaking now.", toolCalls: [] }),
    ]);
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: stt.provider, llm, tts: tts.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "start");
    await until(() => tts.ready, "tts ready");
    tts.pushChunk(1);
    await until(() => call.sent.length === 1, "agent speaking");
    call.push(
      createMediaEvent({
        id: "explicit_interrupt" as never,
        type: "media.interrupt.requested",
        sessionId: session.id,
        callId: call.handle.callId,
        sequence: 2,
        direction: "input",
        timestamp: TS,
        monotonicOffsetMs: 0,
      }),
    );
    await until(() => call.clearCalls === 1, "explicit interrupt cleared output");
    call.push(streamEnded(session.id));
    const result = await running;
    expect(result.interruptions).toBe(1);
  });
});

interface ReconnectablePipelineGeneration {
  readonly events: AsyncQueue<TranscriptEvent>;
  readonly order: string[];
  stream: SttStream;
  failNextAudio: boolean;
  closed: boolean;
}

function makeReconnectablePipelineStt(onOpen?: (openCalls: number) => void) {
  const generations: ReconnectablePipelineGeneration[] = [];
  let openCalls = 0;
  let sessionId: Parameters<typeof streamStarted>[0] | undefined;
  const provider: SpeechToTextProvider = {
    name: "reconnectable-pipeline-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async open(request): Promise<SttStream> {
      openCalls += 1;
      onOpen?.(openCalls);
      sessionId = request.sessionId;
      const events = new AsyncQueue<TranscriptEvent>();
      const order: string[] = [];
      const generation: ReconnectablePipelineGeneration = {
        events,
        order,
        failNextAudio: generations.length === 0,
        closed: false,
        stream: undefined as never,
      };
      generation.stream = {
        events,
        commitMode: "provider",
        timestampOrigin: "generation",
        async sendAudio() {
          if (generation.failNextAudio) {
            generation.failNextAudio = false;
            throw providerError(STT_ERROR_CODES.transportWriteFailed, "fake STT write failed", {
              provider: "reconnectable-pipeline-stt",
              retriable: true,
            });
          }
          generation.order.push("audio");
        },
        async commit() {
          return;
        },
        async close() {
          if (generation.closed) {
            return;
          }
          generation.closed = true;
          generation.events.close();
        },
      };
      generations.push(generation);
      return generation.stream;
    },
  };
  return {
    provider,
    generations,
    get openCalls() {
      return openCalls;
    },
    pushFinal(text: string): void {
      const generation = generations[1];
      if (!generation || !sessionId) {
        throw new Error("recovered STT generation is not open");
      }
      generation.events.push({
        id: "recovered_final" as never,
        type: "stt.final",
        direction: "input",
        sessionId,
        sequence: 1,
        provider: "reconnectable-pipeline-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
      });
    },
    pushEndpoint(): void {
      const generation = generations[1];
      if (!generation || !sessionId) {
        throw new Error("recovered STT generation is not open");
      }
      generation.events.push({
        id: "recovered_endpoint" as never,
        type: "stt.endpoint",
        direction: "input",
        sessionId,
        sequence: 2,
        provider: "reconnectable-pipeline-stt",
        reason: "provider",
        timestamp: TS,
      });
    },
  };
}

function commitRequested(sessionId: Parameters<typeof streamStarted>[0], sequence: number) {
  return createMediaEvent({
    id: `commit_${sequence}` as never,
    type: "media.turn.commit_requested",
    sessionId,
    callId: "call_loop" as never,
    sequence,
    direction: "input" as const,
    timestamp: TS,
    monotonicOffsetMs: 0,
  });
}

function makeScriptedCommitStt(
  sessionId: Parameters<typeof streamStarted>[0],
  script: (call: number, events: ReturnType<typeof pushable<TranscriptEvent>>) => Promise<void>,
  onAudio: () => void = () => undefined,
  commitMode: "provider" | "none" = "provider",
) {
  const events = pushable<TranscriptEvent>();
  let commitCalls = 0;
  let concurrentCommits = 0;
  let maxConcurrentCommits = 0;
  const provider: SpeechToTextProvider = {
    name: "scripted-commit-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: TEST_PROVIDER_CAPABILITIES,
    async open(): Promise<SttStream> {
      return {
        events: events.iterable,
        commitMode,
        async sendAudio() {
          onAudio();
        },
        async commit() {
          commitCalls += 1;
          concurrentCommits += 1;
          maxConcurrentCommits = Math.max(maxConcurrentCommits, concurrentCommits);
          try {
            await script(commitCalls, events);
          } finally {
            concurrentCommits -= 1;
          }
        },
        async close() {
          events.end();
        },
      };
    },
  };
  return {
    provider,
    sessionId,
    push(event: TranscriptEvent) {
      events.push(event);
    },
    get commitCalls() {
      return commitCalls;
    },
    get maxConcurrentCommits() {
      return maxConcurrentCommits;
    },
  };
}

function finalTranscript(
  sessionId: Parameters<typeof streamStarted>[0],
  sequence: number,
  text: string,
): TranscriptEvent {
  return {
    id: `scripted_final_${sequence}` as never,
    type: "stt.final",
    direction: "input",
    sessionId,
    sequence,
    provider: "scripted-commit-stt",
    text,
    startTimestamp: TS,
    endTimestamp: TS,
  };
}

function endpointTranscript(
  sessionId: Parameters<typeof streamStarted>[0],
  sequence: number,
): TranscriptEvent {
  return {
    id: `scripted_endpoint_${sequence}` as never,
    type: "stt.endpoint",
    direction: "input",
    sessionId,
    sequence,
    provider: "scripted-commit-stt",
    reason: "manual",
    timestamp: TS,
  };
}
