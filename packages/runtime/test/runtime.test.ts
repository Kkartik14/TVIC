import { describe, expect, it } from "vitest";
import type {
  AgentAudioPolicy,
  CallId,
  CallHandle,
  Clock,
  CorrelationId,
  LLMProvider,
  LlmCompletionRequest,
  MediaEventId,
  OutputMediaEvent,
  SessionId,
  SpeechToTextProvider,
  StreamEndReason,
  TelephonyProvider,
  TextToSpeechProvider,
  Timestamp,
  TraceEvent,
  TraceExporter,
  TraceEventId,
  SpanId,
  TranscriptEvent,
  TurnId,
} from "@tvic/core";
import { PCM16_16K_MONO } from "@tvic/core";

import {
  createNodeMediaPlane,
  createRuntime,
  defineAgent,
  matchPath,
  runPipelineVoiceLoop,
} from "../src/index.js";

const audioPolicy: AgentAudioPolicy = {
  input: PCM16_16K_MONO,
  output: PCM16_16K_MONO,
  resampleAtEdge: true,
};

const telephony: TelephonyProvider = {
  name: "telephony-contract-provider",
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

const stt: SpeechToTextProvider = {
  name: "stt-contract-provider",
  kind: "stt",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: false },
  async open() {
    throw new Error("not used");
  },
};

const llm: LLMProvider = {
  name: "llm-contract-provider",
  kind: "llm",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: false },
  async complete() {
    throw new Error("not used");
  },
};

const tts: TextToSpeechProvider = {
  name: "tts-contract-provider",
  kind: "tts",
  version: "0.1.0",
  capabilities: { streaming: true, interruption: true },
  async synthesize() {
    throw new Error("not used");
  },
};

