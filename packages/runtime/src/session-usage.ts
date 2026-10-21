import {
  MAX_USAGE_OBSERVATION_SAMPLES,
  MAX_SESSION_USAGE_ENTRIES,
  MAX_SESSION_USAGE_IDENTIFIER_LENGTH,
  MAX_SESSION_USAGE_METRICS_PER_ENTRY,
  countUnicodeCodePoints,
  isSampleRateHz,
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
  unit: UsageUnit;
  readonly aggregation: MetricAggregation;
  invalid: boolean;
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
  readonly providerModel?: string;
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

const CLOSED_LLM_USAGE_OPERATION: LlmUsageOperation = Object.freeze({ finish() {} });
const CLOSED_STT_AUDIO_WRITE_OPERATION: SttAudioWriteOperation = Object.freeze({
  succeeded() {},
  failed() {},
});

export class SessionUsageAccumulator {
  readonly #entries = new Map<string, MutableEntry>();
  #snapshot: SessionUsageSummary | undefined;
  #truncated = false;

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
    if (!entry) return CLOSED_LLM_USAGE_OPERATION;
    this.#addValue(entry, "requestCount", "runtime", "requests", 1);
    for (const field of LLM_USAGE_FIELDS) {
      const metric = this.#metric(entry, field, "provider", "tokens", "sum");
      if (metric) metric.pending += 1;
    }

    let finished = false;
    return {
      finish: (result) => {
        if (finished || this.#snapshot) return;
        finished = true;
        const providerModelEntry =
          typeof result?.providerModel === "string" && result.providerModel.trim().length > 0
            ? this.#entry("llm", input.provider, result.providerModel, "provider_reported")
            : undefined;
        if (
          typeof result?.providerModel === "string" &&
          result.providerModel.trim().length > 0 &&
          !providerModelEntry
        ) {
          const requestCount = entry.metrics.get("requestCount");
          if (requestCount && !requestCount.invalid) {
            requestCount.value -= 1;
            requestCount.observedOperations -= 1;
          }
          for (const field of LLM_USAGE_FIELDS) {
            const metric = entry.metrics.get(field);
            if (metric && !metric.invalid) metric.pending = Math.max(0, metric.pending - 1);
          }
          return;
        }
        const resolvedEntry = providerModelEntry ?? entry;
        if (resolvedEntry !== entry) {
          const requestCount = entry.metrics.get("requestCount");
          if (requestCount && !requestCount.invalid) {
            requestCount.value -= 1;
            requestCount.observedOperations -= 1;
          }
          this.#addValue(resolvedEntry, "requestCount", "runtime", "requests", 1);
        }
        for (const field of LLM_USAGE_FIELDS) {
          const pendingMetric = entry.metrics.get(field);
          if (!pendingMetric || pendingMetric.invalid) continue;
          pendingMetric.pending = Math.max(0, pendingMetric.pending - 1);
          const metric =
            resolvedEntry === entry
              ? pendingMetric
              : this.#metric(resolvedEntry, field, "provider", "tokens", "sum");
          if (!metric) continue;
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
    if (!entry) return CLOSED_STT_AUDIO_WRITE_OPERATION;
    const metric = this.#metric(entry, "audioMsSent", "runtime", "milliseconds", "sum");
    if (!metric) return CLOSED_STT_AUDIO_WRITE_OPERATION;
    metric.pending += 1;
    const durationMs = audioDurationMs(input.byteLength, input.format);
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled || this.#snapshot || metric.invalid) return;
      settled = true;
      metric.pending = Math.max(0, metric.pending - 1);
      if (!success) return;
      if (durationMs === null) {
        this.#addMissing(metric, "invalid");
      } else {
        this.#addValue(entry, "audioMsSent", "runtime", "milliseconds", durationMs);
      }
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
    if (!entry) return;
    const metric = this.#metric(
      entry,
      observation.field,
      "provider",
      observation.unit,
      observation.aggregation,
    );
    if (!metric) return;
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
    if (!entry) return CLOSED_PROVIDER_USAGE_OPERATION;
    const metric = this.#metric(entry, input.field, "provider", input.unit, input.aggregation);
    if (!metric) return CLOSED_PROVIDER_USAGE_OPERATION;
    metric.pending += 1;
    let finished = false;
    return {
      report: (value) => {
        if (finished || this.#snapshot || metric.invalid) return;
        this.#applyProviderObservation(metric, {
          field: input.field,
          status: "reported",
          value,
          unit: input.unit,
          aggregation: input.aggregation,
        });
      },
      notReported: (reason) => {
        if (finished || this.#snapshot || metric.invalid) return;
        this.#addMissing(metric, reason);
      },
      finish: () => {
        if (finished || this.#snapshot || metric.invalid) return;
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
    this.reportTtsTextCharacters(provider, model, countUnicodeCodePoints(text), modelSource);
  }

  reportTtsTextCharacters(
    provider: string,
    model: string | undefined,
    codePoints: number,
    modelSource: ModelSource = model ? "request" : "not_reported",
  ): void {
    if (this.#snapshot) return;
    const entry = this.#entry("tts", provider, model, modelSource);
    if (!entry) return;
    if (!Number.isSafeInteger(codePoints) || codePoints < 0) {
      const metric = this.#metric(entry, "charactersSent", "runtime", "unicode_code_points", "sum");
      if (metric) this.#addMissing(metric, "invalid");
      return;
    }
    this.#addValue(entry, "charactersSent", "runtime", "unicode_code_points", codePoints);
  }

  beginTtsAudio(
    provider: string,
    model: string | undefined,
    modelSource: ModelSource = model ? "request" : "not_reported",
  ): TtsAudioUsageOperation {
    if (this.#snapshot) return CLOSED_TTS_AUDIO_OPERATION;
    const entry = this.#entry("tts", provider, model, modelSource);
    if (!entry) return CLOSED_TTS_AUDIO_OPERATION;
    const metric = this.#metric(entry, "audioMsReceived", "runtime", "milliseconds", "sum");
    if (!metric) return CLOSED_TTS_AUDIO_OPERATION;
    metric.pending += 1;
    let finished = false;
    let observed = false;
    let received = false;
    return {
      record: (input) => {
        if (finished || this.#snapshot || metric.invalid) return;
        received = true;
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
        if (finished || this.#snapshot || metric.invalid) return;
        finished = true;
        metric.pending = Math.max(0, metric.pending - 1);
        if (!received) this.#addMissing(metric, "absent");
      },
    };
  }

  freeze(): SessionUsageSummary {
    if (this.#snapshot) return this.#snapshot;
    const entries: SessionUsageEntry[] = [];
    for (const entry of this.#entries.values()) {
      const metrics = Object.create(null) as Record<string, UsageMetric>;
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
    this.#snapshot = Object.freeze({
      entries: Object.freeze(entries),
      ...(this.#truncated ? { truncated: true as const } : {}),
    });
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
    if (field === "cachedTokens") {
      if (value === undefined) return { status: "not_reported", reason: "absent" };
      if (!validTokenCount(legacy.inputTokens) || value > legacy.inputTokens) {
        return { status: "not_reported", reason: "invalid" };
      }
    }
    return validTokenCount(value)
      ? { status: "reported", value }
      : { status: "not_reported", reason: "invalid" };
  }

  #applyProviderField(metric: MutableMetric, field: ProviderUsageField): void {
    if (metric.invalid) return;
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
    if (metric.invalid) return;
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
    if (!metric) return;
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
  ): MutableMetric | undefined {
    let metric = entry.metrics.get(name);
    if (metric) {
      if (metric.invalid) return undefined;
      if (metric.source !== source || metric.unit !== unit || metric.aggregation !== aggregation) {
        const priorOperations =
          metric.observedOperations +
          metric.observationCount +
          metric.pending +
          [...metric.missing.values()].reduce((total, count) => total + count, 0);
        metric.invalid = true;
        metric.unit = "provider_defined";
        metric.value = 0;
        metric.observedOperations = 0;
        metric.observationCount = 0;
        metric.minimum = Number.POSITIVE_INFINITY;
        metric.maximum = Number.NEGATIVE_INFINITY;
        metric.sample.length = 0;
        metric.missing.clear();
        metric.missing.set("invalid", Math.min(Number.MAX_SAFE_INTEGER, priorOperations + 1));
        metric.pending = 0;
        return undefined;
      }
      return metric;
    }

    if (
      name.length === 0 ||
      name.length > MAX_SESSION_USAGE_IDENTIFIER_LENGTH ||
      entry.metrics.size >= MAX_SESSION_USAGE_METRICS_PER_ENTRY
    ) {
      this.#truncated = true;
      return undefined;
    }
    metric = {
      source,
      unit,
      aggregation,
      invalid: false,
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
    return metric;
  }

  #entry(
    kind: UsageKind,
    provider: string,
    model: string | undefined,
    modelSource: ModelSource,
  ): MutableEntry | undefined {
    if (
      provider.length === 0 ||
      provider.length > MAX_SESSION_USAGE_IDENTIFIER_LENGTH ||
      (model !== undefined && model.length > MAX_SESSION_USAGE_IDENTIFIER_LENGTH)
    ) {
      this.#truncated = true;
      return undefined;
    }
    const normalizedModel = validModel(model) ? model : UNKNOWN_MODEL;
    const key = `${kind.length}:${kind}${provider.length}:${provider}${normalizedModel.length}:${normalizedModel}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= MAX_SESSION_USAGE_ENTRIES) {
        this.#truncated = true;
        return undefined;
      }
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
  if (metric.invalid) {
    return {
      status: "not_reported",
      source: metric.source,
      unit: "provider_defined",
      notReported: [{ reason: "invalid", operations: metric.missing.get("invalid") ?? 1 }],
    };
  }
  const notReported = MISSING_REASON_ORDER.flatMap((reason) => {
    const operations = metric.missing.get(reason) ?? 0;
    return operations > 0 ? [{ reason, operations }] : [];
  });
  const missingOperations = notReported.reduce((total, row) => total + row.operations, 0);
  if (metric.aggregation === "observations") {
    if (metric.observationCount === 0) {
      return missingOperations > 0
        ? { status: "not_reported", source: metric.source, unit: metric.unit, notReported }
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
      ? { status: "not_reported", source: metric.source, unit: metric.unit, notReported }
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
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    format === null ||
    typeof format !== "object"
  ) {
    return null;
  }
  const bytesPerSample =
    format.encoding === "pcm_f32le"
      ? 4
      : format.encoding === "pcm_s16le" || format.encoding === "pcm_s16be"
        ? 2
        : 0;
  const bytesPerFrame = bytesPerSample * format.channels;
  if (
    bytesPerSample === 0 ||
    (format.channels !== 1 && format.channels !== 2) ||
    !isSampleRateHz(format.sampleRateHz) ||
    byteLength % bytesPerFrame !== 0
  ) {
    return null;
  }
  const sampleCount = byteLength / bytesPerFrame;
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
