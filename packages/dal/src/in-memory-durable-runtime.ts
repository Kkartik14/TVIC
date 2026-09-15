import {
  InvalidArgumentError,
  LeaseLostError,
  RecordConflictError,
  type DurableOutboxEvent,
  type DurableRuntimeStore,
  type DurableSessionTransaction,
  type SessionId,
  type SessionLease,
  type SessionLeaseStore,
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

const MAX_OUTBOX_EVENTS = 512;

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
  const rawLeases = new InMemorySessionLeaseStore(options.nowMs ?? Date.now);
  const outbox: DurableOutboxEvent[] = [];
  const queues = new Map<SessionId, Promise<unknown>>();

  const enqueueSessionOperation = <T>(
    sessionId: SessionId,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(sessionId, current);
    const cleanup = (): void => {
      if (queues.get(sessionId) === current) queues.delete(sessionId);
    };
    // Keep the original rejection/result for the caller while ensuring the
    // queue entry is removed without creating an unhandled cleanup rejection.
    void current.then(cleanup, cleanup);
    return current;
  };

  // Lease operations are queued as session operations, alongside aggregate
  // transactions. The raw store is used inside a transaction to avoid waiting
  // on itself. This makes lease reads and mutations participate in the same
  // FIFO boundary instead of merely waiting for one queue snapshot.
  const leases: SessionLeaseStore = {
    acquire: (sessionId: SessionId, holder: string, ttlMs: number) =>
      enqueueSessionOperation(sessionId, () => rawLeases.acquire(sessionId, holder, ttlMs)),
    renew: (sessionId: SessionId, holder: string, fence: number, ttlMs: number) =>
      enqueueSessionOperation(sessionId, () => rawLeases.renew(sessionId, holder, fence, ttlMs)),
    release: (sessionId: SessionId, holder: string, fence: number) =>
      enqueueSessionOperation(sessionId, () => rawLeases.release(sessionId, holder, fence)),
    get: (sessionId: SessionId) =>
      enqueueSessionOperation(sessionId, () => rawLeases.get(sessionId)),
    listRecoveryCandidates: async (
      options: Parameters<InMemorySessionLeaseStore["listRecoveryCandidates"]>[0],
    ) => {
      await Promise.all([...queues.values()].map((current) => current.catch(() => undefined)));
      return rawLeases.listRecoveryCandidates(options);
    },
    close: () => rawLeases.close(),
  };

  const commitOutbox = (staged: readonly DurableOutboxEvent[]): void => {
    // A transaction's staged events are committed in one synchronous section.
    // That matters because transactions for different sessions may be running
    // concurrently while sharing this process-wide development outbox.
    for (const event of staged) {
      if (outbox.some((existing) => existing.id === event.id)) {
        continue;
      }
      if (outbox.length >= MAX_OUTBOX_EVENTS) {
        outbox.shift();
      }
      outbox.push(event);
    }
  };

  const createTransaction = (
    sessionId: SessionId,
    stagedOutbox: DurableOutboxEvent[] = [],
  ): DurableSessionTransaction => {
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
        if (
          !outbox.some((existing) => existing.id === event.id) &&
          !stagedOutbox.some((existing) => existing.id === event.id)
        ) {
          stagedOutbox.push({ ...event, envelope });
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
      // Session creation is an aggregate mutation too. It must share the
      // same queue as ordinary session transactions, otherwise creation can
      // race an unfenced write between putting the record and acquiring its
      // first lease.
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          const existing = await sessions.get(sessionId);
          if (existing) {
            if (!sameRecord(existing, record)) {
              throw new RecordConflictError(`Session:${sessionId}`);
            }
            const leaseBefore = await rawLeases.get(sessionId).catch(() => null);
            const lease = await rawLeases.acquire(sessionId, holder, ttlMs);
            const stagedOutbox: DurableOutboxEvent[] = [];
            if (lease && initialEvent) {
              try {
                await createTransaction(sessionId, stagedOutbox).appendOutbox(initialEvent(lease));
                commitOutbox(stagedOutbox);
              } catch (error) {
                // Re-acquiring a live lease held by this same holder is
                // intentionally idempotent. Do not release that lease during
                // rollback: this call did not create its ownership.
                if (
                  !leaseBefore ||
                  leaseBefore.fence !== lease.fence ||
                  leaseBefore.holder !== holder
                ) {
                  await rawLeases.release(sessionId, holder, lease.fence).catch(() => undefined);
                }
                throw error;
              }
            }
            return lease;
          }
          const stagedOutbox: DurableOutboxEvent[] = [];
          try {
            await sessions.put(record);
            const lease = await rawLeases.acquire(sessionId, holder, ttlMs);
            if (!lease) {
              restoreSession(sessions, sessionId, null);
            } else if (initialEvent) {
              await createTransaction(sessionId, stagedOutbox).appendOutbox(initialEvent(lease));
              commitOutbox(stagedOutbox);
            }
            return lease;
          } catch (error) {
            const lease = await rawLeases.get(sessionId).catch(() => null);
            if (lease?.holder === holder) {
              await rawLeases.release(sessionId, holder, lease.fence).catch(() => undefined);
            }
            restoreSession(sessions, sessionId, null);
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
    async runSessionTransaction<T>(
      sessionId: SessionId,
      lease: Pick<SessionLease, "holder" | "fence">,
      operation: (tx: DurableSessionTransaction) => Promise<T>,
    ): Promise<T> {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          const active = await rawLeases.get(sessionId);
          if (!active || active.holder !== lease.holder || active.fence !== lease.fence) {
            throw new LeaseLostError(sessionId);
          }
          const sessionBefore = await sessions.get(sessionId);
          const turnsBefore = await turns.listBySession(sessionId);
          const toolsBefore = await toolCalls.listBySession(sessionId);
          const stagedOutbox: DurableOutboxEvent[] = [];
          try {
            const result = await operation(createTransaction(sessionId, stagedOutbox));
            const stillOwned = await rawLeases.get(sessionId);
            if (
              !stillOwned ||
              stillOwned.holder !== lease.holder ||
              stillOwned.fence !== lease.fence
            ) {
              throw new LeaseLostError(sessionId);
            }
            commitOutbox(stagedOutbox);
            return result;
          } catch (error) {
            restoreSession(sessions, sessionId, sessionBefore);
            restoreTurns(turns, sessionId, turnsBefore);
            restoreToolCalls(toolCalls, sessionId, toolsBefore);
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
          // R2-06: the coordinated lease facade waits behind this queue, so a
          // fenced acquire cannot race between the check and the transaction.
          const live = await rawLeases.get(sessionId);
          if (live) {
            throw new LeaseLostError(sessionId);
          }
          const sessionBefore = await sessions.get(sessionId);
          const turnsBefore = await turns.listBySession(sessionId);
          const toolsBefore = await toolCalls.listBySession(sessionId);
          const stagedOutbox: DurableOutboxEvent[] = [];
          try {
            const result = await operation(createTransaction(sessionId, stagedOutbox));
            if (await rawLeases.get(sessionId)) {
              throw new LeaseLostError(sessionId);
            }
            commitOutbox(stagedOutbox);
            return result;
          } catch (error) {
            restoreSession(sessions, sessionId, sessionBefore);
            restoreTurns(turns, sessionId, turnsBefore);
            restoreToolCalls(toolCalls, sessionId, toolsBefore);
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
