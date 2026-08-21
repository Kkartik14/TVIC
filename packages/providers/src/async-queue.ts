export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  readonly #maxBuffered: number;
  #closed = false;
  #error: unknown;

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
    if (this.#error) {
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
