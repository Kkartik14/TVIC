import {
  MAX_USAGE_OBSERVATION_SAMPLES,
  type AudioFormat,
  type LlmUsage,
  type LlmUsageReport,
  type ProviderUsageField,
  type ProviderUsageObservation,
  type ProviderUsageOperation,
  type SessionUsageEntry,
  type SessionUsageSummary,
  type UsageModelOrigin,
  type UsageMetric,
  type UsageNotReportedReason,
  type UsageUnit,
} from "@tvic/core";

const UNKNOWN_MODEL = "unknown";
const MISSING_REASON_ORDER: readonly UsageNotReportedReason[] = [
  "absent",
  "invalid",
  "unsupported",
  "interrupted",
];
const LLM_USAGE_FIELDS = ["inputTokens", "outputTokens", "cachedTokens"] as const;
const CLOSED_PROVIDER_USAGE_OPERATION: ProviderUsageOperation = Object.freeze({
  report() {},
  notReported() {},
  finish() {},
});
const CLOSED_TTS_AUDIO_OPERATION: TtsAudioUsageOperation = Object.freeze({
  record() {},
  finish() {},
});

type UsageKind = SessionUsageEntry["kind"];
type ModelSource = UsageModelOrigin;
type MetricAggregation = "sum" | "observations";

interface MutableMetric {
  readonly source: "provider" | "runtime";
  readonly unit: UsageUnit;
  readonly aggregation: MetricAggregation;
  value: number;
  observedOperations: number;
  observationCount: number;
  minimum: number;
  maximum: number;
  readonly sample: number[];
  readonly missing: Map<UsageNotReportedReason, number>;
  pending: number;
}

interface MutableEntry {
  readonly kind: UsageKind;
  readonly provider: string;
  readonly model: string;
  modelSource: ModelSource;
  readonly metrics: Map<string, MutableMetric>;
}

interface LlmRequestResult {
  readonly usageReport?: LlmUsageReport;
  readonly usage?: LlmUsage;
}

export interface LlmUsageOperation {
  finish(result?: LlmRequestResult): void;
}

export interface SttAudioWriteOperation {
  succeeded(): void;
  failed(): void;
}

export interface SttAudioWriteInput {
  readonly provider: string;
  readonly model?: string;
  readonly modelSource?: ModelSource;
  readonly format: AudioFormat;
  readonly byteLength: number;
}

export interface TtsAudioInput {
  readonly format: AudioFormat;
  readonly byteLength: number;
}

export interface TtsAudioUsageOperation {
  record(input: TtsAudioInput): void;
  finish(): void;
}

export class SessionUsageAccumulator {
  readonly #entries = new Map<string, MutableEntry>();
  #snapshot: SessionUsageSummary | undefined;

  beginLlmRequest(input: {
    readonly provider: string;
    readonly model?: string;
    readonly modelSource?: ModelSource;
  }): LlmUsageOperation {
    const entry = this.#entry(
      "llm",
      input.provider,
      input.model,
      input.modelSource ?? (input.model ? "request" : "not_reported"),
    );
    this.#addValue(entry, "requestCount", "runtime", "requests", 1);
    for (const field of LLM_USAGE_FIELDS) {
      this.#metric(entry, field, "provider", "tokens", "sum").pending += 1;
    }

    let finished = false;
    return {
      finish: (result) => {
        if (finished || this.#snapshot) return;
        finished = true;
        for (const field of LLM_USAGE_FIELDS) {
          const metric = this.#metric(entry, field, "provider", "tokens", "sum");
          metric.pending = Math.max(0, metric.pending - 1);
          const reported = this.#llmField(result, field);
          this.#applyProviderField(metric, reported);
        }
      },
    };
  }

