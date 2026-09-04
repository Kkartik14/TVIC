import { createInMemoryDurableRuntimeStore, createInMemoryMemory } from "@tvic/dal";
import { InMemoryToolIdempotencyStore } from "@tvic/tools";
import {
  finishToolCall as persistFinishedToolCall,
  recordToolCall as persistToolCallRecord,
  recoverToolCalls as recoverPersistedToolCalls,
  replayRecoveredToolCall,
  startToolCall as persistStartedToolCall,
} from "./tool-lifecycle.js";
import type { ToolLifecycleContext } from "./tool-lifecycle.js";
import { defaultPreCallContextResolver, resolvePreCallContext } from "./memory-loader.js";
import {
  createDefaultIdGenerator,
  createSystemClock,
  cancelledError,
  DEFAULT_DURABLE_RUNTIME_POLICY,
  BackendUnavailableError,
  internalError,
  InvalidArgumentError,
  isTerminalSession,
  isTerminalTurn,
  LeaseUnavailableError,
  monotonicOffsetMs,
  timeoutError,
  RecordNotFoundError,
  terminalSessionFromRequest,
  terminalTurnFromRequest,
} from "@tvic/core";
import type {
  ActiveSession,
  ActiveTurn,
  Agent,
  Clock,
  EndSessionRequest,
  EndTurnRequest,
  DurableRuntimePolicy,
  DurableRuntimeMetric,
  DurableRuntimeStore,
  IdGenerator,
  DurableSessionTransaction,
  HealthSnapshot,
  Memory,
  OrganizationId,
  PreCallContext,
  PreCallContextResolver,
  Runtime,
  RuntimeOptions,
  SessionAttachment,
  Session,
  SessionId,
  SessionLease,
  SessionMetricsRecorder,
  SessionSnapshot,
  StartSessionOptions,
  StartAttachedSessionOptions,
  StartTurnRequest,
  StoredSessionRecord,
  TerminalToolCall,
  TerminalSession,
  TerminalTurn,
  Timestamp,
  QueuedToolCall,
  RunningToolCall,
  ToolCall,
  ToolCallId,
  ToolIdempotencyStore,
  TurnCancellationReason,
  Turn,
  TurnId,
  TurnStatus,
  UserId,
  WorkflowId,
} from "@tvic/core";
import {
  attachmentView,
  buildSession,
  criticalWrite,
  detachAttachment,
  durableEvent,
  ensureActiveSession,
  renewLease,
  type LateWriteOutcome,
  type RuntimeAttachmentState,
} from "./runtime-support.js";
import {
  checkpointTurnInterruption as checkpointRuntimeTurnInterruption,
  endTurn as endRuntimeTurn,
  startTurn as startRuntimeTurn,
  updateTurnStatus as updateRuntimeTurnStatus,
  type RuntimeTurnContext,
} from "./runtime-turns.js";
import { SessionEndCoordinator } from "./session-end.js";
import { assertMemoryPolicySupported } from "./memory-capabilities.js";

const DEFAULT_DURABLE_POLICY = DEFAULT_DURABLE_RUNTIME_POLICY;
const DEFAULT_SESSION_MEMORY_FINALIZE_TIMEOUT_MS = 1_000;
const DEFAULT_SESSION_END_HOOK_TIMEOUT_MS = 5_000;

interface PersistedSessionEnd {
  readonly session: TerminalSession;
  readonly shouldEmit: boolean;
}

