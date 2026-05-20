export type ErrorCategory =
  | "validation"
  | "auth"
  | "provider"
  | "network"
  | "timeout"
  | "rate_limit"
  | "cancelled"
  | "interrupted"
  | "tool"
  | "media"
  | "internal";

export interface NormalizedError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retriable: boolean;
  readonly provider?: string;
  readonly cause?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
