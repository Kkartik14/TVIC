import type {
  ActiveSession,
  Agent,
  Clock,
  DurableRuntimeStore,
  DurableSessionTransaction,
  OrganizationId,
  QueuedToolCall,
  RunningToolCall,
  Session,
  SessionId,
  SessionLease,
  StoredToolCallRecord,
  SessionStore,
  TerminalToolCall,
  ToolCall,
  ToolCallStore,
  ToolIdempotencyStore,
  UserId,
  WorkflowId,
} from "@tvic/core";
import { LeaseUnavailableError, RecordConflictError, timeoutError } from "@tvic/core";
import { stableStringify } from "@tvic/tools";
import { durableEvent, type LateWriteOutcome } from "./runtime-support.js";
import type { AttachmentAdmission } from "./attachment-admission.js";

export interface ToolLifecycleContext {
  readonly clock: Clock;
  readonly durableStore: DurableRuntimeStore;
  readonly sessionStore: SessionStore;
  readonly toolCallStore: ToolCallStore;
  readonly attachments: ReadonlyMap<
    SessionId,
    {
      readonly lease: SessionLease | null;
      readonly agent?: Agent;
      readonly memoryUserId?: UserId;
      readonly organizationId?: OrganizationId;
      readonly workflowId?: WorkflowId;
    }
  >;
  readonly attachmentStarts: Pick<AttachmentAdmission, "has">;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  readonly isRunning: () => boolean;
  readonly leaseHolder: () => string;
  readonly leaseTtlMs: number;
  readonly sessionClockMs: (sessionId: SessionId) => number;
  readonly criticalWrite: <T>(
    operation: () => Promise<T>,
    onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
    onTimeout?: () => void,
  ) => Promise<T>;
  readonly reserveUnattachedSessionWrite: (sessionId: SessionId) => (() => void) | null;
}

