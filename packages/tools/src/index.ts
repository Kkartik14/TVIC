import { cancelledError, isNormalizedError, TvicThrowableError } from "@tvic/core";
import {
  timeoutError as createTimeoutError,
  toolError as createToolError,
  validationError as createValidationError,
} from "@tvic/core";
import { LeaseLostError } from "@tvic/core";
import type {
  NormalizedError,
  SessionId,
  Timestamp,
  ToolCall,
  ToolCallId,
  ToolDefinition,
  ToolExecutionContext,
  ToolTenant,
  ToolId,
  ToolIdempotencyLease,
  ToolIdempotencyQuarantineResult,
  ToolIdempotencyStore,
  ToolLogger,
  TurnId,
} from "@tvic/core";
import { validateJsonSchemaSubset, type SchemaValidationResult } from "./schema-validation.js";
import { serializabilityError, snapshotJsonValue, stableStringify } from "./serialization.js";
import {
  idempotencyIdentityFor,
  idempotencyClaimTtlMs,
  idempotencyIdentityWithLegacyFor,
  idempotencyRetentionTtlMs,
} from "./idempotency.js";

export {
  idempotencyIdentityFor,
  idempotencyKeyFor,
  idempotencyRequestHashFor,
} from "./idempotency.js";

export { stableStringify } from "./serialization.js";
export { snapshotJsonValue } from "./serialization.js";

export { validateJsonSchemaSubset } from "./schema-validation.js";
export type { SchemaValidationResult } from "./schema-validation.js";

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(id: ToolId): ToolDefinition | null;
  list(): readonly ToolDefinition[];
}

export class InMemoryToolRegistry implements ToolRegistry {
  readonly #tools = new Map<ToolId, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.#tools.has(tool.id)) {
      throw TvicThrowableError.from(
        createValidationError("tool.duplicate", `Tool already registered: ${tool.id}`),
      );
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

export { InMemoryToolIdempotencyStore } from "./idempotency-store.js";

function snapshotToolDefinition<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  const id = requireNonEmptyString(tool.id, "id") as ToolDefinition["id"];
  const name = requireNonEmptyString(tool.name, "name") as ToolDefinition["name"];
  const description = requireString(tool.description, "description");
  const version = requireNonEmptyString(tool.version, "version");
  const execute = tool.execute;
  if (typeof execute !== "function") {
    throw new TypeError("Tool execute must be a function");
  }
  const metadata = tool.metadata;
  const authScope = tool.authScope;
  const tags = tool.tags;
  const inputSchema = tool.inputSchema;
  const outputSchema = tool.outputSchema;
  const timeout = tool.timeout;
  const retry = tool.retry;
  const idempotency = tool.idempotency;
  if (metadata !== undefined && !isRecordObject(metadata)) {
    throw new TypeError("Tool metadata must be an object");
  }

  return {
    id,
    name,
    description,
    version,
    inputSchema: snapshotJsonSchema(inputSchema),
    outputSchema: snapshotJsonSchema(outputSchema),
    execute: execute.bind(tool),
    timeout: snapshotTimeoutPolicy(timeout),
    retry: snapshotRetryPolicy(retry),
    idempotency: snapshotIdempotencyPolicy(idempotency),
    ...(authScope !== undefined ? { authScope: snapshotStringArray(authScope, "authScope") } : {}),
    ...(tags !== undefined ? { tags: snapshotStringArray(tags, "tags") } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function snapshotJsonSchema<T extends Readonly<Record<string, unknown>>>(schema: T): T {
  if (!isRecordObject(schema)) {
    throw new TypeError("Tool schema must be an object");
  }
  try {
    return JSON.parse(stableStringify(schema)) as T;
  } catch {
    return schema;
  }
}

function snapshotTimeoutPolicy(policy: ToolDefinition["timeout"]): ToolDefinition["timeout"] {
  if (!isRecordObject(policy)) throw new TypeError("Tool timeout policy must be an object");
  const timeoutMs = policy.timeoutMs;
  const onTimeout = policy.onTimeout;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Tool timeout must be a positive safe integer in milliseconds");
  }
  if (onTimeout !== "fail" && onTimeout !== "interrupt") {
    throw new TypeError("Tool timeout action must be fail or interrupt");
  }
  return { timeoutMs, onTimeout };
}

function snapshotRetryPolicy(policy: ToolDefinition["retry"]): ToolDefinition["retry"] {
  if (!isRecordObject(policy)) throw new TypeError("Tool retry policy must be an object");
  const maxAttempts = policy.maxAttempts;
  const initialDelayMs = policy.initialDelayMs;
  const maxDelayMs = policy.maxDelayMs;
  const backoff = policy.backoff;
  const jitter = policy.jitter;
  const retryableErrorCodes = policy.retryableErrorCodes;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("Tool retry maxAttempts must be a positive safe integer");
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new TypeError("Tool retry initialDelayMs must be a non-negative finite number");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new TypeError("Tool retry maxDelayMs must be a non-negative finite number");
  }
  if (backoff !== "fixed" && backoff !== "linear" && backoff !== "exponential") {
    throw new TypeError("Tool retry backoff must be fixed, linear, or exponential");
  }
  if (typeof jitter !== "boolean") throw new TypeError("Tool retry jitter must be a boolean");
  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoff,
    jitter,
    ...(retryableErrorCodes !== undefined
      ? { retryableErrorCodes: snapshotStringArray(retryableErrorCodes, "retryableErrorCodes") }
      : {}),
  };
}

