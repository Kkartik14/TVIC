import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import { PCM16_16K_MONO, type UserId } from "@tvic/core";
import {
  createDeepgramSttProvider,
  createOpenAiResponsesLlmProvider,
  createWebClientAudioProvider,
} from "@tvic/providers";
import { defineAgent } from "@tvic/runtime";

import { createPrimedConversationPolicy } from "../src/conversation.js";
import { createVoiceSessionStore } from "../src/security.js";

describe("returning-user conversation priming", () => {
  it("uses Memory.search and includes prior non-interrupted exchanges in the next LLM history", async () => {
    const memory = createInMemoryMemory();
    const userId = "user-1" as UserId;
    await memory.append({ scope: "user", userId }, "exchanges", {
      user: "My name is Ada.",
      assistant: "Nice to meet you, Ada.",
    });
    await memory.append({ scope: "user", userId }, "exchanges", {
      user: "Do not retain this partial turn.",
      assistant: "Partial",
      interrupted: true,
    });
    const policy = await createPrimedConversationPolicy(memory, buildTestAgent(), userId);
    expect(policy.messagesForTranscript("What is my name?")).toEqual(
      expect.arrayContaining([
        { role: "user", content: "My name is Ada." },
        { role: "assistant", content: "Nice to meet you, Ada." },
        { role: "user", content: "What is my name?" },
      ]),
    );
    expect(policy.messagesForTranscript("What is my name?")).not.toContainEqual(
      expect.objectContaining({ content: "Do not retain this partial turn." }),
    );
  });

  it("keeps the memory identity stable across freshly minted reconnect sessions", () => {
    const store = createVoiceSessionStore({
      tokenSecret: "token-secret",
      safetyIdentifierSecret: "safety-secret",
      ttlMs: 1_000,
      concurrentSessionCap: 2,
    });
    const first = store.reserve("user-1", "continuous");
    const second = store.reserve("user-1", "continuous");
    if (!first.ok || !second.ok) throw new Error("reservation failed");
    expect(first.issued.identity.memoryUserId).toBe(second.issued.identity.memoryUserId);
  });
});

function buildTestAgent() {
  return defineAgent({
    id: "conversation-test-agent",
    name: "Conversation Test Agent",
    instructions: "Test.",
    tools: [],
    audioPolicy: { input: PCM16_16K_MONO, output: PCM16_16K_MONO },
    memoryPolicy: { enabled: true, scopes: ["session", "user"] },
    providers: {
      telephony: createWebClientAudioProvider(),
      stt: createDeepgramSttProvider({ apiKey: "test" }),
      llm: createOpenAiResponsesLlmProvider({ apiKey: "test" }),
    },
  });
}
