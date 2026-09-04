export function stallTimer(ms: number): {
  readonly promise: Promise<void>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

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
      reject(abortReason ?? new Error("aborted"));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(timeoutReason ?? new Error("timeout"));
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

export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function raceStartup<T>(
  startup: Promise<T>,
  signal: AbortSignal,
  cancel: (handle: T) => Promise<void>,
): Promise<T | null> {
  const outcome = await Promise.race([
    startup.then((handle) => ({ aborted: false as const, handle })),
    abortPromise(signal).then(() => ({ aborted: true as const })),
  ]);
  if (!outcome.aborted) {
    return outcome.handle;
  }
  void startup.then((handle) => cancel(handle)).catch(() => undefined);
  return null;
}
