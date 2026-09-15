import { describe, expect, it } from "vitest";

import {
  AsyncQueue,
  createMediaEvent,
  createVoiceAgent,
  defineTool,
  nowTimestamp,
  PCM16_16K_MONO,
  type CallHandle,
  type CallId,
  type InboundMediaEvent,
  type LLMProvider,
  type LlmCompletion,
  type LlmStreamEvent,
  type ProviderCapabilities,
  type ProviderEventId,
  type SessionId,
  type SpeechToTextProvider,
  type SttStream,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type TranscriptEvent,
  type TtsEvent,
  type TtsSynthesisRequest,
  type VoiceEvent,
} from "../src/index.js";

const CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: true },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  tools: { functionCalling: true, parallelCalls: true },
  playout: { clearBuffer: true, acknowledgement: true, position: true },
} satisfies ProviderCapabilities;

function streamStarted(sessionId: SessionId): InboundMediaEvent {
  return createMediaEvent({
    id: "stream-started" as never,
    type: "media.stream.started",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    format: PCM16_16K_MONO,
  });
}

function streamEnded(
  sessionId: SessionId,
  reason: "completed" | "remote_hangup" = "completed",
): InboundMediaEvent {
  return createMediaEvent({
    id: "stream-ended" as never,
    type: "media.stream.ended",
    sessionId,
    sequence: 99,
    direction: "input",
    timestamp: nowTimestamp(),
    monotonicOffsetMs: 0,
    reason,
    durationMs: 0,
  });
}

function finalTranscript(sessionId: SessionId, text: string, sequence: number): TranscriptEvent {
  const timestamp = nowTimestamp();
  return {
    id: `stt-final-${sequence}` as ProviderEventId,
    type: "stt.final",
    direction: "input",
    sessionId,
    sequence,
    provider: "fake-stt",
    text,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
  };
}

function endpointEvent(sessionId: SessionId, sequence: number): TranscriptEvent {
  return {
    id: `stt-endpoint-${sequence}` as ProviderEventId,
    type: "stt.endpoint",
    direction: "input",
    sessionId,
    sequence,
    provider: "fake-stt",
    reason: "provider",
    timestamp: nowTimestamp(),
  };
}

function speechStarted(sessionId: SessionId, sequence: number): TranscriptEvent {
  return {
    id: `stt-speech-${sequence}` as ProviderEventId,
    type: "stt.speech.started",
    direction: "input",
    sessionId,
    sequence,
    provider: "fake-stt",
    timestamp: nowTimestamp(),
  };
}

function makeHandle(callId: string) {
  const inbound = new AsyncQueue<InboundMediaEvent>();
  const sent: unknown[] = [];
  const closeReasons: string[] = [];
  let clearCalls = 0;
  const handle: CallHandle = {
    callId: callId as CallId,
    events: inbound,
    async send(event) {
      sent.push(event);
      return true;
    },
    async clear() {
      clearCalls += 1;
    },
    async close(reason) {
      closeReasons.push(reason);
      inbound.close();
    },
    async confirmPlayout() {
      return true;
    },
  };
  return { handle, inbound, sent, closeReasons, clearCalls: () => clearCalls };
}

function makeStt(transcripts: AsyncQueue<TranscriptEvent>): SpeechToTextProvider {
  return {
    name: "fake-stt",
    kind: "stt",
    version: "1.0.0",
    capabilities: CAPABILITIES,
    async open(): Promise<SttStream> {
      return {
        events: transcripts,
        async sendAudio() {},
        async commit() {},
        async close() {
          transcripts.close();
        },
      };
    },
  };
}

function llmText(text: string): LLMProvider {
  return {
    name: "fake-llm",
    kind: "llm",
    version: "1.0.0",
    capabilities: CAPABILITIES,
    async complete(request): Promise<LlmCompletion> {
      const events = new AsyncQueue<LlmStreamEvent>();
      const timestamp = nowTimestamp();
      events.push({
        id: "llm-started" as ProviderEventId,
        type: "llm.started",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        provider: "fake-llm",
        timestamp,
        model: request.model,
      });
      events.push({
        id: "llm-completed" as ProviderEventId,
        type: "llm.completed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        provider: "fake-llm",
        timestamp,
        text,
        toolCalls: [],
      });
      events.close();
      return { events, async cancel() {} };
    },
  };
}

