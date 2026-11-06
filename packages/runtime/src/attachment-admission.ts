import type { SessionId } from "@tvic/core";

export class AttachmentAdmission {
  readonly #owners = new Map<SessionId, Set<symbol>>();
  readonly #closed = new Set<SessionId>();
  readonly #idleWaiters = new Map<SessionId, Set<() => void>>();

  acquire(sessionId: SessionId): () => void {
    if (this.#closed.has(sessionId)) {
      throw new Error(`Session attachment is closed: ${sessionId}`);
    }
    let owners = this.#owners.get(sessionId);
    if (!owners) {
      owners = new Set();
      this.#owners.set(sessionId, owners);
    }
    const owner = Symbol(sessionId);
    owners.add(owner);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      owners!.delete(owner);
      if (owners!.size === 0) {
        this.#owners.delete(sessionId);
        this.#closed.delete(sessionId);
        const waiters = this.#idleWaiters.get(sessionId);
        if (waiters) {
          this.#idleWaiters.delete(sessionId);
          for (const resolve of waiters) resolve();
        }
      }
    };
  }

  waitForIdle(sessionId: SessionId): Promise<void> {
    if (!this.#owners.has(sessionId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let waiters = this.#idleWaiters.get(sessionId);
      if (!waiters) {
        waiters = new Set();
        this.#idleWaiters.set(sessionId, waiters);
      }
      waiters.add(resolve);
    });
  }

  close(sessionId: SessionId): void {
    if (this.#owners.has(sessionId)) this.#closed.add(sessionId);
  }

  isClosed(sessionId: SessionId): boolean {
    return this.#closed.has(sessionId);
  }

  has(sessionId: SessionId): boolean {
    return this.#owners.has(sessionId);
  }
}
