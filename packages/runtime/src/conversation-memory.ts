import type { AgentMemoryPolicy, Memory, MemoryRef, SessionId, UserId } from "@tvic/core";

export async function appendConversationMemory(options: {
  readonly memory: Memory | undefined;
  readonly policy: AgentMemoryPolicy;
  readonly sessionId: SessionId;
  readonly userId: UserId | undefined;
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
  await Promise.all(refs.map((ref) => options.memory!.append(ref, "exchanges", value)));
}
