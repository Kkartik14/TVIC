import { describe, expect, it } from "vitest";

import { isNormalizedError, normalizedError } from "../src/index.js";
import type {
  AgentId,
  CorrelationId,
  SessionId,
  SpanId,
  Timestamp,
  TraceEvent,
  TraceEventId,
  TraceId,
  TurnId,
} from "../src/index.js";

const traceCore = {
  id: "trace_event_1" as TraceEventId,
  traceId: "trace_1" as TraceId,
  sessionId: "session_1" as SessionId,
  timestamp: "2026-05-20T00:00:00.000Z" as Timestamp,
  monotonicOffsetMs: 42,
  spanId: "span_1" as SpanId,
  correlationId: "correlation_1" as CorrelationId,
};

describe("v0.3 contracts", () => {
  it("requires trace events to carry explicit span and monotonic timing fields", () => {
    const event: TraceEvent = {
      ...traceCore,
      type: "session.created",
      status: "succeeded",
      agentId: "agent_1" as AgentId,
    };

    expect(event.spanId).toBe("span_1");
    expect(event.correlationId).toBe("correlation_1");
    expect(event.monotonicOffsetMs).toBe(42);
  });

  it("models turn brackets as first-class trace events", () => {
    const started: TraceEvent = {
      ...traceCore,
      type: "turn.started",
      status: "started",
      turnId: "turn_1" as TurnId,
      sequence: 1,
    };
    const ended: TraceEvent = {
      ...traceCore,
      id: "trace_event_2" as TraceEventId,
      type: "turn.ended",
      status: "succeeded",
      turnId: "turn_1" as TurnId,
      durationMs: 100,
    };

    expect([started.type, ended.type]).toEqual(["turn.started", "turn.ended"]);
    expect(started.spanId).toBe(ended.spanId);
  });
});

describe("error boundary guards", () => {
  it("accepts only structurally complete NormalizedError values with known categories", () => {
    expect(isNormalizedError(normalizedError("x", "message", { category: "provider" }))).toBe(true);
    expect(
      isNormalizedError({
        code: "x",
        category: "made_up",
        message: "message",
        retriable: false,
      }),
    ).toBe(false);
    expect(
      isNormalizedError({
        code: "x",
        category: "provider",
        message: "message",
        retriable: false,
        metadata: "not-an-object",
      }),
    ).toBe(false);
  });
});
