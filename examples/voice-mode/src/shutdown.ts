interface CleanupHealth {
  readonly checks?: {
    readonly cleanup?: {
      readonly details?: { readonly lateCleanupPending?: unknown };
    };
  };
}

interface RuntimeCleanupWaitOptions {
  readonly healthCheck?: () => Promise<CleanupHealth>;
  readonly hasActiveSessions: () => boolean;
}

type BoundedOperationResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "failed" }
  | { readonly status: "timed_out" };

export type ShutdownOperationResult = "completed" | "failed" | "timed_out";

export async function stopOperationBeforeDeadline(
  timeoutMs: number,
  operation: () => Promise<unknown>,
): Promise<ShutdownOperationResult> {
  return (await operationBeforeDeadline(timeoutMs, operation)).status;
}

async function operationBeforeDeadline<T>(
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<BoundedOperationResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedOperationResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
  });
  const result = Promise.resolve()
    .then(operation)
    .then<BoundedOperationResult<T>, BoundedOperationResult<T>>(
      (value) => ({ status: "completed", value }),
      () => ({ status: "failed" }),
    );

  try {
    return await Promise.race([result, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function healthCheckBeforeDeadline(
  healthCheck: () => Promise<CleanupHealth>,
  remainingMs: number,
): Promise<BoundedOperationResult<CleanupHealth>> {
  return operationBeforeDeadline(remainingMs, healthCheck);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForRuntimeCleanup(
  timeoutMs: number,
  options: RuntimeCleanupWaitOptions,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let pendingCleanup = false;
    if (options.healthCheck) {
      const result = await healthCheckBeforeDeadline(
        options.healthCheck,
        Math.max(1, deadline - Date.now()),
      );
      if (result.status === "timed_out") return false;
      pendingCleanup =
        result.status === "failed" ||
        (result.status === "completed" &&
          result.value.checks?.cleanup?.details?.lateCleanupPending === true);
    }
    if (!pendingCleanup && !options.hasActiveSessions()) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(100, remainingMs));
  }
  return false;
}