  beginSttAudioWrite(input: SttAudioWriteInput): SttAudioWriteOperation {
    const entry = this.#entry(
      "stt",
      input.provider,
      input.model,
      input.modelSource ?? (input.model ? "request" : "not_reported"),
    );
    const metric = this.#metric(entry, "audioMsSent", "runtime", "milliseconds", "sum");
    metric.pending += 1;
    const durationMs = audioDurationMs(input.byteLength, input.format);
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled || this.#snapshot) return;
      settled = true;
      metric.pending = Math.max(0, metric.pending - 1);
      if (success && durationMs !== null)
        this.#addValue(entry, "audioMsSent", "runtime", "milliseconds", durationMs);
    };
    return { succeeded: () => settle(true), failed: () => settle(false) };
  }

  reportProviderUsage(
    kind: UsageKind,
    provider: string,
    observation: ProviderUsageObservation,
    requestModel?: string,
    modelSourceOverride?: ModelSource,
  ): void {
    if (this.#snapshot) return;
    const entry = this.#entry(
      kind,
      provider,
      observation.model ?? requestModel,
      (observation.modelSource === "provider_reported"
        ? "provider_reported"
        : (modelSourceOverride ?? observation.modelSource)) ??
        (observation.model ? "configured" : requestModel ? "request" : "not_reported"),
    );
    const metric = this.#metric(
      entry,
      observation.field,
      "provider",
      observation.unit,
      observation.aggregation,
    );
    this.#applyProviderObservation(metric, observation);
  }

  beginProviderUsage(
    kind: UsageKind,
    provider: string,
    input: {
      readonly field: string;
      readonly unit: UsageUnit;
      readonly aggregation: MetricAggregation;
      readonly model?: string;
      readonly modelSource?: ModelSource;
    },
    requestModel?: string,
  ): ProviderUsageOperation {
    if (this.#snapshot) return CLOSED_PROVIDER_USAGE_OPERATION;
    const model = input.model ?? requestModel;
    const entry = this.#entry(
      kind,
      provider,
      model,
      input.modelSource ?? (input.model ? "configured" : requestModel ? "request" : "not_reported"),
    );
    const metric = this.#metric(entry, input.field, "provider", input.unit, input.aggregation);
    metric.pending += 1;
    let finished = false;
    return {
      report: (value) => {
        if (finished || this.#snapshot) return;
        this.#applyProviderObservation(metric, {
          field: input.field,
          status: "reported",
          value,
          unit: input.unit,
          aggregation: input.aggregation,
        });
      },
      notReported: (reason) => {
        if (finished || this.#snapshot) return;
        this.#addMissing(metric, reason);
      },
      finish: () => {
        if (finished || this.#snapshot) return;
        finished = true;
        metric.pending = Math.max(0, metric.pending - 1);
      },
    };
  }

  recordTtsTextCharacters(
    provider: string,
    model: string | undefined,
    text: string,
    modelSource: ModelSource = model ? "request" : "not_reported",
  ): void {
    this.reportTtsTextCharacters(provider, model, [...text].length, modelSource);
  }

  reportTtsTextCharacters(
    provider: string,
    model: string | undefined,
    codePoints: number,
    modelSource: ModelSource = model ? "request" : "not_reported",
  ): void {
    if (this.#snapshot || !Number.isSafeInteger(codePoints) || codePoints < 0) return;
    this.#addValue(
      this.#entry("tts", provider, model, modelSource),
      "charactersSent",
      "runtime",
      "unicode_code_points",
      codePoints,
    );
  }

  beginTtsAudio(
    provider: string,
    model: string | undefined,
    modelSource: ModelSource = model ? "request" : "not_reported",
  ): TtsAudioUsageOperation {
    if (this.#snapshot) return CLOSED_TTS_AUDIO_OPERATION;
    const entry = this.#entry("tts", provider, model, modelSource);
    const metric = this.#metric(entry, "audioMsReceived", "runtime", "milliseconds", "sum");
    metric.pending += 1;
    let finished = false;
    let observed = false;
    return {
      record: (input) => {
        if (finished || this.#snapshot) return;
        const durationMs = audioDurationMs(input.byteLength, input.format);
        if (durationMs === null || !Number.isFinite(metric.value + durationMs)) {
          this.#addMissing(metric, "invalid");
          return;
        }
        metric.value += durationMs;
        if (!observed) {
          observed = true;
          metric.observedOperations += 1;
        }
      },
      finish: () => {
        if (finished || this.#snapshot) return;
        finished = true;
        metric.pending = Math.max(0, metric.pending - 1);
        if (!observed) this.#addMissing(metric, "absent");
      },
    };
  }

  freeze(): SessionUsageSummary {
    if (this.#snapshot) return this.#snapshot;
    const entries: SessionUsageEntry[] = [];
    for (const entry of this.#entries.values()) {
      const metrics: Record<string, UsageMetric> = {};
      for (const [name, metric] of entry.metrics) {
        if (metric.pending > 0) this.#addMissing(metric, "interrupted", metric.pending);
        metric.pending = 0;
        const summarized = summarizeMetric(metric);
        if (summarized) metrics[name] = freezeUsageMetric(summarized);
      }
      if (Object.keys(metrics).length === 0) continue;
      entries.push(
        Object.freeze({
          kind: entry.kind,
          provider: entry.provider,
          model: entry.model,
          modelSource: entry.modelSource,
          metrics: Object.freeze(metrics),
        }),
      );
    }
    entries.sort((left, right) =>
      `${left.kind}\0${left.provider}\0${left.model}`.localeCompare(
        `${right.kind}\0${right.provider}\0${right.model}`,
      ),
    );
    this.#snapshot = Object.freeze({ entries: Object.freeze(entries) });
    return this.#snapshot;
  }

  #llmField(
    result: LlmRequestResult | undefined,
    field: (typeof LLM_USAGE_FIELDS)[number],
  ): ProviderUsageField {
    const report = result?.usageReport;
    if (report) {
      if (field === "cachedTokens" && report.cachedTokens.status === "reported") {
        const input = report.inputTokens;
        if (input.status === "reported" && report.cachedTokens.value > input.value) {
          return { status: "not_reported", reason: "invalid" };
        }
      }
      const value = report[field];
      if (value.status === "reported" && !validTokenCount(value.value)) {
        return { status: "not_reported", reason: "invalid" };
      }
      return value;
    }
    const legacy = result?.usage;
    if (!legacy) return { status: "not_reported", reason: "absent" };
    const value = legacy[field];
    if (field === "cachedTokens" && value === undefined) {
      return { status: "not_reported", reason: "absent" };
    }
    return validTokenCount(value)
      ? { status: "reported", value }
      : { status: "not_reported", reason: "invalid" };
  }

  #applyProviderField(metric: MutableMetric, field: ProviderUsageField): void {
    if (field.status === "not_reported") {
      this.#addMissing(metric, field.reason);
    } else if (!validTokenCount(field.value) || !Number.isSafeInteger(metric.value + field.value)) {
      this.#addMissing(metric, "invalid");
    } else {
      metric.value += field.value;
      metric.observedOperations += 1;
    }
  }

  #applyProviderObservation(metric: MutableMetric, observation: ProviderUsageObservation): void {
    if (observation.status === "not_reported") {
      this.#addMissing(metric, observation.reason);
      return;
    }
    if (!validNumber(observation.value)) {
      this.#addMissing(metric, "invalid");
      return;
    }
    if (observation.aggregation === "observations") {
      metric.observationCount += 1;
      metric.minimum = Math.min(metric.minimum, observation.value);
      metric.maximum = Math.max(metric.maximum, observation.value);
      if (metric.sample.length < MAX_USAGE_OBSERVATION_SAMPLES) {
        metric.sample.push(observation.value);
      }
      return;
    }
    if (!Number.isFinite(metric.value + observation.value)) {
      this.#addMissing(metric, "invalid");
      return;
    }
    metric.value += observation.value;
    metric.observedOperations += 1;
  }

  #addValue(
    entry: MutableEntry,
    name: string,
    source: "provider" | "runtime",
    unit: UsageUnit,
    value: number,
  ): void {
    if (this.#snapshot) return;
    const metric = this.#metric(entry, name, source, unit, "sum");
    if (!validNumber(value) || !Number.isFinite(metric.value + value)) {
      this.#addMissing(metric, "invalid");
      return;
    }
    metric.value += value;
    metric.observedOperations += 1;
  }

  #metric(
    entry: MutableEntry,
    name: string,
    source: "provider" | "runtime",
    unit: UsageUnit,
    aggregation: MetricAggregation,
  ): MutableMetric {
    let metric = entry.metrics.get(name);
    if (!metric) {
      metric = {
        source,
        unit,
        aggregation,
        value: 0,
        observedOperations: 0,
        observationCount: 0,
        minimum: Number.POSITIVE_INFINITY,
        maximum: Number.NEGATIVE_INFINITY,
        sample: [],
        missing: new Map(),
        pending: 0,
      };
      entry.metrics.set(name, metric);
    }
    return metric;
  }

  #entry(
    kind: UsageKind,
    provider: string,
    model: string | undefined,
    modelSource: ModelSource,
  ): MutableEntry {
    const normalizedModel = validModel(model) ? model : UNKNOWN_MODEL;
    const key = `${kind}\0${provider}\0${normalizedModel}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = {
        kind,
        provider,
        model: normalizedModel,
        modelSource: normalizedModel === UNKNOWN_MODEL ? "not_reported" : modelSource,
        metrics: new Map(),
      };
      this.#entries.set(key, entry);
    } else if (modelSourceRank(modelSource) > modelSourceRank(entry.modelSource)) {
      entry.modelSource = modelSource;
    }
    return entry;
  }

  #addMissing(metric: MutableMetric, reason: UsageNotReportedReason, operations = 1): void {
    metric.missing.set(reason, (metric.missing.get(reason) ?? 0) + operations);
  }
}

function summarizeMetric(metric: MutableMetric): UsageMetric | undefined {
  const notReported = MISSING_REASON_ORDER.flatMap((reason) => {
    const operations = metric.missing.get(reason) ?? 0;
    return operations > 0 ? [{ reason, operations }] : [];
  });
  const missingOperations = notReported.reduce((total, row) => total + row.operations, 0);
  if (metric.aggregation === "observations") {
    if (metric.observationCount === 0) {
      return missingOperations > 0
        ? { status: "not_reported", unit: metric.unit, notReported }
        : undefined;
    }
    return {
      status: "reported_observations",
      source: "provider",
      unit: metric.unit,
      observationCount: metric.observationCount,
      minimum: metric.minimum,
      maximum: metric.maximum,
      sample: Object.freeze([...metric.sample]),
      truncatedCount: metric.observationCount - metric.sample.length,
      notReported: Object.freeze(notReported),
    };
  }
  if (metric.observedOperations === 0) {
    return missingOperations > 0
      ? { status: "not_reported", unit: metric.unit, notReported }
      : undefined;
  }
  if (missingOperations > 0) {
    return {
      status: "partial",
      source: metric.source,
      unit: metric.unit,
      value: metric.value,
      observedOperations: metric.observedOperations,
      notReported: Object.freeze(notReported),
    };
  }
  return metric.source === "runtime"
    ? { status: "measured", source: "runtime", unit: metric.unit, value: metric.value }
    : { status: "reported", source: "provider", unit: metric.unit, value: metric.value };
}

function freezeUsageMetric(metric: UsageMetric): UsageMetric {
  if (!("notReported" in metric)) return Object.freeze({ ...metric });
  return Object.freeze({
    ...metric,
    notReported: Object.freeze(
      metric.notReported.map((operation) => Object.freeze({ ...operation })),
    ),
    ...(metric.status === "reported_observations"
      ? { sample: Object.freeze([...metric.sample]) }
      : {}),
  });
}

function audioDurationMs(byteLength: number, format: AudioFormat): number | null {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return null;
  const bytesPerSample = format.encoding === "pcm_f32le" ? 4 : 2;
  const sampleCount = byteLength / (bytesPerSample * format.channels);
  const durationMs = (sampleCount / format.sampleRateHz) * 1_000;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

function validNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function validModel(model: string | undefined): model is string {
  return typeof model === "string" && model.length > 0;
}

function modelSourceRank(source: ModelSource): number {
  switch (source) {
    case "provider_reported":
      return 3;
    case "request":
      return 2;
    case "configured":
      return 1;
    case "not_reported":
      return 0;
  }
}
