export type RecoveryTimingState =
  | "healthy"
  | "recovering"
  | "opening"
  | "probationary"
  | "failed"
  | "closed";

export interface RecoveryAwareTimingOptions {
  readonly now: () => number;
  readonly endpointTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly onEndpoint: () => void;
}

/**
 * Owns synthetic endpoint deadlines and the semantic clock used by speech
 * qualification. Caller-facing latency remains on PipelineVoiceLoop's wall clock;
 * this clock stops while a provider generation is recovering.
 */
export class RecoveryAwareTiming {
  readonly #now: () => number;
  readonly #endpointTimeoutMs: number;
  readonly #maxDurationMs: number;
  readonly #onEndpoint: () => void;
  #state: RecoveryTimingState = "healthy";
  #recoveryStartedAtMs: number | null = null;
  #recoveryElapsedMs = 0;
  #endpointTimer: ReturnType<typeof setTimeout> | null = null;
  #endpointStartedAtActiveMs: number | null = null;
  #endpointRemainingMs: number | null = null;
  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #durationStartedAtActiveMs: number | null = null;
  #durationRemainingMs: number | null = null;

  constructor(options: RecoveryAwareTimingOptions) {
    this.#now = options.now;
    this.#endpointTimeoutMs = options.endpointTimeoutMs;
    this.#maxDurationMs = options.maxDurationMs;
    this.#onEndpoint = options.onEndpoint;
  }

  get isHealthy(): boolean {
    return this.#state === "healthy";
  }

  /**
   * Waits for a predicate or an amount of active semantic time. Recovery and
   * probationary wall time do not consume the budget. This is intentionally a
   * small polling seam: transcript events can satisfy the predicate without
   * needing a second event bus, while the active clock remains authoritative.
   */
  async waitForActive(
    predicate: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const startedAtMs = this.activeNow();
    while (!predicate()) {
      if (signal?.aborted || this.#state === "failed" || this.#state === "closed") {
        return false;
      }
      const remainingMs = timeoutMs - Math.max(0, this.activeNow() - startedAtMs);
      if (remainingMs <= 0) {
        return false;
      }
      await waitForWallOrAbort(Math.min(remainingMs, 5), signal);
    }
    return true;
  }

  activeNow(): number {
    const now = this.#now();
    const recoveryNow =
      this.#recoveryStartedAtMs === null ? 0 : Math.max(0, now - this.#recoveryStartedAtMs);
    return now - this.#recoveryElapsedMs - recoveryNow;
  }

  setState(state: RecoveryTimingState, hasBufferedTranscript: boolean): void {
    const previous = this.#state;
    if (previous === state) {
      return;
    }
    const wasRecovering = previous !== "healthy";
    const isRecovering = state !== "healthy";
    this.#state = state;
    if (!wasRecovering && isRecovering) {
      this.#recoveryStartedAtMs = this.#now();
      this.#pauseTimers();
    } else if (wasRecovering && !isRecovering) {
      if (this.#recoveryStartedAtMs !== null) {
        this.#recoveryElapsedMs += Math.max(0, this.#now() - this.#recoveryStartedAtMs);
      }
      this.#recoveryStartedAtMs = null;
      if (state === "healthy" && hasBufferedTranscript) {
        this.#endpointRemainingMs ??= this.#endpointTimeoutMs;
        this.#durationRemainingMs ??= this.#maxDurationMs;
        this.#scheduleTimers();
      }
    } else if (isRecovering) {
      this.#pauseTimers();
    }
  }

  armEndpointTimers(hasBufferedTranscript: boolean): void {
    if (!hasBufferedTranscript || !this.isHealthy) {
      return;
    }
    this.#cancelEndpointTimer(false);
    this.#endpointRemainingMs = this.#endpointTimeoutMs;
    this.#durationRemainingMs ??= this.#maxDurationMs;
    this.#scheduleTimers();
  }

  cancelEndpointTimer(): void {
    this.#cancelEndpointTimer(true);
  }

  cancelEndpointTimers(): void {
    this.#cancelEndpointTimer(true);
    this.#cancelDurationTimer(true);
  }

  #scheduleTimers(): void {
    if (!this.isHealthy) {
      return;
    }
    if (this.#endpointRemainingMs !== null && !this.#endpointTimer) {
      this.#endpointStartedAtActiveMs = this.activeNow();
      this.#endpointTimer = setTimeout(() => {
        if (!this.isHealthy) {
          this.#pauseTimers();
          return;
        }
        this.#cancelEndpointTimer(true);
        this.#onEndpoint();
      }, this.#endpointRemainingMs);
    }
    if (this.#durationRemainingMs !== null && !this.#durationTimer) {
      this.#durationStartedAtActiveMs = this.activeNow();
      this.#durationTimer = setTimeout(() => {
        if (!this.isHealthy) {
          this.#pauseTimers();
          return;
        }
        this.cancelEndpointTimers();
        this.#onEndpoint();
      }, this.#durationRemainingMs);
    }
  }

  #pauseTimers(): void {
    this.#cancelEndpointTimer(false);
    this.#cancelDurationTimer(false);
  }

  #cancelEndpointTimer(reset: boolean): void {
    if (this.#endpointTimer) {
      const elapsed =
        this.#endpointStartedAtActiveMs === null
          ? 0
          : Math.max(0, this.activeNow() - this.#endpointStartedAtActiveMs);
      this.#endpointRemainingMs = Math.max(0, (this.#endpointRemainingMs ?? 0) - elapsed);
      clearTimeout(this.#endpointTimer);
      this.#endpointTimer = null;
      this.#endpointStartedAtActiveMs = null;
    }
    if (reset) {
      this.#endpointRemainingMs = null;
    }
  }

  #cancelDurationTimer(reset: boolean): void {
    if (this.#durationTimer) {
      const elapsed =
        this.#durationStartedAtActiveMs === null
          ? 0
          : Math.max(0, this.activeNow() - this.#durationStartedAtActiveMs);
      this.#durationRemainingMs = Math.max(0, (this.#durationRemainingMs ?? 0) - elapsed);
      clearTimeout(this.#durationTimer);
      this.#durationTimer = null;
      this.#durationStartedAtActiveMs = null;
    }
    if (reset) {
      this.#durationRemainingMs = null;
    }
  }
}

function waitForWallOrAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => finish();

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
