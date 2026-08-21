/** Resolves when an AbortSignal aborts, including signals already aborted. */
export function abortPromise(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }
  
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  
  /** Rejects after the timeout unless the supplied promise settles first. */
  export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
  