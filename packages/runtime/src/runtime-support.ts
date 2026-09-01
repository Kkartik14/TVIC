import { encodeOutboxEnvelope } from "@tvic/dal-codec";
import { BackendUnavailableError, InvalidArgumentError, LeaseLostError } from "@tvic/core";
import type {
  ActiveSession,
  Agent,
  Clock,
  DurableOutboxEvent,
  DurableRuntimePolicy,
  DurableRuntimeStore,
  IdGenerator,
  SessionAttachment,
  SessionAttachmentHealth,
  SessionId,
  SessionLease,
  SessionSnapshot,
  Session,
  SessionRuntimeMetadata,
  StartSessionOptions,
  StoredSessionRecord,
  ToolCall,
  ToolCallRuntimeMetadata,
  Turn,
  TurnRuntimeMetadata,
} from "@tvic/core";

export interface RuntimeAttachmentState {
  readonly agent: Agent;
  readonly controller: AbortController;
  lease: SessionLease | null;
  readonly holder: string;
  health: SessionAttachmentHealth;
  renewalFailureSinceMs?: number;
  renewalFailureSinceMonotonicMs?: number;
  renewalInFlight?: Promise<{
    readonly renewed: SessionLease | null;
    readonly transientFailure: boolean;
  }>;
  heartbeat?: ReturnType<typeof setInterval>;
  memoryUserId?: import("@tvic/core").UserId;
  organizationId?: import("@tvic/core").OrganizationId;
  workflowId?: import("@tvic/core").WorkflowId;
}

export interface LeaseRenewalContext {
  readonly clock: Clock;
  readonly durableStore: DurableRuntimeStore;
  readonly policy: DurableRuntimePolicy;
  readonly emitMetric: (name: string, value: number) => void;
}

export interface LateWriteOutcome<T> {
  readonly result?: T;
  readonly error?: unknown;
}

export function buildSession(
  clock: Clock,
  ids: IdGenerator,
  agent: Agent,
  options: StartSessionOptions,
): {
  readonly session: ActiveSession;
  readonly record: StoredSessionRecord;
  readonly startMonotonicMs: number;
} {
  const startMonotonicMs = clock.monotonicMs();
  const now = clock.now();
  const meta: Record<string, unknown> = { ...(options.metadata ?? {}) };
  if (options.memoryUserId) meta.memoryUserId = options.memoryUserId;
  if (options.organizationId) meta.organizationId = options.organizationId;
  if (options.workflowId) meta.workflowId = options.workflowId;
  // Persist the agent's `memoryPolicy` (specifically `deleteSessionScopeOnEnd`
  // and `preCallLoad`) into session metadata so `endSession` can read it
  // back at terminalization time. `Runtime.endSession(id, request)` has
  // no agent parameter; the policy is read from `session.metadata`. This
  // avoids changing the public `endSession` signature and the durable
  // record shape.
  if (agent.memoryPolicy) {
    meta.memoryPolicy = {
      enabled: agent.memoryPolicy.enabled,
      scopes: agent.memoryPolicy.scopes,
      deleteSessionScopeOnEnd: agent.memoryPolicy.deleteSessionScopeOnEnd,
      preCallLoad: agent.memoryPolicy.preCallLoad,
    };
  }
  const session: ActiveSession = {
    id: ids.session(),
    agentId: agent.id,
    status: "active",
    channel: options.channel,
    ...(options.call ? { callId: options.call.id } : {}),
    memoryRefs: [],
    ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
    createdAt: now,
    startedAt: now,
    state: {
      variables: options.variables ?? {},
      pendingToolCallIds: [],
      turnSequence: 0,
    },
  };
  return {
    session,
    record: {
      session,
      runtime: {
        monotonicStartedAtMs: startMonotonicMs,
        lastActivityWallAtMs: Date.parse(now),
        clockEpoch: 0,
      },
    },
    startMonotonicMs,
  };
}

export function ensureActiveSession(session: import("@tvic/core").Session): ActiveSession {
  if (
    (session.status === "active" ||
      session.status === "interrupted" ||
      session.status === "waiting_for_tool" ||
      session.status === "ending") &&
    "startedAt" in session
  ) {
    return session;
  }
  throw new Error(`Expected an active session, received ${session.status}`);
}

