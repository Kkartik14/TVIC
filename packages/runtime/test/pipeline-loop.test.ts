import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import {
  PCM16_16K_MONO,
  type AgentAudioPolicy,
  type CallHandle,
  type InboundMediaEvent,
  type InterruptionPolicy,
  type LLMProvider,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmStreamEvent,
  type MediaEventId,
  type MemoryScope,
  type OutputMediaEvent,
  type ProviderEventId,
  type SessionId,
  type SpeechToTextProvider,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type Timestamp,
  type ToolDefinition,
  type TranscriptEvent,
  type TtsStream,
  type TtsSynthesisRequest,
  type TraceEventType,
} from "@tvic/core";

import { createRuntime, defineAgent, defineTool, PipelineVoiceLoop } from "../src/index.js";

const TS = "2026-05-20T00:00:00.000Z" as Timestamp;

describe("PipelineVoiceLoop", () => {
  it("runs a full turn: STT -> LLM -> TTS -> audio out, with latency + memory + spans", async () => {
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
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
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
    const types = new Set(snapshot.traceEvents.map((event) => event.type));
    for (const expected of [
      "stt.final",
      "llm.started",
      "llm.token",
      "llm.completed",
      "tts.started",
      "tts.chunk",
      "tts.completed",
      "audio.output.started",
      "audio.output.ended",
      "memory.write",
    ] satisfies TraceEventType[]) {
      expect(types.has(expected)).toBe(true);
    }

    const turn = snapshot.turns[0];
    expect(turn?.status).toBe("completed");
    expect(typeof turn?.latency.firstTokenMs).toBe("number");
    expect(typeof turn?.latency.firstAudioMs).toBe("number");
    expect(typeof turn?.latency.totalMs).toBe("number");

    const stored = await memory.get({ scope: "session", sessionId: session.id }, "exchanges");
    expect(stored?.value).toEqual([{ user: "book a table for two", assistant: "Sure, booked." }]);
  });

  it("handles barge-in mid-playout: cancels output and ends the turn cancelled", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
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

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
    });

    const running = loop.run();

    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "tell me everything");

    await until(() => call.sent.length >= 1, "first agent audio chunk");
    call.push(bargeIn(session.id));
    await until(() => call.cancelOutputCalls >= 1, "output cancelled");
    call.push(streamEnded(session.id));

    const result = await running;

    expect(result.interruptions).toBe(1);
    expect(call.cancelOutputCalls).toBe(1);

    const snapshot = await runtime.inspectSession(session.id);
    const types = new Set(snapshot.traceEvents.map((event) => event.type));
    expect(types.has("interrupt.detected")).toBe(true);
    expect(types.has("output.cancelled")).toBe(true);
    expect(types.has("interrupt.handled")).toBe(true);

    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("cancels a blocked LLM stream on barge-in without hanging", async () => {
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
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm: llm.provider,
      tts,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => llm.completeCalled, "llm invoked");
    call.push(bargeIn(session.id));
    await until(() => llm.cancelled, "llm cancelled");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(1);
    expect(llm.cancelled).toBe(true);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("cancels a blocked tool on barge-in", async () => {
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
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "do it");
    await until(() => toolStarted, "tool started");
    call.push(bargeIn(session.id));
    await until(() => call.cancelOutputCalls >= 1, "interrupt handled");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    expect(new Set(snapshot.traceEvents.map((event) => event.type)).has("tool.cancelled")).toBe(
      true,
    );
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
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
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
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.traceEvents.some((event) => event.type === "memory.write")).toBe(false);
  });

  it("aborts during TTS connection setup (barge-in before the stream exists)", async () => {
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
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts: tts.provider,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => tts.synthesizeCalled, "tts setup started");
    call.push(bargeIn(session.id));
    await until(() => call.cancelOutputCalls >= 1, "interrupt handled");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.traceEvents.some((event) => event.type === "output.cancelled")).toBe(true);
    expect(snapshot.turns[0]?.status).toBe("cancelled");
  });

  it("bounds a slow telephony clear and traces the timeout", async () => {
    const runtime = createRuntime();
    await runtime.start();
    const agent = buildAgent();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    const call = makeCallHandle({ hangCancelOutput: true });
    const stt = makeStt();
    const llm = makeLlm((req) => [
      llmEvent(req, 1, { type: "llm.started", model: req.model }),
      llmEvent(req, 2, { type: "llm.completed", text: "hi", toolCalls: [] }),
    ]);
    const tts = makeTts((req) => [audioChunk(req, 1)], { endStream: false });

    const loop = new PipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => call.sent.length >= 1, "first agent chunk");
    call.push(bargeIn(session.id));
    await until(
      async () =>
        (await runtime.inspectSession(session.id)).traceEvents.some(
          (event) => event.type === "runtime.timeout",
        ),
      "clear timeout traced",
    );
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(1);
    const snapshot = await runtime.inspectSession(session.id);
    const timeout = snapshot.traceEvents.find((event) => event.type === "runtime.timeout");
    expect(timeout).toBeDefined();
    expect(snapshot.turns[0]?.status).toBe("cancelled");
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
      agent,
      callHandle: call.handle,
      stt: stt.provider,
      llm,
      tts: tts.provider,
      llmModel: "gpt-test",
    });

    const running = loop.run();
    call.push(streamStarted(session.id));
    stt.pushFinal(session.id, "hello");
    await until(() => tts.ready, "tts opened");
    tts.pushChunk(1);
    await until(() => call.sent.length >= 1, "first chunk played");
    call.push(bargeIn(session.id));
    tts.pushChunk(2);
    tts.end();
    await until(() => call.sent.length >= 2, "playout finished");
    call.push(streamEnded(session.id));

    const result = await running;
    expect(result.interruptions).toBe(0);
    const snapshot = await runtime.inspectSession(session.id);
    expect(snapshot.traceEvents.some((event) => event.type === "barge_in.rejected")).toBe(true);
    expect(snapshot.turns[0]?.status).toBe("completed");
  });
});

