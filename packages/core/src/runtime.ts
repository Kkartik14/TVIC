import type { Agent } from "./agent.js";
import type { Call } from "./call.js";
import type { Clock } from "./clock.js";
import type { ChannelKind } from "./direction.js";
import type { ErrorCategory, NormalizedError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { Memory, MemoryKind, MemoryScope } from "./memory.js";
import type { OrganizationId, SessionId, ToolCallId, TurnId, UserId, WorkflowId } from "./ids.js";
import type {
  DurableRuntimeStore,
  SessionLease,
  SessionStore,
  ToolCallStore,
  TurnStore,
} from "./dal.js";
import type {
  ActiveSession,
  Session,
  SessionCancellationReason,
  TerminalSession,
} from "./session.js";
import type {
  QueuedToolCall,
  RunningToolCall,
  TerminalToolCall,
  ToolCall,
  ToolIdempotencyStore,
} from "./tool.js";
import type {
  TerminalTurn,
  Turn,
  TurnCancellationReason,
  TurnStatus,
  TurnInput,
  TurnLatency,
  TurnOutputDelivery,
  TurnOutput,
} from "./turn.js";

export interface RuntimeOptions {
  readonly sessionStore?: SessionStore;
  readonly turnStore?: TurnStore;
  readonly toolCallStore?: ToolCallStore;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly durableStore?: DurableRuntimeStore;
  readonly durableStoreOwnership?: "runtime" | "caller";
  readonly durablePolicy?: Partial<DurableRuntimePolicy>;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  readonly holderId?: string;
  readonly onDurableMetric?: (metric: DurableRuntimeMetric) => void;
  readonly memory?: Memory;
  readonly sessionMemoryFinalizeTimeoutMs?: number;
  readonly sessionEndHookTimeoutMs?: number;
  readonly preCallContextResolver?: PreCallContextResolver;
  readonly defaultOrganizationId?: OrganizationId;
  readonly defaultWorkflowId?: WorkflowId;
  readonly onSessionEnd?: (event: SessionEndEvent) => void | Promise<void>;
  readonly sessionMetricsRecorder?: SessionMetricsRecorder;
  /** Optional metadata-only observation sink; it must only enqueue in bounded memory. */
  readonly observationSink?: RuntimeObservationSink;
  /** Maximum buffered observations before overflow; must be between 1 and 4096. */
  readonly observationQueueCapacity?: number;
  readonly healthCheck?: () => Promise<HealthSnapshot>;
  readonly onShutdownStart?: (state: {
    readonly activeSessions: readonly SessionId[];
  }) => void | Promise<void>;
  readonly preCallStaticProvider?: () => Promise<ReadonlyMap<string, string>>;
}

export type PreCallContextResolver = (input: {
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly sessionId: SessionId;
  readonly memory: Memory;
  readonly clock?: () => number;
  readonly scopes?: readonly MemoryScope[];
  readonly kind?: MemoryKind;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}) => Promise<PreCallContext>;

export interface PreCallContext {
  readonly memory: ReadonlyMap<string, import("./memory.js").MemoryEntry>;
  readonly static: ReadonlyMap<string, string>;
  readonly resolvedAtMs: number;
  readonly degraded: {
    readonly memory: boolean;
    readonly static: boolean;
  };
}

/**
 * @deprecated Use `PreCallContext` and `PreCallContextResolver`. The
 * memory-only variant remains as a separate type for one compatibility release.
 */
export type PreCallMemoryResolver = (input: {
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly sessionId: SessionId;
  readonly memory: Memory;
}) => Promise<PreCallMemoryContext>;
export interface PreCallMemoryContext {
  readonly entries: ReadonlyMap<string, import("./memory.js").MemoryEntry>;
  readonly resolvedAtMs: number;
  readonly degraded: boolean;
}

export interface SessionEndEvent {
  readonly session: import("./session.js").TerminalSession;
  readonly snapshot: import("./runtime.js").SessionSnapshot;
  readonly snapshotStatus?: "available" | "timed_out" | "unavailable";
  readonly finalMemorySnapshot: SessionEndMemorySnapshot;
  readonly memoryFinalization: SessionMemoryFinalization;
  readonly wallClockMs: number;
}

export type SessionMemoryFinalization =
  | { readonly status: "skipped" }
  | { readonly status: "completed"; readonly deletedEntries: number }
  | { readonly status: "failed"; readonly error: NormalizedError }
  | {
      readonly status: "timed_out";
      readonly phase: "drain" | "purge";
      readonly timeoutMs: number;
    };

export interface SessionEndMemorySnapshot {
  readonly user?: ReadonlyMap<string, import("./memory.js").MemoryEntry>;
  readonly organization?: ReadonlyMap<string, import("./memory.js").MemoryEntry>;
  readonly workflow?: ReadonlyMap<string, import("./memory.js").MemoryEntry>;
}

export interface SessionMetricsRecorder {
  record(name: string, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  onTurn(turn: import("./turn.js").TerminalTurn, sessionId: SessionId): void;
  onSessionTrace?(trace: RuntimeSessionTrace): void;
  onSessionEnd?(event: SessionEndEvent): void;
}

export const RUNTIME_OBSERVATION_SCHEMA_VERSION = 1 as const;

export const RUNTIME_OBSERVATION_NAMES = Object.freeze({
  OBSERVATION_DROPPED: "observation.dropped",
  SESSION_END: "session.end",
  /** Durable recovery committed; this does not imply provider or media readiness. */
  SESSION_RESUME: "session.resume",
  SESSION_START: "session.start",
  TURN_END: "turn.end",
  TURN_INTERRUPTION: "turn.interruption",
  TURN_START: "turn.start",
} as const);

export type RuntimeObservationName =
  (typeof RUNTIME_OBSERVATION_NAMES)[keyof typeof RUNTIME_OBSERVATION_NAMES];
export type RuntimePipelineObservationName =
  | typeof RUNTIME_OBSERVATION_NAMES.TURN_START
  | typeof RUNTIME_OBSERVATION_NAMES.TURN_END
  | typeof RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION;
export type RuntimeObservationValue = string | number | boolean;

/**
 * A stable, provider-neutral fact emitted at a runtime boundary. This is an
 * application integration seam, not a durable evidence schema: consumers such
 * as Earshot own mapping, redaction, retention, and storage.
 */
export interface RuntimeObservationInput {
  readonly name: RuntimeObservationName;
  readonly sessionId: SessionId;
  /** Session-relative monotonic offset in milliseconds. */
  readonly atMs: number;
  readonly turnId?: TurnId;
  readonly attributes?: Readonly<Record<string, RuntimeObservationValue>>;
}

/** The only observation facts emitted by TVIC's internal voice pipeline. */
export type RuntimePipelineObservationInput = Omit<RuntimeObservationInput, "name" | "turnId"> & {
  readonly name: RuntimePipelineObservationName;
  readonly turnId: TurnId;
};

export interface RuntimeObservation extends RuntimeObservationInput {
  readonly schemaVersion: typeof RUNTIME_OBSERVATION_SCHEMA_VERSION;
  /** Runtime-instance epoch, with a session-scoped suffix when that session resumes discontinuously. */
  readonly epoch: string;
  /** Monotonic per-session sequence within an observation epoch. */
  readonly sequence: number;
  /** Coordinator-owned identity; stability across runtime epochs depends on the observation kind. */
  readonly factId: string;
}

export interface RuntimeObservationSink {
  /**
   * Enqueue-only callback. Implementations must not perform I/O, await, or
   * block; the runtime invokes this outside the execution call stack.
   */
  enqueue(observation: RuntimeObservation): void;
}

export interface RuntimeObservationStats {
  readonly queueDrops: number;
  readonly sinkFailures: number;
  readonly sinkDisabled: boolean;
  readonly sinkDisabledDrops: number;
  readonly shutdownDrops: number;
  readonly detachedSessionEvictions: number;
}

export interface RuntimeTraceError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retriable: boolean;
}

export interface RuntimeSessionTrace {
  readonly schemaVersion: 1;
  readonly privacy: {
    readonly classification: "metadata_only";
    readonly excludes: readonly [
      "transcripts",
      "audio",
      "tool_names",
      "tool_arguments",
      "tool_results",
      "provider_error_messages",
      "session_metadata",
      "variables",
      "memory",
    ];
  };
  readonly session: {
    readonly id: SessionId;
    readonly callId?: import("./ids.js").CallId;
    readonly agentId: import("./ids.js").AgentId;
    readonly channel: ChannelKind;
    readonly status: import("./session.js").TerminalSessionStatus;
    readonly terminalSource?: TerminalSource;
    readonly createdAt: import("./timestamp.js").Timestamp;
    readonly startedAt: import("./timestamp.js").Timestamp;
    readonly endedAt: import("./timestamp.js").Timestamp;
    readonly error?: RuntimeTraceError;
  };
  readonly snapshot: {
    readonly status: "available" | "timed_out" | "unavailable";
    readonly turnCount: number;
    readonly omittedTurnCount: number;
    readonly toolCallCount: number;
    readonly omittedToolCallCount: number;
  };
  readonly turns: readonly {
    readonly id: import("./ids.js").TurnId;
    readonly sequence: number;
    readonly status: TurnStatus;
    readonly startedAt: import("./timestamp.js").Timestamp;
    readonly endedAt?: import("./timestamp.js").Timestamp;
    readonly latency: TurnLatency;
    readonly delivery?: TurnOutputDelivery;
    readonly error?: RuntimeTraceError;
  }[];
  readonly toolCalls: readonly {
    readonly id: ToolCallId;
    readonly turnId: TurnId;
    readonly status: import("./tool.js").ToolCallStatus;
    readonly attempts: number;
    readonly queuedAt: import("./timestamp.js").Timestamp;
    readonly startedAt?: import("./timestamp.js").Timestamp;
    readonly endedAt?: import("./timestamp.js").Timestamp;
    readonly error?: RuntimeTraceError;
  }[];
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly checks?: Readonly<Record<string, HealthCheckResult>>;
}

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DurableRuntimeMetric {
  readonly name: string;
  readonly value: number;
  readonly atMs: number;
  readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface DurableRuntimePolicy {
  readonly criticalWriteTimeoutMs: number;
  readonly criticalSessionP50BudgetMs: number;
  readonly criticalSessionP95BudgetMs: number;
  readonly criticalSessionP99BudgetMs: number;
  readonly turnStartP95BudgetMs: number;
  readonly turnStartP99BudgetMs: number;
  readonly toolPathP95BudgetMs: number;
  readonly toolPathP99BudgetMs: number;
  readonly failoverP95BudgetMs: number;
  readonly failoverP99BudgetMs: number;
  readonly failoverAlertBudgetMs: number;
  readonly bargeCheckpointRetryBudgetMs: number;
  readonly bargeCheckpointMaxAttempts: number;
  readonly persistenceRecoveryGraceMs: number;
  readonly leaseTtlMs: number;
  readonly leaseHeartbeatMs: number;
  readonly recoveryPollMs: number;
  readonly recoveryGraceMs: number;
  readonly terminalRetentionMs: number;
}

export const DEFAULT_DURABLE_RUNTIME_POLICY: DurableRuntimePolicy = {
  criticalWriteTimeoutMs: 75,
  criticalSessionP50BudgetMs: 10,
  criticalSessionP95BudgetMs: 25,
  criticalSessionP99BudgetMs: 50,
  turnStartP95BudgetMs: 40,
  turnStartP99BudgetMs: 75,
  toolPathP95BudgetMs: 60,
  toolPathP99BudgetMs: 100,
  failoverP95BudgetMs: 4_000,
  failoverP99BudgetMs: 6_000,
  failoverAlertBudgetMs: 8_000,
  bargeCheckpointRetryBudgetMs: 500,
  bargeCheckpointMaxAttempts: 3,
  persistenceRecoveryGraceMs: 2_000,
  leaseTtlMs: 3_000,
  leaseHeartbeatMs: 1_000,
  recoveryPollMs: 250,
  recoveryGraceMs: 10_000,
  terminalRetentionMs: 90 * 24 * 60 * 60 * 1_000,
};

export type SessionAttachmentHealth =
  | "healthy"
  | "persistence_degraded"
  | "lease_lost"
  | "detached";

export interface StartSessionOptions {
  readonly channel: ChannelKind;
  readonly call?: Call;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly memoryUserId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
}

export type EndSessionReason = "completed" | "cancelled" | "failed" | "timeout";

export type TerminalSource =
  | "operator_stop"
  | "caller_abort"
  | "run_timeout"
  | "remote_transport"
  | "provider_runtime"
  | "normal_completion"
  | "runtime_recovery"
  | "runtime_shutdown"
  | "legacy_unknown";

export type EndSessionRequest =
  | {
      readonly reason: "completed";
      readonly terminalSource?: "normal_completion" | "legacy_unknown";
    }
  | {
      readonly reason: "cancelled";
      readonly cancelReason: SessionCancellationReason;
      readonly terminalSource?:
        | "operator_stop"
        | "caller_abort"
        | "remote_transport"
        | "runtime_recovery"
        | "runtime_shutdown"
        | "legacy_unknown";
    }
  | {
      readonly reason: "failed";
      readonly error: NormalizedError;
      readonly terminalSource?: "provider_runtime" | "legacy_unknown";
    }
  | {
      readonly reason: "timeout";
      readonly error: NormalizedError;
      readonly terminalSource?: "run_timeout" | "legacy_unknown";
    };

export interface StartTurnRequest {
  readonly sessionId: SessionId;
  readonly input?: TurnInput;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EndTurnRequest =
  | {
      readonly reason: "completed";
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
    }
  | {
      readonly reason: "cancelled";
      readonly cancelReason: TurnCancellationReason;
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
    }
  | {
      readonly reason: "failed";
      readonly error: NormalizedError;
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
    };

export interface SessionSnapshot {
  readonly session: Session;
  readonly turns: readonly Turn[];
  readonly toolCalls: readonly ToolCall[];
}

export interface StartAttachedSessionOptions extends StartSessionOptions {
  readonly holderId?: string;
}

export interface SessionAttachment {
  readonly session: ActiveSession;
  readonly snapshot: SessionSnapshot;
  readonly lease: SessionLease | null;
  readonly signal: AbortSignal;
  readonly health: SessionAttachmentHealth;
  readonly detach: () => Promise<void>;
  readonly preCallContext?: PreCallContext;
  /**
   * @deprecated Use `preCallContext`. This compatibility field projects
   * `preCallContext.memory`.
   */
  readonly preCallMemory?: PreCallMemoryContext;
}

export interface RuntimeServiceLifecycle {
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

export interface Runtime extends RuntimeServiceLifecycle {
  registerPipelineRun?(
    run: Promise<unknown>,
    cancel: () => void,
    sessionId?: SessionId,
  ): () => void;
  startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession>;
  startAttachedSession(
    agent: Agent,
    options: StartAttachedSessionOptions,
  ): Promise<SessionAttachment>;
  attachSession(
    agent: Agent,
    sessionId: SessionId,
    options?: {
      readonly holderId?: string;
      readonly memoryUserId?: UserId;
      readonly organizationId?: OrganizationId;
      readonly workflowId?: WorkflowId;
    },
  ): Promise<SessionAttachment>;
  getSession(id: SessionId): Promise<Session | null>;
  endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession>;
  startTurn(request: StartTurnRequest): Promise<Turn>;
  endTurn(sessionId: SessionId, turnId: TurnId, request: EndTurnRequest): Promise<TerminalTurn>;
  updateTurnStatus(sessionId: SessionId, turnId: TurnId, status: TurnStatus): Promise<Turn>;
  setPersistenceHealth(sessionId: SessionId, degraded: boolean): void;
  runSessionMemoryOperation?<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T>;
  startToolCall(toolCall: QueuedToolCall): Promise<RunningToolCall>;
  finishToolCall(toolCall: TerminalToolCall): Promise<TerminalToolCall>;
  recoverToolCalls(sessionId: SessionId): Promise<readonly ToolCall[]>;
  checkpointTurnInterruption(
    sessionId: SessionId,
    turnId: TurnId,
    reason: TurnCancellationReason,
  ): Promise<Turn>;
  sessionClockMs(id: SessionId): number;
  /** Returns observation delivery counters without exposing sink internals. */
  observationStats?(): RuntimeObservationStats;
  /** Persists a completed tool call as part of runtime session state. */
  recordToolCall(toolCall: ToolCall): Promise<void>;
  healthCheck(): Promise<HealthSnapshot>;
  inspectSession(id: SessionId): Promise<SessionSnapshot>;
  readonly durablePolicy?: DurableRuntimePolicy;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  readonly memory?: Memory;
}
