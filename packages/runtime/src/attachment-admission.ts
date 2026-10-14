import type { SessionId } from "@tvic/core";

/** Tracks independently owned waits that prevent a session from attaching. */
export class AttachmentAdmission {
  readonly #owners = new Map<SessionId, Set<symbol>>();

  acquire(sessionId: SessionId): () => void {
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
      if (owners!.size === 0) this.#owners.delete(sessionId);
    };
  }

  has(sessionId: SessionId): boolean {
    return this.#owners.has(sessionId);
  }
}
