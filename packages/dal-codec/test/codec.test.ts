import { describe, expect, it } from "vitest";
import type { AgentId, SessionId, Timestamp, TurnId } from "@tvic/core";

import {
  CorruptRecordError,
  decodeStoredSession,
  decodeStoredTurn,
  encodeStoredSession,
  encodeStoredTurn,
  serializeJsonValue,
  stableStringify,
} from "../src/index.js";

const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;

describe("durable codecs", () => {
  it("round-trips active session and interrupted turn envelopes", () => {
    const session = {
      session: {
        id: "session_codec" as SessionId,
        agentId: "agent_codec" as AgentId,
        status: "active" as const,
        channel: "simulated" as const,
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 1 },
      },
      runtime: { monotonicStartedAtMs: 10, clockEpoch: 2 },
    };
    const turn = {
      turn: {
        id: "turn_codec" as TurnId,
        sessionId: session.session.id,
        sequence: 1,
        status: "interrupted" as const,
        input: { transcript: "hello", mediaEventIds: [] },
        output: { text: "hi", mediaEventIds: [] },
        toolCallIds: [],
        startedAt: timestamp,
        latency: { recoveryGapMs: 12 },
      },
      runtime: { monotonicStartedAtMs: 11, recoveryGapMs: 12 },
    };
    expect(decodeStoredSession(encodeStoredSession(session), "session_codec")).toEqual(session);
    expect(decodeStoredTurn(encodeStoredTurn(turn), "turn_codec")).toEqual(turn);
  });

  it("rejects malformed and future envelopes at the storage boundary", () => {
    expect(() => decodeStoredSession("{", "session_bad")).toThrow(CorruptRecordError);
    expect(() =>
      decodeStoredSession(
        JSON.stringify({
          kind: "session",
          schemaVersion: 99,
          payload: {},
        }),
        "session_future",
      ),
    ).toThrow(/unsupported schema version/);
    expect(() =>
      decodeStoredTurn(
        JSON.stringify({
          kind: "turn",
          schemaVersion: 1,
          payload: {
            id: "turn_bad",
            sessionId: "session_bad",
            sequence: 1,
            status: "cancelled",
            reason: "invented_reason",
            input: { mediaEventIds: [] },
            output: { mediaEventIds: [] },
            toolCallIds: [],
            startedAt: timestamp,
            endedAt: timestamp,
            latency: {},
          },
          runtime: { monotonicStartedAtMs: 0 },
        }),
        "turn_bad_reason",
      ),
    ).toThrow(/payload failed domain validation/);
  });

  it("rejects malformed optional domain and runtime fields instead of dropping them", () => {
    const session = {
      kind: "session",
      schemaVersion: 1,
      payload: {
        id: "session_bad_fields",
        agentId: "agent_codec",
        status: "active",
        channel: "simulated",
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: "not-an-object", pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 1, lastActivityWallAtMs: "not-a-number" },
    };
    expect(() => decodeStoredSession(session, "session_bad_fields")).toThrow(
      /payload failed domain validation/,
    );
    const validSession = {
      ...session,
      payload: {
        ...session.payload,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
    };
    expect(() => decodeStoredSession(validSession, "session_bad_runtime")).toThrow(
      /invalid session runtime metadata/,
    );

    const turn = {
      kind: "turn",
      schemaVersion: 1,
      payload: {
        id: "turn_bad_fields",
        sessionId: "session_bad_fields",
        sequence: 1,
        status: "started",
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: "not-an-array",
        startedAt: timestamp,
        latency: { totalMs: "not-a-number" },
      },
      runtime: { monotonicStartedAtMs: 1, recoveryGapMs: -1 },
    };
    expect(() => decodeStoredTurn(turn, "turn_bad_fields")).toThrow(
      /payload failed domain validation/,
    );

    const validTurn = {
      ...turn,
      payload: { ...turn.payload, toolCallIds: [], latency: {} },
      runtime: { monotonicStartedAtMs: 1, recoveryGapMs: "not-a-number" },
    };
    expect(() => decodeStoredTurn(validTurn, "turn_bad_runtime")).toThrow(
      /invalid turn runtime metadata/,
    );
  });

  it("round-trips the persistence-local aggregate version", () => {
    const record = {
      session: {
        id: "session_versioned" as SessionId,
        agentId: "agent_codec" as AgentId,
        status: "active" as const,
        channel: "simulated" as const,
        memoryRefs: [],
        createdAt: timestamp,
        startedAt: timestamp,
        state: { variables: {}, pendingToolCallIds: [], turnSequence: 0 },
      },
      runtime: { monotonicStartedAtMs: 1 },
      version: 7,
    };
    expect(decodeStoredSession(encodeStoredSession(record), "session_versioned")).toEqual(record);
  });

  it("rejects cyclic values instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => stableStringify(cyclic)).toThrow(/cyclic value/);
  });

  it("rejects non-JSON values at the adapter boundary", () => {
    class CustomValue {
      readonly value = 1;
    }

    const invalidValues: unknown[] = [
      undefined,
      () => undefined,
      Symbol("value"),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(),
      new Date("invalid"),
      new Map(),
      new Set(),
      new CustomValue(),
      { nested: undefined },
      [undefined],
    ];

    for (const value of invalidValues) {
      expect(() => serializeJsonValue(value)).toThrow();
    }

    const shared = { value: 1 };
    expect(serializeJsonValue({ first: shared, second: shared })).toBe(
      '{"first":{"value":1},"second":{"value":1}}',
    );
  });
});
