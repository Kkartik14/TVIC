import { executeTool, snapshotJsonValue, toolInputError } from "@tvic/tools";
import {
  internalError,
  isTerminalSession,
  LeaseLostError,
  toolError,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type {
  AgentMemoryPolicy,
  IdGenerator,
  LlmInlineToolCall,
  LlmMessage,
  Memory,
  OrganizationId,
  QueuedToolCall,
  RunningToolCall,
  Runtime,
  SessionId,
  TerminalToolCall,
  Timestamp,
  ToolCallId,
  ToolDefinition,
  ToolId,
  ToolIdempotencyStore,
  Turn,
  UserId,
  WorkflowId,
} from "@tvic/core";

import { isTerminalToolCall } from "./pipeline-helpers.js";
import { appendConversationMemory } from "./conversation-memory.js";
import { REDACTED_TOOL_INPUT } from "./pipeline-llm-accumulator.js";
import { truncateToolInput, truncateToolOutput } from "./pipeline-payload-budgets.js";
import { createRememberFactTool } from "./remember-fact-tool.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";
import type { VoiceEvent } from "./voice-event.js";

export interface PipelineToolExecDeps {
  readonly ids: IdGenerator;
  readonly monotonicMs: () => number;
  readonly sessionId: SessionId;
  readonly lease:
    | { readonly holder: string; readonly fence: number; readonly generationId: string }
    | undefined;
  readonly userId: UserId | undefined;
  readonly organizationId: OrganizationId | undefined;
  readonly workflowId: WorkflowId | undefined;
  readonly findTool: (call: LlmInlineToolCall) => ToolDefinition | null;
  readonly memoryTool: ToolDefinition | undefined;
  readonly idempotency: ToolIdempotencyStore;
  readonly emitVoiceEvent: (event: VoiceEvent) => void;
  readonly startToolCall: (queued: QueuedToolCall) => Promise<RunningToolCall>;
  readonly finishToolCall: (result: TerminalToolCall) => Promise<TerminalToolCall>;
  readonly recordToolCall: (result: TerminalToolCall) => Promise<TerminalToolCall>;
}

export async function executePipelineToolCalls(
  deps: PipelineToolExecDeps,
  turn: Turn,
  calls: readonly LlmInlineToolCall[],
  control: ActiveTurnControl,
  latency: MutableTurnLatency,
): Promise<{
  readonly messages: readonly LlmMessage[];
  readonly toolCallIds: readonly ToolCallId[];
  readonly assistantToolCalls: readonly LlmInlineToolCall[];
}> {
  const messages: LlmMessage[] = [];
  const toolCallIds: ToolCallId[] = [];
  const assistantToolCalls: LlmInlineToolCall[] = [];
  const durationSince = (startedAtMs: number): number =>
    Math.max(0, deps.monotonicMs() - startedAtMs);

  for (const call of calls) {
    if (control.abort.signal.aborted) {
      break;
    }
    const persistedInput = serializableToolValue(call.input);
    // Keep separate copies for the model-facing continuation and the durable
    // lifecycle. Event handlers and persistence adapters receive their own
    // values and cannot change the executor's input snapshot.
    assistantToolCalls.push({
      ...call,
      input: truncateToolInput(serializableToolValue(persistedInput)),
    });
    const tool = call.toolName === "remember_fact" ? deps.memoryTool : deps.findTool(call);
    if (!tool) {
      // Model-hallucinated tool name: caller-side validation failure, never
      // provider/internal. Retriable=false (retrying the same completion
      // replays the same hallucination).
      const error = validationError(
        "tool.not_found",
        `No tool registered named ${String(call.toolName)}`,
      );
      const toolCallId = deps.ids.toolCall();
      const timestamp = new Date().toISOString() as Timestamp;
      await deps.recordToolCall({
        status: "failed",
        toolCallId,
        toolId: `${call.toolName}` as ToolId,
        toolName: call.toolName,
        sessionId: deps.sessionId,
        turnId: turn.id,
        input: persistedInput,
        attempts: 1,
        queuedAt: timestamp,
        startedAt: timestamp,
        endedAt: timestamp,
        error,
        metadata: { unknownTool: true },
      });
      toolCallIds.push(toolCallId);
      deps.emitVoiceEvent({
        kind: "tool_call",
        toolCallId,
        toolName: String(call.toolName),
        input: persistedInput,
      });
      messages.push({
        role: "tool",
        content: JSON.stringify({
          status: "failed",
          error: { code: error.code, message: error.message },
        }),
        toolName: call.toolName,
        toolCallRef: call.callRef,
      });
      deps.emitVoiceEvent({
        kind: "tool_result",
        toolCallId,
        output: {
          status: "failed",
          error: { code: error.code, message: error.message },
        },
        status: "failed",
        error: { code: error.code, message: error.message },
        latencyMs: 0,
      });
      deps.emitVoiceEvent({
        kind: "error",
        error,
        recoverable: error.retriable,
      });
      continue;
    }

    const toolCallId = deps.ids.toolCall();
    const startedAtMs = deps.monotonicMs();
    toolCallIds.push(toolCallId);
    const inputError =
      persistedInput === REDACTED_TOOL_INPUT
        ? validationError(
            "tool.input_not_serializable",
            "Tool input cannot be persisted: provider input was not serializable",
          )
        : toolInputError(persistedInput, tool.inputSchema);
    const safeInput = inputError ? REDACTED_TOOL_INPUT : persistedInput;
    deps.emitVoiceEvent({
      kind: "tool_call",
      toolCallId,
      toolName: String(call.toolName),
      input: serializableToolValue(safeInput),
    });
    const queued: QueuedToolCall = {
      status: "queued",
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: deps.sessionId,
      turnId: turn.id,
      input: serializableToolValue(safeInput),
      attempts: 1,
      queuedAt: new Date().toISOString() as Timestamp,
    };
    let result: TerminalToolCall;
    if (inputError) {
      result = await deps.recordToolCall({
        ...queued,
        status: "failed",
        startedAt: queued.queuedAt,
        endedAt: new Date().toISOString() as Timestamp,
        error: inputError,
        metadata: { inputRedacted: true },
      });
    } else {
      const running = await deps.startToolCall(queued);
      try {
        const executed = await executeTool({
          tool,
          input: persistedInput,
          sessionId: deps.sessionId,
          turnId: turn.id,
          toolCallId,
          queuedAt: queued.queuedAt,
          signal: control.abort.signal,
          idempotencyStore: deps.idempotency,
          ...(deps.lease
            ? {
                lease: {
                  sessionId: deps.sessionId,
                  holder: deps.lease.holder,
                  fence: deps.lease.fence,
                  generationId: deps.lease.generationId,
                },
              }
            : {}),
          ...(deps.userId || deps.organizationId || deps.workflowId
            ? {
                tenant: {
                  ...(deps.userId ? { userId: deps.userId } : {}),
                  ...(deps.organizationId ? { organizationId: deps.organizationId } : {}),
                  ...(deps.workflowId ? { workflowId: deps.workflowId } : {}),
                },
              }
            : {}),
        });
        if (!isTerminalToolCall(executed)) {
          throw TvicThrowableError.from(
            internalError(
              "tool.invalid_terminal_state",
              "Tool execution did not produce a terminal call",
            ),
          );
        }
        result = executed;
      } catch (error) {
        // A lost lease is a failed tool call, not a barge-in cancellation.
        // Abort-during-tool already returns a `cancelled` value below.
        const leaseLost = isLeaseLostError(error);
        result = {
          ...running,
          status: "failed",
          endedAt: new Date().toISOString() as Timestamp,
          error: leaseLost
            ? toolError("tool.lease_lost", "Tool execution lost its session lease", {
                retriable: false,
              })
            : toolError("tool.execution_failed", "Tool execution failed", {
                retriable: false,
              }),
        };
      }
      result = await deps.finishToolCall(result);
    }
    const toolLatencyMs = durationSince(startedAtMs);
    latency.toolMs = (latency.toolMs ?? 0) + toolLatencyMs;
    const resultError =
      result.status === "succeeded"
        ? undefined
        : "error" in result
          ? result.error
          : toolError("tool.failed", "Tool failed", { retriable: false });
    const error = resultError
      ? { code: resultError.code, message: resultError.message }
      : undefined;
    const recoveryPolicy =
      result.metadata?.recoveryPolicy === "do_not_replay" ? "do_not_replay" : undefined;
    const toolOutput =
      result.status === "succeeded"
        ? result.output
        : {
            status: result.status,
            error,
            ...(recoveryPolicy ? { recoveryPolicy } : {}),
          };
    const boundedToolOutput = truncateToolOutput(toolOutput);
    deps.emitVoiceEvent({
      kind: "tool_result",
      toolCallId,
      output: boundedToolOutput,
      status: result.status,
      ...(error ? { error } : {}),
      ...(recoveryPolicy ? { recoveryPolicy } : {}),
      latencyMs: toolLatencyMs,
    });

    if (result.status === "succeeded") {
      messages.push({
        role: "tool",
        content: safeJsonStringify(boundedToolOutput),
        toolName: tool.name,
        toolCallRef: call.callRef,
      });
    } else if (result.status === "cancelled") {
      break;
    } else {
      messages.push({
        role: "tool",
        content: safeJsonStringify(toolOutput),
        toolName: tool.name,
        toolCallRef: call.callRef,
      });
    }
  }
  return { messages, toolCallIds, assistantToolCalls };
}

function serializableToolValue(value: unknown): unknown {
  if (value === REDACTED_TOOL_INPUT) return REDACTED_TOOL_INPUT;
  try {
    return snapshotJsonValue(value);
  } catch {
    return REDACTED_TOOL_INPUT;
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(REDACTED_TOOL_INPUT);
  }
}

export interface AgentToolContext {
  readonly tools: readonly ToolDefinition[];
  readonly memoryPolicy: AgentMemoryPolicy;
  readonly memory: Memory | undefined;
  readonly runtime: Runtime;
  readonly sessionId: SessionId;
  readonly attachmentSignal: AbortSignal | undefined;
  readonly userId: UserId | undefined;
  readonly organizationId: OrganizationId | undefined;
  readonly workflowId: WorkflowId | undefined;
}

function isLeaseLostError(error: unknown): boolean {
  if (error instanceof LeaseLostError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "LEASE_LOST"
  );
}

export function resolveAgentTools(context: AgentToolContext): {
  readonly tools: readonly ToolDefinition[];
  readonly memoryTool: ToolDefinition | undefined;
} {
  const configuredTools = context.tools.filter((tool) => tool.name !== "remember_fact");
  const policy = context.memoryPolicy;
  if (!policy.enabled || !policy.canLlmWrite || policy.readOnly) {
    return { tools: configuredTools, memoryTool: undefined };
  }
  const memory = context.memory;
  if (!memory) {
    return { tools: configuredTools, memoryTool: undefined };
  }
  const tool = createRememberFactTool({
    memory,
    sessionId: context.sessionId,
    allowedScopes: policy.scopes,
    runMemoryOperation: (operation) => {
      const runtime = context.runtime;
      return runtime.runSessionMemoryOperation
        ? runtime.runSessionMemoryOperation(context.sessionId, operation)
        : operation();
    },
    canWrite: async () => {
      if (context.attachmentSignal?.aborted) return false;
      const session = await context.runtime.getSession(context.sessionId).catch(() => null);
      return Boolean(session && !isTerminalSession(session));
    },
    ...(policy.maxBytesPerSession !== undefined
      ? { maxSessionBytes: policy.maxBytesPerSession }
      : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.organizationId ? { organizationId: context.organizationId } : {}),
    ...(context.workflowId ? { workflowId: context.workflowId } : {}),
  });
  return { tools: [...configuredTools, tool], memoryTool: tool };
}

export interface TurnMemoryContext {
  readonly memory: Memory | undefined;
  readonly policy: AgentMemoryPolicy;
  readonly runtime: Runtime;
  readonly sessionId: SessionId;
  readonly attachmentSignal: AbortSignal | undefined;
  readonly userId: UserId | undefined;
  readonly organizationId: OrganizationId | undefined;
  readonly workflowId: WorkflowId | undefined;
}

export async function appendTurnMemory(
  context: TurnMemoryContext,
  turnId: Turn["id"],
  transcript: string,
  assistantText: string,
  interrupted = false,
): Promise<void> {
  const memory = context.memory;
  const policy = context.policy;
  if (!memory || !policy.enabled || policy.readOnly) {
    return;
  }
  const write = async (): Promise<void> => {
    if (context.attachmentSignal?.aborted) return;
    const session = await context.runtime.getSession(context.sessionId).catch(() => null);
    if (!session || isTerminalSession(session) || context.attachmentSignal?.aborted) return;
    await appendConversationMemory({
      memory,
      policy,
      sessionId: context.sessionId,
      turnId,
      userId: context.userId,
      ...(context.organizationId ? { organizationId: context.organizationId } : {}),
      ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      transcript,
      assistantText,
      ...(interrupted ? { interrupted: true } : {}),
    });
  };
  const runtime = context.runtime;
  if (runtime.runSessionMemoryOperation) {
    await runtime.runSessionMemoryOperation(context.sessionId, write);
    return;
  }
  await write();
}
