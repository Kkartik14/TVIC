import { randomUUID } from "node:crypto";
import { createInMemoryDurableRuntimeStore, createInMemoryMemory } from "@tvic/dal";
import { InMemoryToolIdempotencyStore } from "@tvic/tools";
import {
  finishToolCall as persistFinishedToolCall,
  recordToolCall as persistToolCallRecord,
  startToolCall as persistStartedToolCall,
} from "./tool-lifecycle.js";
import { recoverToolCalls as recoverPersistedToolCalls } from "./tool-recovery.js";
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
  LeaseUnavailableError,
  monotonicOffsetMs,
  timeoutError,
  RecordNotFoundError,
} from "@tvic/core";
import type {
  ActiveSession,
  ActiveTurn,
  Agent,
  AudioTapSummary,
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
  drainFinalizers,
  durableEvent,
  renewLease,
  trackFinalizer,
  type LateWriteOutcome,
  type RuntimeAttachmentState,
} from "./runtime-support.js";
import { attachRuntimeSession } from "./runtime-attachment.js";
import type { RuntimeAttachmentContext } from "./runtime-attachment.js";
import { positiveSafeInteger } from "./runtime-request-helpers.js";
import {
  checkpointTurnInterruption as checkpointRuntimeTurnInterruption,
  endTurn as endRuntimeTurn,
  startTurn as startRuntimeTurn,
  updateTurnStatus as updateRuntimeTurnStatus,
  type RuntimeTurnContext,
} from "./runtime-turns.js";
import { SessionEndCoordinator } from "./session-end.js";
import { AttachmentAdmission } from "./attachment-admission.js";
import { assertMemoryPolicySupported } from "./memory-capabilities.js";
import {
  closeRuntimeDurableStore,
  drainPipelineRuns,
  waitForFinalizersAndClose,
} from "./runtime-shutdown.js";
import {
  durationForTerminalTurn,
  persistSessionEnd,
  type PersistedSessionEnd,
} from "./session-terminalization.js";

const DEFAULT_DURABLE_POLICY = DEFAULT_DURABLE_RUNTIME_POLICY;
const DEFAULT_SESSION_MEMORY_FINALIZE_TIMEOUT_MS = 1_000;
const DEFAULT_SESSION_END_HOOK_TIMEOUT_MS = 5_000;
const PIPELINE_DRAIN_TIMEOUT_MS = 5_000;

interface ActiveToolCall {
  pendingFinishes: number;
}

