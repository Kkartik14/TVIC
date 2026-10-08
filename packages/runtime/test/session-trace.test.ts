import { describe, expect, it } from "vitest";
import type { SessionEndEvent } from "@tvic/core";

import { toRuntimeSessionTrace } from "../src/session-trace.js";

const timestamp = "2026-09-28T10:00:00.000Z" as never;
const secret = "trace-private-content-sentinel";
const privateToolName = "lookup_customer_ssn";
const nestedProjectionSentinel = "trace-extra-field-sentinel";

describe("metadata-only session trace", () => {
  it("projects correlation and terminal facts while excluding content-bearing fields", () => {
    const session = {
      id: "session_opaque_1" as never,
      callId: "call_opaque_1" as never,
      agentId: "agent_opaque_1" as never,
      status: "failed" as const,
      terminalSource: "provider_runtime" as const,
      channel: "web_audio" as const,
      memoryRefs: [],
      metadata: { privateValue: secret },
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
      state: {
        variables: { privateValue: secret },
        pendingToolCallIds: [],
        turnSequence: 1,
      },
      error: {
        name: "ProviderError" as const,
        code: "provider.upstream_failed",
        category: "provider" as const,
        message: secret,
        retriable: true,
        provider: "private-provider-detail",
        metadata: { privateValue: secret },
      },
    };
    const event: SessionEndEvent = {
      session,
      snapshot: {
        session,
        turns: [
          {
            id: "turn_opaque_1" as never,
            sessionId: session.id,
            sequence: 1,
            status: "failed",
            input: { transcript: secret, mediaEventIds: [], metadata: { privateValue: secret } },
            output: {
              text: secret,
              mediaEventIds: [],
              metadata: { privateValue: secret },
              delivery: {
                audio: "playout_unconfirmed",
                text: "transport_accepted",
                privateDiagnostic: nestedProjectionSentinel,
              } as never,
            },
            toolCallIds: ["tool_call_opaque_1" as never],
            startedAt: timestamp,
            endedAt: timestamp,
            latency: {
              firstAudioMs: 123,
              totalMs: 456,
              privateDiagnostic: nestedProjectionSentinel,
            } as never,
            metadata: { privateValue: secret },
            error: {
              name: "ProviderError",
              code: "provider.upstream_failed",
              category: "provider",
              message: secret,
              retriable: true,
              provider: "private-provider-detail",
              metadata: { privateValue: secret },
            },
          },
        ],
        toolCalls: [
          {
            toolCallId: "tool_call_opaque_1" as never,
            toolId: privateToolName as never,
            toolName: secret as never,
            sessionId: session.id,
            turnId: "turn_opaque_1" as never,
            input: { privateValue: secret },
            output: { privateValue: secret },
            attempts: 1,
            status: "succeeded",
            queuedAt: timestamp,
            startedAt: timestamp,
            endedAt: timestamp,
            metadata: { privateValue: secret },
          },
        ],
      },
      snapshotStatus: "available",
      finalMemorySnapshot: {
        user: new Map([
          [
            "private-memory-key",
            {
              id: "memory_entry_1" as never,
              ref: { scope: "user", userId: "user_opaque_1" as never },
              key: "private-memory-key",
              kind: "fact",
              value: secret,
              version: 1,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        ]),
      },
      memoryFinalization: { status: "skipped" },
      wallClockMs: Date.parse(timestamp),
    };

    const trace = toRuntimeSessionTrace(event);
    const serialized = JSON.stringify(trace);

    expect(trace.turns[0]?.latency).not.toBe(event.snapshot.turns[0]?.latency);
    expect(trace.turns[0]?.delivery).not.toBe(event.snapshot.turns[0]?.output.delivery);

    expect(trace).toMatchObject({
      schemaVersion: 1,
      privacy: { classification: "metadata_only" },
      session: {
        id: "session_opaque_1",
        callId: "call_opaque_1",
        status: "failed",
        terminalSource: "provider_runtime",
        error: { code: "provider.upstream_failed", category: "provider", retriable: true },
      },
      snapshot: { status: "available", turnCount: 1, toolCallCount: 1 },
      turns: [
        {
          id: "turn_opaque_1",
          latency: { firstAudioMs: 123, totalMs: 456 },
          delivery: { audio: "playout_unconfirmed", text: "transport_accepted" },
          error: { code: "provider.upstream_failed", category: "provider", retriable: true },
        },
      ],
      toolCalls: [
        {
          id: "tool_call_opaque_1",
          turnId: "turn_opaque_1",
          status: "succeeded",
          attempts: 1,
        },
      ],
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(privateToolName);
    expect(serialized).not.toContain(nestedProjectionSentinel);
    expect(serialized).not.toContain("private-provider-detail");
    expect(serialized).not.toContain("private-memory-key");
  });
});
