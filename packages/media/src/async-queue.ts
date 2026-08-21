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

  push(value: T): void {
    if (this.#closed) {
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }

    this.#values.push(value);
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
    };
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#failed) {
      return Promise.reject(this.#error);
    }

    const value = this.#values.shift();
    if (value !== undefined) {
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
