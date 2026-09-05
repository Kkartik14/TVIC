import {
  cancelledError,
  isNormalizedError,
  normalizeUnknownError,
  TvicThrowableError,
} from "@tvic/core";
import {
  timeoutError as createTimeoutError,
  validationError as createValidationError,
} from "@tvic/core";
import { LeaseLostError, RecordConflictError, RecordNotFoundError } from "@tvic/core";
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
  ToolIdempotencyClaim,
  ToolIdempotencyClaimResult,
  ToolIdempotencyLease,
  ToolIdempotencyOutcome,
  ToolIdempotencyRecord,
  ToolIdempotencyStore,
  ToolLogger,
  TurnId,
} from "@tvic/core";
import { validateJsonSchemaSubset, type SchemaValidationResult } from "./schema-validation.js";
import {
  serializabilityError,
  stableStringify,
  stableStringifyForPersistence,
} from "./serialization.js";

export { stableStringify } from "./serialization.js";

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

export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #entries = new Map<string, ToolIdempotencyRecord>();
  readonly #now: () => number;
  readonly #readLease:
    | ((sessionId: SessionId) => Promise<{
        readonly holder: string;
        readonly fence: number;
        readonly expiresAtMs: number;
      } | null>)
    | undefined;

  constructor(
    now: () => number = () => Date.now(),
    readLease?: (sessionId: SessionId) => Promise<{
      readonly holder: string;
      readonly fence: number;
      readonly expiresAtMs: number;
    } | null>,
  ) {
    this.#now = now;
    this.#readLease = readLease;
  }

  async lookup(key: string, requestHash: string): Promise<ToolIdempotencyRecord | null> {
    const found = this.#active(key);
    if (!found) return null;
    if (found.requestHash !== requestHash) {
      return found;
    }
    return found;
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    await this.#assertLease(input.lease);
    const existing = this.#active(input.key);
    if (existing) {
      if (
        (existing.toolId && input.toolId && existing.toolId !== input.toolId) ||
        (existing.toolVersion && input.toolVersion && existing.toolVersion !== input.toolVersion)
      ) {
        return { status: "conflict", record: existing };
      }
      if (existing.requestHash !== input.requestHash) {
        return { status: "conflict", record: existing };
      }
      if (existing.status === "succeeded") return { status: "succeeded", record: existing };
      const staleClaim =
        existing.status === "claimed" &&
        input.lease !== undefined &&
        existing.sessionId === input.lease.sessionId &&
        existing.claimedFence !== undefined &&
        existing.claimedFence < input.lease.fence;
      if (existing.status === "claimed" && existing.owner !== input.owner && !staleClaim) {
        return { status: "in_progress", record: existing };
      }
      if (existing.status === "claimed" && !staleClaim)
        return { status: "claimed", record: existing };
    }
    const record: ToolIdempotencyRecord = {
      key: input.key,
      ...(input.lease ? { sessionId: input.lease.sessionId, claimedFence: input.lease.fence } : {}),
      ...(input.toolId ? { toolId: input.toolId } : {}),
      ...(input.toolVersion ? { toolVersion: input.toolVersion } : {}),
      requestHash: input.requestHash,
      status: "claimed",
      owner: input.owner,
      expiresAtMs: this.#now() + input.ttlMs,
    };
    this.#entries.set(input.key, record);
    return { status: "claimed", record };
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    await this.#assertLease(outcome.lease);
    const existing = this.#active(key);
    if (!existing) throw new RecordNotFoundError(`idempotency:${key}`);
    if (existing.requestHash !== requestHash) {
      throw new RecordConflictError(`idempotency:${key}`);
    }
    if (
      (existing.sessionId !== undefined &&
        (!outcome.lease || existing.sessionId !== outcome.lease.sessionId)) ||
      (existing.claimedFence !== undefined &&
        (!outcome.lease || existing.claimedFence !== outcome.lease.fence))
    ) {
      throw new LeaseLostError(existing.sessionId ?? outcome.lease?.sessionId ?? "unknown");
    }
    if (
      (outcome.owner && existing.owner !== outcome.owner) ||
      (outcome.lease && existing.sessionId && existing.sessionId !== outcome.lease.sessionId)
    ) {
      throw new RecordConflictError(`idempotency:${key}`);
    }
    if (existing.status !== "claimed") {
      const sameOutcome =
        existing.status === outcome.status &&
        stableStringify(existing.output) === stableStringify(outcome.output) &&
        stableStringify(existing.error) === stableStringify(outcome.error);
      if (sameOutcome) return;
      throw new RecordConflictError(`idempotency:${key}`);
    }
    this.#entries.set(key, {
      ...existing,
      key,
      requestHash,
      status: outcome.status,
      expiresAtMs: this.#now() + outcome.ttlMs,
      ...(outcome.owner ? { owner: outcome.owner } : {}),
      ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  async #assertLease(lease: ToolIdempotencyLease | undefined): Promise<void> {
    if (!lease) return;
    if (!this.#readLease) throw new LeaseLostError(lease.sessionId);
    const current = await this.#readLease(lease.sessionId);
    if (
      !current ||
      current.holder !== lease.holder ||
      current.fence !== lease.fence ||
      current.expiresAtMs <= this.#now()
    ) {
      throw new LeaseLostError(lease.sessionId);
    }
  }

  #active(key: string): ToolIdempotencyRecord | null {
    const found = this.#entries.get(key);
    if (!found) return null;
    if (found.expiresAtMs <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    return found;
  }
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
   * Tenant identity propagated into the tool's `ctx.tenant`. The runtime
   * populates this from the session attachment's `memoryUserId` /
   * `organizationId` / `workflowId` so the tool can enforce its own
   * auth/RBAC. TVIC ships no auth layer; the tool author reads
   * `ctx.tenant` and decides.
   */
  readonly tenant?: ToolTenant;
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;

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

export function idempotencyKeyFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): string | null {
  const policy = input.tool.idempotency;
  if (!policy.enabled) {
    return null;
  }
  const serializedInput = stableStringifyForPersistence(input.input);
  const logicalKey = policy.keyTemplate
    ? policy.keyTemplate
        .replaceAll("{sessionId}", String(input.sessionId))
        .replaceAll("{turnId}", String(input.turnId))
        .replaceAll("{toolId}", String(input.tool.id))
        .replaceAll("{toolVersion}", input.tool.version)
        .replaceAll("{input}", serializedInput)
    : serializedInput;
  // The tool identity/version is always part of the canonical key, even when
  // a caller supplies a custom template. A deployment may roll a tool without
  // allowing an old implementation's cached outcome to satisfy the new one.
  return `${String(input.tool.id)}@${input.tool.version}:${logicalKey}`;
}

