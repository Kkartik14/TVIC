import { isNormalizedError, normalizedError, normalizeUnknownError } from "@tvic/core";
import {
  timeoutError as createTimeoutError,
  validationError as createValidationError,
} from "@tvic/core";
import type {
  NormalizedError,
  SessionId,
  Timestamp,
  ToolCall,
  ToolCallId,
  ToolDefinition,
  ToolExecutionContext,
  ToolId,
  ToolLogger,
  TurnId,
} from "@tvic/core";

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(id: ToolId): ToolDefinition | null;
  list(): readonly ToolDefinition[];
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<ToolId, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }

    this.#tools.set(tool.id, tool);
  }

  get(id: ToolId): ToolDefinition | null {
    return this.#tools.get(id) ?? null;
  }

  list(): readonly ToolDefinition[] {
    return [...this.#tools.values()];
  }
}

export function createToolRegistry(tools: readonly ToolDefinition[] = []): ToolRegistry {
  const registry = new InMemoryToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  return registry;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

export function validateJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path = "$",
): SchemaValidationResult {
  const errors: string[] = [];
  const expectedType = schema.type;

  if (typeof expectedType === "string" && expectedType !== typeOf(value)) {
    errors.push(`${path} expected ${expectedType}, received ${typeOf(value)}`);
    return { valid: false, errors };
  }

  if (expectedType === "object") {
    const objectValue = asObject(value);
    if (!objectValue) {
      errors.push(`${path} expected object`);
      return { valid: false, errors };
    }

    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in objectValue)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = asObject(schema.properties);
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in objectValue) || !asObject(propertySchema)) {
          continue;
        }

        const result = validateJsonSchema(
          objectValue[key],
          propertySchema as Readonly<Record<string, unknown>>,
          `${path}.${key}`,
        );
        errors.push(...result.errors);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

const NULL_LOGGER: ToolLogger = {
  debug() {
    return;
  },
  info() {
    return;
  },
  warn() {
    return;
  },
  error() {
    return;
  },
};

export interface ExecuteToolInput<TInput, TOutput> {
  readonly tool: ToolDefinition<TInput, TOutput>;
  readonly input: TInput;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly attempt?: number;
  readonly logger?: ToolLogger;
  readonly now?: () => Date;
  /** Aborts the tool call (e.g. on barge-in). The tool's ctx.signal mirrors this. */
  readonly signal?: AbortSignal;
}

function isoTimestamp(now: () => Date): Timestamp {
  return now().toISOString() as Timestamp;
}

function toolCancelledError(): NormalizedError {
  return normalizedError("tool.cancelled", "Tool execution cancelled", {
    category: "cancelled",
    retriable: false,
  });
}

/**
 * Races tool execution against its timeout and against external abort, so a
 * blocked tool can never outlive the turn that requested it.
 */
function runWithLimits<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(createTimeoutError("tool.timeout", `Tool execution exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const abortPromise = new Promise<T>((_, reject) => {
    if (controller.signal.aborted) {
      reject(toolCancelledError());
      return;
    }
    controller.signal.addEventListener("abort", () => reject(toolCancelledError()), { once: true });
  });

  return Promise.race([promise, timeoutPromise, abortPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export async function executeTool<TInput = unknown, TOutput = unknown>(
  input: ExecuteToolInput<TInput, TOutput>,
): Promise<ToolCall> {
  const now = input.now ?? (() => new Date());
  const queuedAt = isoTimestamp(now);
  const validation = validateJsonSchema(input.input, input.tool.inputSchema);
  if (!validation.valid) {
    return {
      toolCallId: input.toolCallId,
      toolId: input.tool.id,
      toolName: input.tool.name,
      sessionId: input.sessionId,
      turnId: input.turnId,
      input: input.input,
      attempts: input.attempt ?? 1,
      status: "failed",
      queuedAt,
      startedAt: queuedAt,
      endedAt: isoTimestamp(now),
      error: createValidationError("tool.input_validation_failed", validation.errors.join("; ")),
    };
  }

  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort();
    } else {
      input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  const startedAt = isoTimestamp(now);
  const context: ToolExecutionContext = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    attempt: input.attempt ?? 1,
    signal: controller.signal,
    logger: input.logger ?? NULL_LOGGER,
  };

  try {
    const output = await runWithLimits(
      input.tool.execute(input.input, context),
      input.tool.timeout.timeoutMs,
      controller,
    );

    return {
      toolCallId: input.toolCallId,
      toolId: input.tool.id,
      toolName: input.tool.name,
      sessionId: input.sessionId,
      turnId: input.turnId,
      input: input.input,
      attempts: input.attempt ?? 1,
      status: "succeeded",
      queuedAt,
      startedAt,
      endedAt: isoTimestamp(now),
      output,
    };
  } catch (error) {
    const normalized = asNormalizedError(error);
    return {
      toolCallId: input.toolCallId,
      toolId: input.tool.id,
      toolName: input.tool.name,
      sessionId: input.sessionId,
      turnId: input.turnId,
      input: input.input,
      attempts: input.attempt ?? 1,
      status: toolFailureStatus(normalized),
      queuedAt,
      startedAt,
      endedAt: isoTimestamp(now),
      error: normalized,
    };
  }
}

function toolFailureStatus(error: NormalizedError): "failed" | "timed_out" | "cancelled" {
  if (error.category === "timeout") {
    return "timed_out";
  }
  if (error.category === "cancelled") {
    return "cancelled";
  }
  return "failed";
}

function asNormalizedError(error: unknown): NormalizedError {
  if (isNormalizedError(error)) {
    return error;
  }
  return normalizeUnknownError(error, {
    code: "tool.execution_failed",
    category: "tool",
    retriable: true,
  });
}

export type { ToolCall, ToolDefinition, ToolExecutionContext };
