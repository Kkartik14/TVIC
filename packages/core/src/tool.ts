import type { NormalizedError } from "./errors.js";
import type {
  OrganizationId,
  SessionId,
  ToolCallId,
  ToolId,
  ToolName,
  TurnId,
  UserId,
  WorkflowId,
} from "./ids.js";
import type { IdempotencyPolicy, RetryPolicy, TimeoutPolicy } from "./policies.js";
import type { Timestamp } from "./timestamp.js";

export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

/**
 * Optional tenant context for tool execution. The session runtime populates
 * user, organization, and workflow IDs from the attachment. It does not
 * populate scopes; direct `executeTool()` callers may provide them. These
 * values are context, not authorization grants. TVIC ships no RBAC layer.
 */
export interface ToolTenant {
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  /** Scopes supplied by a direct executor caller; the session runtime omits them. */
  readonly scopes?: readonly string[];
}

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  /** Stable, bounded TVIC key for this tool request within the current session. */
  readonly idempotencyKey?: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly logger: ToolLogger;
  readonly tenant?: ToolTenant;
}

export interface ToolLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export type ToolExecutor<TInput, TOutput> = (
  input: TInput,
  ctx: ToolExecutionContext,
) => Promise<TOutput>;

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly id: ToolId;
  readonly name: ToolName;
  readonly description: string;
  readonly version: string;
  readonly inputSchema: JsonSchemaDocument;
  readonly outputSchema: JsonSchemaDocument;
  readonly timeout: TimeoutPolicy;
  readonly retry: RetryPolicy;
  readonly idempotency: IdempotencyPolicy;
  /**
   * @deprecated Use `ctx.tenant` (the `ToolTenant` field on
   * `ToolExecutionContext`). This field is retained for source compatibility
   * but is a no-op: the runtime neither enforces it nor copies it to
   * `ctx.tenant.scopes`. The session runtime supplies identity IDs only; apply
   * authorization in `execute`.
   */
  readonly authScope?: readonly string[];
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly execute: ToolExecutor<TInput, TOutput>;
}

export type ToolCallStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export type ToolIdempotencyStatus = "claimed" | "succeeded" | "failed" | "timed_out" | "cancelled";

export interface ToolIdempotencyRecord {
  readonly key: string;
  readonly sessionId?: SessionId;
  readonly toolId?: ToolId;
  readonly toolVersion?: string;
  readonly requestHash: string;
  readonly status: ToolIdempotencyStatus;
  readonly owner?: string;
  readonly claimedFence?: number;
  readonly claimedGenerationId?: string;
  readonly expiresAtMs: number;
  readonly output?: unknown;
  readonly error?: NormalizedError;
}

/** Ownership context used to fence durable idempotency claims to a session. */
export interface ToolIdempotencyLease {
  readonly sessionId: SessionId;
  readonly holder: string;
  readonly fence: number;
  readonly generationId: string;
}

export interface ToolIdempotencyClaim {
  readonly key: string;
  /** Session scope when the caller does not have a process lease. */
  readonly sessionId?: SessionId;
  readonly lease?: ToolIdempotencyLease;
  readonly toolId?: ToolId;
  readonly toolVersion?: string;
  readonly requestHash: string;
  readonly owner: string;
  readonly ttlMs: number;
}

export type ToolIdempotencyClaimResult =
  | { readonly status: "claimed"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "succeeded"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "terminal"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "in_progress"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "conflict" };

export type ToolIdempotencyLookupResult =
  | { readonly status: "found"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "conflict" }
  | { readonly status: "missing" };

export interface ToolIdempotencyOutcome {
  readonly status: Exclude<ToolIdempotencyStatus, "claimed">;
  readonly ttlMs: number;
  readonly owner: string;
  /** Session scope for an unfenced direct executor call. */
  readonly sessionId?: SessionId;
  readonly lease?: ToolIdempotencyLease;
  readonly output?: unknown;
  readonly error?: NormalizedError;
}

export interface ToolIdempotencyQuarantine {
  readonly key: string;
  readonly sessionId: SessionId;
  readonly lease: ToolIdempotencyLease;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly requestHash: string;
  readonly owner: string;
  readonly ttlMs: number;
  readonly error: NormalizedError;
}

export type ToolIdempotencyQuarantineResult =
  | { readonly status: "quarantined"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "succeeded"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "terminal"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "in_progress"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "conflict" };

export interface ToolIdempotencyStore {
  /**
   * Looks up an active key scoped to its request hash and optional session.
   * A conflict response contains no other request's record or payload.
   */
  lookup(
    key: string,
    requestHash: string,
    sessionId?: SessionId,
  ): Promise<ToolIdempotencyLookupResult>;
  claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult>;
  complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void>;
  /** Atomically prevent a recovered ambiguous call from being replayed. */
  quarantine(input: ToolIdempotencyQuarantine): Promise<ToolIdempotencyQuarantineResult>;
}

interface ToolCallBase {
  readonly toolCallId: ToolCallId;
  readonly toolId: ToolId;
  readonly toolName: ToolName;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly input: unknown;
  readonly attempts: number;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface QueuedToolCall extends ToolCallBase {
  readonly status: "queued";
  readonly queuedAt: Timestamp;
}

export interface RunningToolCall extends ToolCallBase {
  readonly status: "running";
  readonly queuedAt: Timestamp;
  readonly startedAt: Timestamp;
}

export interface SucceededToolCall extends ToolCallBase {
  readonly status: "succeeded";
  readonly queuedAt: Timestamp;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
  readonly output: unknown;
}

export type FailedToolCallStatus = "failed" | "timed_out" | "cancelled";

export interface FailedToolCall extends ToolCallBase {
  readonly status: FailedToolCallStatus;
  readonly queuedAt: Timestamp;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
  readonly error: NormalizedError;
}

export type ToolCall = QueuedToolCall | RunningToolCall | SucceededToolCall | FailedToolCall;

export type TerminalToolCall = SucceededToolCall | FailedToolCall;
