import { describe, expect, it } from "vitest";

import type { AgentId, CorrelationId, SessionId, SpanId, Timestamp, TraceId } from "@tvic/core";

import {
  createInMemorySessionStore,
  createInMemoryTraceStore,
  createInMemoryTurnStore,
} from "../src/index.js";

describe("in-memory DAL stores", () => {
  it("persists session runtime metadata with the session record", async () => {
    const store = createInMemorySessionStore();
    const sessionId = "session_dal" as SessionId;

    await store.put({
      session: {
        id: sessionId,
        agentId: "agent_dal" as AgentId,
        status: "active",
        channel: "simulated",
        traceId: "trace_dal" as TraceId,
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: {
        monotonicStartedAtMs: 10,
        spanId: "span_dal" as SpanId,
        correlationId: "correlation_dal" as CorrelationId,
        traceExporters: [],
      },
    });

    await store.update(sessionId, (record) => ({
      ...record,
      session: { ...record.session, status: "interrupted" } as typeof record.session,
    }));

    await expect(store.get(sessionId)).resolves.toMatchObject({
      session: { status: "interrupted" },
      runtime: { monotonicStartedAtMs: 10, spanId: "span_dal" },
    });
  });

  it("lists turns by session without leaking other sessions", async () => {
    const store = createInMemoryTurnStore();

    await store.put({
      turn: {
        id: "turn_1" as never,
        sessionId: "session_a" as SessionId,
        sequence: 1,
        status: "started",
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [],
        interruptionRefs: [],
        startedAt: timestamp,
        latency: {},
      },
      runtime: {
        monotonicStartedAtMs: 20,
        spanId: "span_turn" as SpanId,
        correlationId: "correlation_turn" as CorrelationId,
      },
    });

    await expect(store.listBySession("session_a" as SessionId)).resolves.toHaveLength(1);
    await expect(store.listBySession("session_b" as SessionId)).resolves.toHaveLength(0);
  });

  it("queries traces by session", async () => {
    const store = createInMemoryTraceStore();

    await store.append({
      id: "trace_event_dal" as never,
      traceId: "trace_dal" as TraceId,
      sessionId: "session_dal" as SessionId,
      timestamp,
      monotonicOffsetMs: 0,
      spanId: "span_dal" as SpanId,
      correlationId: "correlation_dal" as CorrelationId,
      type: "session.started",
      status: "succeeded",
    });

    await expect(store.query({ sessionId: "session_dal" as SessionId })).resolves.toHaveLength(1);
    await expect(store.query({ sessionId: "session_other" as SessionId })).resolves.toHaveLength(0);
  });
});

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
