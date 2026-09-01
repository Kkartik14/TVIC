import type { Agent } from "./agent.js";
import type { Call } from "./call.js";
import type { Clock } from "./clock.js";
import type { ChannelKind } from "./direction.js";
import type { NormalizedError } from "./errors.js";
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
  TurnOutput,
} from "./turn.js";

export interface RuntimeOptions {
  readonly sessionStore?: SessionStore;
  readonly turnStore?: TurnStore;
  readonly toolCallStore?: ToolCallStore;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly durableStore?: DurableRuntimeStore;
  /** Overrides for the explicit defaults; omitted values use the safe defaults. */
  readonly durablePolicy?: Partial<DurableRuntimePolicy>;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
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
   * Pre-call context resolver. When a session is created or attached, the
   * runtime calls this hook when a session is attached to populate the agent's
   * context with memory entries for the relevant scopes AND with non-memory
   * context (CRM, feature flags, tenant config). If omitted, the runtime uses a default
   * resolver that reads from `options.memory` for the active `user` /
   * `organization` / `workflow` scopes and returns an empty `static` map.
   *
   * Pre-1.0, this was named `preCallMemoryResolver` and returned a
   * `PreCallMemoryContext`. The rename to `PreCallContextResolver` and
   * the addition of the `static: ReadonlyMap<string, string>` sub-map
   * fixes a real type lie: the customer previously had to stuff CRM
   * data and feature flags into the `Memory` map as `kind: "fact"`
   * entries. The `static` map is the typed input for non-memory context.
   */
  readonly preCallContextResolver?: PreCallContextResolver;
  /** Optional org/workflow ids carried on every session created by this runtime. */
  readonly defaultOrganizationId?: OrganizationId;
  readonly defaultWorkflowId?: WorkflowId;
  /**
   * Optional callback fired after a session is terminalized and after the
   * runtime has made its best-effort memory-finalization attempt. The event
   * reports whether session-scope deletion was skipped, completed, failed, or
   * timed out. Best-effort: a throw or timeout from the hook does not affect
   * the terminal session. The runtime does not retry; if you need durability,
   * call an external system from inside the hook and have that system retry.
   *
   * The hook is the canonical place for: post-call LLM summarization,
   * CRM sync, callback scheduling, escalation, transcript delivery to a
   * CRM. The runtime does not own any of these — the user picks the LLM,
   * the prompt, the schema.
   */
  readonly onSessionEnd?: (event: SessionEndEvent) => void | Promise<void>;
  /**
   * Optional metrics recorder. The runtime emits one `record` call per
   * observable event (session start, turn end, session end) and one
   * `onTurn` call per terminal turn. The user provides the implementation
   * (Earshot-shaped, console.log-shaped, OTel-shaped).
   */
  readonly sessionMetricsRecorder?: SessionMetricsRecorder;
  /**
   * Optional health check consumed by `NodeMediaPlane.healthPath`. The
   * user implements the readiness check (DB ping, recovery-coordinator
   * liveness); the runtime reflects it on the HTTP endpoint. Returns
   * `ok: true` when all checks pass; the runtime responds with HTTP 200.
   */
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
  /**
   * Optional async provider of the pre-call static context (CRM records,
   * feature flags, tenant config). Called by the runtime when a session is
   * attached; the result is merged into the pre-call context's `static`
   * map. Best-effort: a throw or timeout produces a degraded `static`
   * context (degraded flag set). This is a separate seam from
   * `preCallContextResolver` so a custom resolver can choose to either
   * (a) inline the static fetch into its own resolver, or (b) leave the
   * fetch to the runtime and just augment the result.
   */
  readonly preCallStaticProvider?: () => Promise<ReadonlyMap<string, string>>;
}

/**
 * Resolves the pre-call context for a session. The runtime calls this on
 * `startAttachedSession` and `attachSession` after lease acquisition.
 *
 * Pre-1.0, this was named `PreCallMemoryResolver` and returned a
 * `PreCallMemoryContext`. The rename to `PreCallContextResolver` and
 * the addition of the `static` sub-map fixes the type lie.
 */
