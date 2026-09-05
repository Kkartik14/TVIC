import { describe, expect, it } from "vitest";

import {
  internalError,
  isTerminalSession,
  isTerminalTurn,
  terminalSessionFromRequest,
  terminalTurnFromRequest,
  type ActiveTurn,
  type AgentId,
  type NormalizedError,
  type SessionId,
  type InputMediaEvent,
  type MediaEventId,
  type TerminalSessionDraft,
  type Timestamp,
  type TurnId,
} from "../src/index.js";

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;
const error: NormalizedError = internalError("test.failed", "failed");

const sessionDraft: TerminalSessionDraft = {
  id: "session_domain" as SessionId,
  agentId: "agent_domain" as AgentId,
  channel: "simulated",
  memoryRefs: [],
  createdAt: timestamp,
  startedAt: timestamp,
  endedAt: timestamp,
  state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
};

const activeTurn: ActiveTurn = {
  id: "turn_domain" as TurnId,
  sessionId: "session_domain" as SessionId,
  sequence: 1,
  status: "thinking",
  input: { transcript: "book a table", mediaEventIds: [] },
  output: { mediaEventIds: [] },
  toolCallIds: [],
  startedAt: timestamp,
  latency: { firstTokenMs: 50 },
};

describe("domain transitions", () => {
  it("keeps explicit turn commit and interruption as exhaustive input events", () => {
    const base = {
      id: "media_control" as MediaEventId,
      sessionId: "session_domain" as SessionId,
      sequence: 1,
      direction: "input" as const,
      timestamp,
      monotonicOffsetMs: 0,
    };
    const events = [
      { ...base, type: "media.turn.commit_requested" as const },
      { ...base, type: "media.interrupt.requested" as const },
    ] satisfies readonly InputMediaEvent[];

    expect(events.map((event) => event.type)).toEqual([
      "media.turn.commit_requested",
      "media.interrupt.requested",
    ]);
  });

  it("derives terminal sessions from end-session requests", () => {
    const completed = terminalSessionFromRequest(sessionDraft, { reason: "completed" });
    const cancelled = terminalSessionFromRequest(sessionDraft, {
      reason: "cancelled",
      cancelReason: "caller_hangup",
    });
    const failed = terminalSessionFromRequest(sessionDraft, { reason: "failed", error });
    const timedOut = terminalSessionFromRequest(sessionDraft, { reason: "timeout", error });

    expect(completed.status).toBe("completed");
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "caller_hangup" });
    expect(failed).toMatchObject({ status: "failed", error });
    expect(timedOut).toMatchObject({ status: "failed", error });
    expect(isTerminalSession(completed)).toBe(true);
  });

  it("derives terminal turns while preserving input and latency", () => {
    const completed = terminalTurnFromRequest(
      activeTurn,
      {
        reason: "completed",
        output: { text: "confirmed", mediaEventIds: [] },
        latency: { firstAudioMs: 120 },
      },
      timestamp,
      240,
    );
    const cancelled = terminalTurnFromRequest(
      activeTurn,
      { reason: "cancelled", cancelReason: "barge_in" },
      timestamp,
      80,
    );
    const failed = terminalTurnFromRequest(activeTurn, { reason: "failed", error }, timestamp, 90);

    expect(completed).toMatchObject({
      status: "completed",
      input: activeTurn.input,
      output: { text: "confirmed" },
      latency: { firstTokenMs: 50, firstAudioMs: 120, totalMs: 240 },
    });
    expect(cancelled).toMatchObject({ status: "cancelled", reason: "barge_in" });
    expect(failed).toMatchObject({ status: "failed", error });
    expect(isTerminalTurn(completed)).toBe(true);
    expect(isTerminalTurn(activeTurn)).toBe(false);
  });
});