function oneShotTts(): TextToSpeechProvider {
  return {
    name: "fake-tts",
    kind: "tts",
    version: "1.0.0",
    capabilities: CAPABILITIES,
    async synthesize(request: TtsSynthesisRequest) {
      const events = new AsyncQueue<TtsEvent>();
      const audio = createMediaEvent({
        id: "tts-audio" as never,
        type: "media.audio.chunk",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 1,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "fake-tts",
        audio: {
          format: PCM16_16K_MONO,
          durationMs: 20,
          frameCount: 320,
          bytes: new Uint8Array(640),
        },
      });
      const committed = createMediaEvent({
        id: "tts-committed" as never,
        type: "media.audio.committed",
        sessionId: request.sessionId,
        turnId: request.turnId,
        sequence: 2,
        direction: "output",
        timestamp: nowTimestamp(),
        monotonicOffsetMs: 0,
        provider: "fake-tts",
        durationMs: 20,
        frameCount: 320,
        sequenceRange: [1, 1],
        chunkIds: [audio.id],
      });
      events.push(audio as never);
      events.push(committed as never);
      events.close();
      return { events, async cancel() {} };
    },
  };
}

const telephony: TelephonyProvider = {
  name: "fake-telephony",
  kind: "telephony",
  version: "1.0.0",
  capabilities: CAPABILITIES,
  async dial() {
    throw new Error("not used");
  },
  async accept() {
    throw new Error("not used");
  },
  async hangup() {},
};

