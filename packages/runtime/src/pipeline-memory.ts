import {
  isTerminalSession,
  type Agent,
  type Memory,
  type OrganizationId,
  type Runtime,
  type SessionAttachment,
  type SessionId,
  type ToolDefinition,
  type TurnId,
  type UserId,
  type WorkflowId,
} from "@tvic/core";

import { appendConversationMemory } from "./conversation-memory.js";
import { createRememberFactTool } from "./remember-fact-tool.js";

export interface PipelineMemoryOptions {
  readonly runtime: Runtime;
  readonly sessionId: SessionId;
  readonly agent: Agent;
  readonly attachment?: SessionAttachment;
  readonly memory?: Memory;
  readonly memoryUserId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
}

/** Keeps memory tools and transcript persistence outside the realtime loop facade. */
export class PipelineMemoryCoordinator {
  readonly #options: PipelineMemoryOptions;
  #memoryTool: ToolDefinition | undefined;

  constructor(options: PipelineMemoryOptions) {
    this.#options = options;
  }

  get memoryTool(): ToolDefinition | undefined {
    return this.#memoryTool;
  }

  resolveToolList(): readonly ToolDefinition[] {
    const configuredTools = this.#options.agent.tools.filter(
      (tool) => tool.name !== "remember_fact",
    );
    const policy = this.#options.agent.memoryPolicy;
    const memory = this.#options.memory;
    if (!memory || !policy.enabled || !policy.canLlmWrite || policy.readOnly) {
      this.#memoryTool = undefined;
      return configuredTools;
    }

    const tool = createRememberFactTool({
      memory,
      sessionId: this.#options.sessionId,
      allowedScopes: policy.scopes,
      runMemoryOperation: (operation) => {
        const runtime = this.#options.runtime;
        return runtime.runSessionMemoryOperation
          ? runtime.runSessionMemoryOperation(this.#options.sessionId, operation)
          : operation();
      },
      canWrite: async () => {
        if (this.#options.attachment?.signal.aborted) return false;
        const session = await this.#options.runtime
          .getSession(this.#options.sessionId)
          .catch(() => null);
        return Boolean(session && !isTerminalSession(session));
      },
      ...(policy.maxBytesPerSession !== undefined
        ? { maxSessionBytes: policy.maxBytesPerSession }
        : {}),
      ...(this.#options.memoryUserId ? { userId: this.#options.memoryUserId } : {}),
      ...(this.#options.organizationId ? { organizationId: this.#options.organizationId } : {}),
      ...(this.#options.workflowId ? { workflowId: this.#options.workflowId } : {}),
    });
    this.#memoryTool = tool;
    return [...configuredTools, tool];
  }

  async updateMemory(
    turnId: TurnId,
    transcript: string,
    assistantText: string,
    interrupted = false,
  ): Promise<void> {
    const memory = this.#options.memory;
    const policy = this.#options.agent.memoryPolicy;
    if (!memory || !policy.enabled || policy.readOnly) return;

    const write = async (): Promise<void> => {
      if (this.#options.attachment?.signal.aborted) return;
      const session = await this.#options.runtime
        .getSession(this.#options.sessionId)
        .catch(() => null);
      if (!session || isTerminalSession(session) || this.#options.attachment?.signal.aborted)
        return;
      await appendConversationMemory({
        memory,
        policy,
        sessionId: this.#options.sessionId,
        turnId,
        userId: this.#options.memoryUserId,
        ...(this.#options.organizationId ? { organizationId: this.#options.organizationId } : {}),
        ...(this.#options.workflowId ? { workflowId: this.#options.workflowId } : {}),
        transcript,
        assistantText,
        ...(interrupted ? { interrupted: true } : {}),
      });
    };

    const runtime = this.#options.runtime;
    if (runtime.runSessionMemoryOperation) {
      await runtime.runSessionMemoryOperation(this.#options.sessionId, write);
      return;
    }
    await write();
  }
}