describe("createRuntime", () => {
  it("runs session lifecycle and records media traces", async () => {
    const exportedEvents: TraceEvent[] = [];
    const exporter: TraceExporter = {
      name: "session-exporter",
      kind: "trace_exporter",
      version: "0.1.0",
      capabilities: { streaming: false, interruption: false },
      async export(events) {
        exportedEvents.push(...events);
      },
      async flush() {
        return;
      },
      async close() {
        return;
      },
    };
    const runtime = createRuntime();
    const agent = defineAgent({
      id: "agent_runtime",
      name: "Runtime Agent",
      instructions: "Handle the call.",
      tools: [],
      audioPolicy,
      providers: {
        mode: "pipeline",
        telephony,
        stt,
        llm,
        tts,
        traceExporters: [exporter],
      },
    });

    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const turn = await runtime.startTurn({
      sessionId: session.id,
      input: { transcript: "I need a table for four.", mediaEventIds: [] },
    });

    await runtime.injectMediaEvent({
      id: "media_1" as MediaEventId,
      type: "media.audio.chunk",
      sessionId: session.id as SessionId,
      callId: "call_1" as CallId,
      sequence: 1,
      direction: "input",
      timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
      monotonicOffsetMs: 5,
      audio: {
        format: audioPolicy.input,
        durationMs: 20,
        frameCount: 320,
        data: { kind: "inline", bytes: new Uint8Array([1, 2, 3]) },
      },
    });

    await runtime.injectMediaEvent({
      id: "media_2" as MediaEventId,
      type: "barge_in.detected",
      sessionId: session.id as SessionId,
      callId: "call_1" as CallId,
      sequence: 2,
      direction: "input",
      timestamp: "2026-05-20T00:00:00.010Z" as Timestamp,
      monotonicOffsetMs: 10,
      confidence: 0.9,
      againstTurnId: turn.id,
    });

    await runtime.endTurn(session.id, turn.id, {
      reason: "completed",
      output: { text: "I can help with that.", mediaEventIds: [] },
    });
    await runtime.endSession(session.id, { reason: "completed" });
    const snapshot = await runtime.inspectSession(session.id);

    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.status).toBe("completed");
    expect(snapshot.traceEvents.map((event) => event.type)).toEqual([
      "session.created",
      "session.started",
      "turn.started",
      "audio.input.chunk",
      "barge_in.detected",
      "turn.ended",
      "session.completed",
    ]);
    expect(exportedEvents.map((event) => event.type)).toEqual(
      snapshot.traceEvents.map((event) => event.type),
    );
    expect(snapshot.traceEvents.every((event) => event.monotonicOffsetMs >= 0)).toBe(true);
    expect(snapshot.traceEvents.every((event) => event.spanId && event.correlationId)).toBe(true);
  });

  it("rebases media and externally emitted traces onto the runtime session clock", async () => {
    const clock = new ManualClock();
    const runtime = createRuntime({ clock });
    const agent = defineAgent({
      id: "agent_clock",
      name: "Clock Agent",
      instructions: "Handle the call.",
      tools: [],
      audioPolicy,
      providers: {
        mode: "pipeline",
        telephony,
        stt,
        llm,
        tts,
      },
    });

    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    clock.advance(42);
    await runtime.injectMediaEvent({
      id: "media_clock" as MediaEventId,
      type: "speech.started",
      sessionId: session.id as SessionId,
      sequence: 1,
      direction: "input",
      timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
      monotonicOffsetMs: 999,
    });

    clock.advance(8);
    await runtime.emitTraceEvent({
      id: "trace_event_clock" as TraceEventId,
      traceId: session.traceId,
      sessionId: session.id,
      timestamp: "2026-05-20T00:00:00.050Z" as Timestamp,
      monotonicOffsetMs: 777,
      spanId: "span_clock" as SpanId,
      correlationId: "correlation_clock" as CorrelationId,
      type: "runtime.timeout",
      status: "failed",
      operation: "test",
      timeoutMs: 1,
    });

    const snapshot = await runtime.inspectSession(session.id);
    const speech = snapshot.traceEvents.find((event) => event.type === "speech.started");
    const timeout = snapshot.traceEvents.find((event) => event.type === "runtime.timeout");

    expect(speech?.monotonicOffsetMs).toBe(42);
    expect(speech?.metadata).toEqual({ providerMonotonicOffsetMs: 999 });
    expect(timeout?.monotonicOffsetMs).toBe(50);
    expect(timeout?.metadata).toEqual({ sourceMonotonicOffsetMs: 777 });
  });

  it("runs one pipeline voice loop turn across STT, LLM, TTS, and call output", async () => {
    const runtime = createRuntime();
    const sentOutput: OutputMediaEvent[] = [];
    const agent = defineAgent({
      id: "agent_loop",
      name: "Loop Agent",
      instructions: "You book tables.",
      tools: [],
      audioPolicy,
      providers: {
        mode: "pipeline",
        telephony,
        stt: loopStt(),
        llm: loopLlm(),
        tts: loopTts(),
      },
    });

    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });
    const callHandle: CallHandle = {
      callId: "call_loop" as CallId,
      events: callEvents(session.id),
      async send(event) {
        sentOutput.push(event);
      },
      async clear() {
        return;
      },
      async cancelOutput() {
        return;
      },
      async close(_reason: StreamEndReason) {
        return;
      },
    };

    const result = await runPipelineVoiceLoop({
      runtime,
      session,
      agent,
      callHandle,
      stt: agent.providers.stt,
      llm: agent.providers.llm,
      tts: agent.providers.tts,
      llmModel: "gpt-test",
    });
    const snapshot = await runtime.inspectSession(session.id);

    expect(result.turnsHandled).toBe(1);
    expect(sentOutput.map((event) => event.type)).toEqual([
      "media.audio.chunk",
      "media.audio.committed",
    ]);
    expect(snapshot.turns[0]?.status).toBe("completed");
    expect(snapshot.traceEvents.map((event) => event.type)).toContain("stt.final");
    expect(snapshot.traceEvents.map((event) => event.type)).toContain("llm.completed");
    expect(snapshot.traceEvents.map((event) => event.type)).toContain("tts.completed");
    expect(snapshot.traceEvents.map((event) => event.type)).toContain("audio.output.ended");
  });

  it("configures a long-running WebSocket media plane with path params", () => {
    const plane = createNodeMediaPlane({
      host: "127.0.0.1",
      port: 0,
      path: "/media/:callId",
      onConnection() {
        return;
      },
    });

    expect(plane.isRunning).toBe(false);
    expect(matchPath("/media/:callId", "/media/call_123")).toEqual({ callId: "call_123" });
    expect(matchPath("/media/:callId", "/wrong/call_123")).toBeNull();
  });
});

class ManualClock implements Clock {
  #ms = 1_000;

