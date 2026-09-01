import {
  InvalidArgumentError,
  LeaseLostError,
  RecordConflictError,
  type DurableOutboxEvent,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type SessionId,
  type SessionLease,
  type SessionStore,
  type StoredSessionRecord,
  type StoredToolCallRecord,
  type StoredTurnRecord,
  type ToolCallStore,
  type TurnStore,
} from "@tvic/core";
import { decodeOutboxEnvelope } from "@tvic/dal-codec";

import {
  createInMemorySessionStore,
  createInMemoryToolCallStore,
  createInMemoryTurnStore,
  InMemorySessionLeaseStore,
  sameRecord,
} from "./in-memory-stores.js";

export interface InMemoryDurableRuntimeStore extends DurableRuntimeStore {
  readonly outbox: readonly DurableOutboxEvent[];
}

export interface InMemoryDurableRuntimeStoreOptions {
  readonly nowMs?: () => number;
  /**
   * Legacy stores can be supplied while callers migrate to DurableRuntimeStore.
   * The aggregate transaction facade serializes access to them and uses the
   * optional internal restore hooks when the store provides one. Custom stores
   * without those hooks receive ordering isolation but cannot receive a full
   * rollback guarantee; production adapters should implement DurableRuntimeStore
   * directly when atomicity is required.
   */
  readonly sessionStore?: SessionStore;
  readonly turnStore?: TurnStore;
  readonly toolCallStore?: ToolCallStore;
}

type RestorableSessionStore = SessionStore & {
  restore?: (id: SessionId, record: StoredSessionRecord | null) => void;
};

type RestorableTurnStore = TurnStore & {
  restore?: (sessionId: SessionId, records: readonly StoredTurnRecord[]) => void;
};

type RestorableToolCallStore = ToolCallStore & {
  restore?: (sessionId: SessionId, records: readonly StoredToolCallRecord[]) => void;
};

function restoreSession(
  store: SessionStore,
  id: SessionId,
  record: StoredSessionRecord | null,
): void {
  (store as RestorableSessionStore).restore?.(id, record);
}

function restoreTurns(
  store: TurnStore,
  sessionId: SessionId,
  records: readonly StoredTurnRecord[],
): void {
  (store as RestorableTurnStore).restore?.(sessionId, records);
}

function restoreToolCalls(
  store: ToolCallStore,
  sessionId: SessionId,
  records: readonly StoredToolCallRecord[],
): void {
  (store as RestorableToolCallStore).restore?.(sessionId, records);
}

