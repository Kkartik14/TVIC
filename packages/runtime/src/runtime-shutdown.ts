export interface PipelineRunRegistration {
  readonly run: Promise<unknown>;
  readonly cancel: () => void;
}

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
