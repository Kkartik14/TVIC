import {
  InvalidArgumentError,
  isTerminalTurn,
  LeaseUnavailableError,
  RecordNotFoundError,
  terminalTurnFromRequest,
} from "@tvic/core";
import type {
  Agent,
  Clock,
  DurableRuntimePolicy,
  DurableRuntimeStore,
  Memory,
  OrganizationId,
  PreCallContext,
  SessionAttachment,
  SessionId,
  SessionLease,
  SessionSnapshot,
  ToolCallId,
  UserId,
  WorkflowId,
} from "@tvic/core";
import { attachmentView, durableEvent, ensureActiveSession } from "./runtime-support.js";
import type { RuntimeAttachmentState } from "./runtime-support.js";
import type { AttachmentAdmission } from "./attachment-admission.js";
import { assertMemoryPolicySupported } from "./memory-capabilities.js";
import { metadataString } from "./pipeline-loop-boundary.js";
import {
  prepareToolRecovery,
  resolvePreparedToolRecovery,
  toolTenantForRuntimeIdentity,
} from "./tool-recovery.js";
import type { ToolLifecycleContext } from "./tool-lifecycle.js";

export interface RuntimeAttachmentContext {
  readonly assertRunning: () => void;
  readonly memory: Memory;
  readonly durableStore: DurableRuntimeStore;
  readonly policy: DurableRuntimePolicy;
  readonly clock: Clock;
  readonly isRunning: () => boolean;
  readonly attachments: Map<SessionId, RuntimeAttachmentState>;
  readonly attachmentStarts: AttachmentAdmission;
  readonly activeToolCallsBySession: ReadonlyMap<SessionId, ReadonlyMap<ToolCallId, object>>;
  readonly toolRecoverySessions: ReadonlySet<SessionId>;
  readonly sessionStartMs: Map<SessionId, number>;
  readonly defaultOrganizationId?: OrganizationId;
  readonly defaultWorkflowId?: WorkflowId;
  readonly toolContext: ToolLifecycleContext;
  readonly leaseHolder: (logicalHolderId?: string) => string;
  readonly criticalWrite: <T>(
    operation: () => Promise<T>,
    onLate?: (outcome: { readonly result?: T; readonly error?: unknown }) => void | Promise<void>,
    onTimeout?: () => void,
  ) => Promise<T>;
  readonly waitForUnattachedSessionWrites: (sessionId: SessionId) => Promise<void>;
  readonly emitMetric: (name: string, value: number) => void;
  readonly resolvePreCallContextFor: (sessionId: SessionId) => Promise<PreCallContext>;
  readonly renewLease: (sessionId: SessionId, state: RuntimeAttachmentState) => Promise<void>;
  readonly detach: (
    sessionId: SessionId,
    state?: RuntimeAttachmentState,
    releaseLease?: boolean,
  ) => Promise<void>;
}