  now(): Timestamp {
    return new Date(this.#ms).toISOString() as Timestamp;
  }

  monotonicMs(): number {
    return this.#ms;
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}

async function* callEvents(sessionId: SessionId) {
  yield {
    id: "media_loop_1" as MediaEventId,
    type: "media.audio.chunk" as const,
    sessionId,
    callId: "call_loop" as CallId,
    sequence: 1,
    direction: "input" as const,
    timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
    monotonicOffsetMs: 5,
    audio: {
      format: audioPolicy.input,
      durationMs: 20,
      frameCount: 320,
      data: { kind: "inline" as const, bytes: new Uint8Array(640) },
    },
  };
  yield {
    id: "media_loop_2" as MediaEventId,
    type: "media.stream.ended" as const,
    sessionId,
    callId: "call_loop" as CallId,
    sequence: 2,
    direction: "input" as const,
    timestamp: "2026-05-20T00:00:00.020Z" as Timestamp,
    monotonicOffsetMs: 20,
    reason: "completed" as const,
    durationMs: 20,
  };
}

function loopStt(): SpeechToTextProvider {
  return {
    name: "loop-stt",
    kind: "stt",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: false },
    async open(request) {
      return {
        events: transcriptEvents(request.sessionId),
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
}

async function* transcriptEvents(sessionId: SessionId): AsyncIterable<TranscriptEvent> {
  yield {
    id: "provider_event_1" as never,
    type: "stt.final",
    direction: "input",
    sessionId,
    sequence: 1,
    provider: "loop-stt",
    text: "table for two at seven",
    startTimestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
    endTimestamp: "2026-05-20T00:00:00.020Z" as Timestamp,
    metadata: { speechFinal: true },
  };
}

function loopLlm(): LLMProvider {
  return {
    name: "loop-llm",
    kind: "llm",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async complete(request: LlmCompletionRequest) {
      return {
        events: llmEvents(request.sessionId, request.turnId),
        async cancel() {
          return;
        },
      };
    },
  };
}

async function* llmEvents(sessionId: SessionId, turnId: TurnId) {
  yield {
    id: "provider_event_2" as never,
    type: "llm.started" as const,
    sessionId,
    turnId,
    sequence: 1,
    provider: "loop-llm",
    timestamp: "2026-05-20T00:00:00.030Z" as Timestamp,
    model: "gpt-test",
  };
  yield {
    id: "provider_event_3" as never,
    type: "llm.token" as const,
    sessionId,
    turnId,
    sequence: 2,
    provider: "loop-llm",
    timestamp: "2026-05-20T00:00:00.040Z" as Timestamp,
    text: "Confirmed.",
  };
  yield {
    id: "provider_event_4" as never,
    type: "llm.completed" as const,
    sessionId,
    turnId,
    sequence: 3,
    provider: "loop-llm",
    timestamp: "2026-05-20T00:00:00.050Z" as Timestamp,
    text: "Confirmed.",
    toolCalls: [],
  };
}

function loopTts(): TextToSpeechProvider {
  return {
    name: "loop-tts",
    kind: "tts",
    version: "0.1.0",
    capabilities: { streaming: true, interruption: true },
    async synthesize(request) {
      return {
        events: ttsEvents(request.sessionId, request.turnId),
        async cancel() {
          return;
        },
      };
    },
  };
}

async function* ttsEvents(sessionId: SessionId, turnId: TurnId) {
  yield {
    id: "media_output_1" as MediaEventId,
    type: "media.audio.chunk" as const,
    sessionId,
    turnId,
    sequence: 1,
    direction: "output" as const,
    timestamp: "2026-05-20T00:00:00.060Z" as Timestamp,
    monotonicOffsetMs: 60,
    audio: {
      format: audioPolicy.output,
      durationMs: 20,
      frameCount: 320,
      data: { kind: "inline" as const, bytes: new Uint8Array(640) },
    },
  };
  yield {
    id: "media_output_2" as MediaEventId,
    type: "media.audio.committed" as const,
    sessionId,
    turnId,
    sequence: 2,
    direction: "output" as const,
    timestamp: "2026-05-20T00:00:00.080Z" as Timestamp,
    monotonicOffsetMs: 80,
    durationMs: 20,
    frameCount: 320,
    sequenceRange: [1, 1],
    chunkIds: ["media_output_1" as MediaEventId],
  };
}
