import { CANCELLATION_TIMEOUT_MS } from "./pipeline-constants.js";

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

export function sleepWithAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
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

/**
 * Bounds non-cooperative provider cleanup (P-11). Awaits `cancel()`; if it
 * neither resolves nor rejects within `timeoutMs`, calls `onTimeout()` (the
 * caller emits the degraded diagnostic) and returns, abandoning the hanging
 * provider promise with a late-settlement guard against unhandled rejection.
 * A cancel that settles (success or throw) propagates exactly as awaited.
 */
const CANCEL_TIMEOUT = Symbol("tvic.cancel-timeout");

export async function cancelWithTimeout(
  cancel: () => Promise<unknown>,
  timeoutMs: number,
  onTimeout: () => void = () => {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancel(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(CANCEL_TIMEOUT), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timer === undefined) throw error;
    clearTimeout(timer);
    timer = undefined;
    if (error === CANCEL_TIMEOUT) {
      onTimeout();
      return;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function returnAsyncIteratorWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  onTimeout: () => void = () => {},
): Promise<void> {
  if (!iterator.return) return;
  await cancelWithTimeout(
    () => Promise.resolve().then(() => iterator.return!()),
    timeoutMs,
    onTimeout,
  ).catch(() => undefined);
}

export async function raceStartup<T>(
  startup: Promise<T>,
  signal: AbortSignal,
  cancel: (handle: T) => Promise<void>,
  options: {
    readonly timeoutMs?: number;
    readonly timeoutReason?: unknown;
    readonly onCancelTimeout?: () => void;
  } = {},
): Promise<T | null> {
  type Outcome =
    | { readonly kind: "started"; readonly handle: T }
    | { readonly kind: "rejected"; readonly error: unknown }
    | { readonly kind: "aborted" }
    | { readonly kind: "timed_out" };

  // Always observe the startup promise, including the pre-aborted path. A
  // provider is allowed to settle after the caller has stopped waiting.
  startup.catch(() => undefined);

  const cancelLateHandle = (): void => {
    void startup
      .then((handle) =>
        cancelWithTimeout(
          () => cancel(handle),
          CANCELLATION_TIMEOUT_MS,
          () => options.onCancelTimeout?.(),
        ),
      )
      .catch(() => undefined);
  };

  // Promise.race would let an already-fulfilled startup win over an already
  // aborted signal because the startup branch is registered first. Abortion
  // is a caller decision, so it must win even when startup settled in the
  // same turn.
  if (signal.aborted) {
    cancelLateHandle();
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;
  const startupOutcome: Promise<Outcome> = startup.then(
    (handle) => ({ kind: "started", handle }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
  const abortOutcome = new Promise<Outcome>((resolve) => {
    const onAbort = (): void => resolve({ kind: "aborted" });
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  const outcomes: Promise<Outcome>[] = [startupOutcome, abortOutcome];
  if (options.timeoutMs !== undefined) {
    outcomes.push(
      new Promise<Outcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timed_out" }), options.timeoutMs);
      }),
    );
  }

  let outcome: Outcome;
  try {
    outcome = await Promise.race(outcomes);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener();
  }
  if (outcome.kind === "started") {
    if (signal.aborted) {
      await cancelWithTimeout(
        () => cancel(outcome.handle),
        CANCELLATION_TIMEOUT_MS,
        () => options.onCancelTimeout?.(),
      ).catch(() => undefined);
      return null;
    }
    return outcome.handle;
  }
  if (outcome.kind === "rejected") {
    throw outcome.error;
  }

  cancelLateHandle();
  if (outcome.kind === "timed_out") {
    throw options.timeoutReason ?? new Error("startup timeout");
  }
  return null;
}
