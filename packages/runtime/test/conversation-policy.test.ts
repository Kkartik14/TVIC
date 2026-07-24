import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  type AgentAudioPolicy,
  type LLMProvider,
  type SessionId,
  type SpeechToTextProvider,
  type TelephonyProvider,
  type TextToSpeechProvider,
  type Timestamp,
  type TranscriptEvent,
} from "@tvic/core";

import { ConversationPolicy, defineAgent, defineTool } from "../src/index.js";
import { TEST_PROVIDER_CAPABILITIES } from "./harness.js";

const audioPolicy: AgentAudioPolicy = {
  input: PCM16_16K_MONO,
  output: PCM16_16K_MONO,
  resampleAtEdge: true,
};

describe("ConversationPolicy", () => {
  it("buffers final segments and commits only on an explicit endpoint", () => {
    const policy = new ConversationPolicy({ agent: testAgent() });

    expect(policy.acceptTranscript(finalTranscript("table"))).toBeNull();
    expect(policy.acceptTranscript(finalTranscript("for two"))).toBeNull();
    expect(policy.hasBufferedTranscript).toBe(true);
    expect(policy.acceptTranscript(partialTranscript("ignored partial"))).toBeNull();
    expect(policy.acceptTranscript(endpoint())).toBe("table for two");
    expect(policy.hasBufferedTranscript).toBe(false);
    expect(policy.acceptTranscript(endpoint())).toBeNull();
  });

  it("can flush buffered finals when the provider stream closes without an endpoint", () => {
    const policy = new ConversationPolicy({ agent: testAgent() });

    policy.acceptTranscript(finalTranscript("unfinished utterance"));

    expect(policy.flushBufferedTranscript()).toBe("unfinished utterance");
    expect(policy.flushBufferedTranscript()).toBeNull();
  });

  it("assembles messages and records conversation history", () => {
    const policy = new ConversationPolicy({ agent: testAgent() });

    expect(policy.messagesForTranscript("first")).toEqual([
      { role: "system", content: "You book tables." },
      { role: "user", content: "first" },
    ]);

    policy.recordTurn("first", "confirmed");

    expect(policy.messagesForTranscript("second")).toEqual([
      { role: "system", content: "You book tables." },
      { role: "user", content: "first" },
      { role: "assistant", content: "confirmed" },
      { role: "user", content: "second" },
    ]);
  });

  it("finds tools by branded tool name", () => {
    const agent = testAgent();
    const policy = new ConversationPolicy({ agent });

    expect(policy.findTool({ callRef: "call_1", toolName: agent.tools[0]!.name, input: {} })).toBe(
      agent.tools[0],
    );
    expect(
      policy.findTool({ callRef: "call_2", toolName: "missing_tool" as never, input: {} }),
    ).toBeNull();
  });

  it("preserves interrupted exchanges without claiming the full response was heard", () => {
    const policy = new ConversationPolicy({ agent: testAgent() });

    policy.recordInterruptedTurn("wait", "I can explain the options");

    expect(policy.messagesForTranscript("continue")).toEqual([
      { role: "system", content: "You book tables." },
      { role: "user", content: "wait" },
      {
        role: "assistant",
        content:
          "[Response interrupted before completion; some of this may not have been heard.] I can explain the options",
      },
      { role: "user", content: "continue" },
    ]);
  });
});

function testAgent() {
  return defineAgent({
    id: "agent_policy",
    name: "Policy Agent",
    instructions: "You book tables.",
    tools: [
      defineTool({
        id: "tool_policy",
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
    providers: {
      mode: "pipeline",
      telephony,
      stt,
      llm,
      tts,
    },
  });
}

function finalTranscript(text: string): TranscriptEvent {
  return {
    id: "provider_event" as never,
    type: "stt.final",
    direction: "input",
    sessionId: "session_policy" as SessionId,
    sequence: 1,
    provider: "test-stt",
    text,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
  };
}

function partialTranscript(text: string): TranscriptEvent {
  return {
    id: "provider_event_partial" as never,
    type: "stt.partial",
    direction: "input",
    sessionId: "session_policy" as SessionId,
    sequence: 1,
    provider: "test-stt",
    text,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
  };
}

function endpoint(): TranscriptEvent {
  return {
    id: "provider_event_endpoint" as never,
    type: "stt.endpoint",
    direction: "input",
    sessionId: "session_policy" as SessionId,
    sequence: 2,
    provider: "test-stt",
    reason: "provider",
    timestamp,
  };
}

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;

const telephony: TelephonyProvider = {
  name: "telephony-policy-provider",
  kind: "telephony",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
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
  name: "stt-policy-provider",
  kind: "stt",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async open() {
    throw new Error("not used");
  },
};

const llm: LLMProvider = {
  name: "llm-policy-provider",
  kind: "llm",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async complete() {
    throw new Error("not used");
  },
};

const tts: TextToSpeechProvider = {
  name: "tts-policy-provider",
  kind: "tts",
  version: "0.1.0",
  capabilities: TEST_PROVIDER_CAPABILITIES,
  async synthesize() {
    throw new Error("not used");
  },
};
