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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    return [...keys].every((key) => deepEqual(ao[key], bo[key]));
  }
  return false;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return expected === typeOf(value);
}

/**
 * Validates a value against a deliberately small, well-defined subset of JSON Schema
 * (Draft-07 keywords): `type` (incl. "integer"), `enum`, `const`, object
 * `properties` / `required` / `additionalProperties: false`, array `items` /
 * `minItems` / `maxItems`, string `minLength` / `maxLength`, and numeric `minimum` /
 * `maximum`. It is intentionally NOT a full validator — unsupported keywords are
 * ignored. Swap in Ajv at the call site if full JSON Schema compliance is required.
 */
export function validateJsonSchemaSubset(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path = "$",
): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(value, schema, path, errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  errors: string[],
): void {
  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }

  const expectedType = schema.type;
  if (typeof expectedType === "string" && !matchesType(value, expectedType)) {
    errors.push(`${path} expected ${expectedType}, received ${typeOf(value)}`);
    return; // a type mismatch makes deeper checks meaningless
  }

  if (expectedType === "object") {
    validateObjectNode(value, schema, path, errors);
  } else if (expectedType === "array") {
    validateArrayNode(value, schema, path, errors);
  } else if (expectedType === "string" && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} must have length >= ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} must have length <= ${schema.maxLength}`);
    }
  } else if (
    (expectedType === "number" || expectedType === "integer") &&
    typeof value === "number"
  ) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }
}

function validateObjectNode(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  errors: string[],
): void {
  const objectValue = asObject(value);
  if (!objectValue) {
    errors.push(`${path} expected object`);
    return;
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
      validateNode(
        objectValue[key],
        propertySchema as Readonly<Record<string, unknown>>,
        `${path}.${key}`,
        errors,
      );
    }
  }

  if (schema.additionalProperties === false && properties) {
    for (const key of Object.keys(objectValue)) {
      if (!(key in properties)) {
        errors.push(`${path}.${key} is not an allowed property`);
      }
    }
  }
}

function validateArrayNode(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} expected array`);
    return;
  }
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    errors.push(`${path} must have >= ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    errors.push(`${path} must have <= ${schema.maxItems} items`);
  }
  const itemSchema = asObject(schema.items);
  if (itemSchema) {
    value.forEach((item, index) => {
      validateNode(item, itemSchema, `${path}[${index}]`, errors);
    });
  }
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

/** Caches successful tool outputs so an idempotent call is not re-executed. */
export interface ToolIdempotencyStore {
  get(key: string): unknown | undefined;
  set(key: string, output: unknown, ttlMs: number): void;
}

export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #entries = new Map<string, { readonly output: unknown; readonly expiresAt: number }>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get(key: string): unknown | undefined {
    const found = this.#entries.get(key);
    if (!found) {
      return undefined;
    }
    if (found.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return found.output;
  }

  set(key: string, output: unknown, ttlMs: number): void {
    this.#entries.set(key, { output, expiresAt: this.#now() + ttlMs });
  }
}

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
  /** Honours the tool's idempotency policy when provided. */
  readonly idempotencyStore?: ToolIdempotencyStore;
  /** Invoked before each retry so callers can make hidden retries observable. */
  readonly onRetry?: (info: ToolRetryInfo) => void | Promise<void>;
}

export interface ToolRetryInfo {
  /** The attempt number about to run (2 for the first retry). */
  readonly attempt: number;
  readonly delayMs: number;
  readonly cause: NormalizedError;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function idempotencyKeyFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): string | null {
  const policy = input.tool.idempotency;
  if (!policy.enabled) {
    return null;
  }
  const serializedInput = stableStringify(input.input);
  if (policy.keyTemplate) {
    return policy.keyTemplate
      .replaceAll("{sessionId}", String(input.sessionId))
      .replaceAll("{turnId}", String(input.turnId))
      .replaceAll("{toolId}", String(input.tool.id))
      .replaceAll("{input}", serializedInput);
  }
  return `${String(input.tool.id)}:${serializedInput}`;
}

function isRetriable(error: NormalizedError, retry: ToolDefinition["retry"]): boolean {
  if (error.retriable === false) {
    return false;
  }
  if (retry.retryableErrorCodes && retry.retryableErrorCodes.length > 0) {
    return retry.retryableErrorCodes.includes(error.code);
  }
  return error.retriable === true;
}

function backoffDelayMs(retry: ToolDefinition["retry"], attempt: number): number {
  const step = Math.max(0, attempt - 1);
  const base =
    retry.backoff === "exponential"
      ? retry.initialDelayMs * 2 ** step
      : retry.backoff === "linear"
        ? retry.initialDelayMs * attempt
        : retry.initialDelayMs;
  const bounded = Math.min(base, retry.maxDelayMs);
  return retry.jitter ? Math.round(bounded * (0.5 + Math.random() * 0.5)) : bounded;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
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

  const base = {
    toolCallId: input.toolCallId,
    toolId: input.tool.id,
    toolName: input.tool.name,
    sessionId: input.sessionId,
    turnId: input.turnId,
    input: input.input,
    queuedAt,
  } as const;

  const validation = validateJsonSchemaSubset(input.input, input.tool.inputSchema);
  if (!validation.valid) {
    return {
      ...base,
      attempts: input.attempt ?? 1,
      status: "failed",
      startedAt: queuedAt,
      endedAt: isoTimestamp(now),
      error: createValidationError("tool.input_validation_failed", validation.errors.join("; ")),
    };
  }

  // Idempotency: a cached success short-circuits re-execution of side effects.
  const idempotencyKey = idempotencyKeyFor(input);
  if (idempotencyKey && input.idempotencyStore) {
    const cached = input.idempotencyStore.get(idempotencyKey);
    if (cached !== undefined) {
      const at = isoTimestamp(now);
      return {
        ...base,
        idempotencyKey,
        attempts: input.attempt ?? 1,
        status: "succeeded",
        startedAt: at,
        endedAt: at,
        output: cached,
        metadata: { idempotentHit: true },
      };
    }
  }

  let attempt = input.attempt ?? 1;
  let result = await runToolAttempt(input, attempt, now, base, idempotencyKey);
  while (
    (result.status === "failed" || result.status === "timed_out") &&
    attempt < input.tool.retry.maxAttempts &&
    "error" in result &&
    isRetriable(result.error, input.tool.retry) &&
    !input.signal?.aborted
  ) {
    const delayMs = backoffDelayMs(input.tool.retry, attempt);
    // Surface the retry so it is observable, never a silent jump from attempt 1 to N.
    await input.onRetry?.({ attempt: attempt + 1, delayMs, cause: result.error });
    await sleep(delayMs, input.signal);
    if (input.signal?.aborted) {
      break;
    }
    attempt += 1;
    result = await runToolAttempt(input, attempt, now, base, idempotencyKey);
  }

  if (result.status === "succeeded" && idempotencyKey && input.idempotencyStore) {
    input.idempotencyStore.set(
      idempotencyKey,
      result.output,
      input.tool.idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    );
  }
  return result;
}

type ToolCallBaseFields = {
  readonly toolCallId: ToolCallId;
  readonly toolId: ToolId;
  readonly toolName: ToolCall["toolName"];
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly input: unknown;
  readonly queuedAt: Timestamp;
};

async function runToolAttempt<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
  attempt: number,
  now: () => Date,
  base: ToolCallBaseFields,
  idempotencyKey: string | null,
): Promise<ToolCall> {
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
    attempt,
    signal: controller.signal,
    logger: input.logger ?? NULL_LOGGER,
  };
  const keyField = idempotencyKey ? { idempotencyKey } : {};

  try {
    const output = await runWithLimits(
      input.tool.execute(input.input, context),
      input.tool.timeout.timeoutMs,
      controller,
    );

    // The tool ran, but a malformed output is still a failure — never pass an
    // unvalidated result back to the model.
    const outputValidation = validateJsonSchemaSubset(output, input.tool.outputSchema);
    if (!outputValidation.valid) {
      return {
        ...base,
        ...keyField,
        attempts: attempt,
        status: "failed",
        startedAt,
        endedAt: isoTimestamp(now),
        error: createValidationError(
          "tool.output_validation_failed",
          outputValidation.errors.join("; "),
        ),
      };
    }

    return {
      ...base,
      ...keyField,
      attempts: attempt,
      status: "succeeded",
      startedAt,
      endedAt: isoTimestamp(now),
      output,
    };
  } catch (error) {
    const normalized = asNormalizedError(error);
    return {
      ...base,
      ...keyField,
      attempts: attempt,
      status: toolFailureStatus(normalized),
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