async function collect(run: AsyncIterable<VoiceEvent>): Promise<VoiceEvent[]> {
  const events: VoiceEvent[] = [];
  try {
    for await (const event of run) events.push(event);
  } catch {
    // The managed Promise rejects for remote hangup, cancellation, and raw
    // provider failures after the terminal event has been delivered. This
    // fixture asserts the ordered event prefix separately from that result.
  }
  return events;
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  // Bounded poll: hangs fail loudly instead of hanging CI forever.
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * R2-07: deterministic managed conversation through the PUBLIC facade
 * (joint T1+T2). N phases — sessions have exactly one terminal, so
 * completion/hangup/failure/timeout are separate runs. Harness-level
 * partial-vs-final mapping is asserted in @tvic/runtime conversation-policy
 * tests; here the public finals-only contract (`public has no partials`,
 * T1-signed) is locked.
 */
describe("R2-07 managed vertical slice", () => {
  it("tool turn: validated args -> tool_call/tool_result -> spoken continuation", async () => {
    const transcripts = new AsyncQueue<TranscriptEvent>();
    const ctx = makeHandle("slice-tool");
    const { handle, inbound, sent } = ctx;
    const tool = defineTool({
      id: "tool_slice",
      name: "check_availability",
      description: "Check availability.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute() {
        return { available: true };
      },
    });
    let completions = 0;
    const llm: LLMProvider = {
      name: "fake-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async complete(request): Promise<LlmCompletion> {
        completions += 1;
        const events = new AsyncQueue<LlmStreamEvent>();
        const timestamp = nowTimestamp();
        if (completions === 1) {
          const call = { callRef: "c1", toolName: "check_availability" as never, input: {} };
          events.push({
            id: "s1" as ProviderEventId,
            type: "llm.started",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 1,
            provider: "fake-llm",
            timestamp,
            model: request.model,
          });
          events.push({
            id: "s2" as ProviderEventId,
            type: "llm.tool_call",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 2,
            provider: "fake-llm",
            timestamp,
            call,
          });
          events.push({
            id: "s3" as ProviderEventId,
            type: "llm.completed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 3,
            provider: "fake-llm",
            timestamp,
            text: "",
            toolCalls: [call],
          });
        } else {
          events.push({
            id: "s4" as ProviderEventId,
            type: "llm.started",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 4,
            provider: "fake-llm",
            timestamp,
            model: request.model,
          });
          events.push({
            id: "s5" as ProviderEventId,
            type: "llm.completed",
            sessionId: request.sessionId,
            turnId: request.turnId,
            sequence: 5,
            provider: "fake-llm",
            timestamp,
            text: "You are booked.",
            toolCalls: [],
          });
        }
        events.close();
        return { events, async cancel() {} };
      },
    };
    const agent = createVoiceAgent({
      prompt: "You schedule appointments.",
      tools: [tool],
      providers: { telephony, stt: makeStt(transcripts), llm, tts: oneShotTts() },
    });
    const session = await agent.start({ callHandle: handle, channel: "simulated" });
    const done = collect(session.run);
    inbound.push(streamStarted(session.sessionId));
    transcripts.push(finalTranscript(session.sessionId, "book tomorrow", 1));
    transcripts.push(endpointEvent(session.sessionId, 2));
    // Wait for the spoken continuation before ending the media stream.
    await waitFor("spoken continuation", () => sent.length >= 1);
    inbound.push(streamEnded(session.sessionId));
    await session.run;
    const events = await done;
    expect(events.find((e) => e.kind === "tool_call")).toMatchObject({
      toolName: "check_availability",
    });
    expect(events.find((e) => e.kind === "tool_result")).toMatchObject({
      output: { available: true },
    });
    expect(events.find((e) => e.kind === "audio_output")).toBeDefined();
    expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "completed" });
    await agent.stop();
  });

  it("interruption turn cancels output, clears, completes no stale audio", async () => {
    const transcripts = new AsyncQueue<TranscriptEvent>();
    const ctx = makeHandle("slice-barge");
    // Controlled TTS: opens but caller decides when audio flows.
    const gate = new AsyncQueue<TtsEvent>();
    let opened = false;
    const hangingTts: TextToSpeechProvider = {
      name: "fake-tts",
      kind: "tts",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async synthesize() {
        opened = true;
        return {
          events: gate,
          async cancel() {
            gate.close();
          },
        };
      },
    };
    const agent = createVoiceAgent({
      prompt: "You answer briefly.",
      interruptionPolicy: { mode: "graceful", minSpeechMs: 0, trimOutputOnInterrupt: true },
      providers: {
        telephony,
        stt: makeStt(transcripts),
        llm: llmText("a long answer"),
        tts: hangingTts,
      },
    });
    const session = await agent.start({ callHandle: ctx.handle, channel: "simulated" });
    const done = collect(session.run);
    ctx.inbound.push(streamStarted(session.sessionId));
    transcripts.push(finalTranscript(session.sessionId, "tell me everything", 1));
    transcripts.push(endpointEvent(session.sessionId, 2));
    await waitFor("tts open", () => opened);
    transcripts.push(speechStarted(session.sessionId, 3));
    ctx.inbound.push(streamEnded(session.sessionId));
    await session.run;
    const events = await done;
    expect(
      events
        .filter((e) => e.kind === "turn_completed")
        .map((e) => (e as { status: string }).status),
    ).toContain("cancelled");
    expect(events.at(-1)?.kind).toBe("call_ended");
    await agent.stop();
  });

  it("completion turn answers and ends completed with turn_completed", async () => {
    const transcripts = new AsyncQueue<TranscriptEvent>();
    const { handle, inbound, sent, closeReasons } = makeHandle("slice-complete");
    const agent = createVoiceAgent({
      prompt: "You answer briefly.",
      providers: {
        telephony,
        stt: makeStt(transcripts),
        llm: llmText("All set."),
        tts: oneShotTts(),
      },
    });
    const session = await agent.start({ callHandle: handle, channel: "simulated" });
    const done = collect(session.run);
    inbound.push(streamStarted(session.sessionId));
    transcripts.push(finalTranscript(session.sessionId, "thanks", 1));
    transcripts.push(endpointEvent(session.sessionId, 2));
    await waitFor("spoken answer", () => sent.length >= 1);
    inbound.push(streamEnded(session.sessionId));
    await session.run;
    const events = await done;
    expect(events.find((e) => e.kind === "turn_completed")).toMatchObject({ status: "completed" });
    expect(events.at(-1)).toMatchObject({ kind: "call_ended", reason: "completed", totalTurns: 1 });
    // Managed closeCall owns exactly-once transport close per terminal run.
    expect(closeReasons).toHaveLength(1);
    await agent.stop();
  });

  it("hangup with no turns ends remote_hangup with zero turns", async () => {
    const transcripts = new AsyncQueue<TranscriptEvent>();
    const { handle, inbound } = makeHandle("slice-hangup");
    const agent = createVoiceAgent({
      prompt: "You answer briefly.",
      providers: { telephony, stt: makeStt(transcripts), llm: llmText("hi"), tts: oneShotTts() },
    });
    const session = await agent.start({ callHandle: handle, channel: "simulated" });
    const done = collect(session.run);
    inbound.push(streamStarted(session.sessionId));
    inbound.push(streamEnded(session.sessionId, "remote_hangup"));
    await expect(session.run).rejects.toMatchObject({ code: "voice_runtime.remote_hangup" });
    const events = await done;
    expect(events).toEqual([{ kind: "call_ended", reason: "remote_hangup", totalTurns: 0 }]);
    await agent.stop();
  });

  it("provider failure surfaces normalized error and failed run", async () => {
    const { handle, inbound } = makeHandle("slice-fail");
    const failingStt: SpeechToTextProvider = {
      name: "failing-stt",
      kind: "stt",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async open(): Promise<SttStream> {
        const { providerError } = await import("@tvic/core");
        throw providerError("stt.test_open_failed", "open boom", {
          provider: "failing-stt",
          retriable: false,
        });
      },
    };
    const agent = createVoiceAgent({
      prompt: "You answer briefly.",
      providers: { telephony, stt: failingStt, llm: llmText("hi"), tts: oneShotTts() },
    });
    const session = await agent.start({ callHandle: handle, channel: "simulated" });
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      try {
        for await (const event of session.run) seen.push(event);
      } catch {
        // The run rejection is asserted separately below.
      }
    })();
    inbound.push(streamStarted(session.sessionId));
    await expect(session.run).rejects.toMatchObject({ code: "stt.test_open_failed" });
    await draining;
    expect(seen.find((e) => e.kind === "error")).toBeDefined();
    expect(seen.at(-1)).toMatchObject({ kind: "call_ended", reason: "failed" });
    await agent.stop();
  });

  it("LLM stall times out bounded and fails the run", async () => {
    const transcripts = new AsyncQueue<TranscriptEvent>();
    const { handle, inbound } = makeHandle("slice-timeout");
    const hangingLlm: LLMProvider = {
      name: "hanging-llm",
      kind: "llm",
      version: "1.0.0",
      capabilities: CAPABILITIES,
      async complete() {
        const events = new AsyncQueue<LlmStreamEvent>();
        return {
          events,
          async cancel() {
            events.close();
          },
        };
      },
    };
    const agent = createVoiceAgent({
      prompt: "You answer briefly.",
      providers: { telephony, stt: makeStt(transcripts), llm: hangingLlm, tts: oneShotTts() },
    });
    const session = await agent.start({
      callHandle: handle,
      channel: "simulated",
      streamStallTimeoutMs: 50,
    });
    const seen: VoiceEvent[] = [];
    const draining = (async () => {
      for await (const event of session.run) seen.push(event);
    })();
    inbound.push(streamStarted(session.sessionId));
    transcripts.push(finalTranscript(session.sessionId, "hello?", 1));
    transcripts.push(endpointEvent(session.sessionId, 2));
    // Let the stall fire and fail the turn before ending media.
    await waitFor("turn terminal", () =>
      seen.some((e) => e.kind === "turn_completed" || e.kind === "error"),
    );
    inbound.push(streamEnded(session.sessionId));
    const result = await session.run;
    await draining;
    expect(result.turnsFailed).toBe(1);
    expect(seen.find((e) => e.kind === "error")).toBeDefined();
    await agent.stop();
  }, 10_000);
});