export function createInMemoryDurableRuntimeStore(
  options: InMemoryDurableRuntimeStoreOptions = {},
): InMemoryDurableRuntimeStore {
  const sessions = options.sessionStore ?? createInMemorySessionStore();
  const turns = options.turnStore ?? createInMemoryTurnStore();
  const toolCalls = options.toolCallStore ?? createInMemoryToolCallStore();
  const leases = new InMemorySessionLeaseStore(options.nowMs ?? Date.now);
  const outbox: DurableOutboxEvent[] = [];
  const queues = new Map<SessionId, Promise<unknown>>();
  const sessionCreationQueues = new Map<SessionId, Promise<unknown>>();

  const createTransaction = (sessionId: SessionId): DurableSessionTransaction => {
    const assertSession = (candidate: SessionId): void => {
      if (candidate !== sessionId) {
        throw new InvalidArgumentError(
          `Session transaction ${sessionId} cannot access ${candidate}`,
        );
      }
    };
    return {
      getSession: (id) => {
        assertSession(id);
        return sessions.get(id);
      },
      putSession: (record) => {
        assertSession(record.session.id);
        return sessions.put(record);
      },
      updateSession: (id, updater) => {
        assertSession(id);
        return sessions.update(id, updater);
      },
      getTurn: (candidate, id) => {
        assertSession(candidate);
        return turns.get(candidate, id);
      },
      listTurns: (candidate) => {
        assertSession(candidate);
        return turns.listBySession(candidate);
      },
      putTurn: (record) => {
        assertSession(record.turn.sessionId);
        return turns.put(record);
      },
      updateTurn: (candidate, id, updater) => {
        assertSession(candidate);
        return turns.update(candidate, id, updater);
      },
      getToolCall: (candidate, id) => {
        assertSession(candidate);
        return toolCalls.get(candidate, id);
      },
      listToolCalls: (candidate) => {
        assertSession(candidate);
        return toolCalls.listBySession(candidate);
      },
      putToolCall: (record) => {
        assertSession(record.toolCall.sessionId);
        return toolCalls.put(record);
      },
      updateToolCall: (candidate, id, updater) => {
        assertSession(candidate);
        return toolCalls.update(candidate, id, updater);
      },
      appendOutbox: async (event) => {
        assertSession(event.sessionId);
        const envelope = decodeOutboxEnvelope(
          event.aggregateType,
          event.envelope,
          `outbox:${event.id}`,
          event.version,
        );
        if (!outbox.some((existing) => existing.id === event.id)) {
          outbox.push({ ...event, envelope });
        }
      },
    };
  };

  const store: InMemoryDurableRuntimeStore = {
    sessions,
    turns,
    toolCalls,
    leases,
    outbox,
    async createSessionWithLease(record, holder, ttlMs, initialEvent) {
      const sessionId = record.session.id;
      const previous = sessionCreationQueues.get(sessionId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          const existing = await sessions.get(sessionId);
          if (existing) {
            if (!sameRecord(existing, record)) {
              throw new RecordConflictError(`Session:${sessionId}`);
            }
            const lease = await leases.acquire(sessionId, holder, ttlMs);
            if (lease && initialEvent) {
              try {
                await createTransaction(sessionId).appendOutbox(initialEvent(lease));
              } catch (error) {
                await leases.release(sessionId, holder, lease.fence).catch(() => undefined);
                throw error;
              }
            }
            return lease;
          }
          await sessions.put(record);
          try {
            const lease = await leases.acquire(sessionId, holder, ttlMs);
            if (!lease) {
              restoreSession(sessions, sessionId, null);
            } else if (initialEvent) {
              await createTransaction(sessionId).appendOutbox(initialEvent(lease));
            }
            return lease;
          } catch (error) {
            const lease = await leases.get(sessionId).catch(() => null);
            if (lease?.holder === holder) await leases.release(sessionId, holder, lease.fence);
            restoreSession(sessions, sessionId, null);
            throw error;
          }
        });
      sessionCreationQueues.set(sessionId, current);
      try {
        return await current;
      } finally {
        if (sessionCreationQueues.get(sessionId) === current) {
          sessionCreationQueues.delete(sessionId);
        }
      }
    },
    async runSessionTransaction<T>(
      sessionId: SessionId,
      lease: Pick<SessionLease, "holder" | "fence">,
      operation: (tx: DurableSessionTransaction) => Promise<T>,
    ): Promise<T> {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          const active = await leases.get(sessionId);
          if (!active || active.holder !== lease.holder || active.fence !== lease.fence) {
            throw new LeaseLostError(sessionId);
          }
          const sessionBefore = await sessions.get(sessionId);
          const turnsBefore = await turns.listBySession(sessionId);
          const toolsBefore = await toolCalls.listBySession(sessionId);
          const outboxBefore = new Set(outbox.map((event) => event.id));
          try {
            const result = await operation(createTransaction(sessionId));
            const stillOwned = await leases.get(sessionId);
            if (
              !stillOwned ||
              stillOwned.holder !== lease.holder ||
              stillOwned.fence !== lease.fence
            ) {
              throw new LeaseLostError(sessionId);
            }
            return result;
          } catch (error) {
            restoreSession(sessions, sessionId, sessionBefore);
            restoreTurns(turns, sessionId, turnsBefore);
            restoreToolCalls(toolCalls, sessionId, toolsBefore);
            removeNewOutboxEvents(outbox, outboxBefore);
            throw error;
          }
        });
      queues.set(sessionId, current);
      try {
        return await current;
      } finally {
        if (queues.get(sessionId) === current) queues.delete(sessionId);
      }
    },
    async runUnfencedSessionTransaction<T>(
      sessionId: SessionId,
      operation: (tx: DurableSessionTransaction) => Promise<T>,
    ): Promise<T> {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          const sessionBefore = await sessions.get(sessionId);
          const turnsBefore = await turns.listBySession(sessionId);
          const toolsBefore = await toolCalls.listBySession(sessionId);
          const outboxBefore = new Set(outbox.map((event) => event.id));
          try {
            return await operation(createTransaction(sessionId));
          } catch (error) {
            restoreSession(sessions, sessionId, sessionBefore);
            restoreTurns(turns, sessionId, turnsBefore);
            restoreToolCalls(toolCalls, sessionId, toolsBefore);
            removeNewOutboxEvents(outbox, outboxBefore);
            throw error;
          }
        });
      queues.set(sessionId, current);
      try {
        return await current;
      } finally {
        if (queues.get(sessionId) === current) queues.delete(sessionId);
      }
    },
  };
  return store;
}

function removeNewOutboxEvents(
  outbox: DurableOutboxEvent[],
  existingIds: ReadonlySet<string>,
): void {
  for (let index = outbox.length - 1; index >= 0; index -= 1) {
    if (!existingIds.has(outbox[index]!.id)) outbox.splice(index, 1);
  }
}
