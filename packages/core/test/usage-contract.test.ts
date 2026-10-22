import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_USAGE_ENTRIES,
  MAX_SESSION_USAGE_IDENTIFIER_LENGTH,
  MAX_SESSION_USAGE_METRICS_PER_ENTRY,
  MAX_USAGE_OBSERVATION_SAMPLES,
  countUnicodeCodePoints,
  PROVIDER_ERROR_CODES,
  type LlmUsageReport,
  type ProviderUsageReporter,
  type SessionUsageSummary,
  type TtsUsageAccounting,
  type TtsUsageReporter,
  type UsageMetric,
} from "../src/index.js";

const llmUsage: LlmUsageReport = {
  inputTokens: { status: "reported", value: 4 },
  outputTokens: { status: "not_reported", reason: "absent" },
  cachedTokens: { status: "reported", value: 2 },
};

const providerReporter: ProviderUsageReporter = {
  report(observation) {
    void observation.field;
    void observation.aggregation;
    if (observation.status === "reported") void observation.value;
  },
  beginOperation() {
    return { report() {}, notReported() {}, finish() {} };
  },
};

const ttsReporter: TtsUsageReporter = {
  ...providerReporter,
  reportTextCharacters(codePoints) {
    void codePoints;
  },
};

const ttsUsageAccounting: TtsUsageAccounting = {
  reportsTextCharacters: true,
  usesRequestModelForUsage: true,
};

const usageSummary: SessionUsageSummary = { entries: [] };
const truncatedUsageSummary: SessionUsageSummary = { entries: [], truncated: true };
const missingProviderMetric: UsageMetric = {
  status: "not_reported",
  source: "provider",
  unit: "tokens",
  notReported: [{ reason: "absent", operations: 1 }],
};

describe("session usage contracts", () => {
  it("counts Unicode code points without changing the character definition", () => {
    expect(countUnicodeCodePoints("A🌍𝄞")).toBe(3);
  });

  it("publishes the fixed provider observation sample bound", () => {
    expect(MAX_USAGE_OBSERVATION_SAMPLES).toBe(32);
    expect(MAX_SESSION_USAGE_ENTRIES).toBe(128);
    expect(MAX_SESSION_USAGE_METRICS_PER_ENTRY).toBe(32);
    expect(MAX_SESSION_USAGE_IDENTIFIER_LENGTH).toBe(128);
    expect(PROVIDER_ERROR_CODES.openaiResponseIncomplete).toBe("openai.response.incomplete");
    expect(usageSummary.entries).toEqual([]);
    expect(truncatedUsageSummary.truncated).toBe(true);
    expect(llmUsage.outputTokens).toEqual({ status: "not_reported", reason: "absent" });
    expect(missingProviderMetric.source).toBe("provider");
    expect(typeof ttsReporter.reportTextCharacters).toBe("function");
    expect(ttsUsageAccounting.usesRequestModelForUsage).toBe(true);
  });
});
