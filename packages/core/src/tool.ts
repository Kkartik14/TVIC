import type { NormalizedError } from "./errors.js";
import type { SessionId, ToolCallId, ToolId, ToolName, TurnId } from "./ids.js";
import type { IdempotencyPolicy, RetryPolicy, TimeoutPolicy } from "./policies.js";
import type { Timestamp } from "./timestamp.js";

export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export interface ToolExecutionContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: ToolCallId;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly logger: ToolLogger;
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
