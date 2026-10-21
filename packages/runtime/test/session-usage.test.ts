import { describe, expect, it } from "vitest";
import type { LlmUsageReport } from "@tvic/core";

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
      unit: "tokens",
      notReported: [{ reason: "interrupted", operations: 1 }],
    });
    expect(frozen.entries.find((entry) => entry.kind === "stt")?.metrics.audioMsSent).toEqual({
      status: "not_reported",
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
