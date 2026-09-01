import { describe, expect, it } from "vitest";
import { createInMemoryMemory } from "@tvic/dal";
import type { SessionEndEvent, UserId } from "@tvic/core";

import { buildDeterministicSummarizer } from "../src/agent.js";

describe("post-call summarization", () => {
  it("summarizer builds a stable summary from the event", async () => {
    const summarizer = buildDeterministicSummarizer();
    const memory = createInMemoryMemory();
    const userId = "user-1" as UserId;
    const event: SessionEndEvent = {
      session: {
        id: "sess-1" as never,
        agentId: "agent-1" as never,
        status: "completed",
        channel: "simulated",
        memoryRefs: [],
        createdAt: "2026-08-29T00:00:00.000Z" as never,
        startedAt: "2026-08-29T00:00:00.000Z" as never,
        endedAt: "2026-08-29T00:00:01.000Z" as never,
        state: {
          variables: {},
          pendingToolCallIds: [],
          turnSequence: 1,
        },
      },
      snapshot: {
        session: {
          id: "sess-1" as never,
          agentId: "agent-1" as never,
          status: "completed",
          channel: "simulated",
          memoryRefs: [],
          createdAt: "2026-08-29T00:00:00.000Z" as never,
          startedAt: "2026-08-29T00:00:00.000Z" as never,
          endedAt: "2026-08-29T00:00:01.000Z" as never,
          state: {
            variables: {},
            pendingToolCallIds: [],
            turnSequence: 1,
          },
        },
        turns: [],
        toolCalls: [],
      },
      finalMemorySnapshot: {},
      memoryFinalization: { status: "completed", deletedEntries: 0 },
      wallClockMs: 1,
    };
    const result = await summarizer(event);
    expect(result.summary).toContain("sess-1");
    expect(result.facts).toEqual(["sessionId=sess-1", "turnCount=0"]);
    await memory.put({ scope: "user", userId }, "call_summary", "summary", result.summary);
    const written = await memory.get({ scope: "user", userId }, "call_summary", "summary");
    expect(written?.value).toBe(result.summary);
  });
});
