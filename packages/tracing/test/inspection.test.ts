import { describe, expect, it } from "vitest";

import type {
  CallArtifactManifest,
  CallId,
  CorrelationId,
  SessionId,
  SpanId,
  Timestamp,
  TraceEvent,
  TraceEventId,
  TraceId,
  TurnId,
} from "@tvic/core";

import { deriveCallInspection, parseTraceJsonl } from "../src/index.js";

const SESSION = "session_a" as SessionId;
const TRACE = "trace_a" as TraceId;
const TS = "2026-05-20T00:00:00.000Z" as Timestamp;

let seq = 0;

/** Builds a single crafted trace event (analyzer-only fragment). */
function ev(
  spanId: string,
  offsetMs: number,
  fields: Record<string, unknown>,
  turnId?: string,
  parentSpanId?: string,
): TraceEvent {
  seq += 1;
  return {
    id: `evt_${seq}` as TraceEventId,
    traceId: TRACE,
    sessionId: SESSION,
    timestamp: TS,
    monotonicOffsetMs: offsetMs,
    spanId: spanId as SpanId,
    correlationId: "corr" as CorrelationId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    ...(parentSpanId ? { parentSpanId: parentSpanId as SpanId } : {}),
    ...fields,
  } as TraceEvent;
}

const T = "turn_1";

function manifest(overrides: Partial<CallArtifactManifest> = {}): CallArtifactManifest {
  return {
    version: "0.1.0",
    callId: "call_x" as CallId,
    sessionId: SESSION,
    traceId: TRACE,
    createdAt: TS,
    updatedAt: TS,
    files: {
      trace: "call.jsonl",
      inputAudio: "input.pcm",
      outputAudio: "output.pcm",
      manifest: "manifest.json",
    },
    privacy: { consentMode: "record", persistAudio: true, redactPii: false },
    payloads: [],
    writeFailures: 0,
    ...overrides,
  };
}

