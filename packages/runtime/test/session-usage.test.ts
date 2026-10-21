import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_USAGE_ENTRIES,
  MAX_SESSION_USAGE_IDENTIFIER_LENGTH,
  MAX_SESSION_USAGE_METRICS_PER_ENTRY,
  type AudioFormat,
  type LlmUsageReport,
} from "@tvic/core";

import { SessionUsageAccumulator } from "../src/session-usage.js";

const report = (input: number, output: number, cached: number): LlmUsageReport => ({
  inputTokens: { status: "reported", value: input },
  outputTokens: { status: "reported", value: output },
  cachedTokens: { status: "reported", value: cached },
});

describe("session usage accumulator", () => {
  it("counts every LLM pass and preserves per-field missing coverage", () => {
    const usage = new SessionUsageAccumulator();
    usage
      .beginLlmRequest({ provider: "groq", model: "llama" })
      .finish({ usageReport: report(7, 4, 2) });
    usage.beginLlmRequest({ provider: "groq", model: "llama" }).finish({
      usageReport: {
        inputTokens: { status: "reported", value: 3 },
        outputTokens: { status: "not_reported", reason: "absent" },
        cachedTokens: { status: "reported", value: 1 },
      },
    });

    const summary = usage.freeze();
    const metrics = summary.entries[0]?.metrics;
    expect(metrics?.requestCount).toEqual({
      status: "measured",
      source: "runtime",
      unit: "requests",
      value: 2,
    });
    expect(metrics?.inputTokens).toMatchObject({ status: "reported", value: 10 });
    expect(metrics?.cachedTokens).toMatchObject({ status: "reported", value: 3 });
    expect(metrics?.outputTokens).toMatchObject({
      status: "partial",
      value: 4,
      observedOperations: 1,
      notReported: [{ reason: "absent", operations: 1 }],
    });
  });

  it("continues frozen usage without losing missing coverage or observation order", () => {
    const previous = new SessionUsageAccumulator();
    previous.beginLlmRequest({ provider: "groq", model: "llama" }).finish({
      usageReport: report(12, 4, 2),
    });
    previous.reportProviderUsage("stt", "cartesia", {
      field: "streamDurationMs",
      status: "reported",
      value: 100,
      unit: "milliseconds",
      aggregation: "observations",
      model: "ink",
    });
    previous.freeze();

    previous.resume();
    previous.beginLlmRequest({ provider: "groq", model: "llama" }).finish({
      usageReport: {
        inputTokens: { status: "reported", value: 99 },
        outputTokens: { status: "not_reported", reason: "absent" },
        cachedTokens: { status: "not_reported", reason: "absent" },
      },
    });
    previous.reportProviderUsage("stt", "cartesia", {
      field: "streamDurationMs",
      status: "reported",
      value: 250,
      unit: "milliseconds",
      aggregation: "observations",
      model: "ink",
    });
    const summary = previous.freeze();
    const llmMetrics = summary.entries.find((entry) => entry.kind === "llm")?.metrics;
    const sttMetrics = summary.entries.find((entry) => entry.kind === "stt")?.metrics;

    expect(llmMetrics?.requestCount).toMatchObject({ status: "measured", value: 2 });
    expect(llmMetrics?.inputTokens).toMatchObject({ status: "reported", value: 111 });
    expect(llmMetrics?.outputTokens).toMatchObject({
      status: "partial",
      value: 4,
      observedOperations: 1,
      notReported: [{ reason: "absent", operations: 1 }],
    });
    expect(llmMetrics?.cachedTokens).toMatchObject({
      status: "partial",
      value: 2,
      observedOperations: 1,
      notReported: [{ reason: "absent", operations: 1 }],
    });
    expect(sttMetrics?.streamDurationMs).toMatchObject({
      status: "reported_observations",
      observationCount: 2,
      minimum: 100,
      maximum: 250,
      sample: [100, 250],
      truncatedCount: 0,
    });
  });

  it("carries late provider usage into a resumed accumulator after freeze", () => {
    const previous = new SessionUsageAccumulator();
    const request = previous.beginLlmRequest({ provider: "openai", model: "gpt-4.1" });
    const write = previous.beginSttAudioWrite({
      provider: "deepgram",
      byteLength: 320,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    const providerUsage = previous.beginProviderUsage("stt", "cartesia", {
      field: "streamDurationMs",
      unit: "milliseconds",
      aggregation: "sum",
      model: "ink",
    });
    const audio = previous.beginTtsAudio("cartesia", "sonic-2");
    previous.freeze();

    previous.resume();
    request.finish({ usageReport: report(9, 3, 2) });
    write.succeeded();
    providerUsage.report(750);
    providerUsage.finish();
    audio.record({
      byteLength: 320,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    audio.finish();

    const summary = previous.freeze();
    const llmMetrics = summary.entries.find((entry) => entry.kind === "llm")?.metrics;
    const deepgramMetrics = summary.entries.find((entry) => entry.provider === "deepgram")?.metrics;
    const cartesiaSttMetrics = summary.entries.find(
      (entry) => entry.kind === "stt" && entry.provider === "cartesia",
    )?.metrics;
    const cartesiaTtsMetrics = summary.entries.find((entry) => entry.kind === "tts")?.metrics;
    expect(llmMetrics?.requestCount).toMatchObject({ status: "measured", value: 1 });
    expect(llmMetrics?.inputTokens).toEqual({
      status: "reported",
      source: "provider",
      unit: "tokens",
      value: 9,
    });
    expect(llmMetrics?.outputTokens).toMatchObject({ status: "reported", value: 3 });
    expect(llmMetrics?.cachedTokens).toMatchObject({ status: "reported", value: 2 });
    expect(deepgramMetrics?.audioMsSent).toMatchObject({ status: "measured", value: 10 });
    expect(cartesiaSttMetrics?.streamDurationMs).toMatchObject({
      status: "reported",
      value: 750,
    });
    expect(cartesiaTtsMetrics?.audioMsReceived).toMatchObject({
      status: "measured",
      value: 10,
    });
  });

  it("clears only the provider operation's interrupted count when it finishes late", () => {
    const previous = new SessionUsageAccumulator();
    const first = previous.beginProviderUsage("stt", "cartesia", {
      field: "streamDurationMs",
      unit: "milliseconds",
      aggregation: "observations",
      model: "ink",
    });
    first.report(100);
    previous.freeze();

    previous.resume();
    first.finish();

    const metric = previous.freeze().entries[0]?.metrics.streamDurationMs;
    expect(metric).toMatchObject({
      status: "reported_observations",
      observationCount: 1,
      notReported: [],
    });
  });

  it("does not let repeated late provider reports clear another operation's interruption", () => {
    const previous = new SessionUsageAccumulator();
    const first = previous.beginProviderUsage("stt", "sarvam", {
      field: "audioDurationMs",
      unit: "milliseconds",
      aggregation: "observations",
      model: "saarika",
    });
    const second = previous.beginProviderUsage("stt", "sarvam", {
      field: "audioDurationMs",
      unit: "milliseconds",
      aggregation: "observations",
      model: "saarika",
    });
    previous.freeze();

    previous.resume();
    first.report(100);
    first.report(110);
    first.finish();

    expect(previous.freeze().entries[0]?.metrics.audioDurationMs).toMatchObject({
      status: "reported_observations",
      observationCount: 2,
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
    second.finish();
  });

  it("keeps late usage forwarding bounded across repeated reattachments", () => {
    const original = new SessionUsageAccumulator();
    const request = original.beginLlmRequest({ provider: "openai", model: "gpt-4.1" });

    for (let index = 0; index < 4096; index += 1) {
      original.freeze();
      original.resume();
    }

    request.finish({ usageReport: report(9, 3, 2) });

    const metrics = original.freeze().entries[0]?.metrics;
    expect(metrics?.inputTokens).toMatchObject({ status: "reported", value: 9 });
    expect(metrics?.cachedTokens).toMatchObject({ status: "reported", value: 2 });
  });

  it("marks legacy cached-token usage invalid when it exceeds input tokens", () => {
    const usage = new SessionUsageAccumulator();
    usage.beginLlmRequest({ provider: "custom-llm", model: "model" }).finish({
      usage: { inputTokens: 4, outputTokens: 2, cachedTokens: 5 },
    });

    const metrics = usage.freeze().entries[0]?.metrics;

    expect(metrics?.inputTokens).toMatchObject({ status: "reported", value: 4 });
    expect(metrics?.cachedTokens).toEqual({
      status: "not_reported",
      source: "provider",
      unit: "tokens",
      notReported: [{ reason: "invalid", operations: 1 }],
    });
  });

  it("attributes each LLM request to its provider-reported model", () => {
    const usage = new SessionUsageAccumulator();
    const request = usage.beginLlmRequest({
      provider: "openai-responses",
      model: "gpt-alias",
      modelSource: "request",
    });
    request.finish({
      providerModel: "gpt-effective",
      usageReport: report(8, 3, 2),
    });

    const summary = usage.freeze();

    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({
      kind: "llm",
      provider: "openai-responses",
      model: "gpt-effective",
      modelSource: "provider_reported",
      metrics: {
        requestCount: { status: "measured", value: 1 },
        inputTokens: { status: "reported", value: 8 },
        outputTokens: { status: "reported", value: 3 },
        cachedTokens: { status: "reported", value: 2 },
      },
    });
  });

  it("keeps a provider-reported unknown model separate from a missing model", () => {
    const usage = new SessionUsageAccumulator();
    usage.beginLlmRequest({ provider: "custom-llm", model: "requested-model" }).finish({
      providerModel: "unknown",
      usageReport: report(8, 3, 2),
    });
    usage.beginLlmRequest({ provider: "custom-llm" }).finish({
      usageReport: report(5, 2, 1),
    });

    const entries = usage.freeze().entries;

    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "llm",
        provider: "custom-llm",
        model: "unknown",
        modelSource: "provider_reported",
        metrics: expect.objectContaining({
          requestCount: expect.objectContaining({ value: 1 }),
          inputTokens: expect.objectContaining({ value: 8 }),
        }),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: "llm",
        provider: "custom-llm",
        model: "unknown",
        modelSource: "not_reported",
        metrics: expect.objectContaining({
          requestCount: expect.objectContaining({ value: 1 }),
          inputTokens: expect.objectContaining({ value: 5 }),
        }),
      }),
    );
  });

  it("bounds dynamic model and provider metric cardinality and marks truncated summaries", () => {
    const usage = new SessionUsageAccumulator();
    for (let index = 0; index < MAX_SESSION_USAGE_ENTRIES * 2; index += 1) {
      usage.beginLlmRequest({ provider: "openai-responses", model: "requested-model" }).finish({
        providerModel: `dynamic-model-${index}`,
        usageReport: report(1, 1, 0),
      });
    }
    const metricsUsage = new SessionUsageAccumulator();
    metricsUsage.reportProviderUsage("stt", "custom-stt", {
      field: "__proto__",
      status: "reported",
      value: 1,
      unit: "provider_defined",
      aggregation: "sum",
    });
    for (let index = 0; index < MAX_SESSION_USAGE_METRICS_PER_ENTRY + 8; index += 1) {
      metricsUsage.reportProviderUsage("stt", "custom-stt", {
        field: `customMetric${index}`,
        status: "reported",
        value: index,
        unit: "provider_defined",
        aggregation: "sum",
      });
    }

    const summary = usage.freeze();
    const requestedUsage = summary.entries.find((entry) => entry.model === "requested-model");

    expect(summary.entries.length).toBeLessThanOrEqual(MAX_SESSION_USAGE_ENTRIES);
    expect(summary).toMatchObject({ truncated: true });
    expect(requestedUsage?.modelSource).toBe("request");
    expect(requestedUsage?.metrics.requestCount).toMatchObject({
      status: "measured",
      value: 129,
    });
    expect(requestedUsage?.metrics.inputTokens).toMatchObject({
      status: "reported",
      value: 129,
    });
    expect(requestedUsage?.metrics.outputTokens).toMatchObject({
      status: "reported",
      value: 129,
    });
    expect(requestedUsage?.metrics.cachedTokens).toMatchObject({
      status: "reported",
      value: 0,
    });
    const metricsSummary = metricsUsage.freeze();
    const metrics = metricsSummary.entries[0]?.metrics ?? {};
    expect(Object.keys(metrics)).toHaveLength(MAX_SESSION_USAGE_METRICS_PER_ENTRY);
    expect(Object.hasOwn(metrics, "__proto__")).toBe(true);
    expect(metricsSummary).toMatchObject({ truncated: true });
  });

  it("rejects overlong usage identities and metric names without retaining them", () => {
    const usage = new SessionUsageAccumulator();
    usage.beginLlmRequest({ provider: "openai-responses", model: "requested-model" }).finish({
      providerModel: "x".repeat(MAX_SESSION_USAGE_IDENTIFIER_LENGTH + 1),
      usageReport: report(1, 1, 0),
    });
    usage.reportProviderUsage("stt", "custom-stt", {
      field: "x".repeat(MAX_SESSION_USAGE_IDENTIFIER_LENGTH + 1),
      status: "reported",
      value: 5,
      unit: "provider_defined",
      aggregation: "sum",
    });
    usage.reportProviderUsage("stt", "p".repeat(MAX_SESSION_USAGE_IDENTIFIER_LENGTH + 1), {
      field: "validMetric",
      status: "reported",
      value: 5,
      unit: "provider_defined",
      aggregation: "sum",
    });

    const summary = usage.freeze();

    const requestedUsage = summary.entries.find((entry) => entry.model === "requested-model");
    expect(requestedUsage?.metrics.requestCount).toMatchObject({ value: 1 });
    expect(requestedUsage?.metrics.inputTokens).toMatchObject({ status: "reported", value: 1 });
    expect(requestedUsage?.metrics.outputTokens).toMatchObject({ status: "reported", value: 1 });
    expect(requestedUsage?.metrics.cachedTokens).toMatchObject({ status: "reported", value: 0 });
    expect(summary.entries.map((entry) => entry.model)).not.toContain(
      "x".repeat(MAX_SESSION_USAGE_IDENTIFIER_LENGTH + 1),
    );
    expect(summary.entries.map((entry) => entry.provider)).not.toContain(
      "p".repeat(MAX_SESSION_USAGE_IDENTIFIER_LENGTH + 1),
    );
    expect(summary).toMatchObject({ truncated: true });
  });

  it("marks an incomplete STT PCM frame invalid instead of reporting fractional time", () => {
    const usage = new SessionUsageAccumulator();
    const write = usage.beginSttAudioWrite({
      provider: "custom-stt",
      model: "request-model",
      byteLength: 1,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    write.succeeded();

    expect(usage.freeze().entries[0]?.metrics.audioMsSent).toEqual({
      status: "not_reported",
      source: "runtime",
      unit: "milliseconds",
      notReported: [{ reason: "invalid", operations: 1 }],
    });
  });

  it("marks incomplete TTS PCM frames invalid instead of reporting fractional time", () => {
    const usage = new SessionUsageAccumulator();
    const audio = usage.beginTtsAudio("custom-tts", "request-model");
    audio.record({
      byteLength: 1,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    audio.finish();

    expect(usage.freeze().entries[0]?.metrics.audioMsReceived).toEqual({
      status: "not_reported",
      source: "runtime",
      unit: "milliseconds",
      notReported: [{ reason: "invalid", operations: 1 }],
    });
  });

  it("marks an interrupted TTS stream without audio as interrupted", () => {
    const usage = new SessionUsageAccumulator();
    const audio = usage.beginTtsAudio("custom-tts", "request-model");
    audio.interrupt();
    audio.finish();

    expect(usage.freeze().entries[0]?.metrics.audioMsReceived).toEqual({
      status: "not_reported",
      source: "runtime",
      unit: "milliseconds",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "marks malformed TTS character count %s invalid",
    (codePoints) => {
      const usage = new SessionUsageAccumulator();
      usage.reportTtsTextCharacters("custom-tts", "request-model", codePoints);

      expect(usage.freeze().entries[0]?.metrics.charactersSent).toEqual({
        status: "not_reported",
        source: "runtime",
        unit: "unicode_code_points",
        notReported: [{ reason: "invalid", operations: 1 }],
      });
    },
  );

  it.each([
    {
      byteLength: 32_000,
      format: null,
    },
    {
      byteLength: 32_000,
      format: { encoding: "pcm_s16le", sampleRateHz: 1, channels: 1 },
    },
    {
      byteLength: 32_000,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 3 },
    },
  ])("marks TTS audio with an unsupported format invalid", ({ byteLength, format }) => {
    const usage = new SessionUsageAccumulator();
    const audio = usage.beginTtsAudio("custom-tts", "request-model");
    audio.record({ byteLength, format: format as unknown as AudioFormat });
    audio.finish();

    expect(usage.freeze().entries[0]?.metrics.audioMsReceived).toEqual({
      status: "not_reported",
      source: "runtime",
      unit: "milliseconds",
      notReported: [{ reason: "invalid", operations: 1 }],
    });
  });

  it("marks an STT write with an unsupported sample rate invalid", () => {
    const usage = new SessionUsageAccumulator();
    const write = usage.beginSttAudioWrite({
      provider: "custom-stt",
      model: "request-model",
      byteLength: 32_000,
      format: { encoding: "pcm_s16le", sampleRateHz: 1, channels: 1 } as unknown as AudioFormat,
    });
    write.succeeded();

    expect(usage.freeze().entries[0]?.metrics.audioMsSent).toEqual({
      status: "not_reported",
      source: "runtime",
      unit: "milliseconds",
      notReported: [{ reason: "invalid", operations: 1 }],
    });
  });

  it("keeps provider and model identities distinct when they contain separators", () => {
    const usage = new SessionUsageAccumulator();
    usage.reportProviderUsage(
      "stt",
      "custom\u0000provider",
      {
        field: "durationMs",
        status: "reported",
        value: 1,
        unit: "milliseconds",
        aggregation: "sum",
      },
      "model",
    );
    usage.reportProviderUsage(
      "stt",
      "custom",
      {
        field: "durationMs",
        status: "reported",
        value: 2,
        unit: "milliseconds",
        aggregation: "sum",
      },
      "provider\u0000model",
    );

    const summary = usage.freeze();

    expect(summary.entries).toHaveLength(2);
    expect(summary.entries.map(({ provider, model }) => [provider, model])).toEqual(
      expect.arrayContaining([
        ["custom\u0000provider", "model"],
        ["custom", "provider\u0000model"],
      ]),
    );
  });

  it("marks a field invalid when provider and runtime metadata conflict", () => {
    for (const scenario of [
      { providerFirst: false, unit: "milliseconds" as const, aggregation: "sum" as const },
      { providerFirst: true, unit: "milliseconds" as const, aggregation: "sum" as const },
      { providerFirst: false, unit: "provider_defined" as const, aggregation: "sum" as const },
      { providerFirst: false, unit: "milliseconds" as const, aggregation: "observations" as const },
    ]) {
      const usage = new SessionUsageAccumulator();
      const reportProviderMetric = (): void => {
        usage.reportProviderUsage(
          "stt",
          "custom-stt",
          {
            field: "audioMsSent",
            status: "reported",
            value: 5,
            unit: scenario.unit,
            aggregation: scenario.aggregation,
          },
          "custom-model",
        );
      };
      const measureRuntimeAudio = (): void => {
        const operation = usage.beginSttAudioWrite({
          provider: "custom-stt",
          model: "custom-model",
          byteLength: 32_000,
          format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
        });
        operation.succeeded();
      };

      if (scenario.providerFirst) reportProviderMetric();
      measureRuntimeAudio();
      if (!scenario.providerFirst) reportProviderMetric();

      expect(usage.freeze().entries[0]?.metrics.audioMsSent).toEqual({
        status: "not_reported",
        source: scenario.providerFirst ? "provider" : "runtime",
        unit: "provider_defined",
        notReported: [{ reason: "invalid", operations: 2 }],
      });
    }
  });

  it("preserves configured model provenance for provider usage", () => {
    const usage = new SessionUsageAccumulator();
    const stream = usage.beginProviderUsage("stt", "deepgram", {
      field: "providerAudioMs",
      unit: "milliseconds",
      aggregation: "sum",
      model: "nova-3",
      modelSource: "configured",
    });
    stream.report(100);
    stream.finish();

    expect(usage.freeze().entries[0]?.modelSource).toBe("configured");
  });

  it("measures successful PCM writes and bounds provider observations", () => {
    const usage = new SessionUsageAccumulator();
    const write = usage.beginSttAudioWrite({
      provider: "deepgram",
      model: "nova-3",
      byteLength: 32_000,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });
    write.succeeded();
    for (let value = 1; value <= 35; value += 1) {
      usage.reportProviderUsage(
        "stt",
        "deepgram",
        {
          field: "streamDurationMs",
          status: "reported",
          value,
          unit: "milliseconds",
          aggregation: "observations",
        },
        "nova-3",
      );
    }

    const summary = usage.freeze();
    const metrics = summary.entries[0]?.metrics;
    expect(metrics?.audioMsSent).toEqual({
      status: "measured",
      source: "runtime",
      unit: "milliseconds",
      value: 1_000,
    });
    expect(metrics?.streamDurationMs).toMatchObject({
      status: "reported_observations",
      observationCount: 35,
      minimum: 1,
      maximum: 35,
      sample: Array.from({ length: 32 }, (_value, index) => index + 1),
      truncatedCount: 3,
    });
  });

  it("marks unresolved operations interrupted and ignores late reports after freeze", () => {
    const usage = new SessionUsageAccumulator();
    const request = usage.beginLlmRequest({ provider: "openai", model: "gpt-4.1" });
    const write = usage.beginSttAudioWrite({
      provider: "deepgram",
      byteLength: 320,
      format: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    });

    const frozen = usage.freeze();
    request.finish({ usageReport: report(9, 3, 0) });
    write.succeeded();
    expect(usage.freeze()).toBe(frozen);
    expect(frozen.entries.find((entry) => entry.kind === "llm")?.metrics.inputTokens).toEqual({
      status: "not_reported",
      source: "provider",
      unit: "tokens",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
    expect(frozen.entries.find((entry) => entry.kind === "stt")?.metrics.audioMsSent).toEqual({
      status: "not_reported",
      source: "runtime",
      unit: "milliseconds",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
  });

  it("returns a deeply immutable frozen snapshot", () => {
    const usage = new SessionUsageAccumulator();
    usage
      .beginLlmRequest({ provider: "groq", model: "llama" })
      .finish({ usageReport: report(7, 4, 2) });

    const snapshot = usage.freeze();
    const entry = snapshot.entries[0]!;
    const metric = entry.metrics.inputTokens!;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metrics)).toBe(true);
    expect(Object.isFrozen(metric)).toBe(true);
  });

  it("marks provider stream observations interrupted when a synchronous freeze wins", () => {
    const usage = new SessionUsageAccumulator();
    const streamUsage = usage.beginProviderUsage("stt", "cartesia", {
      field: "providerStreamDurationMs",
      unit: "milliseconds",
      aggregation: "observations",
      model: "sonic-2",
    });
    streamUsage.report(120);

    const frozen = usage.freeze();
    streamUsage.report(180);
    streamUsage.finish();

    expect(frozen.entries[0]?.metrics.providerStreamDurationMs).toEqual({
      status: "reported_observations",
      source: "provider",
      unit: "milliseconds",
      observationCount: 1,
      minimum: 120,
      maximum: 120,
      sample: [120],
      truncatedCount: 0,
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
  });

  it("marks an open TTS audio stream interrupted while preserving received audio", () => {
    const usage = new SessionUsageAccumulator();
    const audio = usage.beginTtsAudio("cartesia", "sonic-2");
    audio.record({
      byteLength: 48_000,
      format: { encoding: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
    });

    const frozen = usage.freeze();

    expect(frozen.entries[0]?.metrics.audioMsReceived).toEqual({
      status: "partial",
      source: "runtime",
      unit: "milliseconds",
      value: 1_000,
      observedOperations: 1,
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
  });

  it("records runtime TTS text and received PCM without inventing missing metrics", () => {
    const usage = new SessionUsageAccumulator();
    usage.recordTtsTextCharacters("cartesia", "sonic-2", "hello 🌍");
    const audio = usage.beginTtsAudio("cartesia", "sonic-2");
    audio.record({
      byteLength: 48_000,
      format: { encoding: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
    });
    audio.finish();

    const summary = usage.freeze();
    const metrics = summary.entries[0]?.metrics;
    expect(metrics?.charactersSent).toEqual({
      status: "measured",
      source: "runtime",
      unit: "unicode_code_points",
      value: 7,
    });
    expect(metrics?.audioMsReceived).toMatchObject({
      status: "measured",
      source: "runtime",
      unit: "milliseconds",
      value: 1_000,
    });
    expect(metrics?.vendorDurationMs).toBeUndefined();
  });
});
