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
  /** Whether the runtime may close an injected durable store during stop. */
  readonly durableStoreOwnership?: "runtime" | "caller";
  /** Overrides for the explicit defaults; omitted values use the safe defaults. */
  readonly durablePolicy?: Partial<DurableRuntimePolicy>;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  /** Logical label; the runtime appends a fresh incarnation ID for lease ownership. */
  readonly holderId?: string;
  readonly onDurableMetric?: (metric: DurableRuntimeMetric) => void;
  /**
   * Memory adapter used for cross-call memory. Defaults to `InMemoryMemory`
   * (process-local) when omitted. For cross-call recall, wire a durable
   * adapter (e.g., `@tvic/dal-postgres-memory`) or a third-party adapter
   * (Mem0, Supermemory, etc.).
   */
  readonly memory?: Memory;
  /**
   * Maximum time the runtime waits for already-admitted memory writes and the
   * session-scope purge during terminalization. Timing out releases the
   * caller while preserving write-before-purge ordering. The default is 1
   * second; the adapter operation is not cancelled.
   */
  readonly sessionMemoryFinalizeTimeoutMs?: number;
  /**
   * Maximum time the runtime waits for the best-effort `onSessionEnd` observer
   * after the terminal event has been assembled. The default is 5 seconds;
   * the observer is not cancelled when this budget expires.
   */
  readonly sessionEndHookTimeoutMs?: number;
  /**
   * Resolves pre-call memory and static context when a session is created or
   * attached. If omitted, the runtime loads enabled user, organization, and
   * workflow memory scopes and supplies an empty static map.
   */
  readonly preCallContextResolver?: PreCallContextResolver;
  /** Optional org/workflow ids carried on every session created by this runtime. */
  readonly defaultOrganizationId?: OrganizationId;
  readonly defaultWorkflowId?: WorkflowId;
  readonly onSessionEnd?: (event: SessionEndEvent) => void | Promise<void>;
  /**
   * Optional metrics recorder called for session start, turn end, and session
   * end, plus `onTurn` once for each terminal turn.
   */
  readonly sessionMetricsRecorder?: SessionMetricsRecorder;
  readonly healthCheck?: () => Promise<HealthSnapshot>;
  /**
   * Optional callback fired at the start of `runtime.stop()` so the
   * user's deployment wiring (SIGTERM handler, kubernetes preStop hook)
   * can drain the load balancer before the runtime detaches sessions
   * and closes stores. Best-effort; the runtime proceeds after the
   * promise settles or 5s, whichever comes first.
   */
  readonly onShutdownStart?: (state: {
    readonly activeSessions: readonly SessionId[];
  }) => void | Promise<void>;
  readonly preCallStaticProvider?: () => Promise<ReadonlyMap<string, string>>;
}

/** Resolves memory and static context after the runtime acquires a session lease. */
export type PreCallContextResolver = (input: {
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly sessionId: SessionId;
  readonly memory: Memory;
  readonly clock?: () => number;
  /** Scopes permitted by the agent's memory policy for this call. */
  readonly scopes?: readonly MemoryScope[];
  /** Optional kind filter from `memoryPolicy.preCallLoad`. */
  readonly kind?: MemoryKind;
  /** Maximum memory entries the runtime should load from any one scope. */
  readonly maxEntries?: number;
  /** Maximum rendered pre-call context bytes. */
  readonly maxBytes?: number;
}) => Promise<PreCallContext>;

export interface PreCallContext {
  /** Map of `${scope}:${scopeId}:${kind}:${key}` to entry. Empty on resolver error. */
  readonly memory: ReadonlyMap<string, import("./memory.js").MemoryEntry>;
  /**
   * Non-memory context: CRM records, feature flags, tenant config, anything
   * the LLM should see in the system prompt that is *not* a memory entry.
   * Rendered into a separate `<context>...</context>` block above the
   * `<memory>...</memory>` block.
   */
  readonly static: ReadonlyMap<string, string>;
  /** When the resolver ran, wall-clock ms. */
  readonly resolvedAtMs: number;
  /** Per-bucket degradation flag. */
  readonly degraded: {
    readonly memory: boolean;
    readonly static: boolean;
  };
}

/** @deprecated Use `PreCallContext` and `PreCallContextResolver`. */
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

