import { normalizeUnknownError, type NormalizedError, type TerminalSource } from "@tvic/core";

/** The terminal result shape selected by the raw voice pipeline. */
export type TerminalKind = "completed" | "cancelled" | "remote_hangup" | "failed";

/** The six sources that may win a live pipeline terminal race. */
export type LiveTerminalSource = Extract<
  TerminalSource,
  | "operator_stop"
  | "caller_abort"
  | "run_timeout"
  | "remote_transport"
  | "provider_runtime"
  | "normal_completion"
>;

export interface TerminalCandidate {
  readonly source: LiveTerminalSource;
  readonly error?: NormalizedError;
}

export interface TerminalClaim extends TerminalCandidate {
  readonly kind: TerminalKind;
}

const TERMINAL_PRIORITY: Readonly<Record<LiveTerminalSource, number>> = Object.freeze({
  operator_stop: 100,
  caller_abort: 90,
  run_timeout: 80,
  remote_transport: 70,
  provider_runtime: 60,
  normal_completion: 0,
});

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

interface BatchRecord {
  readonly candidates: Array<{
    readonly claim: TerminalClaim;
    readonly priority: number;
    readonly sequence: number;
  }>;
  committed: boolean;
}

/**
 * Selects exactly one terminal outcome for a raw pipeline.
 *
 * A synchronous callback is one arbitration batch. Nested callbacks share the
 * active batch, while a later host callback gets a new batch. The first batch
 * that commits a candidate wins; candidates in that batch are selected by
 * priority, then by offer sequence.
 */
export class TerminalArbiter {
  #active: BatchRecord | undefined;
  #claim: TerminalClaim | undefined;
  #nextSequence = 0;

  get claim(): TerminalClaim | undefined {
    return this.#claim;
  }

  dispatchBatch(callback: () => void): void {
    const batch =
      this.#active ??
      (() => {
        const created: BatchRecord = {
          candidates: [],
          committed: false,
        };
        queueMicrotask(() => this.#commit(created));
        return created;
      })();
    const previous = this.#active;
    this.#active = batch;
    try {
      const result = (callback as () => unknown)();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Terminal arbitration callbacks must be synchronous");
      }
    } catch (error) {
      // A boundary callback may rethrow to its adapter, but the pipeline still
      // receives one observed provider-runtime terminal candidate.
      if (!batch.candidates.some((candidate) => candidate.claim.source === "provider_runtime")) {
        this.#offerInBatch(batch, {
          source: "provider_runtime",
          error: normalizeUnknownError(error, {
            code: "voice_runtime.run_failed",
            category: "internal",
            retriable: false,
          }),
        });
      }
      throw error;
    } finally {
      this.#active = previous;
    }
  }

  /**
   * Offer the only accepted terminal candidate path.
   *
   * Calling this outside the active synchronous callback is a programming
   * error. This prevents a late Promise or provider event from changing a
   * terminal result after the pipeline has moved on.
   */
  offerTerminal(candidate: TerminalCandidate): TerminalClaim {
    const batch = this.#active;
    if (!batch) throw new Error("Terminal candidate must be offered inside dispatchBatch()");
    return this.#offerInBatch(batch, candidate);
  }

  async waitForCommit(): Promise<TerminalClaim | undefined> {
    await Promise.resolve();
    return this.#claim;
  }

  #offerInBatch(batch: BatchRecord, candidate: TerminalCandidate): TerminalClaim {
    const claim: TerminalClaim = Object.freeze({
      ...candidate,
      kind: terminalKindForSource(candidate.source),
    });
    batch.candidates.push({
      claim,
      priority: TERMINAL_PRIORITY[candidate.source],
      sequence: ++this.#nextSequence,
    });
    return claim;
  }

  #commit(batch: BatchRecord): void {
    if (batch.committed) return;
    batch.committed = true;
    if (this.#claim || batch.candidates.length === 0) return;
    const winner = [...batch.candidates].sort(
      (left, right) => right.priority - left.priority || left.sequence - right.sequence,
    )[0];
    if (winner) this.#claim = winner.claim;
  }
}

export function terminalKindForSource(source: LiveTerminalSource): TerminalKind {
  switch (source) {
    case "operator_stop":
    case "caller_abort":
      return "cancelled";
    case "run_timeout":
      return "failed";
    case "remote_transport":
      return "remote_hangup";
    case "provider_runtime":
      return "failed";
    case "normal_completion":
      return "completed";
  }
}
