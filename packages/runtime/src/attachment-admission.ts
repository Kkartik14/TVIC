import type { SessionId } from "@tvic/core";

export class AttachmentAdmission {
  readonly #owners = new Map<SessionId, Set<symbol>>();
  readonly #closed = new Set<SessionId>();

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
      }
    };
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
