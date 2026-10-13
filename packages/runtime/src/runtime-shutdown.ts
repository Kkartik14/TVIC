import type { DurableRuntimeStore } from "@tvic/core";

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

export async function closeRuntimeDurableStore(
  ownership: "runtime" | "caller",
  store: DurableRuntimeStore,
): Promise<void> {
  if (ownership !== "runtime") return;
  if (store.close) {
    await store.close();
    return;
  }
  const components = [store.sessions, store.turns, store.toolCalls, store.leases];
  const unique = [...new Set(components)];
  await Promise.all(unique.map((component) => component.close()));
}

export async function waitForFinalizersAndClose(
  finalizers: Set<Promise<unknown>>,
  beforeClose: () => void,
  close: () => Promise<void>,
): Promise<void> {
  while (finalizers.size > 0) {
    await Promise.allSettled([...finalizers]);
  }
  beforeClose();
  await close();
}
