export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoff: BackoffStrategy;
  readonly jitter: boolean;
  readonly retryableErrorCodes?: readonly string[];
}

// "fail" → the operation fails its turn; "interrupt" → the turn is cancelled (the
// agent stops trying, the call continues). Provider "fallback" is intentionally not
// offered until a real fallback path exists.
export type TimeoutAction = "fail" | "interrupt";

export interface TimeoutPolicy {
  readonly timeoutMs: number;
  readonly onTimeout: TimeoutAction;
}

export type InterruptionMode = "allow" | "ignore" | "graceful";

export interface InterruptionPolicy {
  readonly mode: InterruptionMode;
  readonly minSpeechMs: number;
  readonly trimOutputOnInterrupt: boolean;
}

export interface IdempotencyPolicy {
  readonly enabled: boolean;
  readonly keyTemplate?: string;
  readonly ttlMs?: number;
}
