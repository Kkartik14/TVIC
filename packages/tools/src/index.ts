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
import { serializabilityError, snapshotJsonValue } from "./serialization.js";
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
  return {
    ...tool,
    inputSchema: snapshotJsonValue(tool.inputSchema),
    outputSchema: snapshotJsonValue(tool.outputSchema),
    timeout: { ...tool.timeout },
    retry: {
      ...tool.retry,
      ...(tool.retry.retryableErrorCodes
        ? { retryableErrorCodes: [...tool.retry.retryableErrorCodes] }
        : {}),
    },
    idempotency: { ...tool.idempotency },
  };
}

export interface ExecuteToolInput<TInput, TOutput> {
  readonly tool: ToolDefinition<TInput, TOutput>;
  readonly input: TInput;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  /** Reuses the durable queue timestamp when the runtime has already persisted the call. */
  readonly queuedAt?: Timestamp;
  readonly attempt?: number;
  readonly logger?: ToolLogger;
  readonly now?: () => Date;
  /** Aborts the tool call (e.g. on barge-in). The tool's ctx.signal mirrors this. */
  readonly signal?: AbortSignal;
  /** Current process lease used to fence durable idempotency operations. */
  readonly lease?: ToolIdempotencyLease;
  /** Honours the tool's idempotency policy when provided. */
  readonly idempotencyStore?: ToolIdempotencyStore;
  /**
   * Tenant context propagated into `ctx.tenant`. The session runtime provides
   * attachment user, organization, and workflow IDs, but not scopes. Context
   * is not an authorization grant; TVIC ships no auth layer.
   */
  readonly tenant?: ToolTenant;
}

/**
 * Performs the input checks that must complete before a tool call reaches a
 * durable store. Keeping this at the tools boundary lets the runtime reject
 * provider-produced values before it creates queued/running records.
 */
export function toolInputError(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): NormalizedError | null {
  const serialization = serializabilityError(value, "input");
  if (serialization) return serialization;

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

/**
 * Races tool execution against its timeout and against external abort, so a
 * blocked tool can never outlive the turn that requested it.
 */
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

    // Attach the rejection handler before checking an already-aborted signal;
    // otherwise a tool that rejects after an immediate cancellation can become
    // an unhandled rejection even though cancellation already won the race.
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
      // Notify the provider after the timeout result has won the race. This
      // prevents an abort-aware tool from converting a timeout into a
      // cancellation result.
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
  const inputError = toolInputError(executionInput, tool.inputSchema);
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

  // Copy scopes as well so async store lookups cannot change the tenant
  // identity before the executor runs.
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
  // Idempotency: a cached success short-circuits re-execution of side effects.
  let idempotencyKey: string | null;
  let storeIdempotencyKey: string | null;
  let idempotencyRequestHash = "";
  let legacyIdempotency: { readonly key: string; readonly requestHash: string } | null = null;
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
      );
      if (legacyLookup.status === "conflict") {
        return idempotencyConflict(idempotencyKey);
      }
      if (legacyLookup.status === "found") {
        // Legacy records never stored tenant identity. The current request,
        // with or without tenant context, cannot establish ownership of that
        // cached result. Fail closed and let the row expire.
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
      return {
        ...base,
        idempotencyKey,
        attempts: input.attempt ?? 1,
        status,
        startedAt: at,
        endedAt: at,
        error: createToolError(
          "tool.idempotency_terminal",
          "This action already ended and will not be repeated with the same idempotency key",
          { retriable: false },
        ),
        metadata: {
          idempotentHit: true,
          executionAmbiguous: true,
          recoveryPolicy: "do_not_replay",
        },
      };
    }
  }

  let attempt = input.attempt ?? 1;
  let result = await runToolAttempt(executionRequest, attempt, now, base, idempotencyKey);
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
    result = await runToolAttempt(executionRequest, attempt, now, base, idempotencyKey);
  }

  // A cancellation that arrives between attempts must have the same terminal
  // meaning as one that arrives while an attempt is running. Returning the
  // previous retriable failure would make callers believe the operation merely
  // failed and could cause an unintended replay.
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

/**
 * Takes ownership of an interrupted idempotent call and records a terminal
 * outcome so a later generation cannot mistake the old claim for permission
 * to repeat an external side effect.
 */
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
    const rawOutput = await runWithLimits(
      input.tool.execute(input.input, context),
      input.tool.timeout.timeoutMs,
      controller,
    );

    // Detach the executor-owned value before validation or an asynchronous
    // idempotency write. The executor may retain and mutate its result later.
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
    // The structured error was explicitly created by tool code. Retain its
    // public message and classification while dropping untrusted cause and
    // metadata payloads before they reach the model or durable records.
    return {
      name: error.name,
      code: error.code,
      category: error.category,
      message: error.message,
      retriable: error.retriable,
      ...(error.provider !== undefined ? { provider: error.provider } : {}),
    };
  }
  // R2-04 LOCKED: session-lease loss inside tool execution maps to
  // failed(lease_lost) with lease identity, never to barge_in/cancelled and
  // never to a generic error slug. Non-retriable: retrying under a lost
  // fence would fork ownership.
  if (isLeaseLostError(error)) {
    return createToolError("tool.lease_lost", "Tool execution lost its session lease", {
      retriable: false,
    });
  }
  return createToolError("tool.execution_failed", "Tool execution failed", { retriable: true });
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
