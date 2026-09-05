import {
  validationError,
  type AgentMemoryPolicy,
  type Memory,
  TvicThrowableError,
} from "@tvic/core";

/**
 * Fails before a live session starts when the configured memory adapter cannot
 * provide the behavior the agent's policy promises. Memory adapters remain
 * pluggable; the adapter's instance-level declaration is the source of truth.
 */
export function assertMemoryPolicySupported(memory: Memory, policy: AgentMemoryPolicy): void {
  if (!policy.enabled) return;

  const scopes = new Set(policy.scopes);
  const loadsMemory = policy.preCallLoad !== "none" && scopes.size > 0;
  if (loadsMemory) assertMemoryCapability(memory, "search.exact", "pre-call memory loading");

  const writesImplicitly = !policy.readOnly && scopes.size > 0;
  if (writesImplicitly)
    assertMemoryCapability(memory, "write.implicit", "automatic conversation memory");

  if (policy.canLlmWrite && !policy.readOnly)
    assertMemoryCapability(memory, "write.explicit", "the remember_fact tool");

  if (policy.maxBytesPerSession !== undefined && writesImplicitly && scopes.has("session")) {
    assertMemoryCapability(memory, "write.sessionQuota", "session memory byte limit");
  }

  const purgesSession = (policy.deleteSessionScopeOnEnd ?? true) && scopes.has("session");
  if (purgesSession)
    assertMemoryCapability(memory, "purge.perScope", "session-scope deletion at session end");
}

export function assertMemoryCapability(
  memory: Memory,
  capability:
    | "search.exact"
    | "write.explicit"
    | "write.implicit"
    | "write.sessionQuota"
    | "purge.perScope",
  operation: string,
): void {
  const supported =
    capability === "search.exact"
      ? memory.capabilities?.search?.exact === true
      : capability === "write.explicit"
        ? memory.capabilities?.write?.explicit === true
        : capability === "write.implicit"
          ? memory.capabilities?.write?.implicit === true
          : capability === "write.sessionQuota"
            ? memory.capabilities?.write?.sessionQuota === true
            : memory.capabilities?.purge?.perScope === true;
  if (!supported) unsupported(memory, capability, operation);
}

function unsupported(memory: Memory, capability: string, operation: string): never {
  throw TvicThrowableError.from(
    validationError(
      "memory.capability_unsupported",
      `${memory.name} does not support ${capability}, required for ${operation}`,
      {
        metadata: {
          memoryAdapter: memory.name,
          capability,
          operation,
        },
      },
    ),
  );
}