export class InMemoryRuntime implements Runtime {
  readonly #sessionStore;
  readonly #turnStore;
  readonly #toolCallStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #durableStore: DurableRuntimeStore;
  readonly #durableStoreOwnership: "runtime" | "caller";
  readonly #policy: DurableRuntimePolicy;
  readonly #holderId: string;
  readonly #holderIncarnationId: string;
  readonly #onDurableMetric: ((metric: DurableRuntimeMetric) => void) | undefined;
  readonly #attachments = new Map<SessionId, RuntimeAttachmentState>();
  readonly #attachmentStarts = new AttachmentAdmission();
  readonly #unattachedSessionWrites = new Map<SessionId, Set<Promise<void>>>();
  readonly #activeToolCallsBySession = new Map<SessionId, Map<ToolCallId, ActiveToolCall>>();
  readonly #toolRecoverySessions = new Set<SessionId>();
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
  readonly #finalizingSessionStartMs = new Map<SessionId, number>();
  readonly #failedSessionEndCleanups = new Map<
    SessionId,
    { promise: Promise<void>; discardAudioTapSummaryOnFinish: boolean }
  >();
  readonly #sessionEndOperations = new Map<SessionId, Promise<TerminalSession>>();
  readonly #inFlightFinalizers = new Set<Promise<unknown>>();
  readonly #pipelineRuns = new Map<
    symbol,
    { readonly run: Promise<unknown>; readonly cancel: () => void }
  >();
  #running = false;
  #hardStopped = false;
  #acceptingShutdownTerminalWrites = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: RuntimeOptions = {}) {
    this.#clock = options.clock ?? createSystemClock();
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#policy = { ...DEFAULT_DURABLE_POLICY, ...options.durablePolicy };
    this.#holderId = options.holderId ?? "runtime";
    this.#holderIncarnationId = randomUUID();
    this.#onDurableMetric = options.onDurableMetric;
    const hasLegacyStore =
      options.sessionStore !== undefined ||
      options.turnStore !== undefined ||
      options.toolCallStore !== undefined;
    if (options.durableStore !== undefined && hasLegacyStore) {
      throw new InvalidArgumentError(
        "durableStore cannot be combined with sessionStore, turnStore, or toolCallStore",
      );
    }
    this.#durableStoreOwnership = options.durableStoreOwnership ?? "runtime";
    this.#durableStore =
      options.durableStore ??
      createInMemoryDurableRuntimeStore({
        nowMs: () => Date.parse(this.#clock.now()),
        ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
        ...(options.turnStore ? { turnStore: options.turnStore } : {}),
        ...(options.toolCallStore ? { toolCallStore: options.toolCallStore } : {}),
      });
    this.#sessionStore = this.#durableStore.sessions;
    this.#turnStore = this.#durableStore.turns;
    this.#toolCallStore = this.#durableStore.toolCalls;
    const currentLease = (
      this.#durableStore as DurableRuntimeStore & {
        readonly currentLease?: (sessionId: SessionId) => SessionLease | null;
      }
    ).currentLease;
    this.toolIdempotencyStore =
      options.toolIdempotencyStore ??
      this.#durableStore.toolIdempotencyStore ??
      new InMemoryToolIdempotencyStore(
        () => Date.parse(this.#clock.now()),
        currentLease ? (sessionId) => currentLease.call(this.#durableStore, sessionId) : undefined,
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

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#stopPromise) {
      throw new Error("Runtime cannot be restarted after stop");
    }
    if (signal?.aborted) {
      throw cancelledError(
        "voice_runtime.runtime_start_cancelled",
        "Runtime startup was cancelled",
      );
    }
    if (this.#running) return;
    this.#running = true;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#acceptingShutdownTerminalWrites = this.#running;
    this.#running = false;
    for (const active of this.#pipelineRuns.values()) {
      try {
        active.cancel();
      } catch {}
    }
    this.#stopPromise = this.#stopInternal();
    return this.#stopPromise;
  }

  registerPipelineRun(run: Promise<unknown>, cancel: () => void): () => void {
    const key = Symbol("pipeline-run");
    if (this.#stopPromise) {
      try {
        cancel();
      } catch {}
      return () => undefined;
    }
    this.#pipelineRuns.set(key, { run, cancel });
    const unregister = (): void => {
      this.#pipelineRuns.delete(key);
    };
    void run.then(unregister, unregister);
    return unregister;
  }

  async #stopInternal(): Promise<void> {
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
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    const drained = await drainPipelineRuns(this.#pipelineRuns.values(), PIPELINE_DRAIN_TIMEOUT_MS);
    this.#acceptingShutdownTerminalWrites = false;
    if (!drained) {
      this.#hardStopped = true;
      this.#pipelineRuns.clear();
    }
    await drainFinalizers(this.#inFlightFinalizers);
    await Promise.all([...this.#attachments.keys()].map((sessionId) => this.#detach(sessionId)));
    const finalizersDrained = await drainFinalizers(this.#inFlightFinalizers);
    if (!finalizersDrained && this.#inFlightFinalizers.size > 0) {
      void waitForFinalizersAndClose(
        this.#inFlightFinalizers,
        () => {
          this.#sessionStartMs.clear();
          this.#finalizingSessionStartMs.clear();
        },
        () => closeRuntimeDurableStore(this.#durableStoreOwnership, this.#durableStore),
      ).catch(() => this.#emitMetric("runtime.shutdown.deferred_store_close_failure", 1));
      throw new BackendUnavailableError(
        "Runtime shutdown timed out waiting for durable writes; store close is deferred until they settle",
      );
    }
    this.#sessionStartMs.clear();
    this.#finalizingSessionStartMs.clear();
    await closeRuntimeDurableStore(this.#durableStoreOwnership, this.#durableStore);
  }

  async startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession> {
    this.#assertRunning();
    return trackFinalizer(this.#inFlightFinalizers, this.#startSession(agent, options));
  }

  async #startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession> {
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
        if (!error) return this.#abandonLateSession(built.session.id).catch(() => undefined);
      },
    );
    if (!this.#running) {
      await this.#abandonLateSession(built.session.id, undefined, {
        reason: "cancelled",
        cancelReason: "shutdown",
        terminalSource: "runtime_shutdown",
      });
      throw new Error("Runtime is not running");
    }
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
    this.#assertTerminalWriteAllowed();
    const existing = this.#sessionEndOperations.get(id);
    if (existing) return existing;
    const operation = trackFinalizer(this.#inFlightFinalizers, this.#endSession(id, request));
    this.#sessionEndOperations.set(id, operation);
    void operation.then(
      () => {
        if (this.#sessionEndOperations.get(id) === operation) {
          this.#sessionEndOperations.delete(id);
        }
      },
      () => {
        if (this.#sessionEndOperations.get(id) === operation) {
          this.#sessionEndOperations.delete(id);
        }
      },
    );
    return operation;
  }

  reportAudioTapSummary(id: SessionId, summary: AudioTapSummary): void {
    this.#sessionEndCoordinator.reportAudioTapSummary(id, summary);
  }

  registerAudioTapFinalizer(
    id: SessionId,
    finalize: () => AudioTapSummary | Promise<AudioTapSummary>,
  ): void {
    this.#sessionEndCoordinator.registerAudioTapFinalizer(id, finalize);
  }

  unregisterAudioTapFinalizer(id: SessionId): void {
    this.#sessionEndCoordinator.unregisterAudioTapFinalizer(id);
  }

  async #endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession> {
    await this.#failedSessionEndCleanups.get(id)?.promise;
    const attachment = this.#attachments.get(id);
    const lease = attachment?.lease;
    const record = await this.#sessionStore.get(id);
    if (!record) {
      throw new RecordNotFoundError(`session:${id}`);
    }
    if (isTerminalSession(record.session)) {
      if (attachment) await this.#detach(id, attachment).catch(() => undefined);
      return record.session;
    }

    const now = this.#clock.now();
    let persisted: PersistedSessionEnd | undefined;
    let lateEndPending = false;
    let releaseLateWriteAdmission: (() => void) | undefined;
    const onWriteTimeout = (): void => {
      lateEndPending = true;
      releaseLateWriteAdmission ??= this.#attachmentStarts.acquire(id);
    };
    const onLateWriteSettled = (): void => {
      releaseLateWriteAdmission?.();
      releaseLateWriteAdmission = undefined;
    };
    try {
      if (lease) {
        persisted = await this.#criticalWrite(
          () =>
            this.#durableStore.runSessionTransaction(id, lease, (tx) =>
              persistSessionEnd(
                tx,
                id,
                request,
                now,
                lease.fence,
                (sessionId, turn, startedAtMs, endedAt) =>
                  this.#durationForTurn(sessionId, turn, startedAtMs, endedAt),
              ),
            ),
          (outcome) =>
            this.#finishLateSessionEnd(id, attachment, lease, outcome).finally(onLateWriteSettled),
          onWriteTimeout,
        );
      } else {
        persisted = await this.#runUnfencedSessionTransaction(
          id,
          (tx) =>
            persistSessionEnd(tx, id, request, now, 0, (sessionId, turn, startedAtMs, endedAt) =>
              this.#durationForTurn(sessionId, turn, startedAtMs, endedAt),
            ),
          async ({ result, error }) => {
            try {
              if (!error && result?.shouldEmit) {
                await this.#finishLateSession(result.session, attachment);
              } else {
                if (attachment) {
                  await this.#detach(id, attachment, true, true).catch(() => undefined);
                }
                this.#discardFailedSessionEnd(id);
              }
            } finally {
              onLateWriteSettled();
            }
          },
          onWriteTimeout,
        );
      }
    } finally {
      if (persisted?.shouldEmit) {
        await this.#finishClaimedSessionEnd(persisted.session, attachment);
      } else if (lateEndPending) {
        if (lease) {
          await this.#detach(id, attachment, false).catch(() => undefined);
        } else {
          this.#sessionStartMs.delete(id);
          this.#finalizingSessionStartMs.delete(id);
        }
        this.#finalizeTimedOutSessionEnd(id);
      } else {
        if (attachment) await this.#detach(id, attachment, true, true).catch(() => undefined);
        this.#discardFailedSessionEnd(id);
        onLateWriteSettled();
      }
    }
    if (!persisted) {
      throw new BackendUnavailableError(`Session terminalization failed: ${id}`);
    }
    return persisted.session;
  }

  async #emitSessionEnd(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    await this.#sessionEndCoordinator.emit(session, attachment);
  }

  async startTurn(request: StartTurnRequest): Promise<ActiveTurn> {
    this.#assertRunning();
    return trackFinalizer(this.#inFlightFinalizers, startRuntimeTurn(this.#turnContext(), request));
  }

  async endTurn(
    sessionId: SessionId,
    turnId: TurnId,
    request: EndTurnRequest,
  ): Promise<TerminalTurn> {
    this.#assertTerminalWriteAllowed();
    return trackFinalizer(
      this.#inFlightFinalizers,
      endRuntimeTurn(this.#turnContext(), sessionId, turnId, request),
    );
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
    return trackFinalizer(this.#inFlightFinalizers, this.#startToolCall(toolCall));
  }

  async #startToolCall(toolCall: QueuedToolCall): Promise<RunningToolCall> {
    if (
      this.#toolRecoverySessions.has(toolCall.sessionId) ||
      this.#attachmentStarts.has(toolCall.sessionId)
    ) {
      throw new InvalidArgumentError(
        `Cannot start a tool call while recovery is running: ${toolCall.sessionId}`,
      );
    }
    let sessionCalls = this.#activeToolCallsBySession.get(toolCall.sessionId);
    if (!sessionCalls) {
      sessionCalls = new Map();
      this.#activeToolCallsBySession.set(toolCall.sessionId, sessionCalls);
    }
    if (sessionCalls.has(toolCall.toolCallId)) {
      throw new InvalidArgumentError(
        `Tool call is already executing: ${toolCall.sessionId}/${toolCall.toolCallId}`,
      );
    }
    const activeCall: ActiveToolCall = { pendingFinishes: 0 };
    sessionCalls.set(toolCall.toolCallId, activeCall);
    try {
      return await persistStartedToolCall(this.#toolContext(), toolCall);
    } catch (error) {
      this.#releaseActiveToolCall(toolCall.sessionId, toolCall.toolCallId, activeCall);
      throw error;
    }
  }

  async finishToolCall(toolCall: TerminalToolCall): Promise<TerminalToolCall> {
    this.#assertTerminalWriteAllowed();
    const activeCall = this.#activeToolCallsBySession
      .get(toolCall.sessionId)
      ?.get(toolCall.toolCallId);
    if (activeCall) activeCall.pendingFinishes += 1;
    try {
      return await persistFinishedToolCall(this.#toolContext(), toolCall);
    } finally {
      if (activeCall) {
        activeCall.pendingFinishes -= 1;
        if (activeCall.pendingFinishes === 0) {
          this.#releaseActiveToolCall(toolCall.sessionId, toolCall.toolCallId, activeCall);
        }
      }
    }
  }

  async recoverToolCalls(sessionId: SessionId): Promise<readonly ToolCall[]> {
    this.#assertRunning();
    return trackFinalizer(this.#inFlightFinalizers, this.#recoverToolCalls(sessionId));
  }

  async #recoverToolCalls(sessionId: SessionId): Promise<readonly ToolCall[]> {
    const activeCalls = this.#activeToolCallsBySession.get(sessionId);
    if (
      this.#toolRecoverySessions.has(sessionId) ||
      this.#attachmentStarts.has(sessionId) ||
      (activeCalls !== undefined && activeCalls.size > 0)
    ) {
      throw new InvalidArgumentError(
        `Tool-call recovery is unavailable while a call is executing or the session is attaching: ${sessionId}`,
      );
    }
    this.#toolRecoverySessions.add(sessionId);
    try {
      return await recoverPersistedToolCalls(this.#toolContext(), sessionId);
    } finally {
      this.#toolRecoverySessions.delete(sessionId);
    }
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
    return trackFinalizer(this.#inFlightFinalizers, this.#startAttachedSession(agent, options));
  }

  async #startAttachedSession(
    agent: Agent,
    options: StartAttachedSessionOptions,
  ): Promise<SessionAttachment> {
    this.#assertRunning();
    assertMemoryPolicySupported(this.#memory, agent.memoryPolicy);
    const effectiveOptions = this.#withRuntimeDefaults(options);
    const createSessionWithLease = this.#durableStore.createSessionWithLease;
    if (createSessionWithLease) {
      const built = buildSession(this.#clock, this.#ids, agent, effectiveOptions);
      const holder = this.#leaseHolder(options.holderId);
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
            return this.#abandonLateSession(built.session.id, result);
          }
        },
      );
      if (!lease) throw new Error(`Session lease unavailable: ${built.session.id}`);
      if (!this.#running) {
        await this.#abandonLateSession(built.session.id, lease, {
          reason: "cancelled",
          cancelReason: "shutdown",
          terminalSource: "runtime_shutdown",
        });
        throw new Error("Runtime is not running");
      }
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
        this.#assertRunning();
        return attachmentView(
          state,
          snapshot,
          () => this.#detach(built.session.id, state),
          preCallContext,
        );
      } catch (error) {
        await this.#abandonLateSession(
          built.session.id,
          lease,
          this.#sessionAttachFailureRequest(error),
        ).catch(() => undefined);
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
    try {
      return await this.attachSession(agent, session.id, {
        ...fallthrough,
        ...(options.holderId ? { holderId: options.holderId } : {}),
      });
    } catch (error) {
      await this.#abandonUnattachedSessionAfterAttachFailure(
        session.id,
        this.#leaseHolder(options.holderId),
        this.#sessionAttachFailureRequest(error),
      );
      throw error;
    }
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
    await this.#failedSessionEndCleanups.get(sessionId)?.promise;
    return trackFinalizer(
      this.#inFlightFinalizers,
      attachRuntimeSession(this.#attachmentContext(), agent, sessionId, options),
    );
  }

  sessionClockMs(id: SessionId): number {
    const start = this.#sessionStartMs.get(id) ?? this.#finalizingSessionStartMs.get(id);
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
        this.#attachmentStarts,
        state,
        true,
      );
    }
  }

  async #detach(
    sessionId: SessionId,
    expectedState?: RuntimeAttachmentState,
    releaseLease = true,
    preserveSessionClock = false,
  ): Promise<void> {
    await detachAttachment(
      sessionId,
      this.#attachments,
      this.#durableStore,
      this.#sessionStartMs,
      this.#attachmentStarts,
      expectedState,
      false,
      1_000,
      releaseLease,
      preserveSessionClock,
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
      attachmentStarts: this.#attachmentStarts,
      isRunning: () => this.#running,
      criticalWrite: (operation, onLate, onTimeout) =>
        this.#criticalWrite(operation, onLate, onTimeout),
      runUnfencedSessionTransaction: (sessionId, operation, onLate, onTimeout) =>
        this.#runUnfencedSessionTransaction(sessionId, operation, onLate, onTimeout),
      reserveUnattachedSessionWrite: (sessionId) => this.#reserveUnattachedSessionWrite(sessionId),
      durationSince: (monotonicStartedAtMs) => this.#durationSince(monotonicStartedAtMs),
      abandonLateTurn: (turn) => this.#abandonLateTurn(turn),
    };
  }

