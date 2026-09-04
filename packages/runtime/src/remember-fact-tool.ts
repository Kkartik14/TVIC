import {
  validationError,
  type Memory,
  type MemoryRef,
  type MemoryScope,
  type OrganizationId,
  type SessionId,
  type UserId,
  type WorkflowId,
  TvicThrowableError,
} from "@tvic/core";
import { defineTool } from "./define-tool.js";
import { assertMemoryCapability } from "./memory-capabilities.js";

export type MemoryOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export interface RememberFactToolContext {
  readonly memory: Memory;
  readonly sessionId: SessionId;
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  /** Scopes granted by the owning agent's memory policy. Omit for compatibility. */
  readonly allowedScopes?: readonly MemoryScope[];
  /** Serializes this write with the owning session's other memory operations. */
  readonly runMemoryOperation?: MemoryOperationRunner;
  /** Final liveness check executed inside the serialized operation. */
  readonly canWrite?: () => boolean | Promise<boolean>;
  /** Adapter-enforced aggregate quota for session-scope writes. */
  readonly maxSessionBytes?: number;
}

const SCOPES = ["session", "user", "organization", "workflow"] as const;
const KINDS = ["fact", "summary", "open_item", "entity_ref", "raw", "working_memory"] as const;
type RememberFactScope = (typeof SCOPES)[number];
type RememberFactKind = (typeof KINDS)[number];

interface RememberFactInput {
  readonly scope: RememberFactScope;
  readonly key: string;
  readonly kind: RememberFactKind;
  readonly value: unknown;
}

export function createRememberFactTool(context: RememberFactToolContext) {
  assertMemoryCapability(context.memory, "write.explicit", "the remember_fact tool");
  return defineTool({
    id: "remember_fact",
    name: "remember_fact",
    description:
      "Persist a fact about the caller to durable memory. Use this when the caller shares information that should be remembered on future calls (name, preferences, account numbers, contact details).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: [...SCOPES],
          description:
            "Which memory scope to write to. 'user' for cross-call recall. 'session' for this call only.",
        },
        key: {
          type: "string",
          description:
            "Stable key for the fact (e.g., 'preferred_name', 'account_id'). Reuse the same key for the same fact.",
        },
        kind: {
          type: "string",
          enum: [...KINDS],
          description:
            "What kind of memory this is. 'fact' for a stable fact. 'summary' for a derived summary. 'open_item' for follow-ups.",
        },
        value: {
          description:
            "The fact to remember as a JSON value: string, finite number, boolean, null, array, or object.",
        },
      },
      required: ["scope", "key", "kind", "value"],
      additionalProperties: false,
    },
    execute: async (rawInput: unknown) => {
      const input = parseRememberFactInput(rawInput);
      if (context.allowedScopes && !context.allowedScopes.includes(input.scope)) {
        throw TvicThrowableError.from(
          validationError(
            "memory.scope_not_allowed",
            `Memory policy does not allow writes to the ${input.scope} scope`,
          ),
        );
      }
      const ref = scopeToRef(input.scope, context);
      const write = async () => {
        if (context.canWrite && !(await context.canWrite())) {
          throw TvicThrowableError.from(
            validationError(
              "memory.session_ended",
              "Memory writes are closed because the session has ended",
            ),
          );
        }
        return context.memory.put(ref, input.key, input.kind, input.value, {
          ...(input.scope === "session" && context.userId ? { sessionUserId: context.userId } : {}),
          ...(input.scope === "session" && context.maxSessionBytes !== undefined
            ? { maxSessionBytes: context.maxSessionBytes }
            : {}),
        });
      };
      const entry = context.runMemoryOperation
        ? await context.runMemoryOperation(write)
        : await write();
      return {
        id: entry.id,
        scope: input.scope,
        key: input.key,
        kind: input.kind,
        version: entry.version,
        storedAt: entry.createdAt,
      };
    },
  });
}

function parseRememberFactInput(rawInput: unknown): RememberFactInput {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    throw TvicThrowableError.from(
      validationError("memory.invalid_input", "remember_fact input must be an object"),
    );
  }
  const candidate = rawInput as Record<string, unknown>;
  if (
    typeof candidate.scope !== "string" ||
    !SCOPES.includes(candidate.scope as RememberFactScope)
  ) {
    throw TvicThrowableError.from(
      validationError("memory.invalid_scope", `Unknown memory scope: ${String(candidate.scope)}`),
    );
  }
  if (typeof candidate.key !== "string" || candidate.key.trim().length === 0) {
    throw TvicThrowableError.from(
      validationError("memory.invalid_key", "Memory key must be a non-empty string"),
    );
  }
  if (typeof candidate.kind !== "string" || !KINDS.includes(candidate.kind as RememberFactKind)) {
    throw TvicThrowableError.from(
      validationError("memory.invalid_kind", `Unknown memory kind: ${String(candidate.kind)}`),
    );
  }
  if (!("value" in candidate)) {
    throw TvicThrowableError.from(
      validationError("memory.invalid_value", "Memory value is required"),
    );
  }
  if (!isJsonValue(candidate.value, new WeakSet<object>())) {
    throw TvicThrowableError.from(
      validationError(
        "memory.invalid_value",
        "Memory value must be a finite, acyclic JSON-compatible value",
      ),
    );
  }
  return {
    scope: candidate.scope as RememberFactScope,
    key: candidate.key,
    kind: candidate.kind as RememberFactKind,
    value: candidate.value,
  };
}

function isJsonValue(value: unknown, stack: WeakSet<object>): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    return false;
  }
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
  } catch {
    return false;
  }
  if (stack.has(value)) return false;
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => isJsonValue(item, stack));
    return Object.values(value).every((item) => isJsonValue(item, stack));
  } catch {
    return false;
  } finally {
    stack.delete(value);
  }
}

function scopeToRef(
  scope: RememberFactInput["scope"],
  context: RememberFactToolContext,
): MemoryRef {
  switch (scope) {
    case "session":
      return { scope: "session", sessionId: context.sessionId };
    case "user":
      if (!context.userId) {
        throw TvicThrowableError.from(
          validationError("memory.no_user_scope", "memoryUserId is required for user scope"),
        );
      }
      return { scope: "user", userId: context.userId };
    case "organization":
      if (!context.organizationId) {
        throw TvicThrowableError.from(
          validationError(
            "memory.no_organization_scope",
            "organizationId is required for organization scope",
          ),
        );
      }
      return { scope: "organization", organizationId: context.organizationId };
    case "workflow":
      if (!context.workflowId) {
        throw TvicThrowableError.from(
          validationError("memory.no_workflow_scope", "workflowId is required for workflow scope"),
        );
      }
      return { scope: "workflow", workflowId: context.workflowId };
  }
}
