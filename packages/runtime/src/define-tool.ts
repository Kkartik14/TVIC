import type {
  IdempotencyPolicy,
  JsonSchemaDocument,
  RetryPolicy,
  TimeoutPolicy,
  ToolDefinition,
  ToolExecutor,
  ToolId,
  ToolName,
} from "@tvic/core";

const DEFAULT_TIMEOUT: TimeoutPolicy = {
  timeoutMs: 30_000,
  onTimeout: "fail",
};

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoff: "fixed",
  jitter: false,
};

const DEFAULT_IDEMPOTENCY: IdempotencyPolicy = {
  enabled: false,
};

const EMPTY_OUTPUT_SCHEMA: JsonSchemaDocument = { type: "object" };

export interface DefineToolInput<TInput, TOutput> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly inputSchema: JsonSchemaDocument;
  readonly outputSchema?: JsonSchemaDocument;
  readonly timeout?: TimeoutPolicy;
  readonly retry?: RetryPolicy;
  readonly idempotency?: IdempotencyPolicy;
  readonly authScope?: readonly string[];
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly execute: ToolExecutor<TInput, TOutput>;
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  input: DefineToolInput<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return {
    id: input.id as ToolId,
    name: input.name as ToolName,
    description: input.description,
    version: input.version ?? "0.1.0",
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema ?? EMPTY_OUTPUT_SCHEMA,
    timeout: input.timeout ?? DEFAULT_TIMEOUT,
    retry: input.retry ?? DEFAULT_RETRY,
    idempotency: input.idempotency ?? DEFAULT_IDEMPOTENCY,
    execute: input.execute,
    ...(input.authScope ? { authScope: input.authScope } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}