  #attachmentContext(): RuntimeAttachmentContext {
    return {
      assertRunning: () => this.#assertRunning(),
      isRunning: () => this.#running,
      memory: this.#memory,
      durableStore: this.#durableStore,
      policy: this.#policy,
      clock: this.#clock,
      attachments: this.#attachments,
      attachmentStarts: this.#attachmentStarts,
      activeToolCallsBySession: this.#activeToolCallsBySession,
      toolRecoverySessions: this.#toolRecoverySessions,
      sessionStartMs: this.#sessionStartMs,
      ...(this.#defaultOrganizationId
        ? { defaultOrganizationId: this.#defaultOrganizationId }
        : {}),
      ...(this.#defaultWorkflowId ? { defaultWorkflowId: this.#defaultWorkflowId } : {}),
      toolContext: this.#toolContext(),
      leaseHolder: (logicalHolderId) => this.#leaseHolder(logicalHolderId),
      criticalWrite: (operation, onLate, onTimeout) =>
        this.#criticalWrite(operation, onLate, onTimeout),
      waitForUnattachedSessionWrites: (sessionId) =>
        this.#waitForUnattachedSessionWrites(sessionId),
      emitMetric: (name, value) => this.#emitMetric(name, value),
      resolvePreCallContextFor: (id) => this.#resolvePreCallContextFor(id),
      renewLease: (id, state) => this.#renewLease(id, state),
      detach: (id, state, releaseLease) => this.#detach(id, state, releaseLease),
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
      isRunning: () => this.#running,
      leaseHolder: () => this.#leaseHolder(),
      leaseTtlMs: this.#policy.leaseTtlMs,
      sessionClockMs: (sessionId) => this.sessionClockMs(sessionId),
      criticalWrite: (operation, onLate, onTimeout) =>
        this.#criticalWrite(operation, onLate, onTimeout),
      attachmentStarts: this.#attachmentStarts,
      reserveUnattachedSessionWrite: (sessionId) => this.#reserveUnattachedSessionWrite(sessionId),
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

  #leaseHolder(logicalHolderId?: string): string {
    return `${logicalHolderId ?? this.#holderId}:${this.#holderIncarnationId}`;
  }

  #releaseActiveToolCall(
    sessionId: SessionId,
    toolCallId: ToolCallId,
    activeCall: ActiveToolCall,
  ): void {
    const sessionCalls = this.#activeToolCallsBySession.get(sessionId);
    if (sessionCalls?.get(toolCallId) !== activeCall || activeCall.pendingFinishes > 0) return;
    sessionCalls.delete(toolCallId);
    if (sessionCalls.size === 0) this.#activeToolCallsBySession.delete(sessionId);
  }

  #assertRunning(): void {
    if (!this.#running) {
      throw new Error("Runtime is not running");
    }
  }