export function durableEvent(
  aggregateType: "session",
  aggregateId: string,
  sessionId: SessionId,
  fence: number,
  status: string,
  payload: Session,
  runtime: SessionRuntimeMetadata,
  version?: number,
): DurableOutboxEvent;
export function durableEvent(
  aggregateType: "turn",
  aggregateId: string,
  sessionId: SessionId,
  fence: number,
  status: string,
  payload: Turn,
  runtime: TurnRuntimeMetadata,
  version?: number,
): DurableOutboxEvent;
export function durableEvent(
  aggregateType: "tool_call",
  aggregateId: string,
  sessionId: SessionId,
  fence: number,
  status: string,
  payload: ToolCall,
  runtime: ToolCallRuntimeMetadata,
  version?: number,
): DurableOutboxEvent;
export function durableEvent(
  aggregateType: DurableOutboxEvent["aggregateType"],
  aggregateId: string,
  sessionId: SessionId,
  fence: number,
  status: string,
  payload: Session | Turn | ToolCall,
  runtime: SessionRuntimeMetadata | TurnRuntimeMetadata | ToolCallRuntimeMetadata,
  version = 1,
): DurableOutboxEvent {
  if (payload.status !== status) {
    throw new InvalidArgumentError(
      `Outbox status mismatch for ${aggregateType}:${aggregateId}: ${status} != ${payload.status}`,
    );
  }
  const envelope =
    aggregateType === "session"
      ? encodeOutboxEnvelope(
          {
            kind: aggregateType,
            payload: payload as Session,
            runtime: runtime as SessionRuntimeMetadata,
            version,
          },
          `outbox:${aggregateType}:${aggregateId}:${version}:${fence}`,
        )
      : aggregateType === "turn"
        ? encodeOutboxEnvelope(
            {
              kind: aggregateType,
              payload: payload as Turn,
              runtime: runtime as TurnRuntimeMetadata,
              version,
            },
            `outbox:${aggregateType}:${aggregateId}:${version}:${fence}`,
          )
        : encodeOutboxEnvelope(
            {
              kind: aggregateType,
              payload: payload as ToolCall,
              runtime: runtime as ToolCallRuntimeMetadata,
              version,
            },
            `outbox:${aggregateType}:${aggregateId}:${version}:${fence}`,
          );
  return {
    id: `${aggregateType}:${aggregateId}:${version}:${fence}`,
    aggregateType,
    aggregateId,
    sessionId,
    version,
    fence,
    envelope,
  };
}

export function attachmentView(
  state: RuntimeAttachmentState,
  snapshot: SessionSnapshot,
  detach: () => Promise<void>,
  preCallContext?: import("@tvic/core").PreCallContext,
): SessionAttachment {
  // The shim projects the new `PreCallContext` into the legacy
  // `PreCallMemoryContext` shape so existing call sites that read
  // `attachment.preCallMemory.entries` keep working during the
  // pre-1.0 transition.
  const preCallMemory = preCallContext
    ? {
        entries: preCallContext.memory,
        resolvedAtMs: preCallContext.resolvedAtMs,
        degraded: preCallContext.degraded.memory || preCallContext.degraded.static,
      }
    : undefined;
  return {
    session: snapshot.session as ActiveSession,
    snapshot,
    lease: state.lease,
    signal: state.controller.signal,
    get health() {
      return state.health;
    },
    detach,
    ...(preCallContext ? { preCallContext } : {}),
    ...(preCallMemory ? { preCallMemory } : {}),
  } as SessionAttachment;
}