describe("deriveCallInspection", () => {
  it("derives a completed turn with latency breakdown; endpoint is unavailable", () => {
    const events: TraceEvent[] = [
      ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" }),
      ev("s_sess", 0, { type: "session.started", status: "succeeded" }),
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        100,
        { type: "stt.final", status: "succeeded", text: "book a table", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev("s_llm", 110, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev("s_llm", 170, { type: "llm.token", status: "in_progress", text: "Sure" }, T, "s_ctrl"),
      ev(
        "s_llm",
        200,
        { type: "llm.completed", status: "succeeded", model: "m", durationMs: 90 },
        T,
        "s_ctrl",
      ),
      ev("s_tts", 210, { type: "tts.started", status: "started" }, T, "s_ctrl"),
      ev(
        "s_tts",
        250,
        {
          type: "tts.chunk",
          status: "in_progress",
          mediaEventId: "me_1",
          frameCount: 320,
          durationMs: 20,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        255,
        {
          type: "audio.output.chunk",
          status: "in_progress",
          mediaEventId: "me_1",
          frameCount: 320,
          durationMs: 20,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        360,
        { type: "audio.output.ended", status: "succeeded", durationMs: 100 },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 400, { type: "turn.ended", status: "succeeded", durationMs: 400 }, T, "s_sess"),
      ev("s_sess", 410, { type: "session.completed", status: "succeeded", durationMs: 410 }),
    ];

    const call = deriveCallInspection(events, {
      inputTrackAvailable: true,
      outputTrackAvailable: true,
    });

    expect(call.status).toBe("completed");
    expect(call.turns).toHaveLength(1);
    const turn = call.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.callerText).toBe("book a table");
    expect(turn.agentText).toBe("Sure");
    expect(turn.failure).toBeUndefined();

    const l = turn.latency;
    expect(l.endpointMs).toBeNull();
    expect(l.endpointAvailable).toBe(false);
    expect(l.warnings.some((w) => w.includes("endpoint"))).toBe(true);
    expect(l.llmTtftMs).toBe(70); // 170 - 100
    expect(l.ttsTtfbMs).toBe(40); // 250 - 210
    expect(l.firstAudioMs).toBe(155); // 255 - 100 (EOU -> first audio)
    expect(l.playoutMs).toBe(100);
    expect(l.turnTags).toContain("completed");
    expect(l.bottleneck).toBeDefined();

    expect(turn.playout.state).toBe("heard");
    expect(call.summary.completedTurns).toBe(1);
    expect(call.summary.averageResponseLatencyMs).toBe(155);
    expect(call.summary.slowestTurnId).toBe(T);
    expect(call.degraded).toBe(false);
  });

  it("treats a recovered tool failure as an incident, not a terminal failure", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        100,
        { type: "stt.final", status: "succeeded", text: "table for two", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev("s_llm1", 110, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev(
        "s_tool",
        120,
        {
          type: "tool.started",
          status: "in_progress",
          toolId: "t",
          toolName: "check_availability",
          toolCallId: "tc_1",
          attempt: 1,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_tool",
        150,
        {
          type: "tool.failed",
          status: "failed",
          toolId: "t",
          toolName: "check_availability",
          toolCallId: "tc_1",
          attempt: 1,
          durationMs: 30,
          error: {
            code: "tool.execution_failed",
            category: "tool",
            message: "boom",
            retriable: false,
          },
        },
        T,
        "s_ctrl",
      ),
      ev("s_llm2", 160, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev(
        "s_llm2",
        175,
        { type: "llm.token", status: "in_progress", text: "Sorry, try again" },
        T,
        "s_ctrl",
      ),
      ev(
        "s_llm2",
        200,
        { type: "llm.completed", status: "succeeded", model: "m", durationMs: 40 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        255,
        {
          type: "audio.output.chunk",
          status: "in_progress",
          mediaEventId: "me",
          frameCount: 320,
          durationMs: 20,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        300,
        { type: "audio.output.ended", status: "succeeded", durationMs: 45 },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 320, { type: "turn.ended", status: "succeeded", durationMs: 320 }, T, "s_sess"),
    ];

    const turn = deriveCallInspection(events).turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.failure).toBeUndefined();
    expect(turn.incidents).toHaveLength(1);
    expect(turn.incidents[0]!.kind).toBe("tool_failed_recovered");
    expect(turn.tools[0]!.status).toBe("failed");
    // Two LLM passes; the second is post-tool and marked as recovering from the failure.
    expect(turn.latency.llmPasses).toHaveLength(2);
    expect(turn.latency.llmPasses[0]!.kind).toBe("initial");
    expect(turn.latency.llmPasses[1]!.kind).toBe("post_tool");
    expect(turn.latency.llmPasses[1]!.recoveredFromToolFailure).toBe(true);
    expect(turn.latency.turnTags).toContain("tool");
  });

  it("distinguishes input vs output tool validation incidents", () => {
    const base = (code: string): TraceEvent[] => [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "hi", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_tool",
        60,
        {
          type: "tool.failed",
          status: "failed",
          toolId: "t",
          toolName: "check",
          toolCallId: "tc",
          attempt: 1,
          durationMs: 5,
          error: { code, category: "validation", message: "bad", retriable: false },
        },
        T,
        "s_ctrl",
      ),
      ev("s_llm", 70, { type: "llm.token", status: "in_progress", text: "ok" }, T, "s_ctrl"),
      ev("s_turn", 100, { type: "turn.ended", status: "succeeded", durationMs: 100 }, T, "s_sess"),
    ];

    const input = deriveCallInspection(base("tool.input_validation_failed")).turns[0]!;
    expect(input.incidents[0]!.kind).toBe("tool_input_validation_failed");
    const output = deriveCallInspection(base("tool.output_validation_failed")).turns[0]!;
    expect(output.incidents[0]!.kind).toBe("tool_output_validation_failed");
  });

  it("derives a call-level failure from session.failed with no turn", () => {
    const events: TraceEvent[] = [
      ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" }),
      ev("s_sess", 0, { type: "session.started", status: "succeeded" }),
      ev("s_sess", 50, {
        type: "session.failed",
        status: "failed",
        durationMs: 50,
        error: {
          code: "stt.closed_unexpectedly",
          category: "internal",
          message: "stt died",
          retriable: false,
        },
      }),
    ];

    const call = deriveCallInspection(events);
    expect(call.status).toBe("failed");
    expect(call.turns).toHaveLength(0); // no fake turn
    expect(call.summary.primaryFailure?.kind).toBe("stt_closed_unexpectedly");
    expect(call.summary.primaryFailure?.category).toBe("provider");
    expect(call.summary.primaryFailure?.userFacingEffect.length).toBeGreaterThan(0);
  });

  it("classifies a barge-in cancelled turn as interrupted with sent-not-heard playout", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "wait", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        120,
        {
          type: "audio.output.chunk",
          status: "in_progress",
          mediaEventId: "me",
          frameCount: 320,
          durationMs: 20,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_int",
        260,
        { type: "interrupt.detected", status: "succeeded", cause: "barge_in" },
        T,
        "s_ctrl",
      ),
      ev(
        "s_int2",
        280,
        { type: "interrupt.handled", status: "succeeded", durationMs: 20, outputCancelled: true },
        T,
        "s_ctrl",
      ),
      ev(
        "s_out",
        300,
        { type: "output.cancelled", status: "cancelled", framesSent: 7, durationMs: 40 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        305,
        { type: "audio.output.ended", status: "cancelled", durationMs: 50 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_turn",
        320,
        { type: "turn.ended", status: "cancelled", durationMs: 320, reason: "barge_in" },
        T,
        "s_sess",
      ),
    ];

    const turn = deriveCallInspection(events, { outputTrackAvailable: true }).turns[0]!;
    expect(turn.status).toBe("cancelled");
    expect(turn.failure?.kind).toBe("interrupted");
    expect(turn.interruptions).toHaveLength(1);
    expect(turn.interruptions[0]!.framesSentBeforeCancel).toBe(7);
    expect(turn.interruptions[0]!.wasSpeaking).toBe(true);
    expect(turn.playout.state).toBe("cancelled");

    const heard = turn.replaySegments.find((s) => s.kind === "agent_heard")!;
    expect(heard.available).toBe(false); // sent, not confirmed heard
    const sent = turn.replaySegments.find((s) => s.kind === "agent_sent")!;
    expect(sent.available).toBe(true);
    expect(sent.startMs).toBe(120); // absolute call-clock offset (seek contract)
  });

  it("marks a not-heard cancel as playout_unconfirmed", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "book it", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        120,
        {
          type: "audio.output.chunk",
          status: "in_progress",
          mediaEventId: "me",
          frameCount: 320,
          durationMs: 20,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_audio",
        200,
        { type: "audio.output.ended", status: "cancelled", durationMs: 80 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_turn",
        220,
        { type: "turn.ended", status: "cancelled", durationMs: 220, reason: "not_heard" },
        T,
        "s_sess",
      ),
    ];

    const turn = deriveCallInspection(events).turns[0]!;
    expect(turn.status).toBe("cancelled");
    expect(turn.playout.state).toBe("unconfirmed");
    expect(turn.failure?.kind).toBe("playout_unconfirmed");
  });

  it("attaches turn-less memory.write and runtime.retry to their turn via parentSpanId", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "remember me", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      // runtime.retry + memory.write carry NO turnId; only parentSpanId === s_ctrl.
      ev(
        "s_retry",
        60,
        {
          type: "runtime.retry",
          status: "in_progress",
          operation: "tool:x",
          attempt: 2,
          delayMs: 0,
          cause: { code: "x", category: "tool", message: "transient", retriable: true },
        },
        undefined,
        "s_ctrl",
      ),
      ev(
        "s_mem",
        210,
        {
          type: "memory.write",
          status: "succeeded",
          memoryRef: { scope: "session", sessionId: SESSION },
          key: "exchanges",
          scope: "session",
          mode: "append",
        },
        undefined,
        "s_ctrl",
      ),
      ev("s_turn", 220, { type: "turn.ended", status: "succeeded", durationMs: 220 }, T, "s_sess"),
    ];

    const call = deriveCallInspection(events);
    expect(call.turns).toHaveLength(1);
    const turn = call.turns[0]!;
    expect(turn.memoryWrites).toHaveLength(1);
    expect(turn.memoryWrites[0]!.key).toBe("exchanges");
    expect(turn.incidents.some((i) => i.kind === "tool_retry")).toBe(true);
    expect(call.summary.retryCount).toBe(1);
  });

  it("tolerates malformed error/cause/privacy payloads without throwing", () => {
    const events: TraceEvent[] = [
      ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" }),
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      // core-valid envelope, but no `error` object on tool.failed and no `cause` on retry
      ev(
        "s_tool",
        60,
        {
          type: "tool.failed",
          status: "failed",
          toolId: "t",
          toolName: "a",
          toolCallId: "tc",
          attempt: 1,
          durationMs: 5,
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_retry",
        65,
        {
          type: "runtime.retry",
          status: "in_progress",
          operation: "tool:a",
          attempt: 2,
          delayMs: 0,
        },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 100, { type: "turn.ended", status: "succeeded", durationMs: 100 }, T, "s_sess"),
      // session.failed with no error payload
      ev("s_sess", 110, { type: "session.failed", status: "failed", durationMs: 110 }),
    ];

    const call = deriveCallInspection(events); // must not throw
    expect(call.status).toBe("failed");
    expect(call.summary.primaryFailure?.kind).toBe("runtime_error"); // coerced fallback
    const turn = call.turns[0]!;
    expect(turn.incidents.some((i) => i.kind === "tool_failed_recovered")).toBe(true);
    expect(turn.incidents.some((i) => i.kind === "tool_retry")).toBe(true);
  });

  it("normalizes a manifest missing its privacy block to safe defaults", () => {
    const events: TraceEvent[] = [
      ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" }),
      ev("s_sess", 10, { type: "session.completed", status: "succeeded", durationMs: 10 }),
    ];
    const badManifest = {
      version: "0.1.0",
      callId: "c",
      writeFailures: "oops",
      payloads: undefined,
    } as unknown as CallArtifactManifest;

    const call = deriveCallInspection(events, { manifest: badManifest }); // must not throw
    expect(call.recording.consentMode).toBe("unknown");
    expect(call.recording.persistAudio).toBe(false);
    expect(call.recording.redactPii).toBe(false);
  });

  it("flags degraded artifacts and surfaces recording mode from the manifest", () => {
    const events: TraceEvent[] = [
      ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" }),
      ev("s_sess", 10, { type: "session.completed", status: "succeeded", durationMs: 10 }),
    ];

    const degraded = deriveCallInspection(events, { manifestMissing: true });
    expect(degraded.degraded).toBe(true);
    expect(degraded.artifactWarnings.some((w) => w.toLowerCase().includes("manifest"))).toBe(true);

    const withFailures = deriveCallInspection(events, { manifest: manifest({ writeFailures: 3 }) });
    expect(withFailures.degraded).toBe(true);
    expect(withFailures.recording.consentMode).toBe("record");
    expect(withFailures.recording.persistAudio).toBe(true);

    const clean = deriveCallInspection(events, {
      manifest: manifest(),
      inputTrackAvailable: true,
      outputTrackAvailable: true,
    });
    expect(clean.degraded).toBe(false);
    expect(clean.recording.audioAvailable).toBe(true);
  });

  it("resolves evidence ids to display-safe evidence without raw trace payloads", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "hi", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_turn",
        100,
        {
          type: "turn.ended",
          status: "failed",
          durationMs: 100,
          error: { code: "turn.failed", category: "internal", message: "kaboom", retriable: false },
        },
        T,
        "s_sess",
      ),
    ];

    const call = deriveCallInspection(events);
    const turn = call.turns[0]!;
    expect(turn.failure?.kind).toBe("runtime_error");
    expect(turn.failure!.evidenceEventIds.length).toBeGreaterThan(0);
    for (const id of turn.failure!.evidenceEventIds) {
      const evidence = call.evidenceById[String(id)];
      expect(evidence).toBeDefined();
      expect(evidence!.eventId).toBe(id);
      expect(typeof evidence!.type).toBe("string");
    }
    // Display-safe: no raw transcript/text field is hydrated into the evidence map.
    for (const evidence of Object.values(call.evidenceById)) {
      expect("text" in evidence).toBe(false);
    }
    expect(call.rawEventCount).toBe(events.length);
  });

  it("marks only the post-tool pass that follows a tool failure as recovered (3 passes, mixed)", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev("s_llm1", 60, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev(
        "s_toolA",
        70,
        {
          type: "tool.failed",
          status: "failed",
          toolId: "t",
          toolName: "a",
          toolCallId: "tcA",
          attempt: 1,
          durationMs: 5,
          error: {
            code: "tool.execution_failed",
            category: "tool",
            message: "boom",
            retriable: false,
          },
        },
        T,
        "s_ctrl",
      ),
      ev("s_llm2", 80, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev("s_llm2", 85, { type: "llm.token", status: "in_progress", text: "retry" }, T, "s_ctrl"),
      ev(
        "s_toolB",
        100,
        {
          type: "tool.completed",
          status: "succeeded",
          toolId: "t",
          toolName: "b",
          toolCallId: "tcB",
          attempt: 1,
          durationMs: 5,
        },
        T,
        "s_ctrl",
      ),
      ev("s_llm3", 110, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev("s_llm3", 115, { type: "llm.token", status: "in_progress", text: "done" }, T, "s_ctrl"),
      ev("s_turn", 200, { type: "turn.ended", status: "succeeded", durationMs: 200 }, T, "s_sess"),
    ];

    const passes = deriveCallInspection(events).turns[0]!.latency.llmPasses;
    expect(passes).toHaveLength(3);
    expect(passes[0]!.kind).toBe("initial");
    expect(passes[1]!.recoveredFromToolFailure).toBe(true); // follows the failed tool
    expect(passes[2]!.recoveredFromToolFailure).toBe(false); // follows a SUCCEEDED tool
  });

  it("does not report a playout as heard when no audio frames were produced", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      // Malformed: a succeeded audio.output.ended with no preceding audio.output.chunk.
      ev(
        "s_audio",
        100,
        { type: "audio.output.ended", status: "succeeded", durationMs: 50 },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 120, { type: "turn.ended", status: "succeeded", durationMs: 120 }, T, "s_sess"),
    ];
    expect(deriveCallInspection(events).turns[0]!.playout.state).toBe("none");
  });

  it("uses llm.completed.text as the transcript when no tokens are streamed", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "hi", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev("s_llm", 60, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      // completed-only provider: text arrives on completion, no llm.token events.
      ev(
        "s_llm",
        100,
        {
          type: "llm.completed",
          status: "succeeded",
          model: "m",
          durationMs: 40,
          text: "All booked.",
        },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 150, { type: "turn.ended", status: "succeeded", durationMs: 150 }, T, "s_sess"),
    ];
    expect(deriveCallInspection(events).turns[0]!.agentText).toBe("All booked.");
  });

  it("marks a tool failure as unrecovered when the turn then fails", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev("s_llm", 60, { type: "llm.started", status: "started", model: "m" }, T, "s_ctrl"),
      ev(
        "s_tool",
        70,
        {
          type: "tool.failed",
          status: "failed",
          toolId: "t",
          toolName: "a",
          toolCallId: "tc",
          attempt: 1,
          durationMs: 5,
          error: {
            code: "tool.execution_failed",
            category: "tool",
            message: "boom",
            retriable: false,
          },
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_turn",
        100,
        {
          type: "turn.ended",
          status: "failed",
          durationMs: 100,
          error: {
            code: "turn.failed",
            category: "internal",
            message: "no recovery",
            retriable: false,
          },
        },
        T,
        "s_sess",
      ),
    ];
    const turn = deriveCallInspection(events).turns[0]!;
    expect(turn.status).toBe("failed");
    expect(turn.incidents.some((i) => i.kind === "tool_failed_unrecovered")).toBe(true);
    expect(turn.incidents.some((i) => i.kind === "tool_failed_recovered")).toBe(false);
  });

  it("does not crash on a rejected barge-in with a non-numeric confidence", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_brej",
        60,
        {
          type: "barge_in.rejected",
          status: "cancelled",
          confidence: "oops",
          reason: "below_echo_floor",
        },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 100, { type: "turn.ended", status: "succeeded", durationMs: 100 }, T, "s_sess"),
    ];
    const incident = deriveCallInspection(events).turns[0]!.incidents.find(
      (i) => i.kind === "rejected_barge_in",
    );
    expect(incident).toBeDefined();
    expect(incident!.message).toContain("0.00"); // defensive numeric formatting, not a crash
  });

  it("coerces malformed per-event numeric fields and ignores non-NormalizedError span error/metadata", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      // llm.failed with a string `error` and non-object `metadata` (corrupt artifact)
      ev(
        "s_llm",
        60,
        {
          type: "llm.failed",
          status: "failed",
          model: "m",
          durationMs: 5,
          error: "boom",
          metadata: "not-an-object",
        },
        T,
        "s_ctrl",
      ),
      ev(
        "s_int",
        110,
        { type: "interrupt.detected", status: "succeeded", cause: "barge_in" },
        T,
        "s_ctrl",
      ),
      // interrupt.handled.durationMs is a string — must coerce away, never store a string
      ev(
        "s_inth",
        120,
        { type: "interrupt.handled", status: "succeeded", durationMs: "50", outputCancelled: true },
        T,
        "s_ctrl",
      ),
      // framesSent is a string — must coerce to 0, never NaN
      ev(
        "s_out",
        130,
        { type: "output.cancelled", status: "cancelled", framesSent: "oops", durationMs: 10 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_turn",
        150,
        { type: "turn.ended", status: "cancelled", durationMs: 150, reason: "barge_in" },
        T,
        "s_sess",
      ),
    ];

    const turn = deriveCallInspection(events).turns[0]!;
    expect(turn.interruptions[0]!.framesSentBeforeCancel).toBe(0);
    expect(turn.interruptions[0]!.latencyMs).toBeUndefined(); // string "50" coerced away
    const llmSpan = turn.spans.find((s) => s.kind === "llm")!;
    expect(llmSpan.error).toBeUndefined(); // string error not attached as NormalizedError
    expect(llmSpan.metadata).toBeUndefined(); // non-object metadata ignored
  });

  it("reports status active for a started-but-unfinished session", () => {
    const events: TraceEvent[] = [
      ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" }),
      ev("s_sess", 0, { type: "session.started", status: "succeeded" }),
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      // no turn.ended and no terminal session event — the call is still in progress.
    ];
    expect(deriveCallInspection(events).status).toBe("active");
  });

  it("never lets a non-numeric durationMs corrupt latency metrics", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_stt",
        50,
        { type: "stt.final", status: "succeeded", text: "x", durationMs: 0 },
        T,
        "s_ctrl",
      ),
      ev(
        "s_tool",
        60,
        {
          type: "tool.completed",
          status: "succeeded",
          toolId: "t",
          toolName: "a",
          toolCallId: "tc",
          attempt: 1,
          durationMs: "30", // corrupt: a string where a number is expected
        },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 100, { type: "turn.ended", status: "succeeded", durationMs: 100 }, T, "s_sess"),
    ];
    const turn = deriveCallInspection(events).turns[0]!;
    expect(typeof turn.latency.toolMs === "string").toBe(false); // never "030"
    expect(turn.latency.toolMs).toBeUndefined(); // string → 0 → omitted
    expect(turn.tools[0]!.durationMs).toBeUndefined();
  });

  it("drops JSONL records with unknown trace type or status before analysis", () => {
    const valid = ev("s_sess", 0, { type: "session.created", status: "succeeded", agentId: "a" });
    const badType = { ...valid, id: "evt_bad_type", type: "made.up" };
    const badStatus = { ...valid, id: "evt_bad_status", status: "done" };
    const { events, dropped } = parseTraceJsonl(
      [valid, badType, badStatus].map((event) => JSON.stringify(event)).join("\n"),
    );
    expect(events).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("does not stringify malformed tool identity fields into undefined-looking UI data", () => {
    const events: TraceEvent[] = [
      ev("s_turn", 0, { type: "turn.started", status: "started", sequence: 1 }, T, "s_sess"),
      ev(
        "s_tool",
        10,
        {
          type: "tool.failed",
          status: "failed",
          toolId: "tool_1",
          toolCallId: 99,
          attempt: 0,
          durationMs: 5,
          error: {
            code: "tool.execution_failed",
            category: "tool",
            message: "bad identity",
            retriable: false,
          },
        },
        T,
        "s_ctrl",
      ),
      ev("s_turn", 20, { type: "turn.ended", status: "succeeded", durationMs: 20 }, T, "s_sess"),
    ];

    const turn = deriveCallInspection(events).turns[0]!;
    expect(turn.tools[0]!.toolName).toBe("(unknown tool)");
    expect(String(turn.tools[0]!.toolCallId)).toContain("evt_");
    expect(turn.tools[0]!.attempts).toBe(1);
    expect(turn.incidents[0]!.toolName).toBe("(unknown tool)");
    expect(turn.incidents[0]!.attempt).toBe(1);
  });
});
