import { describe, expect, it } from "vitest";

import type { AgentId, SessionId, Timestamp, TraceEvent, TraceEventId, TraceId } from "@tvic/core";

import { createInMemoryTraceStore, traceTypes } from "../src/index.js";

function sessionCreated(id: string, sessionId: string): TraceEvent {
  return {
    id: id as TraceEventId,
    traceId: "trace_1" as TraceId,
    sessionId: sessionId as SessionId,
    timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
    type: "session.created",
    status: "succeeded",
    agentId: "agent_1" as AgentId,
  };
}

describe("InMemoryTraceStore", () => {
  it("queries by session and type", async () => {
    const store = createInMemoryTraceStore();
    const first = sessionCreated("event_1", "session_1");
    const second = sessionCreated("event_2", "session_2");

    await store.append(first);
    await store.append(second);

    const events = await store.query({
      sessionId: "session_1" as SessionId,
      types: ["session.created"],
    });

    expect(events).toEqual([first]);
    expect(traceTypes(events)).toEqual(["session.created"]);
  });
});
