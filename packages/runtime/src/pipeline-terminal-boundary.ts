import { attachmentAbortReason } from "./pipeline-loop-boundary.js";
import {
  TerminalArbiter,
  type LiveTerminalSource,
  type TerminalCandidate,
  type TerminalClaim,
} from "./terminal-arbitration.js";
import { internalError, TvicThrowableError, type NormalizedError } from "@tvic/core";

export interface PipelineTerminalCoordinatorOptions {
  readonly attachmentSignal?: AbortSignal;
  readonly sourceForCancellation?: () => LiveTerminalSource | undefined;
}

/**
 * Keeps terminal-source selection out of the pipeline orchestration class.
 * The coordinator is deliberately small: it translates runtime observations
 * into candidates, while TerminalArbiter owns ordering and commitment.
 */
export class PipelineTerminalCoordinator {
  readonly #attachmentSignal: AbortSignal | undefined;
  readonly #sourceForCancellation: (() => LiveTerminalSource | undefined) | undefined;
  readonly #arbiter: TerminalArbiter;

  constructor(options: PipelineTerminalCoordinatorOptions = {}) {
    this.#attachmentSignal = options.attachmentSignal;
    this.#sourceForCancellation = options.sourceForCancellation;
    this.#arbiter = new TerminalArbiter();
  }

  cancellationSource(): LiveTerminalSource {
    const configured = this.#sourceForCancellation?.();
    if (configured) return configured;
    return attachmentAbortReason(this.#attachmentSignal) !== null
      ? "remote_transport"
      : "caller_abort";
  }

  watchSignal(signal: AbortSignal | undefined, onAbort: () => void): () => void {
    if (!signal) return () => undefined;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    return () => signal.removeEventListener("abort", onAbort);
  }

  sourceForEndReason(endReason: string, streamError?: NormalizedError | null): LiveTerminalSource {
    if (endReason === "remote_hangup") return "remote_transport";
    if (endReason === "timeout") return "run_timeout";
    if (endReason === "cancelled") return this.cancellationSource();
    if (streamError || endReason === "error" || endReason === "media_error") {
      return "provider_runtime";
    }
    return "normal_completion";
  }

  candidateForResult(
    result: {
      readonly turnsFailed: number;
      readonly firstTurnError: NormalizedError | null;
    },
    endReason: string,
  ): TerminalCandidate {
    if (result.turnsFailed > 0) {
      const source: LiveTerminalSource =
        result.firstTurnError?.category === "timeout" ? "run_timeout" : "provider_runtime";
      return {
        source,
        ...(result.firstTurnError ? { error: result.firstTurnError } : {}),
      };
    }
    const source = this.sourceForEndReason(endReason);
    return { source };
  }

  candidateForError(
    error: NormalizedError,
    cancelled: boolean,
    signalAborted: boolean,
  ): TerminalCandidate {
    if (cancelled || signalAborted || error.category === "cancelled") {
      const source = this.cancellationSource();
      return { source, error };
    }
    const source: LiveTerminalSource =
      error.category === "timeout" ? "run_timeout" : "provider_runtime";
    return { source, error };
  }

  offerTerminal(candidate: TerminalCandidate): void {
    this.#arbiter.dispatchBatch(() => {
      this.#arbiter.offerTerminal(candidate);
    });
  }

  async committedTerminal(candidate: TerminalCandidate): Promise<TerminalClaim> {
    if (!this.#arbiter.claim) this.offerTerminal(candidate);
    const claim = await this.#arbiter.waitForCommit();
    if (claim) return claim;
    throw TvicThrowableError.from(
      internalError(
        "voice_runtime.run_failed",
        "The voice pipeline did not select a terminal outcome",
      ),
    );
  }
}
