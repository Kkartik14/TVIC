export type BackoffStrategy = "fixed" | "linear" | "exponential";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoff: BackoffStrategy;
  readonly jitter: boolean;
  readonly retryableErrorCodes?: readonly string[];
}

export type TimeoutAction = "fail" | "interrupt" | "fallback";

export interface TimeoutPolicy {
  readonly timeoutMs: number;
  readonly onTimeout: TimeoutAction;
}

export type InterruptionMode = "allow" | "ignore" | "graceful";

export interface InterruptionPolicy {
  readonly mode: InterruptionMode;
  readonly minSpeechMs: number;
  readonly cancelOutputOnInterrupt: boolean;
  readonly trimOutputOnInterrupt: boolean;
  readonly resumePartialOnEnd: boolean;
}

export interface IdempotencyPolicy {
  readonly enabled: boolean;
  readonly keyTemplate?: string;
  readonly ttlMs?: number;
}

export interface FallbackPolicy {
  readonly enabled: boolean;
  readonly providers: readonly string[];
  readonly maxFallbacks: number;
}
