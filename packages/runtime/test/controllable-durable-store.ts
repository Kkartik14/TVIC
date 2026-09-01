import type {
  DurableOutboxEvent,
  DurableRuntimeStore,
  DurableSessionTransaction,
  SessionId,
  SessionLease,
  SessionLeaseStore,
  SessionStore,
  ToolCallStore,
  ToolIdempotencyStore,
  TurnStore,
} from "@tvic/core";
import { InMemoryToolIdempotencyStore } from "@tvic/tools";

/** Test-only store wrapper for reproducing writes that commit after the runtime deadline. */
export class ControllableDurableStore implements DurableRuntimeStore {
  readonly sessions: SessionStore;
  readonly turns: TurnStore;
  readonly toolCalls: ToolCallStore;
  readonly leases: SessionLeaseStore;
  readonly toolIdempotencyStore: ToolIdempotencyStore;
  #delayNextTransactionMs = 0;
  #delayNextUnfencedTransactionMs = 0;
  #delayNextSessionCreationMs = 0;

  constructor(readonly base: DurableRuntimeStore) {
    this.sessions = base.sessions;
    this.turns = base.turns;
    this.toolCalls = base.toolCalls;
    this.leases = base.leases;
    this.toolIdempotencyStore =
      base.toolIdempotencyStore ??
      new InMemoryToolIdempotencyStore(
        () => Date.now(),
        (sessionId) => this.base.leases.get(sessionId),
      );
  }

  async close(): Promise<void> {
    if (this.base.close) {
      await this.base.close();
      return;
    }
    await Promise.all([
      this.sessions.close(),
      this.turns.close(),
      this.toolCalls.close(),
      this.leases.close(),
    ]);
  }

  delayNextTransaction(ms: number): void {
    this.#delayNextTransactionMs = ms;
  }

  delayNextUnfencedTransaction(ms: number): void {
    this.#delayNextUnfencedTransactionMs = ms;
  }

  delayNextSessionCreation(ms: number): void {
    this.#delayNextSessionCreationMs = ms;
  }

  async createSessionWithLease(
    record: Parameters<NonNullable<DurableRuntimeStore["createSessionWithLease"]>>[0],
    holder: string,
    ttlMs: number,
    initialEvent?: (lease: SessionLease) => DurableOutboxEvent,
  ): Promise<SessionLease | null> {
    const create = this.base.createSessionWithLease;
    if (!create) return Promise.resolve(null);
    const delay = this.#delayNextSessionCreationMs;
    this.#delayNextSessionCreationMs = 0;
    if (delay > 0) await wait(delay);
    return create.call(this.base, record, holder, ttlMs, initialEvent);
  }

  async runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    const delay = this.#delayNextTransactionMs;
    this.#delayNextTransactionMs = 0;
    return this.base.runSessionTransaction(sessionId, lease, async (tx) => {
      if (delay > 0) await wait(delay);
      return operation(tx);
    });
  }

  async runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    const delay = this.#delayNextUnfencedTransactionMs;
    this.#delayNextUnfencedTransactionMs = 0;
    const run = this.base.runUnfencedSessionTransaction;
    if (!run) throw new Error("Base store has no unfenced transaction support");
    return run.call(this.base, sessionId, async (tx) => {
      if (delay > 0) await wait(delay);
      return operation(tx);
    }) as Promise<T>;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