function snapshotIdempotencyPolicy(
  policy: ToolDefinition["idempotency"],
): ToolDefinition["idempotency"] {
  if (!isRecordObject(policy)) throw new TypeError("Tool idempotency policy must be an object");
  const enabled = policy.enabled;
  const keyTemplate = policy.keyTemplate;
  const ttlMs = policy.ttlMs;
  const legacyKeyCompatibility = policy.legacyKeyCompatibility;
  if (typeof enabled !== "boolean")
    throw new TypeError("Tool idempotency enabled must be a boolean");
  if (keyTemplate !== undefined && typeof keyTemplate !== "string") {
    throw new TypeError("Tool idempotency keyTemplate must be a string");
  }
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) {
    throw new TypeError("Tool idempotency ttlMs must be a positive safe integer");
  }
  if (legacyKeyCompatibility !== undefined && typeof legacyKeyCompatibility !== "boolean") {
    throw new TypeError("Tool idempotency legacyKeyCompatibility must be a boolean");
  }
  return {
    enabled,
    ...(keyTemplate !== undefined ? { keyTemplate } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(legacyKeyCompatibility !== undefined ? { legacyKeyCompatibility } : {}),
  };
}

function snapshotStringArray(value: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Tool ${field} must be an array of strings`);
  }
  return [...value];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Tool ${field} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const string = requireString(value, field);
  if (string.length === 0) throw new TypeError(`Tool ${field} must not be empty`);
  return string;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExecuteToolInput<TInput, TOutput> {
  readonly tool: ToolDefinition<TInput, TOutput>;
  readonly input: TInput;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly queuedAt?: Timestamp;
  readonly attempt?: number;
  readonly logger?: ToolLogger;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly lease?: ToolIdempotencyLease;
  readonly idempotencyStore?: ToolIdempotencyStore;
  readonly tenant?: ToolTenant;
}

export function toolInputError(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): NormalizedError | null {
  const serialization = serializabilityError(value, "input");
  if (serialization) return serialization;
  return toolInputSchemaError(value, schema);
}

function toolInputSchemaError(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): NormalizedError | null {
  let validation: SchemaValidationResult;
  try {
    validation = validateJsonSchemaSubset(value, schema);
  } catch (error) {
    return createValidationError(
      "tool.input_validation_failed",
      `Tool input validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!validation.valid) {
    return createValidationError("tool.input_validation_failed", validation.errors.join("; "));
  }
  return null;
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
  return cancelledError("tool.cancelled", "Tool execution cancelled");
}

