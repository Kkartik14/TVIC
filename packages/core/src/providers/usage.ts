import type { AudioFormat } from "../audio.js";

/** Maximum number of provider values retained for a non-additive metric. */
export const MAX_USAGE_OBSERVATION_SAMPLES = 32;

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

/** Per-field usage avoids losing valid token counts when a sibling is missing. */
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

/** Provider facts reported through request-scoped core contracts. */
export interface ProviderUsageReporter {
  report(observation: ProviderUsageObservation): void;
  /** Begin a stream/request-scoped metric so a synchronous freeze can mark it interrupted. */
  beginOperation(input: {
    readonly field: string;
    readonly unit: UsageUnit;
    readonly aggregation: "sum" | "observations";
    readonly model?: string;
    readonly modelSource?: UsageModelOrigin;
  }): ProviderUsageOperation;
}

export interface ProviderUsageOperation {
  /** Record one reported value; observation metrics may report several values per operation. */
  report(value: number): void;
  /** Record an unavailable value without ending a multi-observation operation. */
  notReported(reason: Exclude<UsageNotReportedReason, "interrupted">): void;
  /** Close the operation after its normal provider terminal boundary. */
  finish(): void;
}

export interface SttAudioWriteUsageOperation {
  succeeded(): void;
  failed(): void;
}

export interface SttUsageReporter extends ProviderUsageReporter {
  /** Runtime hook called around a physical sendAudio write, including replays. */
  beginAudioWrite(input: {
    readonly byteLength: number;
    readonly format: AudioFormat;
  }): SttAudioWriteUsageOperation;
}

/** Runtime-owned request boundary for reporting TTS text submitted for synthesis. */
export interface TtsUsageReporter extends ProviderUsageReporter {
  reportTextCharacters(codePoints: number): void;
}

export interface TtsUsageAccounting {
  /** The provider reports text submitted through its public synthesis methods. */
  readonly reportsTextCharacters: true;
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
}
