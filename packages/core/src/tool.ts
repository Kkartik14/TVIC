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
 * Optional tenant identity propagated into every tool execution. The runtime
 * populates this from the session attachment's `memoryUserId` /
 * `organizationId` / `workflowId`. The tool author reads `tenant.userId`
 * inside `execute` to enforce their own auth — TVIC ships no RBAC layer
 * (that is a tenant concern: the customer has an IdP).
 */
export interface ToolTenant {
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  /** Tenant-supplied scopes (e.g., "crm.read", "billing.write"). */
  readonly scopes?: readonly string[];
}

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
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
   * `ToolExecutionContext`). The `authScope` field is kept as a no-op
   * typedef for one release; the runtime never enforced it. Migration:
   * read `ctx.tenant?.scopes` inside `execute` and enforce your own
   * auth.
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
  readonly expiresAtMs: number;
  readonly output?: unknown;
  readonly error?: NormalizedError;
}

/** Ownership context used to fence durable idempotency claims to a session. */
export interface ToolIdempotencyLease {
  readonly sessionId: SessionId;
  readonly holder: string;
  readonly fence: number;
}

export interface ToolIdempotencyClaim {
  readonly key: string;
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
  | { readonly status: "in_progress"; readonly record: ToolIdempotencyRecord }
  | { readonly status: "conflict"; readonly record: ToolIdempotencyRecord };

export interface ToolIdempotencyOutcome {
  readonly status: Exclude<ToolIdempotencyStatus, "claimed">;
  readonly ttlMs: number;
  readonly owner: string;
  readonly lease?: ToolIdempotencyLease;
  readonly output?: unknown;
  readonly error?: NormalizedError;
}

export interface ToolIdempotencyStore {
  lookup(key: string, requestHash: string): Promise<ToolIdempotencyRecord | null>;
  claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult>;
  complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void>;
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
