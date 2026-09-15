import { executeTool, idempotencyKeyFor, toolInputError } from "@tvic/tools";
import {
  internalError,
  isTerminalSession,
  LeaseLostError,
  normalizeUnknownError,
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
  ToolIdempotencyStore,
  Turn,
  UserId,
  WorkflowId,
} from "@tvic/core";

import { isTerminalToolCall } from "./pipeline-helpers.js";
import { appendConversationMemory } from "./conversation-memory.js";
import { createRememberFactTool } from "./remember-fact-tool.js";
import type { ActiveTurnControl, MutableTurnLatency } from "./turn-state.js";
import type { VoiceEvent } from "./voice-event.js";

const REDACTED_TOOL_INPUT = Object.freeze({
  $tvic: "input_unavailable",
  reason: "not_serializable",
});

export interface PipelineToolExecDeps {
  readonly ids: IdGenerator;
  readonly monotonicMs: () => number;
  readonly sessionId: SessionId;
  readonly lease: { readonly holder: string; readonly fence: number } | undefined;
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

/**
 * Executes one turn's LLM-requested tool calls sequentially (extracted from
 * `PipelineVoiceLoop` for module size; behavior unchanged).
 * Emits `tool_call`/`tool_result`/`error` voice events, persists the
 * queued/running/terminal lifecycle, and builds tool continuation messages.
 */
export async function executePipelineToolCalls(
  deps: PipelineToolExecDeps,
  turn: Turn,
  calls: readonly LlmInlineToolCall[],
  control: ActiveTurnControl,
  latency: MutableTurnLatency,
): Promise<{
  readonly messages: readonly LlmMessage[];
  readonly toolCallIds: readonly ToolCallId[];
}> {
  const messages: LlmMessage[] = [];
  const toolCallIds: ToolCallId[] = [];
  const durationSince = (startedAtMs: number): number =>
    Math.max(0, deps.monotonicMs() - startedAtMs);

  for (const call of calls) {
    if (control.abort.signal.aborted) {
      break;
    }
    const tool = call.toolName === "remember_fact" ? deps.memoryTool : deps.findTool(call);
    if (!tool) {
      // Model-hallucinated tool name: caller-side validation failure, never
      // provider/internal. Retriable=false (retrying the same completion
      // replays the same hallucination).
      const error = validationError(
        "tool.not_found",
        `No tool registered named ${String(call.toolName)}`,
      );
      messages.push({
        role: "tool",
        content: JSON.stringify({ error: { code: error.code, message: error.message } }),
        toolName: call.toolName,
        toolCallRef: call.callRef,
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
    const inputError = toolInputError(call.input, tool.inputSchema);
    deps.emitVoiceEvent({
      kind: "tool_call",
      toolCallId,
      toolName: String(call.toolName),
      input: inputError ? REDACTED_TOOL_INPUT : call.input,
    });
    const persistedInput = inputError ? REDACTED_TOOL_INPUT : call.input;
    const idempotencyKey = inputError
      ? null
      : idempotencyKeyFor({
          tool,
          input: call.input,
          sessionId: deps.sessionId,
          turnId: turn.id,
          toolCallId,
        });
    const queued: QueuedToolCall = {
      status: "queued",
      toolCallId,
      toolId: tool.id,
      toolName: tool.name,
      sessionId: deps.sessionId,
      turnId: turn.id,
      input: persistedInput,
      attempts: 1,
      ...(idempotencyKey ? { idempotencyKey } : {}),
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
          input: call.input,
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
        // R2-04 LOCKED: lease-fence loss maps to failed(lease_lost),
        // never coerced to barge_in; abort-during-tool already returns
        // a `cancelled` ToolCall value (handled by the break below).
        const leaseLost = isLeaseLostError(error);
        result = {
          ...running,
          status: "failed",
          endedAt: new Date().toISOString() as Timestamp,
          error: leaseLost
            ? toolError("tool.lease_lost", "Tool execution lost its session lease", {
                retriable: false,
                cause: error,
              })
            : normalizeUnknownError(error, {
                code: "tool.execution_failed",
                category: "internal",
                retriable: false,
              }),
        };
      }
      result = await deps.finishToolCall(result);
    }
    const toolLatencyMs = durationSince(startedAtMs);
    latency.toolMs = (latency.toolMs ?? 0) + toolLatencyMs;
    const toolOutput =
      result.status === "succeeded"
        ? result.output
        : {
            error: {
              code: "error" in result ? result.error.code : "tool.failed",
              message: "error" in result ? result.error.message : "Tool failed",
            },
          };
    deps.emitVoiceEvent({
      kind: "tool_result",
      toolCallId,
      output: toolOutput,
      latencyMs: toolLatencyMs,
    });

    if (result.status === "succeeded") {
      messages.push({
        role: "tool",
        content: JSON.stringify(result.output),
        toolName: tool.name,
        toolCallRef: call.callRef,
      });
    } else if (result.status === "cancelled") {
      break;
    } else {
      const error = "error" in result ? result.error : internalError("tool.failed", "Tool failed");
      messages.push({
        role: "tool",
        content: JSON.stringify({ error: { code: error.code, message: error.message } }),
        toolName: tool.name,
        toolCallRef: call.callRef,
      });
    }
  }
  return { messages, toolCallIds };
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

/**
 * Resolves the turn's tool list, injecting the runtime-managed
 * `remember_fact` tool when the memory policy allows LLM writes.
 * Extracted from `PipelineVoiceLoop` for module size; behavior unchanged.
 */
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

/**
 * Appends one conversation exchange to memory scopes. Extracted from
 * `PipelineVoiceLoop` for module size; behavior unchanged.
 */
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
