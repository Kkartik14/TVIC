import { describe, expect, it } from "vitest";

import type {
  CorrelationId,
  SessionId,
  SpanId,
  Timestamp,
  TraceEvent,
  TraceEventId,
  TraceId,
  TurnId,
} from "@tvic/core";

import { deriveCallTimeline } from "../src/index.js";

const SESSION = "session_a" as SessionId;
const TRACE = "trace_a" as TraceId;
const TURN = "turn_1" as TurnId;
const TS = "2026-05-20T00:00:00.000Z" as Timestamp;

let eventSeq = 0;

function event(
  spanId: string,
  offsetMs: number,
  fields: Record<string, unknown>,
  turnId: TurnId | undefined = TURN,
): TraceEvent {
  eventSeq += 1;
  return {
    id: `evt_${eventSeq}` as TraceEventId,
    traceId: TRACE,
    sessionId: SESSION,
    timestamp: TS,
    monotonicOffsetMs: offsetMs,
    spanId: spanId as SpanId,
    correlationId: "corr_1" as CorrelationId,
    ...(turnId ? { turnId } : {}),
    ...fields,
  } as TraceEvent;
}

describe("deriveCallTimeline", () => {
  it("derives spans, transcript, response, and latency metrics for a turn", () => {
    const events: TraceEvent[] = [
      event("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }),
      event("s_stt", 100, {
        type: "stt.final",
        status: "succeeded",
        text: "book a table",
        durationMs: 0,
      }),
      event("s_llm", 110, { type: "llm.started", status: "started", model: "m" }),
      event("s_llm", 180, { type: "llm.token", status: "in_progress", text: "Sure" }),
      event("s_llm", 200, { type: "llm.token", status: "in_progress", text: " thing" }),
      event("s_llm", 230, {
        type: "llm.completed",
        status: "succeeded",
        model: "m",
        durationMs: 120,
      }),
      event("s_tts", 240, { type: "tts.started", status: "started" }),
      event("s_tts", 360, {
        type: "tts.chunk",
        status: "in_progress",
        mediaEventId: "me_1",
        frameCount: 320,
        durationMs: 20,
      }),
      event("s_audio", 365, {
        type: "audio.output.chunk",
        status: "in_progress",
        mediaEventId: "me_1",
        frameCount: 320,
        durationMs: 20,
      }),
      event("s_turn", 600, { type: "turn.ended", status: "succeeded", durationMs: 500 }),
    ];

    const timeline = deriveCallTimeline(events);
    expect(timeline.turns).toHaveLength(1);
    const turn = timeline.turns[0]!;

    expect(turn.status).toBe("completed");
    expect(turn.transcript).toBe("book a table");
    expect(turn.response).toBe("Sure thing");
    expect(turn.interrupted).toBe(false);
    expect(turn.spans.map((span) => span.kind).sort()).toEqual([
      "audio.output",
      "llm",
      "stt",
      "tts",
      "turn",
    ]);

    expect(turn.metrics.endOfUtteranceMs).toBe(100);
    expect(turn.metrics.ttftMs).toBe(80); // 180 - 100
    expect(turn.metrics.ttfbMs).toBe(120); // 360 - 240
    expect(turn.metrics.responseLatencyMs).toBe(265); // 365 - 100
  });

  it("reports turn totalMs from the stamped end offset (no double-count)", () => {
    const turnId = "turn_dur" as TurnId;
    const events: TraceEvent[] = [
      event("s_t", 0, { type: "turn.started", status: "started", sequence: 1 }, turnId),
      event("s_t", 600, { type: "turn.ended", status: "succeeded", durationMs: 600 }, turnId),
    ];
    const turn = deriveCallTimeline(events).turns[0]!;
    expect(turn.endMs).toBe(600);
    expect(turn.metrics.totalMs).toBe(600);
  });

  it("marks interruptions at detection time, with cancellation frames as outcome", () => {
    const turnId = "turn_2" as TurnId;
    const events: TraceEvent[] = [
      event("s_turn2", 0, { type: "turn.started", status: "started", sequence: 1 }, turnId),
      event(
        "s_stt2",
        50,
        { type: "stt.final", status: "succeeded", text: "wait", durationMs: 0 },
        turnId,
      ),
      event(
        "s_int2",
        260,
        { type: "interrupt.detected", status: "succeeded", cause: "barge_in" },
        turnId,
      ),
      event(
        "s_out2",
        300,
        { type: "output.cancelled", status: "cancelled", framesSent: 7, durationMs: 40 },
        turnId,
      ),
      event(
        "s_turn2",
        320,
        { type: "turn.ended", status: "cancelled", durationMs: 320, reason: "barge_in" },
        turnId,
      ),
    ];

    const timeline = deriveCallTimeline(events);
    const turn = timeline.turns[0]!;
    expect(turn.status).toBe("cancelled");
    expect(turn.interrupted).toBe(true);
    expect(turn.interruptions).toHaveLength(1);
    expect(turn.interruptions[0]?.atMs).toBe(260); // detection time, not cancellation (300)
    expect(turn.interruptions[0]?.framesSent).toBe(7); // outcome from output.cancelled
    expect(timeline.interruptions).toBe(1);
  });
});
