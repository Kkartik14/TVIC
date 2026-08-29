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

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
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
