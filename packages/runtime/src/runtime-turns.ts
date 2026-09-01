import { isTerminalTurn, RecordNotFoundError, terminalTurnFromRequest } from "@tvic/core";
import type {
  ActiveSession,
  ActiveTurn,
  Clock,
  DurableRuntimeStore,
  DurableSessionTransaction,
  EndTurnRequest,
  IdGenerator,
  SessionId,
  SessionLease,
  SessionStore,
  StartTurnRequest,
  StoredSessionRecord,
  StoredTurnRecord,
  TerminalTurn,
  Turn,
  TurnCancellationReason,
  TurnId,
  TurnStatus,
  TurnStore,
} from "@tvic/core";
import {
  durableEvent,
  type LateWriteOutcome as RuntimeLateWriteOutcome,
} from "./runtime-support.js";

export interface RuntimeTurnContext {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly durableStore: DurableRuntimeStore;
  readonly sessionStore: SessionStore;
  readonly turnStore: TurnStore;
  readonly attachments: ReadonlyMap<SessionId, { readonly lease: SessionLease | null }>;
  readonly criticalWrite: <T>(
    operation: () => Promise<T>,
    onLate?: (outcome: RuntimeLateWriteOutcome<T>) => void | Promise<void>,
  ) => Promise<T>;
  readonly runUnfencedSessionTransaction: <T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
    onLate?: (outcome: RuntimeLateWriteOutcome<T>) => void | Promise<void>,
  ) => Promise<T>;
  readonly durationSince: (monotonicStartedAtMs: number) => number;
  readonly abandonLateTurn: (turn: ActiveTurn) => void | Promise<void>;
}

export async function startTurn(
  context: RuntimeTurnContext,
  request: StartTurnRequest,
): Promise<ActiveTurn> {
  const sessionRecord = await context.sessionStore.get(request.sessionId);
  if (!sessionRecord) throw new RecordNotFoundError(`session:${request.sessionId}`);
  if (sessionRecord.session.status !== "active") {
    throw new Error(
      `Cannot start turn for ${sessionRecord.session.status} session: ${request.sessionId}`,
    );
  }

  const create = (current: StoredSessionRecord): StoredTurnRecord => {
    const sequence = current.session.state.turnSequence + 1;
    const now = context.clock.now();
    return {
      turn: {
        id: context.ids.turn(),
        sessionId: current.session.id,
        sequence,
        status: "started",
        input: request.input ?? { mediaEventIds: [] },
        output: { mediaEventIds: [] },
        toolCallIds: [],
        startedAt: now,
        latency: {},
        ...(request.metadata ? { metadata: request.metadata } : {}),
      },
      runtime: { monotonicStartedAtMs: context.clock.monotonicMs() },
    };
  };

  const persist = async (tx: DurableSessionTransaction, fence: number): Promise<ActiveTurn> => {
    const current = await tx.getSession(request.sessionId);
    if (!current || current.session.status !== "active") {
      throw new Error(`Cannot start turn for ${request.sessionId}`);
    }
    const record = create(current);
    await tx.putTurn(record);
    const updatedSession = await tx.updateSession(request.sessionId, (stored) => ({
      ...stored,
      session: {
        ...stored.session,
        state: {
          ...stored.session.state,
          turnSequence: record.turn.sequence,
          currentTurnId: record.turn.id,
        },
      } as ActiveSession,
      runtime: {
        ...stored.runtime,
        lastActivityWallAtMs: Date.parse(context.clock.now()),
      },
    }));
    await tx.appendOutbox(
      durableEvent(
        "turn",
        record.turn.id,
        request.sessionId,
        fence,
        record.turn.status,
        record.turn,
        record.runtime,
        record.version,
      ),
    );
    await tx.appendOutbox(
      durableEvent(
        "session",
        request.sessionId,
        request.sessionId,
        fence,
        updatedSession.session.status,
        updatedSession.session,
        updatedSession.runtime,
        updatedSession.version,
      ),
    );
    return record.turn as ActiveTurn;
  };

  const abandonLate = ({ error, result }: RuntimeLateWriteOutcome<ActiveTurn>): void => {
    if (!error && result) {
      void Promise.resolve(context.abandonLateTurn(result)).catch(() => undefined);
    }
  };
  const lease = context.attachments.get(request.sessionId)?.lease;
  if (lease) {
    return context.criticalWrite(
      () =>
        context.durableStore.runSessionTransaction(request.sessionId, lease, (tx) =>
          persist(tx, lease.fence),
        ),
      abandonLate,
    );
  }
  return context.runUnfencedSessionTransaction(
    request.sessionId,
    (tx) => persist(tx, 0),
    abandonLate,
  );
}

