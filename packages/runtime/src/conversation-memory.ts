import type {
  AgentMemoryPolicy,
  Memory,
  MemoryRef,
  OrganizationId,
  SessionId,
  TurnId,
  UserId,
  WorkflowId,
} from "@tvic/core";
import { assertMemoryCapability } from "./memory-capabilities.js";

/**
 * The runtime stores each exchange under an immutable key. A read-modify-write
 * aggregate such as `exchanges` cannot be made safe with the Memory contract:
 * `get`, `put`, and `delete` do not form one atomic operation, so two callers
 * can overwrite one another or a failed retry can delete the only copy.
 */
export function conversationMemoryKey(sessionId: SessionId, turnId: TurnId): string {
  return `exchange:${sessionId}:${turnId}`;
}

export async function appendConversationMemory(options: {
  readonly memory: Memory | undefined;
  readonly policy: AgentMemoryPolicy;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly userId: UserId | undefined;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly transcript: string;
  readonly assistantText: string;
  readonly interrupted?: boolean;
}): Promise<void> {
  if (!options.memory || !options.policy.enabled || options.policy.readOnly) {
    return;
  }

  const value = {
    user: options.transcript,
    assistant: options.assistantText,
    ...(options.interrupted ? { interrupted: true } : {}),
  };
  const refs: MemoryRef[] = [];
  if (options.policy.scopes.includes("session")) {
    refs.push({ scope: "session", sessionId: options.sessionId });
  }
  if (options.policy.scopes.includes("user") && options.userId) {
    refs.push({ scope: "user", userId: options.userId });
  }
  if (options.policy.scopes.includes("organization") && options.organizationId) {
    refs.push({ scope: "organization", organizationId: options.organizationId });
  }
  if (options.policy.scopes.includes("workflow") && options.workflowId) {
    refs.push({ scope: "workflow", workflowId: options.workflowId });
  }

  if (refs.length > 0) {
    assertMemoryCapability(options.memory, "write.implicit", "automatic conversation memory");
  }

  const key = conversationMemoryKey(options.sessionId, options.turnId);
  const writes = await Promise.allSettled(
    refs.map((ref) =>
      options.memory!.put(ref, key, "raw", value, {
        // The turn id makes the write idempotent across retries and safe for
        // concurrent attachments. Existing entries are returned unchanged.
        ifNotExists: true,
        ...(ref.scope === "session" && options.userId ? { sessionUserId: options.userId } : {}),
        ...(ref.scope === "session" && options.policy.maxBytesPerSession !== undefined
          ? { maxSessionBytes: options.policy.maxBytesPerSession }
          : {}),
      }),
    ),
  );
  // Memory has no cross-scope transaction primitive. Wait for every adapter
  // write before surfacing the first failure so callers know that a failure
  // may have left a partial set of scope entries, rather than mistaking an
  // early rejection for all writes having stopped.
  const failed = writes.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
