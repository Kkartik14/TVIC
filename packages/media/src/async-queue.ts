export const ASYNC_QUEUE_DEFAULT_MAX_BUFFERED = 1_024;

/**
 * Thrown synchronously by a second concurrent `[Symbol.asyncIterator]()`
 * claim. The `code` is the cross-realm detection contract (`instanceof`
 * is not); `name` is always `"AsyncQueueConsumerError"`.
 */
export class AsyncQueueConsumerError extends Error {
  readonly code = "async_queue.consumer_already_claimed" as const;

  constructor() {
    super("AsyncQueue already has a live consumer");
    this.name = "AsyncQueueConsumerError";
  }
}

/**
 * Single-producer, single-live-consumer async queue: pushed values resolve
 * waiters in FIFO order. Lives in `@tvic/media` because it is the one
 * package both `@tvic/providers` and `@tvic/runtime` are allowed to depend on
 * (see `scripts/check-architecture.mjs`), so provider adapters and the
 * runtime's own session/stream wrappers share this one implementation instead
 * of each keeping a private copy.
 *
 * Bounds: `maxBuffered` defaults to 1,024 (finite everywhere; no public voice
 * stream uses an unbounded queue). `push()` returns false when full/closed —
 * callers MUST handle false as terminal backpressure, never silent drop.
 *
 * Terminal semantics (normative):
 * - first `[Symbol.asyncIterator]()` claims the queue; a second claim while
 *   one iterator is live throws `AsyncQueueConsumerError` synchronously;
 *   the claim releases when that iterator settles (return/throw/done/reject);
 * - producer `close()` keeps buffered values, drains them, then resolves done;
 * - consumer `return()` (early break) discards buffered values, resolves
 *   pending waiters done, and closes permanently;
 * - `fail(error)` records the first error, discards buffered values, rejects
 *   all pending and future `next()` calls with it; first terminal wins.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #failed = false;
  #error: unknown;
  #claimed = false;
  readonly #maxBuffered: number;

  constructor(options: { readonly maxBuffered?: number } = {}) {
    const maxBuffered = options.maxBuffered ?? ASYNC_QUEUE_DEFAULT_MAX_BUFFERED;
    if (!Number.isSafeInteger(maxBuffered) || maxBuffered < 1) {
      throw new RangeError("AsyncQueue maxBuffered must be a positive safe integer");
    }
    this.#maxBuffered = maxBuffered;
  }

  push(value: T): boolean {
    if (this.#closed) {
      return false;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return true;
    }

    if (this.#values.length >= this.#maxBuffered) {
      return false;
    }

    this.#values.push(value);
    return true;
  }

  fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#error = error;
    this.#failed = true;
    this.#closed = true;
    this.#values.length = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#claimed) {
      throw new AsyncQueueConsumerError();
    }
    this.#claimed = true;
    let settled = false;
    const release = (): void => {
      if (!settled) {
        settled = true;
        this.#claimed = false;
      }
    };
    return {
      next: async () => {
        try {
          const result = await this.#next();
          if (result.done) release();
          return result;
        } catch (error) {
          release();
          throw error;
        }
      },
      return: async () => {
        // Early consumer cancellation: discard buffered values (unlike
        // producer close, which drains them), resolve pending waiters done,
        // and close permanently.
        this.#values.length = 0;
        this.close();
        release();
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        this.#values.length = 0;
        if (error === undefined) {
          this.close();
        } else {
          // Reject any pending `next()` and permanently stop the producer.
          // Leaving a pending waiter alive here would release the claim while
          // another iterator could start consuming the same queue.
          this.fail(error);
        }
        release();
        throw error;
      },
    };
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#failed) {
      return Promise.reject(this.#error);
    }

    if (this.#values.length > 0) {
      const value = this.#values.shift() as T;
      return Promise.resolve({ done: false, value });
    }

    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}
