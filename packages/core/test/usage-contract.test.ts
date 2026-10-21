import { describe, expect, it } from "vitest";

import {
  MAX_USAGE_OBSERVATION_SAMPLES,
  PROVIDER_ERROR_CODES,
  type LlmUsageReport,
  type ProviderUsageReporter,
  type SessionUsageSummary,
  type TtsUsageReporter,
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

const usageSummary: SessionUsageSummary = { entries: [] };

describe("session usage contracts", () => {
  it("publishes the fixed provider observation sample bound", () => {
    expect(MAX_USAGE_OBSERVATION_SAMPLES).toBe(32);
    expect(PROVIDER_ERROR_CODES.openaiResponseIncomplete).toBe("openai.response.incomplete");
    expect(usageSummary.entries).toEqual([]);
    expect(llmUsage.outputTokens).toEqual({ status: "not_reported", reason: "absent" });
    expect(typeof ttsReporter.reportTextCharacters).toBe("function");
  });
});