function runWithLimits<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => rejectOnce(toolCancelledError());

    promise.then(resolveOnce, rejectOnce);
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createTimeoutError("tool.timeout", `Tool execution exceeded ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
}

export async function executeTool<TInput = unknown, TOutput = unknown>(
  input: ExecuteToolInput<TInput, TOutput>,
): Promise<ToolCall> {
  const now = input.now ?? (() => new Date());
  const queuedAt = input.queuedAt ?? isoTimestamp(now);
  let tool: ToolDefinition<TInput, TOutput>;
  try {
    tool = snapshotToolDefinition(input.tool);
  } catch (error) {
    return {
      toolCallId: input.toolCallId,
      toolId: input.tool.id,
      toolName: input.tool.name,
      sessionId: input.sessionId,
      turnId: input.turnId,
      input: null,
      queuedAt,
      attempts: input.attempt ?? 1,
      status: "failed",
      startedAt: queuedAt,
      endedAt: isoTimestamp(now),
      error: createValidationError(
        "tool.invalid_definition",
        `Tool definition cannot be snapshotted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  const initialBase = {
    toolCallId: input.toolCallId,
    toolId: tool.id,
    toolName: tool.name,
    sessionId: input.sessionId,
    turnId: input.turnId,
    input: input.input,
    queuedAt,
  } as const;
  const idempotencyConflict = (key: string): ToolCall => {
    const at = isoTimestamp(now);
    return {
      ...initialBase,
      idempotencyKey: key,
      attempts: input.attempt ?? 1,
      status: "failed",
      startedAt: at,
      endedAt: at,
      error: createValidationError(
        "tool.idempotency_conflict",
        "Idempotency key is already associated with a different request or session",
      ),
    };
  };

  let executionInput: TInput;
  try {
    executionInput = snapshotJsonValue(input.input);
  } catch (error) {
    return {
      ...initialBase,
      input: null,
      attempts: input.attempt ?? 1,
      status: "failed",
      startedAt: queuedAt,
      endedAt: isoTimestamp(now),
      error: createValidationError(
        "tool.input_not_serializable",
        `Tool input cannot be persisted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  const base = { ...initialBase, input: executionInput };
  const inputError = toolInputSchemaError(executionInput, tool.inputSchema);
  if (inputError) {
    return {
      ...base,
      attempts: input.attempt ?? 1,
      status: "failed",
      startedAt: queuedAt,
      endedAt: isoTimestamp(now),
      error: inputError,
    };
  }

  const executionTenant = input.tenant
    ? {
        ...input.tenant,
        ...(input.tenant.scopes ? { scopes: [...input.tenant.scopes] } : {}),
      }
    : undefined;
  const executionRequest = {
    ...input,
    tool,
    input: executionInput,
    ...(executionTenant ? { tenant: executionTenant } : {}),
  };
  let idempotencyKey: string | null;
  let storeIdempotencyKey: string | null;
  let idempotencyRequestHash = "";
  let legacyIdempotency: { readonly key: string; readonly requestHash: string } | null = null;
  let ownsIdempotencyClaim = false;
  const idempotencyTtlMs = idempotencyRetentionTtlMs(tool);
  const claimTtlMs = idempotencyClaimTtlMs(tool, idempotencyTtlMs);
  try {
    const identity = idempotencyIdentityWithLegacyFor(executionRequest);
    idempotencyKey = identity?.key ?? null;
    storeIdempotencyKey = idempotencyKey;
    if (identity && input.idempotencyStore) {
      idempotencyRequestHash = identity.requestHash;
      legacyIdempotency = identity.legacy;
    }
  } catch (error) {
    return {
      ...base,
      attempts: input.attempt ?? 1,
      status: "failed",
      startedAt: queuedAt,
      endedAt: isoTimestamp(now),
      error: createValidationError(
        "tool.input_not_serializable",
        `Tool input cannot be persisted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  if (idempotencyKey && input.idempotencyStore) {
    if (legacyIdempotency && legacyIdempotency.key !== idempotencyKey) {
      const legacyLookup = await input.idempotencyStore.lookup(
        legacyIdempotency.key,
        legacyIdempotency.requestHash,
        input.sessionId,
        input.lease,
      );
      if (legacyLookup.status === "conflict") {
        return idempotencyConflict(idempotencyKey);
      }
      if (legacyLookup.status === "found") {
        return idempotencyConflict(idempotencyKey);
      }
    }
    const claim = await input.idempotencyStore.claim({
      key: storeIdempotencyKey ?? idempotencyKey,
      sessionId: input.sessionId,
      ...(input.lease ? { lease: input.lease } : {}),
      toolId: tool.id,
      toolVersion: tool.version,
      requestHash: idempotencyRequestHash,
      owner: String(input.toolCallId),
      ttlMs: claimTtlMs,
    });
    if (claim.status === "conflict") {
      return idempotencyConflict(idempotencyKey);
    }
    if (claim.status === "claimed") ownsIdempotencyClaim = true;
    if (claim.status === "in_progress") {
      const at = isoTimestamp(now);
      return {
        ...base,
        idempotencyKey,
        attempts: input.attempt ?? 1,
        status: "failed",
        startedAt: at,
        endedAt: at,
        error: createValidationError(
          "tool.idempotency_in_progress",
          `Idempotent tool call is already running: ${idempotencyKey}`,
        ),
      };
    }
    if (claim.status === "succeeded") {
      const at = isoTimestamp(now);
      return {
        ...base,
        idempotencyKey,
        attempts: input.attempt ?? 1,
        status: "succeeded",
        startedAt: at,
        endedAt: at,
        output: claim.record.output,
        metadata: { idempotentHit: true },
      };
    }
    if (claim.status === "terminal") {
      const status = claim.record.status;
      if (status === "claimed" || status === "succeeded") {
        return idempotencyConflict(idempotencyKey);
      }
      const at = isoTimestamp(now);
      const terminalError =
        claim.record.error ??
        createToolError(
          "tool.idempotency_terminal",
          "This action already ended and will not be repeated with the same idempotency key",
          { retriable: false },
        );
      return {
        ...base,
        idempotencyKey,
        attempts: input.attempt ?? 1,
        status,
        startedAt: at,
        endedAt: at,
        error: { ...terminalError, retriable: false },
        metadata: {
          idempotentHit: true,
          executionAmbiguous: true,
          recoveryPolicy: "do_not_replay",
        },
      };
    }
  }

  let attempt = input.attempt ?? 1;
  let executionStarted = false;
  const markExecutionStarted = (): void => {
    executionStarted = true;
  };
  let result = await runToolAttempt(
    executionRequest,
    attempt,
    now,
    base,
    idempotencyKey,
    markExecutionStarted,
  );
  let cancelledDuringRetryDelay = false;
  while (
    (result.status === "failed" || result.status === "timed_out") &&
    attempt < tool.retry.maxAttempts &&
    "error" in result &&
    isRetriable(result.error, tool.retry) &&
    !input.signal?.aborted
  ) {
    const delayMs = backoffDelayMs(tool.retry, attempt);
    await sleep(delayMs, input.signal);
    if (input.signal?.aborted) {
      cancelledDuringRetryDelay = true;
      break;
    }
    attempt += 1;
    result = await runToolAttempt(
      executionRequest,
      attempt,
      now,
      base,
      idempotencyKey,
      markExecutionStarted,
    );
  }

  if (cancelledDuringRetryDelay && (result.status === "failed" || result.status === "timed_out")) {
    result = {
      ...base,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      attempts: result.attempts,
      status: "cancelled",
      startedAt: result.startedAt,
      endedAt: isoTimestamp(now),
      error: toolCancelledError(),
      metadata: { ...(result.metadata ?? {}), cancellationPhase: "retry_backoff" },
    };
  }

  if (idempotencyKey && input.idempotencyStore) {
    if (ownsIdempotencyClaim && !executionStarted && result.status === "cancelled") {
      try {
        await input.idempotencyStore.releaseClaim({
          key: storeIdempotencyKey ?? idempotencyKey,
          requestHash: idempotencyRequestHash,
          owner: String(input.toolCallId),
          sessionId: input.sessionId,
          ...(input.lease ? { lease: input.lease } : {}),
        });
      } catch {}
      return result;
    }
    if (
      result.status === "succeeded" ||
      result.status === "failed" ||
      result.status === "timed_out" ||
      result.status === "cancelled"
    ) {
      try {
        await input.idempotencyStore.complete(
          storeIdempotencyKey ?? idempotencyKey,
          idempotencyRequestHash,
          {
            status: result.status,
            ttlMs: idempotencyTtlMs,
            owner: String(input.toolCallId),
            sessionId: input.sessionId,
            ...(input.lease ? { lease: input.lease } : {}),
            ...(result.status === "succeeded"
              ? { output: result.output }
              : { error: result.error }),
          },
        );
      } catch {
        return idempotencyCompletionFailure(result, now);
      }
    }
  }
  return result;
}

export async function quarantineRecoveredToolCall<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
  lease: ToolIdempotencyLease,
  error: NormalizedError,
): Promise<ToolIdempotencyQuarantineResult | null> {
  const store = input.idempotencyStore;
  if (!store) return null;

  let tool: ToolDefinition<TInput, TOutput>;
  let executionInput: TInput;
  try {
    tool = snapshotToolDefinition(input.tool);
    executionInput = snapshotJsonValue(input.input);
  } catch {
    return null;
  }
  const executionTenant = input.tenant
    ? {
        ...input.tenant,
        ...(input.tenant.scopes ? { scopes: [...input.tenant.scopes] } : {}),
      }
    : undefined;
  const executionRequest = {
    ...input,
    tool,
    input: executionInput,
    lease,
    ...(executionTenant ? { tenant: executionTenant } : {}),
  };
  const identity = idempotencyIdentityFor(executionRequest);
  if (!identity) return null;

  const ttlMs = idempotencyRetentionTtlMs(tool);
  return store.quarantine({
    key: identity.key,
    sessionId: input.sessionId,
    lease,
    toolId: tool.id,
    toolVersion: tool.version,
    requestHash: identity.requestHash,
    owner: String(input.toolCallId),
    ttlMs,
    error,
  });
}

function idempotencyCompletionFailure(result: ToolCall, now: () => Date): ToolCall {
  const at = isoTimestamp(now);
  const start = "startedAt" in result ? result.startedAt : result.queuedAt;
  const { output: _unrecordedOutput, ...withoutOutput } = result as ToolCall & {
    readonly output?: unknown;
  };
  return {
    ...withoutOutput,
    status: "failed",
    startedAt: start,
    endedAt: at,
    error: createToolError(
      "tool.idempotency_result_unrecorded",
      "The action may have completed, but its result could not be recorded. Do not repeat it with a new key until it is reconciled.",
      { retriable: false },
    ),
    metadata: {
      ...(result.metadata ?? {}),
      executionAmbiguous: true,
      recoveryPolicy: "do_not_replay",
      resultRecordFailed: true,
    },
  };
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
  onExecutionStart: () => void,
): Promise<ToolCall> {
  const controller = new AbortController();
  let detachParentSignal = (): void => undefined;
  if (input.signal) {
    if (input.signal.aborted) {
      controller.abort();
    } else {
      const onParentAbort = (): void => controller.abort();
      input.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => input.signal?.removeEventListener("abort", onParentAbort);
    }
  }
  const startedAt = isoTimestamp(now);
  const context: ToolExecutionContext = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    attempt,
    signal: controller.signal,
    logger: input.logger ?? NULL_LOGGER,
    ...(input.tenant ? { tenant: input.tenant } : {}),
  };
  const keyField = idempotencyKey ? { idempotencyKey } : {};

  try {
    if (controller.signal.aborted) {
      const error = toolCancelledError();
      return {
        ...base,
        ...keyField,
        attempts: attempt,
        status: "cancelled",
        startedAt,
        endedAt: isoTimestamp(now),
        error,
      };
    }
    onExecutionStart();
    const rawOutput = await runWithLimits(
      input.tool.execute(input.input, context),
      input.tool.timeout.timeoutMs,
      controller,
    );

    let output: TOutput;
    try {
      output = snapshotJsonValue(rawOutput);
    } catch (error) {
      return {
        ...base,
        ...keyField,
        attempts: attempt,
        status: "failed",
        startedAt,
        endedAt: isoTimestamp(now),
        error: createValidationError(
          "tool.output_not_serializable",
          `Tool output cannot be persisted: ${error instanceof Error ? error.message : String(error)}`,
        ),
        metadata: { executionAmbiguous: true, recoveryPolicy: "do_not_replay" },
      };
    }
    let outputValidation: SchemaValidationResult;
    try {
      outputValidation = validateJsonSchemaSubset(output, input.tool.outputSchema);
    } catch (error) {
      return {
        ...base,
        ...keyField,
        attempts: attempt,
        status: "failed",
        startedAt,
        endedAt: isoTimestamp(now),
        error: createValidationError(
          "tool.output_validation_failed",
          `Tool output validation failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
        metadata: { executionAmbiguous: true, recoveryPolicy: "do_not_replay" },
      };
    }
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
        metadata: { executionAmbiguous: true, recoveryPolicy: "do_not_replay" },
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
    const ambiguous = normalized.category === "timeout" || normalized.category === "cancelled";
    const safeError = ambiguous ? { ...normalized, retriable: false } : normalized;
    return {
      ...base,
      ...keyField,
      attempts: attempt,
      status: toolFailureStatus(safeError),
      startedAt,
      endedAt: isoTimestamp(now),
      error: safeError,
      metadata: { executionAmbiguous: true, recoveryPolicy: "do_not_replay" },
    };
  } finally {
    detachParentSignal();
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
    return {
      name: error.name,
      code: error.code,
      category: error.category,
      message: error.message,
      retriable: error.retriable,
      ...(error.provider !== undefined ? { provider: error.provider } : {}),
    };
  }
  if (isLeaseLostError(error)) {
    return createToolError("tool.lease_lost", "Tool execution lost its session lease", {
      retriable: false,
    });
  }
  return createToolError("tool.execution_failed", "Tool execution failed", { retriable: false });
}

function isLeaseLostError(error: unknown): boolean {
  if (error instanceof LeaseLostError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "LEASE_LOST"
  );
}

export type { ToolCall, ToolDefinition, ToolExecutionContext };
