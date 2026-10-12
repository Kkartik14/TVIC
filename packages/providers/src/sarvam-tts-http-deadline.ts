import { PROVIDER_NAMES, TVIC_ERROR_CODES, timeoutError, TvicThrowableError } from "@tvic/core";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SarvamTtsHttpDeadline {
  readonly onResponseProgress: () => void;
  readonly dispose: () => void;
  readonly timeoutError: () => TvicThrowableError | undefined;
}

export function createSarvamTtsHttpDeadline(
  controller: AbortController,
  requestTimeoutMs: number,
  responseIdleTimeoutMs: number,
): SarvamTtsHttpDeadline {
  let disposed = false;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutReason: TvicThrowableError | undefined;

  const abortForTimeout = (phase: "request" | "response_idle", timeoutMs: number): void => {
    if (disposed || controller.signal.aborted) return;
    timeoutReason = TvicThrowableError.from(
      timeoutError(
        TVIC_ERROR_CODES.providerTransportTimeout,
        `Sarvam TTS ${phase === "request" ? "request" : "response"} timed out after ${timeoutMs}ms`,
        {
          provider: PROVIDER_NAMES.sarvamTts,
          retriable: false,
          metadata: { timeoutPhase: phase, timeoutMs, outcomeUnknown: true },
        },
      ),
    );
    controller.abort(timeoutReason);
  };

  const onResponseProgress = (): void => {
    if (disposed || controller.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortForTimeout("response_idle", responseIdleTimeoutMs),
      responseIdleTimeoutMs,
    );
    idleTimer.unref?.();
  };

  if (!controller.signal.aborted) {
    requestTimer = setTimeout(() => abortForTimeout("request", requestTimeoutMs), requestTimeoutMs);
    requestTimer.unref?.();
  }

  return {
    onResponseProgress,
    timeoutError: () => timeoutReason,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (requestTimer) clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
  };
}

export function assertSarvamTtsHttpTimeout(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`Sarvam TTS ${name} must be an integer from 1 to ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}