export type PreCallContextResolver = (input: {
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId;
  readonly workflowId?: WorkflowId;
  readonly sessionId: SessionId;
  readonly memory: Memory;
  /** Wall-clock source supplied by the runtime for deterministic resolution. */
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

/**
 * Carries the terminal session, the persisted snapshot, and a snapshot
 * of the memory adapter's state at the moment of endSession. The
 * memory snapshot is the source of truth for "what did we learn about
 * this caller" — the runtime does not try to track per-write
 * `MemoryChangeRecord`s, because most writes are within the session
 * scope and are about to be deleted by `deleteSessionScopeOnEnd`. The
 * snapshot the user actually wants is what survives into `user` /
 * `organization` / `workflow` scopes.
 */
export interface SessionEndEvent {
  readonly session: import("./session.js").TerminalSession;
  readonly snapshot: import("./runtime.js").SessionSnapshot;
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
  onSessionEnd?(event: SessionEndEvent): void;
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly checks?: Readonly<Record<string, HealthCheckResult>>;
}

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly message?: string;
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

export type EndSessionRequest =
  | { readonly reason: "completed" }
  | { readonly reason: "cancelled"; readonly cancelReason: SessionCancellationReason }
  | { readonly reason: "failed"; readonly error: NormalizedError }
  | { readonly reason: "timeout"; readonly error: NormalizedError };

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
  /**
   * Pre-call context loaded from the runtime's pre-call context resolver
   * before the call starts. Contains both memory entries (rendered as
   * `<memory>...</memory>`) and non-memory static context (rendered as
   * `<context>...</context>`). Pre-1.0, this was `preCallMemory` and
   * carried only the memory entries. The rename is the contract-clarity
   * fix; legacy callers reading `preCallMemory.entries` should switch
   * to `preCallContext.memory`.
   */
  readonly preCallContext?: PreCallContext;
  /**
   * @deprecated Use `preCallContext`. The legacy `preCallMemory` field
   * is kept as a typedef for one release and resolved to a shim that
   * projects `preCallContext.memory`.
   */
  readonly preCallMemory?: PreCallMemoryContext;
}

export interface RuntimeServiceLifecycle {
  /** Starts the runtime. A runtime can be started once; create a new runtime after stop. */
  start(): Promise<void>;
  /**
   * Stops the runtime and closes its owned resources. The operation is
   * idempotent and concurrent callers await the same teardown. A stopped
   * runtime cannot be restarted because durable adapters are closed.
   */
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

export interface Runtime extends RuntimeServiceLifecycle {
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
  /** Marks durable persistence health for the live attachment without changing lease ownership. */
  setPersistenceHealth(sessionId: SessionId, degraded: boolean): void;
  /**
   * Serializes memory writes and session-end purge for one session. Built-in
   * runtimes provide this; custom runtimes may omit it for compatibility.
   */
  runSessionMemoryOperation?<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T>;
  startToolCall(toolCall: QueuedToolCall): Promise<RunningToolCall>;
  finishToolCall(toolCall: TerminalToolCall): Promise<TerminalToolCall>;
  recoverToolCalls(sessionId: SessionId): Promise<readonly ToolCall[]>;
  checkpointTurnInterruption(
    sessionId: SessionId,
    turnId: TurnId,
    reason: TurnCancellationReason,
  ): Promise<Turn>;
  /** Session-relative monotonic offset used for turn and media timing. */
  sessionClockMs(id: SessionId): number;
  /** Persists a completed tool call as part of runtime session state. */
  recordToolCall(toolCall: ToolCall): Promise<void>;
  /**
   * Optional health check. The runtime exposes this so the
   * `NodeMediaPlane` (or any other host) can surface readiness via
   * `/healthz`. Returns `ok: true` when the underlying store + leases
   * are healthy; the host responds with HTTP 200 vs 503. Best-effort:
   * a throw produces `ok: false`.
   */
  healthCheck(): Promise<HealthSnapshot>;
  inspectSession(id: SessionId): Promise<SessionSnapshot>;
  readonly durablePolicy?: DurableRuntimePolicy;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  readonly memory?: Memory;
}