/** Data emitted after a session ends, including its final durable snapshot. */
export interface SessionEndEvent {
  readonly session: import("./session.js").TerminalSession;
  readonly snapshot: import("./runtime.js").SessionSnapshot;
  /** Whether `snapshot` contains the complete terminal inspection result. */
  readonly snapshotStatus?: "available" | "timed_out" | "unavailable";
  /**
   * Memory state at end-of-session, scoped to the user/org/workflow ids
   * the runtime resolved for this session. Empty for sessions that wrote
   * only to `session` scope (which is about to be deleted).
   */
  readonly finalMemorySnapshot: SessionEndMemorySnapshot;
  /** Result of the ordered session-memory drain and optional purge. */
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

/**
 * Contract for an external observability consumer. The runtime emits
 * one `record` per observable event and one `onTurn` per terminal
 * turn. Implementations: Earshot-shaped (project into an `earshot.*`
 * event), OTel-shaped (project into a span event), console.log-shaped.
 */
export interface SessionMetricsRecorder {
  record(name: string, attributes?: Readonly<Record<string, string | number | boolean>>): void;
  onTurn(turn: import("./turn.js").TerminalTurn, sessionId: SessionId): void;
  /**
   * Receives an allowlisted, content-free projection for external trace sinks.
   * Keep this callback synchronous and fast; enqueue to a bounded local buffer
   * before doing network I/O elsewhere.
   */
  onSessionTrace?(trace: RuntimeSessionTrace): void;
  /** Rich, content-bearing observer. Do not forward this event without review. */
  onSessionEnd?(event: SessionEndEvent): void;
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
  /** Sanitized diagnostic details supplied by the owning subsystem. */
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
  /** User scope identity for cross-call memory recall. */
  readonly memoryUserId?: UserId;
  /** Organization scope for cross-call memory recall. */
  readonly organizationId?: OrganizationId;
  /** Workflow scope for cross-call memory recall. */
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
  /** Logical label; the runtime appends a fresh incarnation ID for lease ownership. */
  readonly holderId?: string;
}

export interface SessionAttachment {
  readonly session: ActiveSession;
  readonly snapshot: SessionSnapshot;
  readonly lease: SessionLease | null;
  readonly signal: AbortSignal;
  readonly health: SessionAttachmentHealth;
  readonly detach: () => Promise<void>;
  /** Memory and static context resolved before the call starts. */
  readonly preCallContext?: PreCallContext;
  /**
   * @deprecated Use `preCallContext`. This legacy field contains its memory-only projection.
   */
  readonly preCallMemory?: PreCallMemoryContext;
}

export interface RuntimeServiceLifecycle {
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

export interface Runtime extends RuntimeServiceLifecycle {
  /** Registers a run that `stop()` cancels and drains before closing durable stores. */
  registerPipelineRun?(run: Promise<unknown>, cancel: () => void): () => void;
  startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession>;
  startAttachedSession(
    agent: Agent,
    options: StartAttachedSessionOptions,
  ): Promise<SessionAttachment>;
  attachSession(
    agent: Agent,
    sessionId: SessionId,
    options?: {
      /** Logical label; the runtime appends its fresh incarnation ID for lease ownership. */
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
  /**
   * Serializes memory writes and session-end purge for one session. Built-in
   * runtimes provide this; custom runtimes may omit it for compatibility.
   */
  runSessionMemoryOperation?<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T>;
  startToolCall(toolCall: QueuedToolCall): Promise<RunningToolCall>;
  finishToolCall(toolCall: TerminalToolCall): Promise<TerminalToolCall>;
  /**
   * Reconciles interrupted calls for a session with no currently executing
   * tool call. Built-in runtimes reject overlap with startToolCall() and with
   * an in-progress session attachment; attachment already recovers before the
   * pipeline resumes.
   */
  recoverToolCalls(sessionId: SessionId): Promise<readonly ToolCall[]>;
  checkpointTurnInterruption(
    sessionId: SessionId,
    turnId: TurnId,
    reason: TurnCancellationReason,
  ): Promise<Turn>;
  sessionClockMs(id: SessionId): number;
  recordToolCall(toolCall: ToolCall): Promise<void>;
  healthCheck(): Promise<HealthSnapshot>;
  inspectSession(id: SessionId): Promise<SessionSnapshot>;
  readonly durablePolicy?: DurableRuntimePolicy;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  readonly memory?: Memory;
}
