export async function sleepWithAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, milliseconds);
    timer.unref?.();
  });
}
