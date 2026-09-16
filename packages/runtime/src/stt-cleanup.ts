import { STT_ERROR_CODES, timeoutError, type SttStream } from "@tvic/core";

import { withTimeout } from "./internal/async.js";

export const DEFAULT_STT_CLOSE_TIMEOUT_MS = 1_000;

export interface SttCloseOptions {
  readonly timeoutMs?: number;
  readonly provider?: string;
}

/**
 * Close a provider-owned STT stream without allowing a custom implementation
 * to wedge runtime teardown. Callers choose whether a close failure should be
 * surfaced or treated as best-effort cleanup.
 */
export function closeSttStreamBounded(
  stream: SttStream | undefined,
  options: SttCloseOptions = {},
): Promise<void> {
  if (!stream) return Promise.resolve();
  const timeoutMs = options.timeoutMs ?? DEFAULT_STT_CLOSE_TIMEOUT_MS;
  return withTimeout(
    Promise.resolve().then(() => stream.close()),
    timeoutMs,
    timeoutError(
      STT_ERROR_CODES.closeTimeout,
      `STT provider close timed out after ${timeoutMs}ms`,
      {
        ...(options.provider ? { provider: options.provider } : {}),
        retriable: false,
      },
    ),
  );
}

export function closeSttProviderStreamBounded(
  stream: SttStream | undefined,
  provider: string,
  timeoutMs: number,
): Promise<void> {
  return closeSttStreamBounded(stream, { timeoutMs, provider });
}
