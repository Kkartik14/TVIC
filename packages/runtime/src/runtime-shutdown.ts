export interface PipelineRunRegistration {
  readonly run: Promise<unknown>;
  readonly cancel: () => void;
}

/**
 * Waits for caller-owned pipeline work without making shutdown unbounded.
 * Cancellation is initiated by the runtime before this barrier is entered;
 * this helper only answers whether every registered run settled in time.
 */
export async function drainPipelineRuns(
  registrations: Iterable<PipelineRunRegistration>,
  timeoutMs: number,
): Promise<boolean> {
  const pending = [...registrations].map(({ run }) => run);
  if (pending.length === 0) return true;

  let drained = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending).then(() => {
        drained = true;
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return drained;
}
