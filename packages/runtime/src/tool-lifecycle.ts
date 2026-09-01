import type {
  ActiveSession,
  Agent,
  Clock,
  DurableRuntimeStore,
  DurableSessionTransaction,
  QueuedToolCall,
  RunningToolCall,
  Session,
  SessionId,
  SessionLease,
  SessionStore,
  StoredToolCallRecord,
  TerminalToolCall,
  ToolCall,
  ToolCallStore,
  ToolIdempotencyStore,
} from "@tvic/core";
import { LeaseUnavailableError, normalizedError, RecordConflictError } from "@tvic/core";
import { idempotencyKeyFor, idempotencyRequestHashFor, stableStringify } from "@tvic/tools";
import { durableEvent, type LateWriteOutcome } from "./runtime-support.js";

export interface ToolLifecycleContext {
  readonly clock: Clock;
  readonly durableStore: DurableRuntimeStore;
  readonly sessionStore: SessionStore;
  readonly toolCallStore: ToolCallStore;
  readonly attachments: ReadonlyMap<
    SessionId,
    { readonly lease: SessionLease | null; readonly agent?: Agent }
  >;
  readonly toolIdempotencyStore?: ToolIdempotencyStore;
  readonly sessionClockMs: (sessionId: SessionId) => number;
  readonly criticalWrite: <T>(
    operation: () => Promise<T>,
    onLate?: (outcome: LateWriteOutcome<T>) => void | Promise<void>,
  ) => Promise<T>;
}

export async function startToolCall(
  context: ToolLifecycleContext,
  toolCall: QueuedToolCall,
): Promise<RunningToolCall> {
  const sessionRecord = await context.sessionStore.get(toolCall.sessionId);
  if (!sessionRecord) throw new Error(`Session not found: ${toolCall.sessionId}`);
  if (sessionRecord.session.status !== "active") {
    throw new Error(
      `Cannot start tool call for ${sessionRecord.session.status} session: ${toolCall.sessionId}`,
    );
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
  const lease = context.attachments.get(toolCall.sessionId)?.lease;
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
    error: normalizedError(
      "tool.start_timed_out",
      "Tool start completed after the caller deadline",
      { category: "timeout", retriable: true },
    ),
  });
  const abandonLateStart = ({ error }: LateWriteOutcome<void>): void => {
    if (!error) void finishToolCall(context, abandoned()).catch(() => undefined);
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
): Promise<TerminalToolCall> {
  const lease = context.attachments.get(toolCall.sessionId)?.lease;
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

export async function recoverToolCalls(
  context: ToolLifecycleContext,
  sessionId: SessionId,
): Promise<readonly ToolCall[]> {
  const records = await context.toolCallStore.listBySession(sessionId);
  const recovered: ToolCall[] = [];
  for (const record of records) {
    if (record.toolCall.status !== "running") {
      recovered.push(record.toolCall);
      continue;
    }
    const terminal =
      (await replayRecoveredToolCall(
        record.toolCall,
        context.attachments.get(sessionId)?.agent,
        context.toolIdempotencyStore,
        context.clock.now(),
      )) ?? ambiguousRecoveredToolCall(record.toolCall, context.clock.now());
    await finishToolCall(context, terminal);
    recovered.push(terminal);
  }
  return recovered;
}

/**
 * A tool executor may have completed and durably recorded its idempotency
 * result immediately before the owning process died. Reconcile that result
 * before classifying a running tool as ambiguous; this is the recovery-side
 * half of the exactly-once side-effect boundary.
 */
export async function replayRecoveredToolCall(
  toolCall: RunningToolCall,
  agent: Agent | undefined,
  idempotencyStore: ToolIdempotencyStore | undefined,
  endedAt: RunningToolCall["queuedAt"],
): Promise<TerminalToolCall | null> {
  if (!agent || !idempotencyStore) return null;
  const tool = agent.tools.find((candidate) => candidate.id === toolCall.toolId);
  if (!tool) return null;
  const input = {
    tool,
    input: toolCall.input,
    sessionId: toolCall.sessionId,
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
  };
  let key: string | null;
  let requestHash: string;
  try {
    key = toolCall.idempotencyKey ?? idempotencyKeyFor(input);
    if (!key) return null;
    requestHash = idempotencyRequestHashFor(input);
  } catch {
    // A legacy malformed record cannot be safely replayed. Leave it for the
    // ambiguous-recovery classification instead of failing attachment.
    return null;
  }
  const record = await idempotencyStore.lookup(key, requestHash);
  if (!record || record.requestHash !== requestHash) return null;
  if (record.status !== "succeeded") return null;
  return {
    ...toolCall,
    ...(toolCall.idempotencyKey !== undefined ? { idempotencyKey: key } : {}),
    status: "succeeded",
    endedAt,
    output: record.output,
    metadata: {
      ...(toolCall.metadata ?? {}),
      recovery: "idempotent_replay",
      idempotentHit: true,
    },
  };
}

function ambiguousRecoveredToolCall(
  toolCall: RunningToolCall,
  endedAt: RunningToolCall["queuedAt"],
): TerminalToolCall {
  return {
    ...toolCall,
    status: "failed",
    endedAt,
    error: {
      code: "tool.runtime_restarted",
      category: "internal",
      message: "Tool execution was interrupted by runtime ownership loss",
      retriable: false,
    },
    metadata: { ...(toolCall.metadata ?? {}), recovery: "ambiguous" },
  };
}

export async function recordToolCall(
  context: ToolLifecycleContext,
  toolCall: ToolCall,
): Promise<void> {
  if (toolCall.status === "queued" || toolCall.status === "running") {
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
            error: normalizedError(
              "tool.record_timed_out",
              "Tool recording completed after the caller deadline",
              { category: "timeout", retriable: true },
            ),
          }
        : {
            ...toolCall,
            status: "cancelled",
            endedAt: context.clock.now(),
            error: normalizedError(
              "tool.record_timed_out",
              "Tool recording completed after the caller deadline",
              { category: "timeout", retriable: true },
            ),
          };
    const abandonLateRecord = ({ error }: LateWriteOutcome<void>): void => {
      if (!error) void finishToolCall(context, abandoned).catch(() => undefined);
    };
    const lease = context.attachments.get(toolCall.sessionId)?.lease;
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
        abandonLateRecord,
      );
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

/**
 * A terminal payload may change execution outcome fields, but it must not
 * change which logical call those fields belong to. This check runs inside
 * the transaction so a stale or malformed executor result cannot overwrite a
 * live call with another turn/tool/input.
 */
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
    current.idempotencyKey !== incoming.idempotencyKey ||
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
): Promise<T> {
  const run = context.durableStore.runUnfencedSessionTransaction;
  if (!run) {
    throw new LeaseUnavailableError(`Unfenced compatibility transaction unavailable: ${sessionId}`);
  }
  return context.criticalWrite(
    () => run.call(context.durableStore, sessionId, operation) as Promise<T>,
    onLate,
  );
}
