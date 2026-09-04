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
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutReason?: unknown,
  signal?: AbortSignal,
  abortReason?: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason ?? new Error("Aborted"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(timeoutReason ?? new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