  #assertTerminalWriteAllowed(): void {
    if (this.#hardStopped) throw new Error("Runtime shutdown hard-stop deadline exceeded");
    if (!this.#running && !this.#acceptingShutdownTerminalWrites) this.#assertRunning();
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
    return durationForTerminalTurn(
      this.#sessionStartMs.has(sessionId) ? this.#durationSince(monotonicStartedAtMs) : undefined,
      turn.startedAt,
      endedAt,
    );
  }

  async #abandonUnattachedSessionAfterAttachFailure(
    sessionId: SessionId,
    holder: string,
    request: EndSessionRequest,
  ): Promise<void> {
    try {
      const lease = await this.#durableStore.leases.acquire(
        sessionId,
        holder,
        this.#policy.leaseTtlMs,
      );
      if (!lease) return;
      await this.#abandonLateSession(sessionId, lease, request);
    } catch {}
  }

  #sessionAttachFailureRequest(error: unknown): EndSessionRequest {
    return this.#running
      ? {
          reason: "failed",
          error: internalError(
            "runtime.session_attach_failed",
            "The runtime could not attach a newly created session",
            { cause: error },
          ),
        }
      : { reason: "cancelled", cancelReason: "shutdown", terminalSource: "runtime_shutdown" };
  }

  async #abandonLateSession(
    sessionId: SessionId,
    lease?: SessionLease,
    request: EndSessionRequest = {
      reason: "failed",
      error: timeoutError(
        "runtime.session_start_timed_out",
        "Session creation completed after the caller deadline",
      ),
    },
  ): Promise<void> {
    let cleanupLease = lease;
    if (!cleanupLease) {
      try {
        cleanupLease =
          (await this.#durableStore.leases.acquire(
            sessionId,
            this.#leaseHolder(),
            this.#policy.leaseTtlMs,
          )) ?? undefined;
      } catch {
        return;
      }
    }
    if (!cleanupLease) return;
    const ownedLease = cleanupLease;

    let persisted: PersistedSessionEnd | undefined;
    try {
      persisted = await this.#durableStore.runSessionTransaction(sessionId, ownedLease, (tx) =>
        persistSessionEnd(
          tx,
          sessionId,
          request,
          this.#clock.now(),
          ownedLease.fence,
          (id, turn, startedAtMs, endedAt) => this.#durationForTurn(id, turn, startedAtMs, endedAt),
        ),
      );
    } catch {
    } finally {
      await this.#durableStore.leases
        .release(sessionId, ownedLease.holder, ownedLease.fence, ownedLease.generationId)
        .catch(() => undefined);
    }
    if (persisted?.shouldEmit) {
      await this.#finishClaimedSessionEnd(persisted.session, undefined);
    }
  }

  async #finishClaimedSessionEnd(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    await this.#failedSessionEndCleanups.get(session.id)?.promise;
    // The persisted terminal record is the idempotency boundary. Remove the
    // joinable operation before invoking finalizers or hooks so they can safely
    // re-enter endSession; later calls take the already-terminal fast path.
    this.#sessionEndOperations.delete(session.id);
    this.#preserveFinalizingSessionClock(session.id);
    this.#sessionEndCoordinator.closeAdmission(session.id);
    this.#sessionStartMs.delete(session.id);
    if (attachment) await this.#detach(session.id, attachment).catch(() => undefined);
    try {
      await this.#emitSessionEnd(session, attachment);
    } finally {
      this.#finalizingSessionStartMs.delete(session.id);
    }
  }

  #preserveFinalizingSessionClock(sessionId: SessionId): void {
    const startedAtMs = this.#sessionStartMs.get(sessionId);
    if (startedAtMs !== undefined) {
      this.#finalizingSessionStartMs.set(sessionId, startedAtMs);
    }
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
      .release(sessionId, lease.holder, lease.fence, lease.generationId)
      .catch(() => undefined);
    if (outcome.result?.shouldEmit) {
      await this.#finishClaimedSessionEnd(outcome.result.session, attachment);
    } else {
      if (attachment) {
        await this.#detach(sessionId, attachment, true, true).catch(() => undefined);
      }
      this.#discardFailedSessionEnd(sessionId);
    }
  }

  #discardFailedSessionEnd(sessionId: SessionId): Promise<void> {
    return this.#scheduleAudioTapCleanup(sessionId, true);
  }

  #finalizeTimedOutSessionEnd(sessionId: SessionId): Promise<void> {
    return this.#scheduleAudioTapCleanup(sessionId, false);
  }

  #scheduleAudioTapCleanup(
    sessionId: SessionId,
    discardAudioTapSummaryOnFinish: boolean,
  ): Promise<void> {
    const existing = this.#failedSessionEndCleanups.get(sessionId);
    if (existing) {
      if (discardAudioTapSummaryOnFinish) existing.discardAudioTapSummaryOnFinish = true;
      return existing.promise;
    }

    const cleanup = {
      promise: Promise.resolve(),
      discardAudioTapSummaryOnFinish,
    };
    const finalization = discardAudioTapSummaryOnFinish
      ? this.#sessionEndCoordinator.finalizeAudioTapAfterFailedTerminalWrite(sessionId)
      : this.#sessionEndCoordinator.finalizeAudioTapAfterTerminalWriteTimeout(sessionId);
    cleanup.promise = finalization
      .then(
        (finalized) => {
          if (finalized) {
            this.#sessionStartMs.delete(sessionId);
            this.#finalizingSessionStartMs.delete(sessionId);
          }
        },
        () => {
          this.#sessionStartMs.delete(sessionId);
          this.#finalizingSessionStartMs.delete(sessionId);
        },
      )
      .finally(() => {
        if (cleanup.discardAudioTapSummaryOnFinish) {
          this.#sessionEndCoordinator.discardAudioTapSummary(sessionId);
        }
        if (this.#failedSessionEndCleanups.get(sessionId) === cleanup) {
          this.#failedSessionEndCleanups.delete(sessionId);
        }
      });
    this.#failedSessionEndCleanups.set(sessionId, cleanup);
    return cleanup.promise;
  }

  async #abandonLateTurn(turn: ActiveTurn): Promise<void> {
    if (this.#hardStopped) return;
    await endRuntimeTurn(this.#turnContext(), turn.sessionId, turn.id, {
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
      (pending) => trackFinalizer(this.#inFlightFinalizers, pending),
    );
  }

  #runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
    onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
    onTimeout?: () => void,
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
      onTimeout,
    );
  }

  #reserveUnattachedSessionWrite(sessionId: SessionId): (() => void) | null {
    if (this.#attachments.has(sessionId) || this.#attachmentStarts.has(sessionId)) return null;

    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sessionWrites = this.#unattachedSessionWrites.get(sessionId);
    if (!sessionWrites) {
      sessionWrites = new Set();
      this.#unattachedSessionWrites.set(sessionId, sessionWrites);
    }
    sessionWrites.add(pending);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      sessionWrites.delete(pending);
      if (sessionWrites.size === 0) this.#unattachedSessionWrites.delete(sessionId);
      release();
    };
  }

  async #waitForUnattachedSessionWrites(sessionId: SessionId): Promise<void> {
    const pending = this.#unattachedSessionWrites.get(sessionId);
    if (pending && pending.size > 0) await Promise.all([...pending]);
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
    } catch {}
  }

  #recordSessionMetric(
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
  ): void {
    try {
      this.#sessionMetricsRecorder?.record(name, attributes);
    } catch {}
  }
}
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new InMemoryRuntime(options);
}
