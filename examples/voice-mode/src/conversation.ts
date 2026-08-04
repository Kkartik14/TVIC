import type { Agent, Memory, UserId } from "@tvic/core";
import { ConversationPolicy } from "@tvic/runtime";

interface StoredExchange {
  readonly user: string;
  readonly assistant: string;
  readonly interrupted?: boolean;
}

export async function createPrimedConversationPolicy(
  memory: Memory,
  agent: Agent,
  userId: UserId,
): Promise<ConversationPolicy> {
  const policy = new ConversationPolicy({ agent });
  const result = await memory.search<readonly StoredExchange[]>(
    { scope: "user", userId },
    { key: "exchanges" },
  );
  for (const exchange of result.entries.flatMap((entry) => entry.value)) {
    if (!exchange.interrupted) policy.recordTurn(exchange.user, exchange.assistant);
  }
  return policy;
}
