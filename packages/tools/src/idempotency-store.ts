import {
  LeaseLostError,
  RecordConflictError,
  RecordNotFoundError,
  safeLeaseExpiryAt,
} from "@tvic/core";
import type {
  SessionId,
  ToolIdempotencyClaim,
  ToolIdempotencyClaimResult,
  ToolIdempotencyLease,
  ToolIdempotencyLookupResult,
  ToolIdempotencyOutcome,
  ToolIdempotencyQuarantine,
  ToolIdempotencyQuarantineResult,
  ToolIdempotencyRecord,
  ToolIdempotencyStore,
} from "@tvic/core";
import { snapshotJsonValue, stableStringify } from "./serialization.js";

type InMemoryLeaseSnapshot = {
  readonly holder: string;
  readonly fence: number;
  readonly generationId: string;
  readonly expiresAtMs: number;
};

export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #entries = new Map<string, ToolIdempotencyRecord>();
  #pruneCursor: Iterator<[string, ToolIdempotencyRecord]> = this.#entries.entries();
  readonly #now: () => number;
  readonly #readLeaseSnapshot: ((sessionId: SessionId) => InMemoryLeaseSnapshot | null) | undefined;

  /**
   * Fenced writes require a synchronous lease snapshot so validation and the
   * Map mutation run in one JavaScript turn without an intervening await.
   */
  constructor(
    now: () => number = () => Date.now(),
    readLeaseSnapshot?: (sessionId: SessionId) => InMemoryLeaseSnapshot | null,
  ) {
    this.#now = now;
    this.#readLeaseSnapshot = readLeaseSnapshot;
  }

  /** Deletes expired entries; normal operations also prune a bounded batch. */
  pruneExpired(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    this.#pruneCursor = this.#entries.entries();
    return removed;
  }

  async lookup(
    key: string,
    requestHash: string,
    sessionId?: SessionId,
    lease?: ToolIdempotencyLease,
  ): Promise<ToolIdempotencyLookupResult> {
    this.#assertLease(lease);
    if (lease && sessionId && lease.sessionId !== sessionId) return { status: "conflict" };
    const found = this.#active(key);
    if (!found) return { status: "missing" };
    if (found.requestHash !== requestHash || found.sessionId !== (lease?.sessionId ?? sessionId)) {
      return { status: "conflict" };
    }
    return { status: "found", record: snapshotIdempotencyRecord(found) };
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    const expiresAtMs = safeLeaseExpiryAt(this.#now(), input.ttlMs);
    const claimInput = {
      ...input,
      ...(input.lease ? { lease: { ...input.lease } } : {}),
    };
    this.#assertLease(claimInput.lease);
    if (
      claimInput.lease &&
      claimInput.sessionId &&
      claimInput.lease.sessionId !== claimInput.sessionId
    ) {
      return { status: "conflict" };
    }
    const sessionId = claimInput.lease?.sessionId ?? claimInput.sessionId;
    const existing = this.#active(claimInput.key);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        return { status: "conflict" };
      }
      if (
        (existing.toolId && claimInput.toolId && existing.toolId !== claimInput.toolId) ||
        (existing.toolVersion &&
          claimInput.toolVersion &&
          existing.toolVersion !== claimInput.toolVersion)
      ) {
        return { status: "conflict" };
      }
      if (existing.requestHash !== claimInput.requestHash) {
        return { status: "conflict" };
      }
      if (existing.status === "succeeded") {
        return { status: "succeeded", record: snapshotIdempotencyRecord(existing) };
      }
      if (existing.status !== "claimed") {
        return { status: "terminal", record: snapshotIdempotencyRecord(existing) };
      }
      const staleClaim =
        existing.status === "claimed" &&
        claimInput.lease !== undefined &&
        existing.sessionId === claimInput.lease.sessionId &&
        (existing.claimedGenerationId !== undefined
          ? existing.claimedGenerationId !== claimInput.lease.generationId
          : existing.claimedFence !== undefined && existing.claimedFence < claimInput.lease.fence);
      if (existing.status === "claimed" && !staleClaim) {
        return { status: "in_progress", record: snapshotIdempotencyRecord(existing) };
      }
    }
    const record: ToolIdempotencyRecord = {
      key: claimInput.key,
      ...(sessionId
        ? {
            sessionId,
          }
        : {}),
      ...(claimInput.lease
        ? {
            claimedFence: claimInput.lease.fence,
            claimedGenerationId: claimInput.lease.generationId,
          }
        : {}),
      ...(claimInput.toolId ? { toolId: claimInput.toolId } : {}),
      ...(claimInput.toolVersion ? { toolVersion: claimInput.toolVersion } : {}),
      requestHash: claimInput.requestHash,
      status: "claimed",
      owner: claimInput.owner,
      expiresAtMs,
    };
    this.#entries.set(claimInput.key, record);
    return { status: "claimed", record: snapshotIdempotencyRecord(record) };
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    const expiresAtMs = safeLeaseExpiryAt(this.#now(), outcome.ttlMs);
    const completion = {
      ...outcome,
      ...(outcome.lease ? { lease: { ...outcome.lease } } : {}),
      ...(outcome.output !== undefined ? { output: snapshotJsonValue(outcome.output) } : {}),
      ...(outcome.error ? { error: snapshotJsonValue(outcome.error) } : {}),
    };
    this.#assertLease(completion.lease);
    if (
      completion.lease &&
      completion.sessionId &&
      completion.lease.sessionId !== completion.sessionId
    ) {
      throw new RecordConflictError("tool_idempotency");
    }
    const existing = this.#active(key);
    if (!existing) throw new RecordNotFoundError("tool_idempotency");
    if (existing.requestHash !== requestHash) {
      throw new RecordConflictError("tool_idempotency");
    }
    if (
      (completion.lease?.sessionId ?? completion.sessionId) !== existing.sessionId ||
      ((existing.claimedFence !== undefined || existing.claimedGenerationId !== undefined) &&
        (!completion.lease ||
          (existing.claimedGenerationId !== undefined
            ? existing.claimedGenerationId !== completion.lease.generationId ||
              (existing.claimedFence !== undefined &&
                existing.claimedFence !== completion.lease.fence)
            : existing.claimedFence !== completion.lease.fence)))
    ) {
      throw new LeaseLostError(existing.sessionId ?? completion.lease?.sessionId ?? "unknown");
    }
    if (
      (completion.owner && existing.owner !== completion.owner) ||
      (completion.lease && existing.sessionId && existing.sessionId !== completion.lease.sessionId)
    ) {
      throw new RecordConflictError("tool_idempotency");
    }
    if (existing.status !== "claimed") {
      const sameOutcome =
        existing.status === completion.status &&
        stableStringify(existing.output) === stableStringify(completion.output) &&
        stableStringify(existing.error) === stableStringify(completion.error);
      if (sameOutcome) return;
      throw new RecordConflictError("tool_idempotency");
    }
    this.#entries.set(key, {
      ...existing,
      key,
      requestHash,
      status: completion.status,
      expiresAtMs,
      ...(completion.owner ? { owner: completion.owner } : {}),
      ...(completion.output !== undefined ? { output: completion.output } : {}),
      ...(completion.error ? { error: completion.error } : {}),
    });
  }

  async quarantine(input: ToolIdempotencyQuarantine): Promise<ToolIdempotencyQuarantineResult> {
    const expiresAtMs = safeLeaseExpiryAt(this.#now(), input.ttlMs);
    const quarantine = {
      ...input,
      lease: { ...input.lease },
      error: snapshotJsonValue(input.error),
    };
    this.#assertLease(quarantine.lease);
    if (quarantine.sessionId !== quarantine.lease.sessionId) return { status: "conflict" };

    const existing = this.#active(quarantine.key);
    if (existing) {
      if (
        existing.sessionId !== quarantine.sessionId ||
        existing.toolId !== quarantine.toolId ||
        existing.toolVersion !== quarantine.toolVersion ||
        existing.requestHash !== quarantine.requestHash
      ) {
        return { status: "conflict" };
      }
      if (existing.status === "succeeded") {
        return { status: "succeeded", record: snapshotIdempotencyRecord(existing) };
      }
      if (existing.status !== "claimed") {
        return { status: "terminal", record: snapshotIdempotencyRecord(existing) };
      }
      if (existing.owner !== quarantine.owner) {
        return { status: "in_progress", record: snapshotIdempotencyRecord(existing) };
      }
      const previousGeneration = existing.claimedGenerationId;
      const previousFence = existing.claimedFence;
      const priorLease =
        previousGeneration !== undefined
          ? previousGeneration !== quarantine.lease.generationId
          : previousFence !== undefined && previousFence < quarantine.lease.fence;
      if (!priorLease) {
        return { status: "in_progress", record: snapshotIdempotencyRecord(existing) };
      }
    }

    const record: ToolIdempotencyRecord = {
      key: quarantine.key,
      sessionId: quarantine.sessionId,
      toolId: quarantine.toolId,
      toolVersion: quarantine.toolVersion,
      requestHash: quarantine.requestHash,
      status: "failed",
      owner: quarantine.owner,
      claimedFence: quarantine.lease.fence,
      claimedGenerationId: quarantine.lease.generationId,
      expiresAtMs,
      error: quarantine.error,
    };
    this.#entries.set(quarantine.key, record);
    return { status: "quarantined", record: snapshotIdempotencyRecord(record) };
  }

  #assertLease(lease: ToolIdempotencyLease | undefined): void {
    if (!lease) return;
    if (!this.#readLeaseSnapshot) throw new LeaseLostError(lease.sessionId);
    assertLeaseSnapshot(this.#readLeaseSnapshot(lease.sessionId), lease, this.#now());
  }

  #active(key: string): ToolIdempotencyRecord | null {
    this.#pruneExpiredBatch(32);
    const found = this.#entries.get(key);
    if (!found) return null;
    if (found.expiresAtMs <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    return found;
  }

  #pruneExpiredBatch(limit: number): void {
    const now = this.#now();
    for (let scanned = 0; scanned < limit; scanned += 1) {
      const next = this.#pruneCursor.next();
      if (next.done) {
        this.#pruneCursor = this.#entries.entries();
        return;
      }
      const [key, entry] = next.value;
      if (entry.expiresAtMs <= now) this.#entries.delete(key);
    }
  }
}

function assertLeaseSnapshot(
  current: InMemoryLeaseSnapshot | null,
  lease: ToolIdempotencyLease,
  nowMs: number,
): void {
  if (
    !current ||
    current.holder !== lease.holder ||
    current.fence !== lease.fence ||
    current.generationId !== lease.generationId ||
    current.expiresAtMs <= nowMs
  ) {
    throw new LeaseLostError(lease.sessionId);
  }
}

function snapshotIdempotencyRecord(record: ToolIdempotencyRecord): ToolIdempotencyRecord {
  return {
    ...record,
    ...(record.output !== undefined ? { output: snapshotJsonValue(record.output) } : {}),
    ...(record.error ? { error: snapshotJsonValue(record.error) } : {}),
  };
}
