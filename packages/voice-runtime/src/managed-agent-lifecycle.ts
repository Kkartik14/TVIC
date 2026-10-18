import {
  cancelledError,
  internalError,
  normalizeUnknownError,
  timeoutError,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import type { CleanupErrorSummary, CleanupStage } from "@tvic/runtime";

export interface DeferredValue<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function deferredValue<T>(): DeferredValue<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function nativePromiseFromThenable<T>(value: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      value.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

export function combinedSignal(signals: readonly AbortSignal[]): AbortSignal {
  const active = signals.filter((signal) => signal !== undefined);
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
}

export function timeoutPromise(milliseconds: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), milliseconds);
    timer.unref?.();
  });
}

export function protocolError(): TvicThrowableError {
  return TvicThrowableError.from(
    validationError(
      "voice_runtime.events_already_consumed",
      "The voice event stream has already been claimed by another consumer",
    ),
  );
}

export function startupCancelledError(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("voice_runtime.start_cancelled", "Voice agent startup was cancelled"),
  );
}

export function remoteHangupError(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("voice_runtime.remote_hangup", "The remote caller ended the call"),
  );
}

export function startupTimeoutError(milliseconds: number): TvicThrowableError {
  return TvicThrowableError.from(
    normalizeUnknownError(
      timeoutError(
        "voice_runtime.start_timeout",
        `Voice agent startup exceeded its ${milliseconds}ms deadline`,
      ),
      {
        code: "voice_runtime.start_timeout",
        category: "timeout",
        retriable: false,
      },
    ),
  );
}

export function finalizationDeadlineError(finalizationStarted: boolean): TvicThrowableError {
  return TvicThrowableError.from(
    internalError(
      "voice_runtime.shutdown_failed",
      "A call did not finish finalization before the voice agent shutdown deadline",
      {
        metadata: {
          degraded: true,
          timedOut: true,
          lateCleanupPending: true,
          finalizationStarted,
        },
      },
    ),
  );
}

export function cleanupErrorSummary(stage: CleanupStage, error: unknown): CleanupErrorSummary {
  const normalized = TvicThrowableError.from(error).error;
  return {
    stage,
    code: normalized.code.slice(0, 128),
    message: normalized.message.slice(0, 4096),
  };
}
