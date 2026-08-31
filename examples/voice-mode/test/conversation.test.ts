import { describe, expect, it } from "vitest";

import { createInMemoryMemory } from "@tvic/dal";
import { PCM16_16K_MONO, type UserId } from "@tvic/core";
import {
  createDeepgramSttProvider,
  createOpenAiResponsesLlmProvider,
  createWebClientAudioProvider,
} from "@tvic/providers";
import { ConversationPolicy, createRuntime, defineAgent } from "@tvic/runtime";

describe("returning-user conversation priming", () => {
  it("pre-call loader includes prior non-interrupted exchanges in the next LLM history", async () => {
    const memory = createInMemoryMemory();
    const userId = "user-1" as UserId;
    await memory.put({ scope: "user", userId }, "exchange:seed:1", "raw", {
      user: "My name is Ada.",
      assistant: "Nice to meet you, Ada.",
    });

    // Drive the runtime's pre-call loader to build a MemoryContext, then feed
    // it into ConversationPolicy. The policy's system prompt should include
    // the prior exchange as a <memory> block.
    const runtime = createRuntime({ memory });
    await runtime.start();
    const attachment = await runtime.startAttachedSession(buildTestAgent(), {
      channel: "simulated",
      memoryUserId: userId,
    });
    const policy = new ConversationPolicy({
      agent: buildTestAgent(),
      ...(attachment.preCallContext
        ? {
            preCallContext: {
              memory: attachment.preCallContext.memory,
              static: new Map(),
              resolvedAtMs: attachment.preCallContext.resolvedAtMs,
              degraded: {
                memory: attachment.preCallContext.degraded.memory,
                static: attachment.preCallContext.degraded.static,
              },
            },
          }
        : {}),
    });
    const messages = policy.messagesForTranscript("What is my name?");
    const systemContent = messages.find((m) => m.role === "system")?.content;
    expect(systemContent).toBeDefined();
    expect(String(systemContent)).toContain("Ada");
    expect(String(systemContent)).toContain("Nice to meet you, Ada");
    await attachment.detach();
    await runtime.stop();
  });

  it("keeps each exchange addressable when two turns are written", async () => {
    let nowMs = 0;
    const memory = createInMemoryMemory({ now: () => new Date(++nowMs) });
    const userId = "user-2" as UserId;
    await memory.put({ scope: "user", userId }, "exchange:session-a:turn-1", "raw", {
      user: "I prefer tea.",
      assistant: "I will remember that.",
    });
    await memory.put({ scope: "user", userId }, "exchange:session-a:turn-2", "raw", {
      user: "Actually, coffee.",
      assistant: "Coffee it is.",
    });

    const entries = await memory.list(
      { scope: "user", userId },
      { prefix: "exchange:session-a:", kind: "raw" },
    );
    expect(entries.map((entry) => entry.value)).toEqual([
      { user: "Actually, coffee.", assistant: "Coffee it is." },
      { user: "I prefer tea.", assistant: "I will remember that." },
    ]);
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
