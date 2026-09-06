import { AsyncQueue } from "@tvic/media";
import type { SessionId } from "@tvic/core";

import type { DualProtocolResult, PipelineVoiceLoopResultLike, VoiceEvent } from "./voice-event.js";

/**
 * Concrete implementation of {@link DualProtocolResult}. Owns:
 *   - the underlying `Promise<PipelineVoiceLoopResultLike>` from the run
 *   - an `AsyncQueue<VoiceEvent>` that the run lifecycle pushes to
 *   - a `cancel` function that the run's abort plumbing can call (or that
 *     `iterator.return()` calls on consumer break)
 *
 * The constructor receives the run promise and the queue *by reference*;
 * the run's lifecycle pushes events to the queue as it goes, and
 * resolves/rejects the run promise when the run finishes. This class
 * is a thin wrapper: it does not own the run's lifecycle.
 */
export class DualProtocolResultImpl implements DualProtocolResult {
  readonly #runPromise: Promise<PipelineVoiceLoopResultLike>;
  readonly #events: AsyncQueue<VoiceEvent>;
  readonly #cancel: () => void;
  readonly #sessionId: SessionId;

  constructor(options: {
    readonly runPromise: Promise<PipelineVoiceLoopResultLike>;
    readonly events: AsyncQueue<VoiceEvent>;
    readonly cancel: () => void;
    readonly sessionId: SessionId;
  }) {
    this.#runPromise = options.runPromise;
    this.#events = options.events;
    this.#cancel = options.cancel;
    this.#sessionId = options.sessionId;
  }

  get sessionId(): SessionId {
    return this.#sessionId;
  }

  then<TResult1 = PipelineVoiceLoopResultLike, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResultLike) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#runPromise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResultLike | TResult> {
    return this.#runPromise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResultLike> {
    return this.#runPromise.finally(onfinally);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    const iter = this.#events[Symbol.asyncIterator]();
    return {
      next: () => iter.next(),
      // On consumer break, cancel the run so the in-flight turn doesn't
      // continue. The `cancel` function is owned by the run's lifecycle.
      return: () => {
        this.#cancel();
        return iter.return?.() ?? Promise.resolve({ done: true, value: undefined });
      },
      throw: (err?: unknown) => iter.throw?.(err) ?? Promise.reject(err),
    };
  }
}

/**
 * Helper: build a `DualProtocolResult` from a run promise and an event queue.
 * The lifecycle code (the run loop) is responsible for:
 *   - calling `queue.push(event)` at each lifecycle point
 *   - calling `queue.close()` when the run finishes (success or failure)
 *   - calling `queue.fail(error)` if the run throws and the queue should reject
 *
 * Returns the result, the queue (so the lifecycle can push/close/fail), and
 * a `cancel` function the iterator's `return()` will call.
 */
export function buildDualProtocolResult(options: {
  readonly runPromise: Promise<PipelineVoiceLoopResultLike>;
  readonly cancel: () => void;
  readonly sessionId: SessionId;
}): { result: DualProtocolResult; events: AsyncQueue<VoiceEvent> } {
  const events = new AsyncQueue<VoiceEvent>();
  const result = new DualProtocolResultImpl({
    runPromise: options.runPromise,
    events,
    cancel: options.cancel,
    sessionId: options.sessionId,
  });
  return { result, events };
}