export async function renewLease(
  sessionId: SessionId,
  state: RuntimeAttachmentState,
  context: LeaseRenewalContext,
): Promise<void> {
  if (!state.lease || (state.health !== "healthy" && state.health !== "persistence_degraded")) {
    return;
  }
  if (state.renewalInFlight) {
    if (
      state.renewalFailureSinceMonotonicMs !== undefined &&
      context.clock.monotonicMs() - state.renewalFailureSinceMonotonicMs >=
        context.policy.persistenceRecoveryGraceMs
    ) {
      context.emitMetric("lease.lost", 1);
      state.health = "lease_lost";
      state.controller.abort(new LeaseLostError(sessionId));
      if (state.heartbeat) clearInterval(state.heartbeat);
    }
    return;
  }
  const startedAt = context.clock.monotonicMs();
  const renewal = context.durableStore.leases
    .renew(sessionId, state.holder, state.lease.fence, context.policy.leaseTtlMs)
    .then(
      (renewed) => ({ renewed, transientFailure: false }),
      () => ({ renewed: null, transientFailure: true }),
    );
  let trackedRenewal!: Promise<{
    readonly renewed: SessionLease | null;
    readonly transientFailure: boolean;
  }>;
  trackedRenewal = renewal.finally(() => {
    if (state.renewalInFlight === trackedRenewal) delete state.renewalInFlight;
  });
  state.renewalInFlight = trackedRenewal;
  // Renewal is liveness work, not a provider-side critical write. Give a
  // transient backend pause most of the heartbeat interval to recover while
  // still bounding the attempt well before the lease can expire. The
  // persistence deadline is intentionally not used here: applying the
  // 75 ms turn-write budget to renewal would turn ordinary jitter into an
  // avoidable ownership loss.
  const timeoutMs = Math.max(
    1,
    Math.min(
      Math.floor(context.policy.leaseHeartbeatMs * 0.75),
      Math.floor(context.policy.leaseTtlMs / 2),
    ),
  );
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{
    readonly renewed: SessionLease | null;
    readonly transientFailure: boolean;
  }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ renewed: null, transientFailure: true }), timeoutMs);
  });
  const outcome = await Promise.race([trackedRenewal, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  const { renewed, transientFailure } = outcome;
  context.emitMetric("lease.renew.latency_ms", context.clock.monotonicMs() - startedAt);
  if (!renewed) {
    if (transientFailure) {
      state.renewalFailureSinceMonotonicMs ??= context.clock.monotonicMs();
      const nowMs = Date.parse(context.clock.now());
      state.renewalFailureSinceMs ??= nowMs;
      if (
        Number.isFinite(nowMs) &&
        nowMs < state.lease.expiresAtMs &&
        context.clock.monotonicMs() - state.renewalFailureSinceMonotonicMs <
          context.policy.persistenceRecoveryGraceMs
      ) {
        context.emitMetric("lease.renew.degraded", 1);
        return;
      }
    }
    context.emitMetric("lease.lost", 1);
    state.health = "lease_lost";
    state.controller.abort(new LeaseLostError(sessionId));
    if (state.heartbeat) clearInterval(state.heartbeat);
    return;
  }
  state.lease = renewed;
  delete state.renewalFailureSinceMs;
  delete state.renewalFailureSinceMonotonicMs;
}

export async function detachAttachment(
  sessionId: SessionId,
  attachments: Map<SessionId, RuntimeAttachmentState>,
  durableStore: DurableRuntimeStore,
  sessionStartMs: Map<SessionId, number>,
  expectedState?: RuntimeAttachmentState,
  preserveHealth = false,
  releaseTimeoutMs = 1_000,
  releaseLease = true,
): Promise<void> {
  const state = attachments.get(sessionId);
  if (!state) return;
  if (expectedState && state !== expectedState) return;
  if (!preserveHealth) state.health = "detached";
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.controller.abort();
  if (state.lease && releaseLease) {
    const release = Promise.resolve()
      .then(() => durableStore.leases.release(sessionId, state.holder, state.lease!.fence))
      .catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        release,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, releaseTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  attachments.delete(sessionId);
  sessionStartMs.delete(sessionId);
}

export async function criticalWrite<T>(
  clock: Clock,
  policy: DurableRuntimePolicy,
  operation: () => Promise<T>,
  emitMetric: (name: string, value: number) => void,
  onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
  onTimeout?: () => void,
): Promise<T> {
  const deadlineMs = policy.criticalWriteTimeoutMs;
  const startedAt = clock.monotonicMs();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(operation);
  operationPromise.then(
    (result) => {
      if (timedOut) {
        emitMetric("durable.write.late_completion_ms", clock.monotonicMs() - startedAt);
        if (onLate) {
          void Promise.resolve()
            .then(() => onLate({ result }))
            .catch(() => undefined);
        }
      }
    },
    (error: unknown) => {
      if (timedOut) {
        emitMetric("durable.write.late_failure_ms", clock.monotonicMs() - startedAt);
        if (onLate) {
          void Promise.resolve()
            .then(() => onLate({ error }))
            .catch(() => undefined);
        }
      }
    },
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      emitMetric("durable.write.timeout", 1);
      try {
        onTimeout?.();
      } catch {
        // Timeout bookkeeping must not prevent the caller from receiving the
        // bounded-write failure.
      }
      reject(new BackendUnavailableError(`Durable write exceeded ${deadlineMs}ms`));
    }, deadlineMs);
  });
  try {
    const result = await Promise.race([operationPromise, timeout]);
    emitMetric("durable.write.latency_ms", clock.monotonicMs() - startedAt);
    return result;
  } catch (error) {
    emitMetric("durable.write.failure", 1);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
