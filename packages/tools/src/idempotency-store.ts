import { LeaseLostError, RecordConflictError, RecordNotFoundError } from "@tvic/core";
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

export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  readonly #entries = new Map<string, ToolIdempotencyRecord>();
  #pruneCursor: Iterator<[string, ToolIdempotencyRecord]> = this.#entries.entries();
  readonly #now: () => number;
  readonly #readLease:
    | ((sessionId: SessionId) =>
        | {
            readonly holder: string;
            readonly fence: number;
            readonly generationId: string;
            readonly expiresAtMs: number;
          }
        | null
        | PromiseLike<{
            readonly holder: string;
            readonly fence: number;
            readonly generationId: string;
            readonly expiresAtMs: number;
          } | null>)
    | undefined;
  readonly #readLeaseSnapshot:
    | ((sessionId: SessionId) => {
        readonly holder: string;
        readonly fence: number;
        readonly generationId: string;
        readonly expiresAtMs: number;
      } | null)
    | undefined;

  constructor(
    now: () => number = () => Date.now(),
    readLease?: (sessionId: SessionId) =>
      | {
          readonly holder: string;
          readonly fence: number;
          readonly generationId: string;
          readonly expiresAtMs: number;
        }
      | null
      | PromiseLike<{
          readonly holder: string;
          readonly fence: number;
          readonly generationId: string;
          readonly expiresAtMs: number;
        } | null>,
    readLeaseSnapshot?: (sessionId: SessionId) => {
      readonly holder: string;
      readonly fence: number;
      readonly generationId: string;
      readonly expiresAtMs: number;
    } | null,
  ) {
    this.#now = now;
    this.#readLease = readLease;
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
  ): Promise<ToolIdempotencyLookupResult> {
    const found = this.#active(key);
    if (!found) return { status: "missing" };
    if (found.requestHash !== requestHash || found.sessionId !== sessionId) {
      return { status: "conflict" };
    }
    return { status: "found", record: snapshotIdempotencyRecord(found) };
  }

  async claim(input: ToolIdempotencyClaim): Promise<ToolIdempotencyClaimResult> {
    const claimInput = {
      ...input,
      ...(input.lease ? { lease: { ...input.lease } } : {}),
    };
    const leaseCheck = this.#assertLease(claimInput.lease);
    if (leaseCheck) await leaseCheck;
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
          ? existing.claimedGenerationId !== claimInput.lease.generationId ||
            (existing.claimedFence !== undefined && existing.claimedFence < claimInput.lease.fence)
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
      expiresAtMs: this.#now() + claimInput.ttlMs,
    };
    this.#entries.set(claimInput.key, record);
    return { status: "claimed", record: snapshotIdempotencyRecord(record) };
  }

  async complete(key: string, requestHash: string, outcome: ToolIdempotencyOutcome): Promise<void> {
    const completion = {
      ...outcome,
      ...(outcome.lease ? { lease: { ...outcome.lease } } : {}),
      ...(outcome.output !== undefined ? { output: snapshotJsonValue(outcome.output) } : {}),
      ...(outcome.error ? { error: snapshotJsonValue(outcome.error) } : {}),
    };
    const leaseCheck = this.#assertLease(completion.lease);
    if (leaseCheck) await leaseCheck;
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
          existing.claimedFence !== completion.lease.fence ||
          existing.claimedGenerationId !== completion.lease.generationId))
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
      expiresAtMs: this.#now() + completion.ttlMs,
      ...(completion.owner ? { owner: completion.owner } : {}),
      ...(completion.output !== undefined ? { output: completion.output } : {}),
      ...(completion.error ? { error: completion.error } : {}),
    });
  }

  async quarantine(input: ToolIdempotencyQuarantine): Promise<ToolIdempotencyQuarantineResult> {
    const quarantine = {
      ...input,
      lease: { ...input.lease },
      error: snapshotJsonValue(input.error),
    };
    const leaseCheck = this.#assertLease(quarantine.lease);
    if (leaseCheck) await leaseCheck;
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
          ? previousGeneration !== quarantine.lease.generationId &&
            (previousFence === undefined || previousFence < quarantine.lease.fence)
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
      expiresAtMs: this.#now() + quarantine.ttlMs,
      error: quarantine.error,
    };
    this.#entries.set(quarantine.key, record);
    return { status: "quarantined", record: snapshotIdempotencyRecord(record) };
  }

  #assertLease(lease: ToolIdempotencyLease | undefined): PromiseLike<void> | void {
    if (!lease) return;
    if (this.#readLeaseSnapshot) {
      assertLeaseSnapshot(this.#readLeaseSnapshot(lease.sessionId), lease, this.#now());
      return;
    }
    if (!this.#readLease) throw new LeaseLostError(lease.sessionId);
    const current = this.#readLease(lease.sessionId);
    if (isPromiseLike(current)) {
      return current.then((snapshot) => assertLeaseSnapshot(snapshot, lease, this.#now()));
    }
    assertLeaseSnapshot(current, lease, this.#now());
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

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return Boolean(value && typeof value === "object" && "then" in value);
}

function assertLeaseSnapshot(
  current: {
    readonly holder: string;
    readonly fence: number;
    readonly generationId: string;
    readonly expiresAtMs: number;
  } | null,
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