// ----- harness -----

function buildAgent(
  overrides: {
    readonly tools?: readonly ToolDefinition[];
    readonly memoryScopes?: readonly MemoryScope[];
    readonly interruptionPolicy?: InterruptionPolicy;
  } = {},
) {
  const audioPolicy: AgentAudioPolicy = {
    input: PCM16_16K_MONO,
    output: PCM16_16K_MONO,
    resampleAtEdge: true,
  };
  return defineAgent({
    id: "agent_loop",
    name: "Loop Agent",
    instructions: "Book tables.",
    tools: overrides.tools ?? [
      defineTool({
        id: "tool_loop",
        name: "check_availability",
        description: "Check availability.",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        async execute() {
          return { available: true };
        },
      }),
    ],
    audioPolicy,
    memoryPolicy: { enabled: true, scopes: overrides.memoryScopes ?? ["session"] },
    ...(overrides.interruptionPolicy ? { interruptionPolicy: overrides.interruptionPolicy } : {}),
    providers: {
      mode: "pipeline",
      telephony: stubTelephony,
      stt: stubStt,
      llm: stubLlm,
      tts: stubTts,
    },
  });
}

function ignoreInterruptionPolicy(): InterruptionPolicy {
  return {
    mode: "ignore",
    minSpeechMs: 200,
    cancelOutputOnInterrupt: true,
    trimOutputOnInterrupt: true,
    resumePartialOnEnd: false,
  };
}

function makeBlockingTts() {
  let synthesizeCalled = false;
  const provider: TextToSpeechProvider = {
    name: "blocking-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async synthesize(): Promise<TtsStream> {
      synthesizeCalled = true;
      // Never resolves: simulates a TTS connection that stalls during setup.
      return new Promise<TtsStream>(() => {});
    },
  };
  return {
    provider,
    get synthesizeCalled() {
      return synthesizeCalled;
    },
  };
}

function makeControlledTts() {
  let queue: ReturnType<typeof pushable<OutputMediaEvent>> | null = null;
  let request: TtsSynthesisRequest | null = null;
  const provider: TextToSpeechProvider = {
    name: "controlled-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async synthesize(req): Promise<TtsStream> {
      request = req;
      queue = pushable<OutputMediaEvent>();
      return {
        events: queue.iterable as TtsStream["events"],
        async cancel() {
          queue?.end();
        },
      };
    },
  };
  return {
    provider,
    get ready() {
      return queue !== null;
    },
    pushChunk(sequence: number) {
      queue?.push(audioChunk(request as TtsSynthesisRequest, sequence) as never);
    },
    end() {
      queue?.end();
    },
  };
}

