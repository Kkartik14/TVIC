import { AsyncQueue, AsyncQueueConsumerError } from "@tvic/media";
import { TvicThrowableError, validationError } from "@tvic/core";
import type { SessionId } from "@tvic/core";

import type {
  DualProtocolResult,
  PipelineVoiceLoopResultLike as PipelineVoiceLoopResult,
  VoiceEvent,
} from "./voice-event.js";

/**
 * Concrete implementation of {@link DualProtocolResult}. Owns:
 *   - the underlying `Promise<PipelineVoiceLoopResult>` from the run
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
  readonly #runPromise: Promise<PipelineVoiceLoopResult>;
  readonly #events: AsyncQueue<VoiceEvent>;
  readonly #cancel: () => void;
  readonly #sessionId: SessionId;
  readonly #consumer: "internal" | "public";
  #iterator: AsyncIterator<VoiceEvent> | undefined;

  constructor(options: {
    readonly runPromise: Promise<PipelineVoiceLoopResult>;
    readonly events: AsyncQueue<VoiceEvent>;
    readonly cancel: () => void;
    readonly sessionId: SessionId;
    readonly consumer?: "internal" | "public";
  }) {
    this.#runPromise = options.runPromise;
    this.#events = options.events;
    this.#cancel = options.cancel;
    this.#sessionId = options.sessionId;
    this.#consumer = options.consumer ?? "public";
    if (this.#consumer === "public") {
      this.#iterator = this.#claimIterator();
    } else {
      // The internal drain claims the queue before this object is constructed.
      // Keep the public boundary unavailable to prevent a second consumer.
      this.#iterator = undefined;
    }
  }

  get sessionId(): SessionId {
    return this.#sessionId;
  }

  then<TResult1 = PipelineVoiceLoopResult, TResult2 = never>(
    onfulfilled?:
      | ((value: PipelineVoiceLoopResult) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#runPromise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined,
  ): PromiseLike<PipelineVoiceLoopResult | TResult> {
    return this.#runPromise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): PromiseLike<PipelineVoiceLoopResult> {
    return this.#runPromise.finally(onfinally);
  }

  [Symbol.asyncIterator](): AsyncIterator<VoiceEvent> {
    if (this.#consumer !== "public" || !this.#iterator) {
      throw this.#eventsAlreadyConsumed();
    }
    const iter = this.#iterator;
    this.#iterator = undefined;
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

  #claimIterator(): AsyncIterator<VoiceEvent> {
    try {
      return this.#events[Symbol.asyncIterator]();
    } catch (error) {
      if (error instanceof AsyncQueueConsumerError || isQueueConsumerError(error)) {
        throw this.#eventsAlreadyConsumed();
      }
      throw error;
    }
  }

  #eventsAlreadyConsumed(): TvicThrowableError {
    return TvicThrowableError.from(
      validationError(
        "voice_runtime.events_already_consumed",
        "The voice event stream has already been claimed by another consumer",
      ),
    );
  }
}

function isQueueConsumerError(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly code?: unknown }).code === "async_queue.consumer_already_claimed"
  );
}