export async function endTurn(
  context: RuntimeTurnContext,
  sessionId: SessionId,
  turnId: TurnId,
  request: EndTurnRequest,
): Promise<TerminalTurn> {
  const session = await context.sessionStore.get(sessionId);
  if (!session) throw new RecordNotFoundError(`session:${sessionId}`);
  const lease = context.attachments.get(sessionId)?.lease;
  const finish = async (
    record: StoredTurnRecord,
    update: (next: TerminalTurn) => Promise<void>,
  ): Promise<TerminalTurn> => {
    if (isTerminalTurn(record.turn)) return record.turn;
    const terminal = terminalTurnFromRequest(
      record.turn,
      request,
      context.clock.now(),
      context.durationSince(record.runtime.monotonicStartedAtMs),
    );
    await update(terminal);
    return terminal;
  };

  const persist = async (tx: DurableSessionTransaction, fence: number): Promise<TerminalTurn> => {
    const record = await tx.getTurn(sessionId, turnId);
    if (!record) throw new RecordNotFoundError(`turn:${sessionId}:${turnId}`);
    return finish(record, async (terminal) => {
      const updatedTurn = await tx.updateTurn(sessionId, turnId, (current) => ({
        ...current,
        turn: terminal,
        runtime: { ...current.runtime },
      }));
      const updatedSession = await tx.updateSession(sessionId, (current) => ({
        ...current,
        session: {
          ...current.session,
          state: {
            ...current.session.state,
            ...(current.session.state.currentTurnId === turnId ? { currentTurnId: undefined } : {}),
            pendingToolCallIds: current.session.state.pendingToolCallIds.filter(
              (id) => !terminal.toolCallIds.includes(id),
            ),
          },
        } as ActiveSession,
        runtime: {
          ...current.runtime,
          lastActivityWallAtMs: Date.parse(context.clock.now()),
        },
      }));
      await tx.appendOutbox(
        durableEvent(
          "turn",
          turnId,
          sessionId,
          fence,
          updatedTurn.turn.status,
          updatedTurn.turn,
          updatedTurn.runtime,
          updatedTurn.version,
        ),
      );
      await tx.appendOutbox(
        durableEvent(
          "session",
          sessionId,
          sessionId,
          fence,
          updatedSession.session.status,
          updatedSession.session,
          updatedSession.runtime,
          updatedSession.version,
        ),
      );
    });
  };

  if (lease) {
    return context.criticalWrite(() =>
      context.durableStore.runSessionTransaction(sessionId, lease, (tx) =>
        persist(tx, lease.fence),
      ),
    );
  }
  return context.runUnfencedSessionTransaction(sessionId, (tx) => persist(tx, 0));
}

export async function updateTurnStatus(
  context: RuntimeTurnContext,
  sessionId: SessionId,
  turnId: TurnId,
  status: TurnStatus,
): Promise<Turn> {
  if (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "started"
  ) {
    if (status === "started") {
      const record = await context.turnStore.get(sessionId, turnId);
      if (!record) throw new RecordNotFoundError(`turn:${sessionId}:${turnId}`);
      return record.turn;
    }
    throw new Error(`Status transition ${status} requires a terminal turn request`);
  }

  const lease = context.attachments.get(sessionId)?.lease;
  const persist = async (tx: DurableSessionTransaction, fence: number): Promise<Turn> => {
    const current = await tx.getTurn(sessionId, turnId);
    if (!current) throw new RecordNotFoundError(`turn:${sessionId}:${turnId}`);
    if (isTerminalTurn(current.turn)) return current.turn;
    const updatedTurn = await tx.updateTurn(sessionId, turnId, (record) => ({
      ...record,
      turn: { ...record.turn, status } as ActiveTurn,
    }));
    const updatedSession = await tx.updateSession(sessionId, (record) => ({
      ...record,
      runtime: { ...record.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
    }));
    await tx.appendOutbox(
      durableEvent(
        "turn",
        turnId,
        sessionId,
        fence,
        updatedTurn.turn.status,
        updatedTurn.turn,
        updatedTurn.runtime,
        updatedTurn.version,
      ),
    );
    await tx.appendOutbox(
      durableEvent(
        "session",
        sessionId,
        sessionId,
        fence,
        updatedSession.session.status,
        updatedSession.session,
        updatedSession.runtime,
        updatedSession.version,
      ),
    );
    return updatedTurn.turn;
  };

  if (lease) {
    return context.criticalWrite(() =>
      context.durableStore.runSessionTransaction(sessionId, lease, (tx) =>
        persist(tx, lease.fence),
      ),
    );
  }
  return context.runUnfencedSessionTransaction(sessionId, (tx) => persist(tx, 0));
}

export async function checkpointTurnInterruption(
  context: RuntimeTurnContext,
  sessionId: SessionId,
  turnId: TurnId,
  reason: TurnCancellationReason,
): Promise<Turn> {
  const lease = context.attachments.get(sessionId)?.lease;
  const persist = async (tx: DurableSessionTransaction, fence: number): Promise<Turn> => {
    const record = await tx.getTurn(sessionId, turnId);
    if (!record) throw new RecordNotFoundError(`turn:${sessionId}:${turnId}`);
    if (isTerminalTurn(record.turn)) return record.turn;
    const interrupted: ActiveTurn = {
      ...record.turn,
      status: "interrupted",
      latency: { ...record.turn.latency },
      metadata: {
        ...(record.turn.metadata ?? {}),
        interruptionReason: reason,
      },
    };
    const updatedTurn = await tx.updateTurn(sessionId, turnId, (current) => ({
      ...current,
      turn: interrupted,
    }));
    const updatedSession = await tx.updateSession(sessionId, (current) => ({
      ...current,
      runtime: { ...current.runtime, lastActivityWallAtMs: Date.parse(context.clock.now()) },
    }));
    await tx.appendOutbox(
      durableEvent(
        "turn",
        turnId,
        sessionId,
        fence,
        updatedTurn.turn.status,
        updatedTurn.turn,
        updatedTurn.runtime,
        updatedTurn.version,
      ),
    );
    await tx.appendOutbox(
      durableEvent(
        "session",
        sessionId,
        sessionId,
        fence,
        updatedSession.session.status,
        updatedSession.session,
        updatedSession.runtime,
        updatedSession.version,
      ),
    );
    return updatedTurn.turn;
  };

  if (lease) {
    return context.criticalWrite(() =>
      context.durableStore.runSessionTransaction(sessionId, lease, (tx) =>
        persist(tx, lease.fence),
      ),
    );
  }
  return context.runUnfencedSessionTransaction(sessionId, (tx) => persist(tx, 0));
}