function makeBlockingLlm() {
  let completeCalled = false;
  let cancelled = false;
  const provider: LLMProvider = {
    name: "blocking-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async complete(request): Promise<LlmCompletion> {
      completeCalled = true;
      const queue = pushable<LlmStreamEvent>();
      queue.push(llmEvent(request, 1, { type: "llm.started", model: request.model }));
      // Intentionally never end the stream: simulates an LLM blocked on output.
      return {
        events: queue.iterable,
        async cancel() {
          cancelled = true;
          queue.end();
        },
      };
    },
  };
  return {
    provider,
    get completeCalled() {
      return completeCalled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function pushable<T>() {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;
  return {
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        values.push(value);
      }
    },
    end(): void {
      ended = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined as never });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value !== undefined) {
              return Promise.resolve({ done: false, value });
            }
            if (ended) {
              return Promise.resolve({ done: true, value: undefined as never });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

function makeCallHandle(options: { readonly hangCancelOutput?: boolean } = {}) {
  const inbound = pushable<InboundMediaEvent>();
  const sent: OutputMediaEvent[] = [];
  let cancelOutputCalls = 0;
  const handle: CallHandle = {
    callId: "call_loop" as never,
    events: inbound.iterable,
    async send(event) {
      sent.push(event);
    },
    async clear() {
      cancelOutputCalls += 1;
      if (options.hangCancelOutput) {
        await new Promise<never>(() => {});
      }
    },
    async cancelOutput() {
      cancelOutputCalls += 1;
      if (options.hangCancelOutput) {
        await new Promise<never>(() => {});
      }
    },
    async close() {
      inbound.end();
    },
  } as CallHandle;
  return {
    handle,
    push: (event: InboundMediaEvent) => inbound.push(event),
    get sent() {
      return sent;
    },
    get cancelOutputCalls() {
      return cancelOutputCalls;
    },
  };
}

function makeStt() {
  const transcripts = pushable<TranscriptEvent>();
  const provider: SpeechToTextProvider = {
    name: "fake-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: false },
    async open(): Promise<SttStream> {
      return {
        events: transcripts.iterable,
        async sendAudio() {
          return;
        },
        async commit() {
          return;
        },
        async close() {
          transcripts.end();
        },
      };
    },
  };
  return {
    provider,
    pushFinal(sessionId: SessionId, text: string) {
      transcripts.push({
        id: "stt_event" as ProviderEventId,
        type: "stt.final",
        direction: "input",
        sessionId,
        sequence: 1,
        provider: "fake-stt",
        text,
        startTimestamp: TS,
        endTimestamp: TS,
        metadata: { speechFinal: true },
      });
    },
  };
}

function makeLlm(
  script: (request: LlmCompletionRequest) => readonly LlmStreamEvent[],
): LLMProvider {
  return {
    name: "fake-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async complete(request): Promise<LlmCompletion> {
      const queue = pushable<LlmStreamEvent>();
      for (const event of script(request)) {
        queue.push(event);
      }
      queue.end();
      return {
        events: queue.iterable,
        async cancel() {
          queue.end();
        },
      };
    },
  };
}

function makeTts(
  script: (request: TtsSynthesisRequest) => readonly OutputMediaEvent[],
  options: { readonly endStream: boolean },
): TextToSpeechProvider {
  return {
    name: "fake-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async synthesize(request): Promise<TtsStream> {
      const queue = pushable<OutputMediaEvent>();
      for (const event of script(request)) {
        queue.push(event as never);
      }
      if (options.endStream) {
        queue.end();
      }
      return {
        events: queue.iterable as TtsStream["events"],
        async cancel() {
          queue.end();
        },
      };
    },
  };
}

function llmEvent(
  request: LlmCompletionRequest,
  sequence: number,
  body: Record<string, unknown>,
): LlmStreamEvent {
  return {
    id: `llm_${sequence}` as ProviderEventId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence,
    provider: "fake-llm",
    timestamp: TS,
    ...body,
  } as LlmStreamEvent;
}

function audioChunk(request: TtsSynthesisRequest, sequence: number): OutputMediaEvent {
  return {
    id: `tts_${sequence}` as MediaEventId,
    type: "media.audio.chunk",
    sessionId: request.sessionId,
    turnId: request.turnId,
    sequence,
    direction: "output",
    timestamp: TS,
    monotonicOffsetMs: 0,
    provider: "fake-tts",
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      data: { kind: "inline", bytes: new Uint8Array(640) },
    },
  };
}

function streamStarted(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_started" as MediaEventId,
    type: "media.stream.started",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 0,
    format: PCM16_16K_MONO,
  };
}

function audioChunkIn(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_audio" as MediaEventId,
    type: "media.audio.chunk",
    sessionId,
    sequence: 2,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 5,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      data: { kind: "inline", bytes: new Uint8Array(640) },
    },
  };
}

function bargeIn(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_barge" as MediaEventId,
    type: "barge_in.detected",
    sessionId,
    sequence: 3,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 10,
    confidence: 0.9,
  };
}

function streamEnded(sessionId: SessionId): InboundMediaEvent {
  return {
    id: "in_ended" as MediaEventId,
    type: "media.stream.ended",
    sessionId,
    sequence: 9,
    direction: "input",
    timestamp: TS,
    monotonicOffsetMs: 50,
    reason: "remote_hangup",
    durationMs: 50,
  };
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const stubTelephony: TelephonyProvider = {
  name: "stub-telephony",
  kind: "telephony",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: true },
  async dial() {
    throw new Error("not used");
  },
  async accept() {
    throw new Error("not used");
  },
  async hangup() {
    return;
  },
};

const stubStt: SpeechToTextProvider = {
  name: "stub-stt",
  kind: "stt",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: false },
  async open() {
    throw new Error("not used");
  },
};

const stubLlm: LLMProvider = {
  name: "stub-llm",
  kind: "llm",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: false },
  async complete() {
    throw new Error("not used");
  },
};

const stubTts: TextToSpeechProvider = {
  name: "stub-tts",
  kind: "tts",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: true },
  async synthesize() {
    throw new Error("not used");
  },
};
