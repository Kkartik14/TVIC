import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import { AsyncQueue } from "@tvic/media";
import {
  internalError,
  providerError,
  STT_STREAM_ENDED_REASON,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type SpeechToTextProvider,
  type SttStream,
  type TranscriptEvent,
  type UserId,
} from "@tvic/core";

import {
  ConversationPolicy,
  createRuntime,
  defineAgent,
  defineTool,
  PipelineVoiceLoop,
} from "../src/index.js";
import type { AssistantTextRecord } from "../src/index.js";
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

  it("runs a full turn: STT -> LLM -> TTS -> audio out, with latency and memory", async () => {
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
    call.push(audioChunkIn(session.id));
    stt.pushFinal(session.id, "book a table for two");

    await until(() => call.sent.length >= 2, "agent audio sent");
    call.push(streamEnded(session.id));

    const result = await running;

    expect(result.turnsHandled).toBe(1);
    expect(result.interruptions).toBe(0);
    expect(call.sent.filter((event) => event.type === "media.audio.chunk")).toHaveLength(2);

    const snapshot = await runtime.inspectSession(session.id);
    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("completed");
    expect(typeof turn?.latency.firstTokenMs).toBe("number");
    expect(typeof turn?.latency.firstAudioMs).toBe("number");
    expect(typeof turn?.latency.totalMs).toBe("number");

    const stored = await memory.get({ scope: "session", sessionId: session.id }, "exchanges");
    expect(stored?.value).toEqual([{ user: "book a table for two", assistant: "Sure, booked." }]);
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
    // Emit one chunk then leave the TTS stream open so playout is in-flight.
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

  it("reconstructs character alignment without spaces or repeated-letter loss", async () => {
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
      llmEvent(req, 2, { type: "llm.token", text: "letter before the long answer" }),
      llmEvent(req, 3, {
        type: "llm.completed",
        text: "letter before the long answer",
        toolCalls: [],
      }),
    ]);
    const tts = makeIncrementalTts({ autoFinish: false });
    const memory = createInMemoryMemory();
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
    expect(
      (await memory.get({ scope: "session", sessionId: session.id }, "exchanges"))?.value,
    ).toEqual([{ user: "spell it", assistant: "letter", interrupted: true }]);
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
    // Caller hangs up while the LLM is blocked. Generation must be aborted promptly.
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
        // Ignores ctx.signal on purpose: proves the executor's abort race works.
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
    // Caller hangs up while the tool is blocked. The executor's abort race must fire.
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("does not write session memory when the policy excludes the session scope", async () => {
    const runtime = createRuntime();
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
    const memory = createInMemoryMemory();

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

    expect(await memory.get({ scope: "session", sessionId: session.id }, "exchanges")).toBeNull();
  });

  it("aborts during TTS connection setup when the caller hangs up (before the stream exists)", async () => {
    const runtime = createRuntime();
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
    // Caller hangs up while TTS is still connecting. The startup race must abort it.
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
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

    // Deepgram's VAD signal starts the candidate immediately, but minSpeechMs
    // prevents a click or echo blip from cancelling the response.
    stt.pushSpeechStarted(session.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(call.clearCalls).toBe(0);
    await until(() => call.clearCalls >= 1, "barge-in handled");
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

    // TTS is connected but no audio chunk has been sent yet → agent not speaking.
    stt.pushPartial(session.id, "are you there");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(call.clearCalls).toBe(0);

    // Now the agent actually speaks and finishes uninterrupted.
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

    stt.pushSpeechStarted(session.id, 1_000);
    stt.pushEndpoint(session.id, 1_010);
    await new Promise((resolve) => setTimeout(resolve, 40));
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
    // Leave the TTS stream open so the agent is still speaking when the call drops.
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

    // Caller hangs up before the reply finishes. Generation must not outlive the call.
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("cancelled");
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("remote_hangup");
  });

  it("keeps a turn completed when the caller hangs up after the reply is delivered", async () => {
    const runtime = createRuntime();
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
    const memory = createInMemoryMemory();

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

    // Agent finishes delivering the reply, THEN the caller hangs up.
    tts.end();
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("completed");
    // A fully delivered turn is still recorded to conversation memory.
    const stored = await memory.get({ scope: "session", sessionId: session.id }, "exchanges");
    expect(stored?.value).toEqual([{ user: "book it", assistant: "all set" }]);
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
    // The caller never hangs up; the loop must still reject because STT failed.
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

    await expect(running).rejects.toBe(sttFailure);
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

    // No audio sent yet → the agent is not speaking, so even an STT speech signal
    // must not cancel: there is nothing audible to barge into.
    stt.pushSpeechStarted(session.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(call.clearCalls).toBe(0);

    // The agent then speaks and finishes uninterrupted.
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
    // The socket is dropping audio: the first chunk send returns false.
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
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("transport_closed");
    // Nothing must be recorded to memory for a reply the caller never heard.
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
    stt.pushFinalSegment(session.id, "a table for four");
    await new Promise((resolve) => setTimeout(resolve, 50));
    stt.pushFinalSegment(session.id, "at eight tomorrow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(call.sent).toHaveLength(0);
    await until(() => call.sent.length >= 1, "debounced fallback turn audio");
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
    stt.pushFinalSegment(session.id, "continuous");
    await new Promise((resolve) => setTimeout(resolve, 45));
    stt.pushFinalSegment(session.id, "speech");
    await until(() => call.sent.length >= 1, "maximum-duration turn audio");
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
    stt.pushFinalSegment(session.id, "must not become a turn");
    stt.failStream(failure);

    await expect(running).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 40));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const scripted = makeScriptedCommitStt(session.id, async (_call, events) => {
      await delay(5);
      events.push(finalTranscript(session.id, 1, "one"));
      await delay(15);
      events.push(finalTranscript(session.id, 2, "two"));
    });
    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent: withPipelineProviders(base, { stt: scripted.provider }),
      callHandle: call.handle,
      llmModel: "gpt-test",
    });
    const startedAt = Date.now();
    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 1,
      "multi-final committed turn",
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
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
        await delay(5);
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
    const startedAt = Date.now();
    const running = loop.run();
    call.push(streamStarted(session.id));
    call.push(commitRequested(session.id, 1));
    call.push(audioChunkIn(session.id));
    await until(() => order.includes("audio"), "post-commit audio accepted");
    expect(order).toEqual(["commit:start", "commit:end", "audio"]);
    expect(Date.now() - startedAt).toBeLessThan(200);
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
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const scripted = makeScriptedCommitStt(session.id, async () => undefined, undefined, "none");
    const startedAt = Date.now();
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
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it("cancels a commit's stale endpoint timer without disabling the next utterance timer", async () => {
    const runtime = createRuntime();
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
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 1,
      "manual commit turn",
    );
    scripted.push(finalTranscript(session.id, 2, "fresh utterance"));
    await delay(50);
    expect((await runtime.inspectSession(session.id)).turns).toHaveLength(1);
    await until(
      async () => (await runtime.inspectSession(session.id)).turns.length === 2,
      "fresh endpoint timer turn",
    );
    call.push(streamEnded(session.id));
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
    // STT closes while the caller is still connected. The loop must stop (not hang)
    // AND fail: a provider disappearing mid-call is not a successful call.
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
    call.push(streamEnded(session.id)); // caller hangs up first → clean completion

    const result = await running;
    expect(result.turnsHandled).toBe(0);
  });

  it("fails the turn when the LLM stream stalls with no events", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm(); // emits llm.started then never streams again
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
    expect(result.turnsFailed).toBe(1);
    expect(result.firstTurnError?.code).toBe("llm.stalled");
    expect(llm.cancelled).toBe(true);
  });

  it("does not complete a turn whose playout the caller never heard", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    // Frames reach the transport, but playout is never confirmed (caller dropped).
    const call = makeCallHandle({ playout: "dropped" });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "your table is booked", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1), committed(req)], { endStream: true });
    const memory = createInMemoryMemory();

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
    // An answer the caller never heard must not be remembered.
    const stored = await memory.get({ scope: "session", sessionId: session.id }, "exchanges");
    expect(stored?.value ?? []).toEqual([]);
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
          throw new Error("transient");
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
    // Audio chunks deliver, but the commit mark send is dropped.
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
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("transport_closed");
  });

  it("executes tool calls delivered only on the llm.completed event", async () => {
    const runtime = createRuntime();
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
        // Tool call carried ONLY on completed, with no separate llm.tool_call event.
        return [
          llmEvent(req, 1, { type: "llm.started", model: req.model }),
          llmEvent(req, 2, { type: "llm.completed", text: "", toolCalls: [toolCall] }),
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
    expect(executed).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.toolCalls).toHaveLength(1);
    expect(snapshot.toolCalls[0]?.status).toBe("succeeded");
  });

  it("surfaces a hallucinated (unknown) tool call instead of dropping it", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent(); // only check_availability registered
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
    expect(snapshot.toolCalls).toHaveLength(0);
    expect(snapshot.turns[0]).toMatchObject({ status: "completed", output: { text: "sorry" } });
  });

  it("cancels (not fails) a stalled turn when onTimeout is 'interrupt'", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent({ timeoutPolicy: { timeoutMs: 30, onTimeout: "interrupt" } });
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle();
    const stt = makeStt();
    const llm = makeBlockingLlm(); // started then never streams → stalls
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
    // interrupt mode: the turn is cancelled, NOT failed, and the call survives.
    expect(result.turnsFailed).toBe(0);
    const turn = (await runtime.inspectSession(session.id)).turns[0];
    expect(turn?.status === "cancelled" ? turn.reason : null).toBe("timeout");
  });

  it("marks a confirming transport unheard when TTS emits no commit mark", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    // Confirming transport, but the TTS never emits media.audio.committed → nothing to
    // confirm playout against → not_heard.
    const call = makeCallHandle({ playout: "heard" });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "all set", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: true }); // no committed

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
    const runtime = createRuntime();
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

    expect((await runtime.inspectSession(session.id)).turns[0]?.status).toBe("completed");
    expect(records[0]).toEqual(expect.objectContaining({ delivered: true, status: "completed" }));
    expect(records[0]?.audioError?.code).toBe("tts.delivery_failed");
  });

  it("runs without TTS, forwards the safety identifier, and writes user memory", async () => {
    const runtime = createRuntime();
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
    const memory = createInMemoryMemory();
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
      await memory.get({ scope: "session", sessionId: session.id }, "exchanges"),
    ).not.toBeNull();
    expect(await memory.get({ scope: "user", userId }, "exchanges")).not.toBeNull();
  });

  it("drains delayed trailing speech at a normal media end", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const base = buildAgent();
    const session = await runtime.startSession(base, { channel: "simulated" });
    const call = makeCallHandle();
    const transcripts = pushable<TranscriptEvent>();
    let closed = false;
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
            setTimeout(() => {
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
            }, 5);
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
    call.push({
      id: "explicit_interrupt" as never,
      type: "media.interrupt.requested",
      sessionId: session.id,
      callId: call.handle.callId,
      sequence: 2,
      direction: "input",
      timestamp: TS,
      monotonicOffsetMs: 0,
    });
    await until(() => call.clearCalls === 1, "explicit interrupt cleared output");
    call.push(streamEnded(session.id));
    const result = await running;
    expect(result.interruptions).toBe(1);
  });
});

function commitRequested(sessionId: Parameters<typeof streamStarted>[0], sequence: number) {
  return {
    id: `commit_${sequence}` as never,
    type: "media.turn.commit_requested" as const,
    sessionId,
    callId: "call_loop" as never,
    sequence,
    direction: "input" as const,
    timestamp: TS,
    monotonicOffsetMs: 0,
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
