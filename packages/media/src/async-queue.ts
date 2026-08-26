/**
 * A deliberately unbounded, single-consumer async queue: exactly one iterator
 * may drain it, and pushed values resolve waiters in FIFO order. Lives in
 * `@tvic/media` because it is the one package both `@tvic/providers` and
 * `@tvic/runtime` are allowed to depend on (see `scripts/check-architecture.mjs`),
 * so provider adapters and the runtime's own session/stream wrappers share this
 * one implementation instead of each keeping a private copy.
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
  readonly #maxBuffered: number;

  constructor(options: { readonly maxBuffered?: number } = {}) {
    const maxBuffered = options.maxBuffered ?? Number.POSITIVE_INFINITY;
    if (
      maxBuffered !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(maxBuffered) || maxBuffered < 1)
    ) {
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
    return {
      next: () => this.#next(),
      return: async () => {
        this.close();
        return { done: true, value: undefined };
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