export async function startToolCall(
  context: ToolLifecycleContext,
  toolCall: QueuedToolCall,
): Promise<RunningToolCall> {
  const attachment = context.attachments.get(toolCall.sessionId);
  const lease = attachment?.lease ?? undefined;
  if (attachment && !lease) {
    throw new LeaseUnavailableError(`Session lease unavailable: ${toolCall.sessionId}`);
  }
  const sessionRecord = await context.sessionStore.get(toolCall.sessionId);
  if (!sessionRecord) throw new Error(`Session not found: ${toolCall.sessionId}`);
  if (sessionRecord.session.status !== "active") {
    throw new Error(
      `Cannot start tool call for ${sessionRecord.session.status} session: ${toolCall.sessionId}`,
    );
  }
  if (context.attachments.get(toolCall.sessionId) !== attachment) {
    throw new LeaseUnavailableError(`Session attachment changed: ${toolCall.sessionId}`);
  }
  if (!attachment && !context.isRunning()) {
    throw new Error("Runtime is not running");
  }
  const queuedRecord = {
    toolCall,
    runtime: { monotonicQueuedAtMs: context.sessionClockMs(toolCall.sessionId) },
    version: 1,
  };
  const running: RunningToolCall = {
    ...toolCall,
    status: "running",
    startedAt: context.clock.now(),
  };
  const persistQueuedAndRunning = async (
    tx: DurableSessionTransaction,
    fence: number,
  ): Promise<void> => {
    await tx.putToolCall(queuedRecord);
    const updatedSession = await tx.updateSession(toolCall.sessionId, (current) => ({
      ...current,
      session: activeSessionWithState(current.session, {
        ...current.session.state,
        pendingToolCallIds: current.session.state.pendingToolCallIds.includes(toolCall.toolCallId)
          ? current.session.state.pendingToolCallIds
          : [...current.session.state.pendingToolCallIds, toolCall.toolCallId],
      }),
      runtime: { ...current.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
    }));
    await tx.appendOutbox(
      durableEvent(
        "tool_call",
        toolCall.toolCallId,
        toolCall.sessionId,
        fence,
        toolCall.status,
        toolCall,
        queuedRecord.runtime,
        queuedRecord.version,
      ),
    );
    await tx.appendOutbox(
      durableEvent(
        "session",
        toolCall.sessionId,
        toolCall.sessionId,
        fence,
        updatedSession.session.status,
        updatedSession.session,
        updatedSession.runtime,
        updatedSession.version,
      ),
    );
    const updatedTool = await tx.updateToolCall(
      toolCall.sessionId,
      toolCall.toolCallId,
      (current) => ({ ...current, toolCall: running }),
    );
    await tx.appendOutbox(
      durableEvent(
        "tool_call",
        toolCall.toolCallId,
        toolCall.sessionId,
        fence,
        updatedTool.toolCall.status,
        updatedTool.toolCall,
        updatedTool.runtime,
        updatedTool.version,
      ),
    );
  };
  const abandoned = (): TerminalToolCall => ({
    ...running,
    status: "cancelled",
    endedAt: context.clock.now(),
    error: timeoutError("tool.start_timed_out", "Tool start completed after the caller deadline"),
  });
  const abandonLateStart = ({ error }: LateWriteOutcome<void>): void | Promise<void> => {
    if (!error) {
      return finishToolCall(context, abandoned(), lease ?? null)
        .then(() => undefined)
        .catch(() => undefined);
    }
  };

  if (lease) {
    await context.criticalWrite(
      () =>
        context.durableStore.runSessionTransaction(toolCall.sessionId, lease, (tx) =>
          persistQueuedAndRunning(tx, lease.fence),
        ),
      abandonLateStart,
    );
  } else {
    await runUnfencedTransaction(
      context,
      toolCall.sessionId,
      (tx) => persistQueuedAndRunning(tx, 0),
      abandonLateStart,
    );
  }
  return running;
}

export async function finishToolCall(
  context: ToolLifecycleContext,
  toolCall: TerminalToolCall,
  leaseOverride?: SessionLease | null,
): Promise<TerminalToolCall> {
  const lease =
    leaseOverride === undefined
      ? context.attachments.get(toolCall.sessionId)?.lease
      : (leaseOverride ?? undefined);
  const finish = (current: StoredToolCallRecord): TerminalToolCall =>
    isTerminalToolCall(current.toolCall) ? current.toolCall : toolCall;
  if (lease) {
    return context.criticalWrite(() =>
      context.durableStore.runSessionTransaction(toolCall.sessionId, lease, async (tx) => {
        const current = await tx.getToolCall(toolCall.sessionId, toolCall.toolCallId);
        if (!current) {
          const inserted = {
            toolCall,
            runtime: { monotonicQueuedAtMs: context.sessionClockMs(toolCall.sessionId) },
            version: 1,
          } satisfies StoredToolCallRecord;
          await tx.putToolCall(inserted);
          const updatedSession = await tx.updateSession(toolCall.sessionId, (record) => ({
            ...record,
            session: activeSessionWithState(record.session, {
              ...record.session.state,
              pendingToolCallIds: record.session.state.pendingToolCallIds.filter(
                (id) => id !== toolCall.toolCallId,
              ),
            }),
            runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
          }));
          await tx.appendOutbox(
            durableEvent(
              "tool_call",
              toolCall.toolCallId,
              toolCall.sessionId,
              lease.fence,
              toolCall.status,
              toolCall,
              inserted.runtime,
              inserted.version,
            ),
          );
          await tx.appendOutbox(
            durableEvent(
              "session",
              toolCall.sessionId,
              toolCall.sessionId,
              lease.fence,
              updatedSession.session.status,
              updatedSession.session,
              updatedSession.runtime,
              updatedSession.version,
            ),
          );
          return toolCall;
        }
        assertToolCallIdentity(current.toolCall, toolCall);
        if (isTerminalToolCall(current.toolCall)) return current.toolCall;
        const terminal = finish(current);
        const updatedTool = await tx.updateToolCall(
          toolCall.sessionId,
          toolCall.toolCallId,
          (record) => ({
            ...record,
            toolCall: terminal,
          }),
        );
        const updatedSession = await tx.updateSession(toolCall.sessionId, (record) => ({
          ...record,
          session: activeSessionWithState(record.session, {
            ...record.session.state,
            pendingToolCallIds: record.session.state.pendingToolCallIds.filter(
              (id) => id !== toolCall.toolCallId,
            ),
          }),
          runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
        }));
        await tx.appendOutbox(
          durableEvent(
            "tool_call",
            toolCall.toolCallId,
            toolCall.sessionId,
            lease.fence,
            updatedTool.toolCall.status,
            updatedTool.toolCall,
            updatedTool.runtime,
            updatedTool.version,
          ),
        );
        await tx.appendOutbox(
          durableEvent(
            "session",
            toolCall.sessionId,
            toolCall.sessionId,
            lease.fence,
            updatedSession.session.status,
            updatedSession.session,
            updatedSession.runtime,
            updatedSession.version,
          ),
        );
        return terminal;
      }),
    );
  }
  return runUnfencedTransaction(context, toolCall.sessionId, async (tx) => {
    const current = await tx.getToolCall(toolCall.sessionId, toolCall.toolCallId);
    if (!current) {
      const inserted = {
        toolCall,
        runtime: { monotonicQueuedAtMs: context.sessionClockMs(toolCall.sessionId) },
      } satisfies StoredToolCallRecord;
      await tx.putToolCall(inserted);
      const updatedSession = await tx.updateSession(toolCall.sessionId, (record) => ({
        ...record,
        session: activeSessionWithState(record.session, {
          ...record.session.state,
          pendingToolCallIds: record.session.state.pendingToolCallIds.filter(
            (id) => id !== toolCall.toolCallId,
          ),
        }),
        runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
      }));
      await tx.appendOutbox(
        durableEvent(
          "tool_call",
          toolCall.toolCallId,
          toolCall.sessionId,
          0,
          toolCall.status,
          toolCall,
          inserted.runtime,
          1,
        ),
      );
      await tx.appendOutbox(
        durableEvent(
          "session",
          toolCall.sessionId,
          toolCall.sessionId,
          0,
          updatedSession.session.status,
          updatedSession.session,
          updatedSession.runtime,
          updatedSession.version,
        ),
      );
      return toolCall;
    }
    assertToolCallIdentity(current.toolCall, toolCall);
    if (isTerminalToolCall(current.toolCall)) return current.toolCall;
    const terminal = finish(current);
    const updatedTool = await tx.updateToolCall(
      toolCall.sessionId,
      toolCall.toolCallId,
      (record) => ({ ...record, toolCall: terminal }),
    );
    const updatedSession = await tx.updateSession(toolCall.sessionId, (record) => ({
      ...record,
      session: activeSessionWithState(record.session, {
        ...record.session.state,
        pendingToolCallIds: record.session.state.pendingToolCallIds.filter(
          (id) => id !== toolCall.toolCallId,
        ),
      }),
      runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
    }));
    await tx.appendOutbox(
      durableEvent(
        "tool_call",
        toolCall.toolCallId,
        toolCall.sessionId,
        0,
        updatedTool.toolCall.status,
        updatedTool.toolCall,
        updatedTool.runtime,
        updatedTool.version,
      ),
    );
    await tx.appendOutbox(
      durableEvent(
        "session",
        toolCall.sessionId,
        toolCall.sessionId,
        0,
        updatedSession.session.status,
        updatedSession.session,
        updatedSession.runtime,
        updatedSession.version,
      ),
    );
    return terminal;
  });
}

export async function recordToolCall(
  context: ToolLifecycleContext,
  toolCall: ToolCall,
): Promise<void> {
  if (toolCall.status === "queued" || toolCall.status === "running") {
    const attachment = context.attachments.get(toolCall.sessionId);
    const lease = attachment?.lease ?? undefined;
    if (attachment && !lease) {
      throw new LeaseUnavailableError(`Session lease unavailable: ${toolCall.sessionId}`);
    }
    if (!attachment && context.attachmentStarts.has(toolCall.sessionId)) {
      throw new LeaseUnavailableError(`Session attachment is starting: ${toolCall.sessionId}`);
    }
    if (!attachment && !context.isRunning()) {
      throw new Error("Runtime is not running");
    }
    const session = await context.sessionStore.get(toolCall.sessionId);
    if (!session) throw new Error(`Session not found: ${toolCall.sessionId}`);
    if (session.session.status !== "active") {
      throw new Error(
        `Cannot record a tool call for ${session.session.status} session: ${toolCall.sessionId}`,
      );
    }
    if (context.attachments.get(toolCall.sessionId) !== attachment) {
      throw new LeaseUnavailableError(`Session attachment changed: ${toolCall.sessionId}`);
    }
    if (!attachment && context.attachmentStarts.has(toolCall.sessionId)) {
      throw new LeaseUnavailableError(`Session attachment is starting: ${toolCall.sessionId}`);
    }
    if (!attachment && !context.isRunning()) {
      throw new Error("Runtime is not running");
    }
    const releaseReservation = lease
      ? undefined
      : context.reserveUnattachedSessionWrite(toolCall.sessionId);
    if (!lease && !releaseReservation) {
      throw new LeaseUnavailableError(`Session attachment is starting: ${toolCall.sessionId}`);
    }
    const persistOpen = async (tx: DurableSessionTransaction, fence: number): Promise<void> => {
      const session = await tx.getSession(toolCall.sessionId);
      if (!session) throw new Error(`Session not found: ${toolCall.sessionId}`);
      if (session.session.status !== "active") {
        throw new Error(
          `Cannot record a tool call for ${session.session.status} session: ${toolCall.sessionId}`,
        );
      }

      const existing = await tx.getToolCall(toolCall.sessionId, toolCall.toolCallId);
      if (existing) {
        assertToolCallIdentity(existing.toolCall, toolCall);
        if (isTerminalToolCall(existing.toolCall)) return;
      }
      const nextToolCall =
        existing?.toolCall.status === "running" && toolCall.status === "queued"
          ? existing.toolCall
          : toolCall;
      let stored: StoredToolCallRecord;
      if (existing) {
        stored = await tx.updateToolCall(toolCall.sessionId, toolCall.toolCallId, (record) => ({
          ...record,
          toolCall: nextToolCall,
        }));
      } else {
        stored = {
          toolCall: nextToolCall,
          runtime: { monotonicQueuedAtMs: context.sessionClockMs(toolCall.sessionId) },
          version: 1,
        };
        await tx.putToolCall(stored);
      }
      const updatedSession = await tx.updateSession(toolCall.sessionId, (current) => ({
        ...current,
        session: activeSessionWithState(current.session, {
          ...current.session.state,
          pendingToolCallIds: current.session.state.pendingToolCallIds.includes(toolCall.toolCallId)
            ? current.session.state.pendingToolCallIds
            : [...current.session.state.pendingToolCallIds, toolCall.toolCallId],
        }),
        runtime: { ...current.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
      }));
      await tx.appendOutbox(
        durableEvent(
          "tool_call",
          toolCall.toolCallId,
          toolCall.sessionId,
          fence,
          stored.toolCall.status,
          stored.toolCall,
          stored.runtime,
          stored.version,
        ),
      );
      await tx.appendOutbox(
        durableEvent(
          "session",
          toolCall.sessionId,
          toolCall.sessionId,
          fence,
          updatedSession.session.status,
          updatedSession.session,
          updatedSession.runtime,
          updatedSession.version,
        ),
      );
    };
    const abandoned: TerminalToolCall =
      toolCall.status === "queued"
        ? {
            ...toolCall,
            status: "cancelled",
            startedAt: context.clock.now(),
            endedAt: context.clock.now(),
            error: timeoutError(
              "tool.record_timed_out",
              "Tool recording completed after the caller deadline",
            ),
          }
        : {
            ...toolCall,
            status: "cancelled",
            endedAt: context.clock.now(),
            error: timeoutError(
              "tool.record_timed_out",
              "Tool recording completed after the caller deadline",
            ),
          };
    const abandonLateRecord = ({ error }: LateWriteOutcome<void>): void | Promise<void> => {
      if (!error) {
        return finishToolCall(context, abandoned, lease ?? null)
          .then(() => undefined)
          .catch(() => undefined);
      }
    };
    let timedOut = false;
    const settleLateRecord = async (outcome: LateWriteOutcome<void>): Promise<void> => {
      try {
        await abandonLateRecord(outcome);
      } finally {
        releaseReservation?.();
      }
    };
    try {
      if (lease) {
        await context.criticalWrite(
          () =>
            context.durableStore.runSessionTransaction(toolCall.sessionId, lease, (tx) =>
              persistOpen(tx, lease.fence),
            ),
          abandonLateRecord,
        );
      } else {
        await runUnfencedTransaction(
          context,
          toolCall.sessionId,
          (tx) => persistOpen(tx, 0),
          settleLateRecord,
          () => {
            timedOut = true;
          },
        );
      }
    } finally {
      // If a timed-out write can still commit, attachment admission stays
      // closed until its late outcome and compensation have settled.
      if (!timedOut) releaseReservation?.();
    }
    return;
  }
  await finishToolCall(context, toolCall);
}

function isTerminalToolCall(toolCall: ToolCall): toolCall is TerminalToolCall {
  return (
    toolCall.status === "succeeded" ||
    toolCall.status === "failed" ||
    toolCall.status === "timed_out" ||
    toolCall.status === "cancelled"
  );
}

function assertToolCallIdentity(current: ToolCall, incoming: ToolCall): void {
  let sameInput = false;
  try {
    sameInput = stableStringify(current.input) === stableStringify(incoming.input);
  } catch {
    // A cyclic or otherwise non-serializable input cannot cross a durable
    // adapter boundary. The built-in in-memory adapter can still terminalize
    // the same object, so retain that narrow compatibility path while treating
    // separately-created malformed values as a conflict.
    sameInput = current.input === incoming.input;
  }
  if (
    current.toolCallId !== incoming.toolCallId ||
    current.sessionId !== incoming.sessionId ||
    current.turnId !== incoming.turnId ||
    current.toolId !== incoming.toolId ||
    current.toolName !== incoming.toolName ||
    current.queuedAt !== incoming.queuedAt ||
    (current.idempotencyKey !== undefined &&
      incoming.idempotencyKey !== undefined &&
      current.idempotencyKey !== incoming.idempotencyKey) ||
    !sameInput
  ) {
    throw new RecordConflictError(`tool_call:${incoming.toolCallId}`);
  }
}

function activeSessionWithState(session: Session, state: ActiveSession["state"]): ActiveSession {
  if (
    (session.status === "active" ||
      session.status === "interrupted" ||
      session.status === "waiting_for_tool" ||
      session.status === "ending") &&
    "startedAt" in session
  ) {
    return { ...session, state };
  }
  throw new Error(`Expected an active session, received ${session.status}`);
}

async function runUnfencedTransaction<T>(
  context: ToolLifecycleContext,
  sessionId: SessionId,
  operation: (tx: DurableSessionTransaction) => Promise<T>,
  onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
  onTimeout?: () => void,
): Promise<T> {
  const run = context.durableStore.runUnfencedSessionTransaction;
  if (!run) {
    throw new LeaseUnavailableError(`Unfenced compatibility transaction unavailable: ${sessionId}`);
  }
  return context.criticalWrite(
    () => run.call(context.durableStore, sessionId, operation) as Promise<T>,
    onLate,
    onTimeout,
  );
}