/**
 * The request hash paired with idempotencyKeyFor. Keep this beside the key
 * builder so execution and crash recovery cannot silently hash different
 * request shapes.
 */
export function idempotencyRequestHashFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): string {
  return stableStringifyForPersistence({
    toolId: input.tool.id,
    toolVersion: input.tool.version,
    input: input.input,
  });
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
      if (timeout) clearTimeout(timeout);
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

  const base = {
    toolCallId: input.toolCallId,
    toolId: input.tool.id,
    toolName: input.tool.name,
    sessionId: input.sessionId,
    turnId: input.turnId,
    input: input.input,
    queuedAt,
  } as const;

  const inputError = toolInputError(input.input, input.tool.inputSchema);
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

  // Idempotency: a cached success short-circuits re-execution of side effects.
  let idempotencyKey: string | null;
  let idempotencyRequestHash = "";
  try {
    idempotencyKey = idempotencyKeyFor(input);
    if (idempotencyKey && input.idempotencyStore) {
      idempotencyRequestHash = idempotencyRequestHashFor(input);
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
    const claim = await input.idempotencyStore.claim({
      key: idempotencyKey,
      ...(input.lease ? { lease: input.lease } : {}),
      toolId: input.tool.id,
      toolVersion: input.tool.version,
      requestHash: idempotencyRequestHash,
      owner: String(input.toolCallId),
      ttlMs: input.tool.idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
    });
    if (claim.status === "conflict") {
      const at = isoTimestamp(now);
      return {
        ...base,
        idempotencyKey,
        attempts: input.attempt ?? 1,
        status: "failed",
        startedAt: at,
        endedAt: at,
        error: createValidationError(
          "tool.idempotency_conflict",
          `Idempotency key already belongs to a different request: ${idempotencyKey}`,
        ),
      };
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
    await sleep(delayMs, input.signal);
    if (input.signal?.aborted) {
      break;
    }
    attempt += 1;
    result = await runToolAttempt(input, attempt, now, base, idempotencyKey);
  }

  if (idempotencyKey && input.idempotencyStore) {
    if (result.status === "succeeded") {
      await input.idempotencyStore.complete(idempotencyKey, idempotencyRequestHash, {
        status: result.status,
        ttlMs: input.tool.idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
        owner: String(input.toolCallId),
        ...(input.lease ? { lease: input.lease } : {}),
        output: result.output,
      });
    } else if (
      result.status === "failed" ||
      result.status === "timed_out" ||
      result.status === "cancelled"
    ) {
      await input.idempotencyStore.complete(idempotencyKey, idempotencyRequestHash, {
        status: result.status,
        ttlMs: input.tool.idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
        owner: String(input.toolCallId),
        ...(input.lease ? { lease: input.lease } : {}),
        error: result.error,
      });
    }
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
    const output = await runWithLimits(
      input.tool.execute(input.input, context),
      input.tool.timeout.timeoutMs,
      controller,
    );

    // The tool ran, but a malformed output is still a failure, so never pass an
    // unvalidated result back to the model.
    const outputSerializationError = serializabilityError(output, "output");
    if (outputSerializationError) {
      return {
        ...base,
        ...keyField,
        attempts: attempt,
        status: "failed",
        startedAt,
        endedAt: isoTimestamp(now),
        error: outputSerializationError,
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
      ...(ambiguous
        ? {
            metadata: {
              executionAmbiguous: true,
              recoveryPolicy: "do_not_replay",
            },
          }
        : {}),
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
    return error;
  }
  return normalizeUnknownError(error, {
    code: "tool.execution_failed",
    category: "tool",
    retriable: true,
  });
}

export type { ToolCall, ToolDefinition, ToolExecutionContext };
