import { describe, expect, it } from "vitest";

import type {
  AgentAudioPolicy,
  CallId,
  LLMProvider,
  MediaEventId,
  SessionId,
  SpeechToTextProvider,
  TelephonyProvider,
  TextToSpeechProvider,
  Timestamp,
} from "@tvic/core";

import { createRuntime, defineAgent } from "../src/index.js";

const audioPolicy: AgentAudioPolicy = {
  input: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
  output: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
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
      },
    });

    await runtime.start();
    const session = await runtime.startSession(agent, { channel: "simulated" });

    await runtime.injectMediaEvent({
      id: "media_1" as MediaEventId,
      type: "media.audio.chunk",
      sessionId: session.id as SessionId,
      callId: "call_1" as CallId,
      sequence: 1,
      direction: "input",
      timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
      audio: {
        format: audioPolicy.input,
        durationMs: 20,
        frameCount: 320,
        data: { kind: "inline", bytes: new Uint8Array([1, 2, 3]) },
      },
    });

    await runtime.endSession(session.id, { reason: "completed" });
    const snapshot = await runtime.inspectSession(session.id);

    expect(snapshot.session.status).toBe("completed");
    expect(snapshot.traceEvents.map((event) => event.type)).toEqual([
      "session.created",
      "session.started",
      "audio.input.chunk",
      "session.completed",
    ]);
  });
});
