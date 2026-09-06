import type {
  DualProtocolResult,
  PipelineVoiceLoopResultLike as PipelineVoiceLoopResult,
  VoiceEvent,
} from "./voice-event.js";

/**
 * Fluent builder returned by {@link PipelineVoiceLoop.start}. Supports
 * `.abortSignal(sig)` to attach a per-call cancellation signal. Awaiting
 * the builder yields the final {@link PipelineVoiceLoopResult}; iterating
 * it exposes the per-event stream.
 *
 * Multiple `then` / `catch` / `finally` / `await` calls share a single
 * underlying run. Breaking out of the iteration cancels the run via the
 * supervisor controller.
 *
 * The double-set guard rejects a second `abortSignal` call. To compose
 * multiple signals, use `AbortSignal.any([a, b])` (Node 20+) before
 * passing them in.
 */
export class PipelineVoiceLoopBuilder {
  readonly #loop: PipelineVoiceLoopLike;
  #overrideSignal: AbortSignal | undefined;
  #runOnce: DualProtocolResult | undefined;

  constructor(loop: PipelineVoiceLoopLike, overrideSignal?: AbortSignal) {
    this.#loop = loop;
    this.#overrideSignal = overrideSignal;
  }

  /**
   * Attach an `AbortSignal` that cancels the run when triggered. Composed
   * with `attachment.signal` (both fire to cancel; the lease-loss reason
   * on the attachment is preserved). Throws if called twice on the same
   * builder.
   */
  abortSignal(signal: AbortSignal): this {
    if (this.#overrideSignal !== undefined) {
      throw new Error(
        "PipelineVoiceLoopBuilder: abortSignal already set; compose multiple signals with AbortSignal.any([...]) first (Node 20+)",
      );
    }
    if (this.#runOnce !== undefined) {
      throw new Error(
        "PipelineVoiceLoopBuilder: abortSignal cannot be set after the run has started",
      );
    }
    this.#overrideSignal = signal;
    return this;
  }

  /**
   * Cached run promise. First call invokes `_startInternal`; subsequent
   * calls return the same `DualProtocolResult` instance.
   */
  #getRunOnce(): DualProtocolResult {
    if (this.#runOnce === undefined) {
      this.#runOnce = this.#loop._startInternal(
        this.#overrideSignal ? { overrideSignal: this.#overrideSignal } : {},
      );
    }
    return this.#runOnce;
  }

  then<TResult1 = PipelineVoiceLoopResult, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResult) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#getRunOnce().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResult | TResult> {
    return this.#getRunOnce().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResult> {
    return this.#getRunOnce().finally(onfinally);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    return this.#getRunOnce()[Symbol.asyncIterator]();
  }
}

/**
 * Subset of the `PipelineVoiceLoop` API the builder needs. Declared as
 * a structural type so the builder can live in its own file without
 * creating a circular import. The full `PipelineVoiceLoop` class
 * implements this.
 */
export interface PipelineVoiceLoopLike {
  _startInternal(options: { readonly overrideSignal?: AbortSignal }): DualProtocolResult;
}
