import { describe, expect, it } from "vitest";

import type {
  IdGenerator,
  LlmInlineToolCall,
  QueuedToolCall,
  RunningToolCall,
  SessionId,
  ToolCallId,
  ToolDefinition,
  ToolId,
  ToolName,
  Turn,
  TurnId,
} from "@tvic/core";
import { InMemoryToolIdempotencyStore } from "@tvic/tools";

import { executePipelineToolCalls } from "../src/pipeline-tool-exec.js";
import type { VoiceEvent } from "../src/voice-event.js";

describe("pipeline tool result boundary", () => {
  it("detaches provider, event, and persistence inputs from the execution snapshot", async () => {
    const sessionId = "pipeline_snapshot_session" as SessionId;
    const turnId = "pipeline_snapshot_turn" as TurnId;
    const toolCallId = "pipeline_snapshot_call" as ToolCallId;
    const queuedAt = "2026-10-01T00:00:00.000Z" as QueuedToolCall["queuedAt"];
    const seen: number[] = [];
    const tool: ToolDefinition<{ id: number }, { readonly ok: boolean }> = {
      id: "pipeline_snapshot_tool" as ToolId,
      name: "pipeline_snapshot_tool" as ToolName,
      description: "Captures the persisted tool input.",
      version: "1.0.0",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "number" } },
      },
      outputSchema: { type: "object" },
      timeout: { timeoutMs: 1_000, onTimeout: "fail" },
      retry: {
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoff: "fixed",
        jitter: false,
      },
      idempotency: { enabled: false },
      async execute(input) {
        seen.push(input.id);
        return { ok: true };
      },
    };
    const running: RunningToolCall = {
      status: "running",
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId,
      turnId,
      input: { id: 1 },
      attempts: 1,
      queuedAt,
      startedAt: queuedAt,
    };
    const providerInput = { id: 1 };
    const eventInputs: unknown[] = [];
    let persistedInput: unknown;
    const call: LlmInlineToolCall = {
      callRef: "pipeline_snapshot_call_ref",
      toolName: tool.name,
      input: providerInput,
    };

    const result = await executePipelineToolCalls(
      {
        ids: { toolCall: () => toolCallId } as IdGenerator,
        monotonicMs: () => 1,
        sessionId,
        lease: undefined,
        userId: undefined,
        organizationId: undefined,
        workflowId: undefined,
        findTool: () => tool as ToolDefinition,
        memoryTool: undefined,
        idempotency: new InMemoryToolIdempotencyStore(),
        emitVoiceEvent: (event) => {
          if (event.kind !== "tool_call") return;
          eventInputs.push(structuredClone(event.input));
          (event.input as { id: number }).id = 9;
        },
        startToolCall: async (queued) => {
          persistedInput = structuredClone(queued.input);
          (queued.input as { id: number }).id = 7;
          return running;
        },
        finishToolCall: async (terminal) => terminal,
        recordToolCall: async (terminal) => terminal,
      },
      {
        id: turnId,
        sessionId,
        sequence: 1,
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [toolCallId],
        startedAt: queuedAt,
        latency: {},
        status: "calling_tool",
      } as Turn,
      [call],
      { abort: new AbortController() } as Parameters<typeof executePipelineToolCalls>[3],
      {},
    );

    expect(providerInput).toEqual({ id: 1 });
    expect(eventInputs).toEqual([{ id: 1 }]);
    expect(persistedInput).toEqual({ id: 1 });
    expect(seen).toEqual([1]);
    expect(result.assistantToolCalls[0]?.input).toEqual({ id: 1 });
  });

  it("exposes safe status and replay policy when a tool throws an internal error", async () => {
    const sessionId = "pipeline_failure_session" as SessionId;
    const turnId = "pipeline_failure_turn" as TurnId;
    const toolCallId = "pipeline_failure_call" as ToolCallId;
    const queuedAt = "2026-10-01T00:00:00.000Z" as QueuedToolCall["queuedAt"];
    const tool: ToolDefinition<Record<string, never>, { readonly ok: boolean }> = {
      id: "pipeline_failure_tool" as ToolId,
      name: "pipeline_failure_tool" as ToolName,
      description: "Fails with an internal error for the boundary test.",
      version: "1.0.0",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      timeout: { timeoutMs: 1_000, onTimeout: "fail" },
      retry: {
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoff: "fixed",
        jitter: false,
      },
      idempotency: { enabled: true },
      async execute() {
        throw new Error("postgres://internal-user:secret@db/private");
      },
    };
    const queued: QueuedToolCall = {
      status: "queued",
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId,
      turnId,
      input: {},
      attempts: 1,
      queuedAt,
    };
    const running: RunningToolCall = {
      ...queued,
      status: "running",
      startedAt: queuedAt,
    };
    const call: LlmInlineToolCall = {
      callRef: "pipeline_failure_call_ref",
      toolName: tool.name,
      input: {},
    };
    const events: VoiceEvent[] = [];
    const messages = await executePipelineToolCalls(
      {
        ids: { toolCall: () => toolCallId } as IdGenerator,
        monotonicMs: () => 1,
        sessionId,
        lease: undefined,
        userId: undefined,
        organizationId: undefined,
        workflowId: undefined,
        findTool: () => tool as ToolDefinition,
        memoryTool: undefined,
        idempotency: new InMemoryToolIdempotencyStore(),
        emitVoiceEvent: (event) => events.push(event),
        startToolCall: async () => running,
        finishToolCall: async (result) => result,
        recordToolCall: async (result) => result,
      },
      {
        id: turnId,
        sessionId,
        sequence: 1,
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [toolCallId],
        startedAt: queuedAt,
        latency: {},
        status: "calling_tool",
      } as Turn,
      [call],
      { abort: new AbortController() } as Parameters<typeof executePipelineToolCalls>[3],
      {},
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool_result",
          status: "failed",
          error: { code: "tool.execution_failed", message: "Tool execution failed" },
          recoveryPolicy: "do_not_replay",
        }),
      ]),
    );
    expect(messages.messages[0]?.content).toContain('"status":"failed"');
    expect(messages.messages[0]?.content).toContain('"recoveryPolicy":"do_not_replay"');
    expect(JSON.stringify({ events, messages })).not.toContain("internal-user:secret");
  });

  it("rejects a nonserializable provider input instead of executing its redaction marker", async () => {
    const sessionId = "pipeline_invalid_input_session" as SessionId;
    const turnId = "pipeline_invalid_input_turn" as TurnId;
    const toolCallId = "pipeline_invalid_input_call" as ToolCallId;
    const queuedAt = "2026-10-01T00:00:00.000Z" as QueuedToolCall["queuedAt"];
    let executions = 0;
    let recorded: unknown;
    const tool: ToolDefinition<Record<string, unknown>, { readonly ok: boolean }> = {
      id: "pipeline_invalid_input_tool" as ToolId,
      name: "pipeline_invalid_input_tool" as ToolName,
      description: "Must not execute a redacted input.",
      version: "1.0.0",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      timeout: { timeoutMs: 1_000, onTimeout: "fail" },
      retry: {
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoff: "fixed",
        jitter: false,
      },
      idempotency: { enabled: false },
      async execute() {
        executions += 1;
        return { ok: true };
      },
    };
    const cyclicInput: Record<string, unknown> = {};
    cyclicInput.self = cyclicInput;
    const call: LlmInlineToolCall = {
      callRef: "pipeline_invalid_input_call_ref",
      toolName: tool.name,
      input: cyclicInput,
    };

    await executePipelineToolCalls(
      {
        ids: { toolCall: () => toolCallId } as IdGenerator,
        monotonicMs: () => 1,
        sessionId,
        lease: undefined,
        userId: undefined,
        organizationId: undefined,
        workflowId: undefined,
        findTool: () => tool as ToolDefinition,
        memoryTool: undefined,
        idempotency: new InMemoryToolIdempotencyStore(),
        emitVoiceEvent: () => undefined,
        startToolCall: async () => {
          throw new Error("nonserializable inputs must fail before the running state");
        },
        finishToolCall: async (terminal) => terminal,
        recordToolCall: async (terminal) => {
          recorded = terminal;
          return terminal;
        },
      },
      {
        id: turnId,
        sessionId,
        sequence: 1,
        input: { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [toolCallId],
        startedAt: queuedAt,
        latency: {},
        status: "calling_tool",
      } as Turn,
      [call],
      { abort: new AbortController() } as Parameters<typeof executePipelineToolCalls>[3],
      {},
    );

    expect(executions).toBe(0);
    expect(recorded).toMatchObject({
      status: "failed",
      input: { $tvic: "input_unavailable", reason: "not_serializable" },
      error: { code: "tool.input_not_serializable" },
    });
  });
});
