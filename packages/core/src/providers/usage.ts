import type { AudioFormat } from "../audio.js";

export const MAX_USAGE_OBSERVATION_SAMPLES = 32;
export const MAX_SESSION_USAGE_ENTRIES = 128;
export const MAX_SESSION_USAGE_METRICS_PER_ENTRY = 32;
export const MAX_SESSION_USAGE_IDENTIFIER_LENGTH = 128;

export function countUnicodeCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    const second = value.charCodeAt(index + 1);
    if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
      index += 1;
    }
    count += 1;
  }
  return count;
}

export type UsageUnit =
  | "requests"
  | "tokens"
  | "milliseconds"
  | "unicode_code_points"
  | "provider_defined";

export type UsageNotReportedReason = "absent" | "invalid" | "unsupported" | "interrupted";
export type UsageModelSource = "provider_reported" | "request" | "configured";
export type UsageModelOrigin = UsageModelSource | "not_reported";

export interface MissingUsageOperation {
  readonly reason: UsageNotReportedReason;
  readonly operations: number;
}

export type ProviderUsageField =
  | { readonly status: "reported"; readonly value: number }
  | { readonly status: "not_reported"; readonly reason: "absent" | "invalid" };

export interface LlmUsageReport {
  readonly inputTokens: ProviderUsageField;
  readonly outputTokens: ProviderUsageField;
  readonly cachedTokens: ProviderUsageField;
}

export type ProviderUsageObservation =
  | {
      readonly field: string;
      readonly status: "reported";
      readonly value: number;
      readonly unit: UsageUnit;
      readonly aggregation: "sum" | "observations";
      readonly model?: string;
      readonly modelSource?: UsageModelSource;
    }
  | {
      readonly field: string;
      readonly status: "not_reported";
      readonly reason: "absent" | "invalid" | "unsupported";
      readonly unit: UsageUnit;
      readonly aggregation: "sum" | "observations";
      readonly model?: string;
      readonly modelSource?: UsageModelSource;
    };

export interface ProviderUsageReporter {
  report(observation: ProviderUsageObservation): void;
  beginOperation(input: {
    readonly field: string;
    readonly unit: UsageUnit;
    readonly aggregation: "sum" | "observations";
    readonly model?: string;
    readonly modelSource?: UsageModelOrigin;
  }): ProviderUsageOperation;
}

export interface ProviderUsageOperation {
  report(value: number): void;
  notReported(reason: Exclude<UsageNotReportedReason, "interrupted">): void;
  finish(): void;
}

export interface SttAudioWriteUsageOperation {
  succeeded(): void;
  failed(): void;
}

export interface SttUsageReporter extends ProviderUsageReporter {
  beginAudioWrite(input: {
    readonly byteLength: number;
    readonly format: AudioFormat;
  }): SttAudioWriteUsageOperation;
}

export interface SttUsageAccounting {
  readonly reportsAudioWrites: true;
}

export interface TtsUsageReporter extends ProviderUsageReporter {
  reportTextCharacters(codePoints: number): void;
}

export interface TtsUsageAccounting {
  readonly reportsTextCharacters: true;
  readonly usesRequestModelForUsage?: true;
}

export type UsageMetric =
  | {
      readonly status: "measured";
      readonly source: "runtime";
      readonly unit: UsageUnit;
      readonly value: number;
    }
  | {
      readonly status: "reported";
      readonly source: "provider";
      readonly unit: UsageUnit;
      readonly value: number;
    }
  | {
      readonly status: "partial";
      readonly source: "provider" | "runtime";
      readonly unit: UsageUnit;
      readonly value: number;
      readonly observedOperations: number;
      readonly notReported: readonly MissingUsageOperation[];
    }
  | {
      readonly status: "reported_observations";
      readonly source: "provider";
      readonly unit: UsageUnit;
      readonly observationCount: number;
      readonly minimum: number;
      readonly maximum: number;
      readonly sample: readonly number[];
      readonly truncatedCount: number;
      readonly notReported: readonly MissingUsageOperation[];
    }
  | {
      readonly status: "not_reported";
      readonly source: "provider" | "runtime";
      readonly unit: UsageUnit;
      readonly notReported: readonly MissingUsageOperation[];
    };

export interface SessionUsageEntry {
  readonly kind: "llm" | "stt" | "tts";
  readonly provider: string;
  readonly model: string;
  readonly modelSource: UsageModelOrigin;
  readonly metrics: Readonly<Record<string, UsageMetric>>;
}

export interface SessionUsageSummary {
  readonly entries: readonly SessionUsageEntry[];
  readonly truncated?: true;
}
