import type { Runtime, TerminalToolCall } from "@tvic/core";

/** Small boundary readers kept outside the realtime orchestration class. */
export function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function attachmentAbortReason(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "code" in reason) {
    if ((reason as { readonly code?: unknown }).code === "LEASE_LOST") return "lease_lost";
  }
  return "transport_lost";
}

export async function drainAsyncIterator<T>(
  iterator: AsyncIterator<T>,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    while (!(await iterator.next()).done) {
      // Result-only callers deliberately do not retain event history.
    }
  } catch (error) {
    onError(error);
  }
}

export async function recordToolCall(
  runtime: Runtime,
  result: TerminalToolCall,
  onDegraded: () => void,
): Promise<TerminalToolCall> {
  try {
    await runtime.recordToolCall(result);
    return result;
  } catch (error) {
    onDegraded();
    throw error;
  }
}

export async function startToolCall(
  runtime: Runtime,
  queued: Parameters<Runtime["startToolCall"]>[0],
  onDegraded: () => void,
): ReturnType<Runtime["startToolCall"]> {
  try {
    return await runtime.startToolCall(queued);
  } catch (error) {
    onDegraded();
    throw error;
  }
}

export async function finishToolCall(
  runtime: Runtime,
  result: TerminalToolCall,
  onDegraded: () => void,
): Promise<TerminalToolCall> {
  try {
    await runtime.finishToolCall(result);
    return result;
  } catch (error) {
    onDegraded();
    throw error;
  }
}