export async function attachRuntimeSession(
  context: RuntimeAttachmentContext,
  agent: Agent,
  sessionId: SessionId,
  options: {
    readonly holderId?: string;
    readonly memoryUserId?: UserId;
    readonly organizationId?: OrganizationId;
    readonly workflowId?: WorkflowId;
  } = {},
): Promise<SessionAttachment> {
  context.assertRunning();
  assertMemoryPolicySupported(context.memory, agent.memoryPolicy);
  if (context.attachments.has(sessionId) || context.attachmentStarts.has(sessionId)) {
    throw new LeaseUnavailableError(`Session is already attached: ${sessionId}`);
  }
  const activeToolCalls = context.activeToolCallsBySession.get(sessionId);
  if (context.toolRecoverySessions.has(sessionId) || (activeToolCalls?.size ?? 0) > 0) {
    throw new InvalidArgumentError(
      `Session cannot attach while tool-call execution or recovery is in progress: ${sessionId}`,
    );
  }
  const releaseAdmission = context.attachmentStarts.acquire(sessionId);
  try {
    await context.criticalWrite(() => context.waitForUnattachedSessionWrites(sessionId));
  } catch (error) {
    releaseAdmission();
    throw error;
  }
  const stored = await context.durableStore.sessions.get(sessionId).catch((error: unknown) => {
    releaseAdmission();
    throw error;
  });
  if (!stored) {
    releaseAdmission();
    throw new RecordNotFoundError(`session:${sessionId}`);
  }
  if (!context.isRunning()) {
    releaseAdmission();
    throw new Error("Runtime is not running");
  }
  if (stored.session.agentId !== agent.id) {
    releaseAdmission();
    throw new InvalidArgumentError(`Agent mismatch for session: ${sessionId}`);
  }
  if (
    stored.session.status !== "active" &&
    stored.session.status !== "interrupted" &&
    stored.session.status !== "waiting_for_tool" &&
    stored.session.status !== "ending"
  ) {
    releaseAdmission();
    throw new Error(`Cannot attach ${stored.session.status} session: ${sessionId}`);
  }

  const storedMemoryUserId = metadataString(stored.session.metadata, "memoryUserId");
  const storedOrganizationId = metadataString(stored.session.metadata, "organizationId");
  const storedWorkflowId = metadataString(stored.session.metadata, "workflowId");
  const memoryUserId = storedMemoryUserId ?? options.memoryUserId;
  const organizationId =
    storedOrganizationId ?? options.organizationId ?? context.defaultOrganizationId;
  const workflowId = storedWorkflowId ?? options.workflowId ?? context.defaultWorkflowId;
  const replayTenant = toolTenantForRuntimeIdentity(memoryUserId, organizationId, workflowId);

  const holder = context.leaseHolder(options.holderId);
  const attachStartedAtMs = context.clock.monotonicMs();
  let leaseAcquireTimedOut = false;
  let lease: SessionLease | null;
  try {
    lease = await context.criticalWrite(
      () => context.durableStore.leases.acquire(sessionId, holder, context.policy.leaseTtlMs),
      async ({ result, error }) => {
        try {
          if (!error && result) {
            await context.durableStore.leases
              .release(sessionId, result.holder, result.fence, result.generationId)
              .catch(() => undefined);
          }
        } finally {
          releaseAdmission();
        }
      },
      () => {
        leaseAcquireTimedOut = true;
      },
    );
  } catch (error) {
    if (!leaseAcquireTimedOut) releaseAdmission();
    throw error;
  }
  if (!lease) {
    releaseAdmission();
    throw new Error(`Session lease unavailable: ${sessionId}`);
  }
  if (!context.isRunning()) {
    releaseAdmission();
    await context.durableStore.leases
      .release(sessionId, lease.holder, lease.fence, lease.generationId)
      .catch(() => undefined);
    throw new Error("Runtime is not running");
  }

  let attachmentState: RuntimeAttachmentState | undefined;
  let lateAttachPending = false;
  try {
    const nowMs = Date.parse(context.clock.now());
    const startedAtMs =
      "startedAt" in stored.session ? Date.parse(stored.session.startedAt) : nowMs;
    const lastActivityMs =
      stored.runtime.lastActivityWallAtMs ?? Date.parse(stored.session.createdAt);
    const recoveryGapMs = Number.isFinite(lastActivityMs) ? Math.max(0, nowMs - lastActivityMs) : 0;
    const sessionElapsedMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
    context.emitMetric("session.recovery.gap_ms", recoveryGapMs);
    context.sessionStartMs.set(sessionId, context.clock.monotonicMs() - sessionElapsedMs);

    const toolRecoverySnapshot = await prepareToolRecovery(
      context.toolContext,
      sessionId,
      agent,
      replayTenant,
      lease,
    );
    context.assertRunning();

    const snapshot = await context.criticalWrite(
      () =>
        context.durableStore.runSessionTransaction(sessionId, lease, async (tx) => {
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
          const recoveredTurns: SessionSnapshot["turns"][number][] = [];
          for (const turnRecord of turns) {
            maxSequence = Math.max(maxSequence, turnRecord.turn.sequence);
            let recoveredTurn = turnRecord.turn;
            if (!isTerminalTurn(turnRecord.turn)) {
              const orphaned = terminalTurnFromRequest(
                turnRecord.turn,
                {
                  reason: "cancelled",
                  cancelReason: "runtime_restarted",
                  latency: { recoveryGapMs },
                },
                context.clock.now(),
                0,
              );
              const recoveredTurnRecord = await tx.updateTurn(
                sessionId,
                turnRecord.turn.id,
                (record) => ({
                  ...record,
                  turn: orphaned,
                  runtime: { ...record.runtime, recoveryGapMs },
                }),
              );
              recoveredTurn = recoveredTurnRecord.turn;
              await tx.appendOutbox(
                durableEvent(
                  "turn",
                  recoveredTurnRecord.turn.id,
                  sessionId,
                  lease.fence,
                  recoveredTurnRecord.turn.status,
                  recoveredTurnRecord.turn,
                  recoveredTurnRecord.runtime,
                  recoveredTurnRecord.version,
                ),
              );
            }
            recoveredTurns.push(recoveredTurn);
          }
          const toolRecords =
            toolRecoverySnapshot.prepared.size > 0
              ? await tx.listToolCalls(sessionId)
              : toolRecoverySnapshot.records;
          const recoveredToolCalls: SessionSnapshot["toolCalls"][number][] = [];
          for (const toolRecord of toolRecords) {
            const currentToolCall = toolRecord.toolCall;
            if (currentToolCall.status === "queued") {
              pendingToolCallIds.push(currentToolCall.toolCallId);
              recoveredToolCalls.push(currentToolCall);
              continue;
            }
            if (currentToolCall.status !== "running") {
              recoveredToolCalls.push(currentToolCall);
              continue;
            }
            const runningToolRecord = { ...toolRecord, toolCall: currentToolCall };
            const recoveredAt = context.clock.now();
            const recoveredTool = resolvePreparedToolRecovery(
              runningToolRecord,
              toolRecoverySnapshot.prepared.get(currentToolCall.toolCallId),
              recoveredAt,
            );
            const updatedTool = await tx.updateToolCall(
              sessionId,
              currentToolCall.toolCallId,
              (record) => ({ ...record, toolCall: recoveredTool }),
            );
            recoveredToolCalls.push(updatedTool.toolCall);
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
                ...(recoveryGapMs > context.policy.recoveryGraceMs
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
          return {
            session: updatedSession.session,
            turns: recoveredTurns,
            toolCalls: recoveredToolCalls,
          } satisfies SessionSnapshot;
        }),
      async () => {
        try {
          await context.durableStore.leases
            .release(sessionId, holder, lease.fence, lease.generationId)
            .catch(() => undefined);
        } finally {
          releaseAdmission();
        }
      },
      () => {
        lateAttachPending = true;
      },
    );
    context.assertRunning();
    context.emitMetric(
      "session.attach.latency_ms",
      context.clock.monotonicMs() - attachStartedAtMs,
    );

    const controller = new AbortController();
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
    context.attachments.set(sessionId, state);
    state.heartbeat = setInterval(() => {
      void context.renewLease(sessionId, state);
    }, context.policy.leaseHeartbeatMs);
    state.heartbeat.unref?.();
    const preCallContext = await context.resolvePreCallContextFor(sessionId);
    context.assertRunning();
    return attachmentView(state, snapshot, () => context.detach(sessionId, state), preCallContext);
  } catch (error) {
    await context.detach(sessionId, attachmentState).catch(() => undefined);
    if (!lateAttachPending) {
      await context.durableStore.leases
        .release(sessionId, holder, lease.fence, lease.generationId)
        .catch(() => undefined);
    }
    context.sessionStartMs.delete(sessionId);
    throw error;
  } finally {
    if (!lateAttachPending) releaseAdmission();
  }
}