function positiveSafeInteger(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive safe integer: ${resolved}`);
  }
  return resolved;
}

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function turnCancellationForSession(request: EndSessionRequest): TurnCancellationReason {
  if (request.reason !== "cancelled") return "explicit";
  switch (request.cancelReason) {
    case "caller_hangup":
    case "transport_lost":
      return "transport_lost";
    case "recovery_expired":
      return "runtime_restarted";
    case "operator_requested":
    case "shutdown":
      return "explicit";
  }
}

function turnEndRequestForSession(request: EndSessionRequest): EndTurnRequest {
  switch (request.reason) {
    case "failed":
    case "timeout":
      return { reason: "failed", error: request.error };
    case "completed":
    case "cancelled":
      return { reason: "cancelled", cancelReason: turnCancellationForSession(request) };
  }
}

function cancelOpenToolCall(
  toolCall: QueuedToolCall | RunningToolCall,
  endedAt: TerminalToolCall["endedAt"],
): TerminalToolCall {
  const error = cancelledError("tool.session_ended", "Tool execution was stopped with the session");
  if (toolCall.status === "queued") {
    return { ...toolCall, status: "cancelled", startedAt: endedAt, endedAt, error };
  }
  return { ...toolCall, status: "cancelled", endedAt, error };
}

/**
 * The runtime owns execution state only: sessions, turns, tool calls, and the
 * monotonic clocks needed by the realtime loop. Observability is deliberately
 * outside this module so an external system can consume runtime activity without
 * becoming part of the call's critical path.
 */
export class InMemoryRuntime implements Runtime {
  readonly #sessionStore;
  readonly #turnStore;
  readonly #toolCallStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #durableStore: DurableRuntimeStore;
  readonly #policy: DurableRuntimePolicy;
  readonly #holderId: string;
  readonly #onDurableMetric: ((metric: DurableRuntimeMetric) => void) | undefined;
  readonly #attachments = new Map<SessionId, RuntimeAttachmentState>();
  readonly #attachmentStarts = new Set<SessionId>();
  readonly toolIdempotencyStore: ToolIdempotencyStore;
  readonly #memory: Memory;
  readonly #preCallContextResolver: PreCallContextResolver;
  readonly #preCallStaticProvider: (() => Promise<ReadonlyMap<string, string>>) | undefined;
  readonly #defaultOrganizationId: OrganizationId | undefined;
  readonly #defaultWorkflowId: WorkflowId | undefined;
  readonly #sessionMetricsRecorder: SessionMetricsRecorder | undefined;
  readonly #sessionEndCoordinator: SessionEndCoordinator;
  readonly #onShutdownStart:
    | ((state: { readonly activeSessions: readonly SessionId[] }) => void | Promise<void>)
    | undefined;
  readonly #sessionStartMs = new Map<SessionId, number>();
  #running = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: RuntimeOptions = {}) {
    this.#clock = options.clock ?? createSystemClock();
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#policy = { ...DEFAULT_DURABLE_POLICY, ...options.durablePolicy };
    this.#holderId =
      options.holderId ?? `runtime-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    this.#onDurableMetric = options.onDurableMetric;
    this.#durableStore =
      options.durableStore ??
      createInMemoryDurableRuntimeStore({
        nowMs: () => Date.parse(this.#clock.now()),
        ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
        ...(options.turnStore ? { turnStore: options.turnStore } : {}),
        ...(options.toolCallStore ? { toolCallStore: options.toolCallStore } : {}),
      });
    // A DurableRuntimeStore owns the three aggregate stores. When callers use
    // the pre-durable RuntimeOptions fields, the in-memory compatibility
    // facade above adapts those exact instances so direct reads and aggregate
    // transactions cannot diverge.
    this.#sessionStore = this.#durableStore.sessions;
    this.#turnStore = this.#durableStore.turns;
    this.#toolCallStore = this.#durableStore.toolCalls;
    this.toolIdempotencyStore =
      options.toolIdempotencyStore ??
      this.#durableStore.toolIdempotencyStore ??
      new InMemoryToolIdempotencyStore(
        () => Date.parse(this.#clock.now()),
        (sessionId) => this.#durableStore.leases.get(sessionId),
      );
    this.#memory = options.memory ?? (createInMemoryMemory() satisfies Memory);
    const sessionMemoryFinalizeTimeoutMs = positiveSafeInteger(
      options.sessionMemoryFinalizeTimeoutMs,
      "sessionMemoryFinalizeTimeoutMs",
      DEFAULT_SESSION_MEMORY_FINALIZE_TIMEOUT_MS,
    );
    const sessionEndHookTimeoutMs = positiveSafeInteger(
      options.sessionEndHookTimeoutMs,
      "sessionEndHookTimeoutMs",
      DEFAULT_SESSION_END_HOOK_TIMEOUT_MS,
    );
    this.#preCallContextResolver = options.preCallContextResolver ?? defaultPreCallContextResolver;
    this.#preCallStaticProvider = options.preCallStaticProvider;
    this.#defaultOrganizationId = options.defaultOrganizationId;
    this.#defaultWorkflowId = options.defaultWorkflowId;
    this.#sessionMetricsRecorder = options.sessionMetricsRecorder;
    this.#onShutdownStart = options.onShutdownStart;
    this.#optionsHealthCheck = options.healthCheck;
    this.#sessionEndCoordinator = new SessionEndCoordinator({
      memory: this.#memory,
      sessionStore: this.#sessionStore,
      clock: this.#clock,
      sessionMemoryFinalizeTimeoutMs,
      sessionEndHookTimeoutMs,
      inspectSession: (id) => this.inspectSession(id),
      ...(options.onSessionEnd ? { onSessionEnd: options.onSessionEnd } : {}),
      ...(options.sessionMetricsRecorder
        ? { sessionMetricsRecorder: options.sessionMetricsRecorder }
        : {}),
      emitMetric: (name, value, attributes) => this.#emitMetric(name, value, attributes),
      recordSessionMetric: (name, attributes) => this.#recordSessionMetric(name, attributes),
    });
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get durablePolicy(): DurableRuntimePolicy {
    return this.#policy;
  }

  get memory(): Memory {
    return this.#memory;
  }

  async healthCheck(): Promise<HealthSnapshot> {
    // The user can override `RuntimeOptions.healthCheck` with a richer
    // implementation. The default intentionally reports runtime liveness
    // only; deployments that need store/readiness checks can provide the
    // optional healthCheck callback.
    if (this.#optionsHealthCheck) {
      try {
        return await this.#optionsHealthCheck();
      } catch (error) {
        return {
          ok: false,
          checks: {
            runtime: {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    }
    return { ok: true, checks: { runtime: { ok: true } } };
  }

  readonly #optionsHealthCheck: (() => Promise<HealthSnapshot>) | undefined;

  get onShutdownStart():
    | ((state: { readonly activeSessions: readonly SessionId[] }) => void | Promise<void>)
    | undefined {
    return this.#onShutdownStart;
  }

  debugStats(): { readonly activeSessionClocks: number } {
    return { activeSessionClocks: this.#sessionStartMs.size };
  }

  async start(): Promise<void> {
    if (this.#stopPromise) {
      throw new Error("Runtime cannot be restarted after stop");
    }
    if (this.#running) return;
    this.#running = true;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#running = false;
    this.#stopPromise = this.#stopInternal();
    return this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    // Fire the shutdown seam first so the deployment can drain the load
    // balancer before the runtime detaches sessions. Best-effort: the
    // runtime proceeds after the promise settles or 5s, whichever comes
    // first. Throw is swallowed.
    if (this.#onShutdownStart) {
      const activeSessions = [...this.#attachments.keys()];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#onShutdownStart({ activeSessions }),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 5_000);
            timeout.unref?.();
          }),
        ]);
      } catch {
        // Swallow: the observation seam must not affect shutdown.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    await Promise.all([...this.#attachments.keys()].map((sessionId) => this.#detach(sessionId)));
    this.#sessionStartMs.clear();
    if (this.#durableStore.close) {
      await this.#durableStore.close();
    } else {
      await Promise.all([
        this.#sessionStore.close(),
        this.#turnStore.close(),
        this.#toolCallStore.close(),
        this.#durableStore.leases.close(),
      ]);
    }
  }

  async startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession> {
    this.#assertRunning();
    assertMemoryPolicySupported(this.#memory, agent.memoryPolicy);
    const effectiveOptions = this.#withRuntimeDefaults(options);
    const built = buildSession(this.#clock, this.#ids, agent, effectiveOptions);
    await this.#runUnfencedSessionTransaction(
      built.session.id,
      async (tx) => {
        await tx.putSession(built.record);
        await tx.appendOutbox(
          durableEvent(
            "session",
            built.session.id,
            built.session.id,
            0,
            built.session.status,
            built.session,
            built.record.runtime,
            1,
          ),
        );
      },
      ({ error }) => {
        if (!error) void this.#abandonLateSession(built.session.id).catch(() => undefined);
      },
    );
    this.#sessionStartMs.set(built.session.id, built.startMonotonicMs);
    this.#sessionEndCoordinator.open(built.session.id);
    this.#recordSessionMetric("session.start", {
      session_id: built.session.id,
      agent_id: built.session.agentId,
      channel: built.session.channel,
    });
    return built.session;
  }

  async getSession(id: SessionId): Promise<Session | null> {
    return (await this.#sessionStore.get(id))?.session ?? null;
  }

  async endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession> {
    const record = await this.#sessionStore.get(id);
    if (!record) {
      throw new RecordNotFoundError(`session:${id}`);
    }
    const attachment = this.#attachments.get(id);
    if (isTerminalSession(record.session)) {
      await this.#detach(id, attachment).catch(() => undefined);
      return record.session;
    }

    const now = this.#clock.now();
    const lease = attachment?.lease;
    let persisted: PersistedSessionEnd | undefined;
    let lateEndPending = false;
    try {
      if (lease) {
        persisted = await this.#criticalWrite(
          () =>
            this.#durableStore.runSessionTransaction(id, lease, (tx) =>
              this.#persistEnd(tx, id, request, now, lease.fence),
            ),
          (outcome) => {
            void this.#finishLateSessionEnd(id, attachment, lease, outcome).catch(() => undefined);
          },
          () => {
            lateEndPending = true;
          },
        );
      } else {
        persisted = await this.#runUnfencedSessionTransaction(
          id,
          (tx) => this.#persistEnd(tx, id, request, now, 0),
          ({ result, error }) => {
            if (!error && result?.shouldEmit) {
              void this.#finishLateSession(result.session, attachment).catch(() => undefined);
            }
          },
        );
      }
    } finally {
      this.#sessionStartMs.delete(id);
      if (persisted?.shouldEmit) {
        await this.#finishClaimedSessionEnd(persisted.session, attachment);
      } else if (lateEndPending && lease) {
        // The fenced transaction is still allowed to finish after the caller
        // deadline. Remove the live attachment, but keep its exact lease until
        // the transaction settles so the late commit cannot be fenced out.
        await this.#detach(id, attachment, false).catch(() => undefined);
      } else {
        await this.#detach(id, attachment).catch(() => undefined);
      }
    }
    if (!persisted) {
      throw new BackendUnavailableError(`Session terminalization failed: ${id}`);
    }
    return persisted.session;
  }

  async #persistEnd(
    tx: DurableSessionTransaction,
    id: SessionId,
    request: EndSessionRequest,
    now: Timestamp,
    fence: number,
  ): Promise<PersistedSessionEnd> {
    const current = await tx.getSession(id);
    if (!current) throw new RecordNotFoundError(`session:${id}`);
    if (isTerminalSession(current.session)) {
      return { session: current.session, shouldEmit: false };
    }

    const { currentTurnId: _currentTurnId, ...stateWithoutCurrentTurn } = current.session.state;
    const terminalFor = terminalSessionFromRequest(
      {
        id: current.session.id,
        agentId: current.session.agentId,
        channel: current.session.channel,
        ...(current.session.callId ? { callId: current.session.callId } : {}),
        memoryRefs: current.session.memoryRefs,
        ...(current.session.metadata ? { metadata: current.session.metadata } : {}),
        createdAt: current.session.createdAt,
        state: { ...stateWithoutCurrentTurn, pendingToolCallIds: [] },
        startedAt: "startedAt" in current.session ? current.session.startedAt : now,
        endedAt: now,
      },
      request,
    );
    const turnRequest = turnEndRequestForSession(request);
    for (const turnRecord of await tx.listTurns(id)) {
      if (isTerminalTurn(turnRecord.turn)) continue;
      const terminalTurn = terminalTurnFromRequest(
        turnRecord.turn as ActiveTurn,
        turnRequest,
        now,
        this.#durationForTurn(
          id,
          turnRecord.turn as ActiveTurn,
          turnRecord.runtime.monotonicStartedAtMs,
          now,
        ),
      );
      const updatedTurn = await tx.updateTurn(id, turnRecord.turn.id, (record) => ({
        ...record,
        turn: terminalTurn,
      }));
      await tx.appendOutbox(
        durableEvent(
          "turn",
          updatedTurn.turn.id,
          id,
          fence,
          updatedTurn.turn.status,
          updatedTurn.turn,
          updatedTurn.runtime,
          updatedTurn.version,
        ),
      );
    }

    for (const toolRecord of await tx.listToolCalls(id)) {
      if (toolRecord.toolCall.status !== "queued" && toolRecord.toolCall.status !== "running") {
        continue;
      }
      const terminalTool = cancelOpenToolCall(toolRecord.toolCall, now);
      const updatedTool = await tx.updateToolCall(id, toolRecord.toolCall.toolCallId, (record) => ({
        ...record,
        toolCall: terminalTool,
      }));
      await tx.appendOutbox(
        durableEvent(
          "tool_call",
          updatedTool.toolCall.toolCallId,
          id,
          fence,
          updatedTool.toolCall.status,
          updatedTool.toolCall,
          updatedTool.runtime,
          updatedTool.version,
        ),
      );
    }

    const updated = await tx.updateSession(id, (record) => ({
      ...record,
      session: terminalFor,
      runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(now) },
    }));
    await tx.appendOutbox(
      durableEvent(
        "session",
        id,
        id,
        fence,
        updated.session.status,
        updated.session,
        updated.runtime,
        updated.version,
      ),
    );
    return { session: updated.session as TerminalSession, shouldEmit: true };
  }

  async #emitSessionEnd(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    await this.#sessionEndCoordinator.emit(session, attachment);
  }

  async startTurn(request: StartTurnRequest): Promise<ActiveTurn> {
    this.#assertRunning();
    return startRuntimeTurn(this.#turnContext(), request);
  }

  async endTurn(
    sessionId: SessionId,
    turnId: TurnId,
    request: EndTurnRequest,
  ): Promise<TerminalTurn> {
    this.#assertRunning();
    return endRuntimeTurn(this.#turnContext(), sessionId, turnId, request);
  }

  async updateTurnStatus(sessionId: SessionId, turnId: TurnId, status: TurnStatus): Promise<Turn> {
    this.#assertRunning();
    return updateRuntimeTurnStatus(this.#turnContext(), sessionId, turnId, status);
  }

  setPersistenceHealth(sessionId: SessionId, degraded: boolean): void {
    const state = this.#attachments.get(sessionId);
    if (!state || state.health === "lease_lost" || state.health === "detached") return;
    if (degraded && state.health === "healthy") state.health = "persistence_degraded";
    if (!degraded && state.health === "persistence_degraded") state.health = "healthy";
  }

  runSessionMemoryOperation<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    return this.#sessionEndCoordinator.runMemoryOperation(sessionId, operation);
  }

  async startToolCall(toolCall: QueuedToolCall): Promise<RunningToolCall> {
    this.#assertRunning();
    return persistStartedToolCall(this.#toolContext(), toolCall);
  }

  async finishToolCall(toolCall: TerminalToolCall): Promise<TerminalToolCall> {
    this.#assertRunning();
    return persistFinishedToolCall(this.#toolContext(), toolCall);
  }

  async recoverToolCalls(sessionId: SessionId): Promise<readonly ToolCall[]> {
    this.#assertRunning();
    return recoverPersistedToolCalls(this.#toolContext(), sessionId);
  }

  async checkpointTurnInterruption(
    sessionId: SessionId,
    turnId: TurnId,
    reason: TurnCancellationReason,
  ): Promise<Turn> {
    this.#assertRunning();
    return checkpointRuntimeTurnInterruption(this.#turnContext(), sessionId, turnId, reason);
  }

  async startAttachedSession(
    agent: Agent,
    options: StartAttachedSessionOptions,
  ): Promise<SessionAttachment> {
    this.#assertRunning();
    assertMemoryPolicySupported(this.#memory, agent.memoryPolicy);
    const effectiveOptions = this.#withRuntimeDefaults(options);
    const createSessionWithLease = this.#durableStore.createSessionWithLease;
    if (createSessionWithLease) {
      const built = buildSession(this.#clock, this.#ids, agent, effectiveOptions);
      const holder = options.holderId ?? this.#holderId;
      const lease = await this.#criticalWrite(
        () =>
          createSessionWithLease.call(
            this.#durableStore,
            built.record,
            holder,
            this.#policy.leaseTtlMs,
            (lease) =>
              durableEvent(
                "session",
                built.session.id,
                built.session.id,
                lease.fence,
                built.session.status,
                built.session,
                built.record.runtime,
                built.record.version,
              ),
          ),
        ({ result, error }) => {
          if (!error && result) {
            void this.#abandonLateSession(built.session.id, result).catch(() => undefined);
          }
        },
      );
      if (!lease) throw new Error(`Session lease unavailable: ${built.session.id}`);
      this.#sessionStartMs.set(built.session.id, built.startMonotonicMs);
      this.#sessionEndCoordinator.open(built.session.id);
      this.#recordSessionMetric("session.start", {
        session_id: built.session.id,
        agent_id: built.session.agentId,
        channel: built.session.channel,
      });
      const state: RuntimeAttachmentState = {
        agent,
        controller: new AbortController(),
        lease,
        holder,
        health: "healthy",
        ...(effectiveOptions.memoryUserId ? { memoryUserId: effectiveOptions.memoryUserId } : {}),
        ...(effectiveOptions.organizationId
          ? { organizationId: effectiveOptions.organizationId }
          : {}),
        ...(effectiveOptions.workflowId ? { workflowId: effectiveOptions.workflowId } : {}),
      };
      this.#attachments.set(built.session.id, state);
      state.heartbeat = setInterval(() => {
        void this.#renewLease(built.session.id, state);
      }, this.#policy.leaseHeartbeatMs);
      state.heartbeat.unref?.();
      try {
        const snapshot = await this.inspectSession(built.session.id);
        const preCallContext = await this.#resolvePreCallContextFor(built.session.id);
        return attachmentView(
          state,
          snapshot,
          () => this.#detach(built.session.id, state),
          preCallContext,
        );
      } catch (error) {
        await this.#detach(built.session.id, state).catch(() => undefined);
        throw error;
      }
    }
    const session = await this.startSession(agent, effectiveOptions);
    const fallthrough: {
      memoryUserId?: UserId;
      organizationId?: OrganizationId;
      workflowId?: WorkflowId;
    } = {};
    if (effectiveOptions.memoryUserId) fallthrough.memoryUserId = effectiveOptions.memoryUserId;
    if (effectiveOptions.organizationId)
      fallthrough.organizationId = effectiveOptions.organizationId;
    if (effectiveOptions.workflowId) fallthrough.workflowId = effectiveOptions.workflowId;
    return this.attachSession(agent, session.id, {
      ...fallthrough,
      ...(options.holderId ? { holderId: options.holderId } : {}),
    });
  }

  async attachSession(
    agent: Agent,
    sessionId: SessionId,
    options: {
      readonly holderId?: string;
      readonly memoryUserId?: UserId;
      readonly organizationId?: OrganizationId;
      readonly workflowId?: WorkflowId;
    } = {},
  ): Promise<SessionAttachment> {
    this.#assertRunning();
    assertMemoryPolicySupported(this.#memory, agent.memoryPolicy);
    if (this.#attachments.has(sessionId) || this.#attachmentStarts.has(sessionId)) {
      throw new LeaseUnavailableError(`Session is already attached: ${sessionId}`);
    }
    this.#attachmentStarts.add(sessionId);
    const stored = await this.#requireSession(sessionId).catch((error: unknown) => {
      this.#attachmentStarts.delete(sessionId);
      throw error;
    });
    if (stored.session.agentId !== agent.id) {
      this.#attachmentStarts.delete(sessionId);
      throw new InvalidArgumentError(`Agent mismatch for session: ${sessionId}`);
    }
    if (
      stored.session.status !== "active" &&
      stored.session.status !== "interrupted" &&
      stored.session.status !== "waiting_for_tool" &&
      stored.session.status !== "ending"
    ) {
      this.#attachmentStarts.delete(sessionId);
      throw new Error(`Cannot attach ${stored.session.status} session: ${sessionId}`);
    }

    const holder = options.holderId ?? this.#holderId;
    const attachStartedAtMs = this.#clock.monotonicMs();
    let lease: SessionLease | null;
    try {
      lease = await this.#criticalWrite(
        () => this.#durableStore.leases.acquire(sessionId, holder, this.#policy.leaseTtlMs),
        ({ result, error }) => {
          if (!error && result) {
            void this.#durableStore.leases
              .release(sessionId, result.holder, result.fence)
              .catch(() => undefined);
          }
        },
      );
    } catch (error) {
      this.#attachmentStarts.delete(sessionId);
      throw error;
    }
    if (!lease) {
      this.#attachmentStarts.delete(sessionId);
      throw new Error(`Session lease unavailable: ${sessionId}`);
    }

    let attachmentState: RuntimeAttachmentState | undefined;
    try {
      const nowMs = Date.parse(this.#clock.now());
      const startedAtMs =
        "startedAt" in stored.session ? Date.parse(stored.session.startedAt) : nowMs;
      const lastActivityMs =
        stored.runtime.lastActivityWallAtMs ?? Date.parse(stored.session.createdAt);
      const recoveryGapMs = Number.isFinite(lastActivityMs)
        ? Math.max(0, nowMs - lastActivityMs)
        : 0;
      const sessionElapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
      this.#emitMetric("session.recovery.gap_ms", recoveryGapMs);
      this.#sessionStartMs.set(sessionId, this.#clock.monotonicMs() - sessionElapsedMs);

      await this.#criticalWrite(() =>
        this.#durableStore.runSessionTransaction(sessionId, lease, async (tx) => {
          const current = await tx.getSession(sessionId);
          if (
            !current ||
            (current.session.status !== "active" &&
              current.session.status !== "interrupted" &&
              current.session.status !== "waiting_for_tool" &&
              current.session.status !== "ending")
          ) {
            throw new Error(`Session is no longer attachable: ${sessionId}`);
          }
          const turns = await tx.listTurns(sessionId);
          let maxSequence = current.session.state.turnSequence;
          const pendingToolCallIds: ToolCallId[] = [];
          for (const turnRecord of turns) {
            maxSequence = Math.max(maxSequence, turnRecord.turn.sequence);
            if (!isTerminalTurn(turnRecord.turn)) {
              const orphaned = terminalTurnFromRequest(
                turnRecord.turn,
                {
                  reason: "cancelled",
                  cancelReason: "runtime_restarted",
                  latency: { recoveryGapMs },
                },
                this.#clock.now(),
                0,
              );
              const recoveredTurn = await tx.updateTurn(
                sessionId,
                turnRecord.turn.id,
                (record) => ({
                  ...record,
                  turn: orphaned,
                  runtime: { ...record.runtime, recoveryGapMs },
                }),
              );
              await tx.appendOutbox(
                durableEvent(
                  "turn",
                  recoveredTurn.turn.id,
                  sessionId,
                  lease.fence,
                  recoveredTurn.turn.status,
                  recoveredTurn.turn,
                  recoveredTurn.runtime,
                  recoveredTurn.version,
                ),
              );
            }
          }
          const toolRecords = await tx.listToolCalls(sessionId);
          for (const toolRecord of toolRecords) {
            if (toolRecord.toolCall.status === "queued") {
              pendingToolCallIds.push(toolRecord.toolCall.toolCallId);
              continue;
            }
            if (toolRecord.toolCall.status !== "running") continue;
            const recoveredAt = this.#clock.now();
            const replayed = await replayRecoveredToolCall(
              toolRecord.toolCall,
              agent,
              this.toolIdempotencyStore,
              recoveredAt,
            );
            const recoveredTool: TerminalToolCall = replayed ?? {
              ...toolRecord.toolCall,
              status: "failed",
              endedAt: recoveredAt,
              error: internalError(
                "tool.runtime_restarted",
                "Tool execution was interrupted by runtime ownership loss",
              ),
              metadata: { ...(toolRecord.toolCall.metadata ?? {}), recovery: "ambiguous" },
            };
            const updatedTool = await tx.updateToolCall(
              sessionId,
              toolRecord.toolCall.toolCallId,
              (record) => ({ ...record, toolCall: recoveredTool }),
            );
            await tx.appendOutbox(
              durableEvent(
                "tool_call",
                updatedTool.toolCall.toolCallId,
                sessionId,
                lease.fence,
                updatedTool.toolCall.status,
                updatedTool.toolCall,
                updatedTool.runtime,
                updatedTool.version,
              ),
            );
          }
          const updatedSession = await tx.updateSession(sessionId, (record) => {
            const { currentTurnId: _currentTurnId, ...stateWithoutCurrentTurn } =
              record.session.state;
            return {
              ...record,
              session: ensureActiveSession({
                ...record.session,
                state: {
                  ...stateWithoutCurrentTurn,
                  turnSequence: maxSequence,
                  pendingToolCallIds,
                },
              }),
              runtime: {
                ...record.runtime,
                lastActivityWallAtMs: nowMs,
                clockEpoch: (record.runtime.clockEpoch ?? 0) + 1,
                ...(recoveryGapMs > this.#policy.recoveryGraceMs
                  ? { clockDiscontinuityMs: recoveryGapMs }
                  : {}),
              },
            };
          });
          await tx.appendOutbox(
            durableEvent(
              "session",
              sessionId,
              sessionId,
              lease.fence,
              updatedSession.session.status,
              updatedSession.session,
              updatedSession.runtime,
              updatedSession.version,
            ),
          );
        }),
      );
      this.#emitMetric("session.attach.latency_ms", this.#clock.monotonicMs() - attachStartedAtMs);

      const controller = new AbortController();
      const storedMemoryUserId = metadataString(stored.session.metadata, "memoryUserId");
      const storedOrganizationId = metadataString(stored.session.metadata, "organizationId");
      const storedWorkflowId = metadataString(stored.session.metadata, "workflowId");
      const memoryUserId = storedMemoryUserId ?? options.memoryUserId;
      const organizationId =
        storedOrganizationId ?? options.organizationId ?? this.#defaultOrganizationId;
      const workflowId = storedWorkflowId ?? options.workflowId ?? this.#defaultWorkflowId;
      const state: RuntimeAttachmentState = {
        agent,
        controller,
        lease,
        holder,
        health: "healthy",
        ...(memoryUserId ? { memoryUserId: memoryUserId as UserId } : {}),
        ...(organizationId ? { organizationId: organizationId as OrganizationId } : {}),
        ...(workflowId ? { workflowId: workflowId as WorkflowId } : {}),
      };
      attachmentState = state;
      this.#attachments.set(sessionId, state);
      state.heartbeat = setInterval(() => {
        void this.#renewLease(sessionId, state);
      }, this.#policy.leaseHeartbeatMs);
      state.heartbeat.unref?.();
      const snapshot = await this.inspectSession(sessionId);
      const preCallContext = await this.#resolvePreCallContextFor(sessionId);
      return attachmentView(state, snapshot, () => this.#detach(sessionId, state), preCallContext);
    } catch (error) {
      await this.#detach(sessionId, attachmentState).catch(() => undefined);
      await this.#durableStore.leases
        .release(sessionId, holder, lease.fence)
        .catch(() => undefined);
      this.#sessionStartMs.delete(sessionId);
      throw error;
    } finally {
      this.#attachmentStarts.delete(sessionId);
    }
  }

  sessionClockMs(id: SessionId): number {
    const start = this.#sessionStartMs.get(id);
    if (start === undefined) {
      throw new Error(`sessionClockMs: no active clock for session ${id}`);
    }
    return monotonicOffsetMs(this.#clock, start);
  }

  async recordToolCall(toolCall: ToolCall): Promise<void> {
    this.#assertRunning();
    await persistToolCallRecord(this.#toolContext(), toolCall);
  }

  async inspectSession(id: SessionId): Promise<SessionSnapshot> {
    const sessionRecord = await this.#requireSession(id);
    return {
      session: sessionRecord.session,
      turns: (await this.#turnStore.listBySession(id)).map((record) => record.turn),
      toolCalls: (await this.#toolCallStore.listBySession(id)).map((record) => record.toolCall),
    };
  }

  async #renewLease(sessionId: SessionId, state: RuntimeAttachmentState): Promise<void> {
    await renewLease(sessionId, state, {
      clock: this.#clock,
      durableStore: this.#durableStore,
      policy: this.#policy,
      emitMetric: (name, value) => this.#emitMetric(name, value),
    });
    if (state.health === "lease_lost") {
      await detachAttachment(
        sessionId,
        this.#attachments,
        this.#durableStore,
        this.#sessionStartMs,
        state,
        true,
      );
    }
  }

  async #detach(
    sessionId: SessionId,
    expectedState?: RuntimeAttachmentState,
    releaseLease = true,
  ): Promise<void> {
    await detachAttachment(
      sessionId,
      this.#attachments,
      this.#durableStore,
      this.#sessionStartMs,
      expectedState,
      false,
      1_000,
      releaseLease,
    );
  }

  async #requireSession(id: SessionId): Promise<StoredSessionRecord> {
    const record = await this.#sessionStore.get(id);
    if (!record) {
      throw new RecordNotFoundError(`session:${id}`);
    }
    return record;
  }

  #turnContext(): RuntimeTurnContext {
    return {
      clock: this.#clock,
      ids: this.#ids,
      durableStore: this.#durableStore,
      sessionStore: this.#sessionStore,
      turnStore: this.#turnStore,
      attachments: this.#attachments,
      criticalWrite: (operation, onLate) => this.#criticalWrite(operation, onLate),
      runUnfencedSessionTransaction: (sessionId, operation, onLate) =>
        this.#runUnfencedSessionTransaction(sessionId, operation, onLate),
      durationSince: (monotonicStartedAtMs) => this.#durationSince(monotonicStartedAtMs),
      abandonLateTurn: (turn) => this.#abandonLateTurn(turn),
    };
  }

  #toolContext(): ToolLifecycleContext {
    return {
      clock: this.#clock,
      durableStore: this.#durableStore,
      sessionStore: this.#sessionStore,
      toolCallStore: this.#toolCallStore,
      attachments: this.#attachments,
      toolIdempotencyStore: this.toolIdempotencyStore,
      sessionClockMs: (sessionId) => this.sessionClockMs(sessionId),
      criticalWrite: (operation, onLate) => this.#criticalWrite(operation, onLate),
    };
  }

  async #resolvePreCallContextFor(sessionId: SessionId): Promise<PreCallContext> {
    const attachment = this.#attachments.get(sessionId);
    const refs: { userId?: UserId; organizationId?: OrganizationId; workflowId?: WorkflowId } = {};
    if (attachment?.memoryUserId) refs.userId = attachment.memoryUserId;
    if (attachment?.organizationId) refs.organizationId = attachment.organizationId;
    if (attachment?.workflowId) refs.workflowId = attachment.workflowId;

    const memoryPolicy = attachment?.agent.memoryPolicy;
    const contextPolicy = attachment?.agent.contextPolicy;
    const preCallLoad = memoryPolicy?.preCallLoad ?? "all";
    const scopes =
      memoryPolicy?.enabled !== false && preCallLoad !== "none" ? (memoryPolicy?.scopes ?? []) : [];
    const kind = preCallLoad.startsWith("kind:")
      ? (preCallLoad.slice("kind:".length) as import("@tvic/core").MemoryKind)
      : undefined;

    return resolvePreCallContext({
      memory: this.#memory,
      resolver: this.#preCallContextResolver,
      sessionId,
      ...refs,
      clock: () => Date.parse(this.#clock.now()),
      scopes,
      ...(kind ? { kind } : {}),
      ...(contextPolicy?.maxPreCallEntries !== undefined
        ? { maxEntries: contextPolicy.maxPreCallEntries }
        : {}),
      ...(contextPolicy?.maxPreCallBytes !== undefined
        ? { maxBytes: contextPolicy.maxPreCallBytes }
        : {}),
      ...(this.#preCallStaticProvider ? { staticProvider: this.#preCallStaticProvider } : {}),
    });
  }

  #withRuntimeDefaults(options: StartSessionOptions): StartSessionOptions {
    const withDefaults = { ...options };
    const organizationId = options.organizationId ?? this.#defaultOrganizationId;
    if (organizationId) withDefaults.organizationId = organizationId;
    const workflowId = options.workflowId ?? this.#defaultWorkflowId;
    if (workflowId) withDefaults.workflowId = workflowId;
    return withDefaults;
  }

  #assertRunning(): void {
    if (!this.#running) {
      throw new Error("Runtime is not running");
    }
  }

  #durationSince(monotonicStartedAtMs: number): number {
    return monotonicOffsetMs(this.#clock, monotonicStartedAtMs);
  }

  #durationForTurn(
    sessionId: SessionId,
    turn: ActiveTurn,
    monotonicStartedAtMs: number,
    endedAt: Timestamp,
  ): number {
    if (this.#sessionStartMs.has(sessionId)) {
      return this.#durationSince(monotonicStartedAtMs);
    }
    const startedAtMs = Date.parse(turn.startedAt);
    const endedAtMs = Date.parse(endedAt);
    return Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
      ? Math.max(0, endedAtMs - startedAtMs)
      : 0;
  }

  async #abandonLateSession(sessionId: SessionId, lease?: SessionLease): Promise<void> {
    const request = {
      reason: "failed" as const,
      error: timeoutError(
        "runtime.session_start_timed_out",
        "Session creation completed after the caller deadline",
      ),
    };
    if (lease) {
      let persisted: PersistedSessionEnd | undefined;
      try {
        persisted = await this.#durableStore.runSessionTransaction(sessionId, lease, (tx) =>
          this.#persistEnd(tx, sessionId, request, this.#clock.now(), lease.fence),
        );
      } catch {
        // The returned lease may have expired before the fenced cleanup could
        // run. In that case the next owner/reaper remains authoritative; an
        // unfenced fallback would be unsafe.
      } finally {
        await this.#durableStore.leases
          .release(sessionId, lease.holder, lease.fence)
          .catch(() => undefined);
      }
      if (persisted?.shouldEmit) {
        await this.#finishClaimedSessionEnd(persisted.session, undefined);
      }
      return;
    }
    try {
      await this.endSession(sessionId, request);
    } catch {
      // The late result is observed by the critical-write continuation. A
      // failed unfenced cleanup remains visible to the normal reaper path.
    }
  }

  async #finishClaimedSessionEnd(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    this.#sessionEndCoordinator.closeAdmission(session.id);
    this.#sessionStartMs.delete(session.id);
    await this.#detach(session.id, attachment).catch(() => undefined);
    await this.#emitSessionEnd(session, attachment);
  }

  async #finishLateSession(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    await this.#finishClaimedSessionEnd(session, attachment);
  }

  async #finishLateSessionEnd(
    sessionId: SessionId,
    attachment: RuntimeAttachmentState | undefined,
    lease: SessionLease,
    outcome: LateWriteOutcome<PersistedSessionEnd>,
  ): Promise<void> {
    await this.#durableStore.leases
      .release(sessionId, lease.holder, lease.fence)
      .catch(() => undefined);
    if (outcome.result?.shouldEmit) {
      await this.#finishClaimedSessionEnd(outcome.result.session, attachment);
    }
  }

  async #abandonLateTurn(turn: ActiveTurn): Promise<void> {
    await this.endTurn(turn.sessionId, turn.id, {
      reason: "cancelled",
      cancelReason: "runtime_restarted",
    }).catch(() => undefined);
  }

  async #criticalWrite<T>(
    operation: () => Promise<T>,
    onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
    onTimeout?: () => void,
  ): Promise<T> {
    return criticalWrite(
      this.#clock,
      this.#policy,
      operation,
      (name, value) => this.#emitMetric(name, value),
      onLate,
      onTimeout,
    );
  }

  #runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
    onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
  ): Promise<T> {
    const run = this.#durableStore.runUnfencedSessionTransaction;
    if (!run) {
      return Promise.reject(
        new LeaseUnavailableError(`Unfenced compatibility transaction unavailable: ${sessionId}`),
      );
    }
    return this.#criticalWrite(
      () => run.call(this.#durableStore, sessionId, operation) as Promise<T>,
      onLate,
    );
  }

  #emitMetric(
    name: string,
    value: number,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    try {
      this.#onDurableMetric?.({
        name,
        value,
        atMs: Date.parse(this.#clock.now()),
        ...(attributes ? { attributes } : {}),
      });
    } catch {
      // Metrics are observation only and cannot affect live execution.
    }
  }

  #recordSessionMetric(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
  ): void {
    try {
      this.#sessionMetricsRecorder?.record(name, attributes);
    } catch {
      // Metrics are observation only and cannot affect live execution.
    }
  }
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new InMemoryRuntime(options);
}
