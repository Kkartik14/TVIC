import { describe, expect, it } from "vitest";

import type { TelephonyProvider } from "@tvic/core";

import { requireProviderKind, supportsAudioFormat } from "../src/index.js";

const provider: TelephonyProvider = {
  name: "telephony-contract-provider",
  kind: "telephony",
  version: "0.1.0",
  capabilities: {
    streaming: true,
    interruption: true,
    audioFormats: [{ encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 }],
  },
  async dial() {
    throw new Error("not used");
  },
  async accept() {
    throw new Error("not used");
  },
  async hangup() {
    return;
  },
};

describe("provider utilities", () => {
  it("narrows providers by kind", () => {
    expect(requireProviderKind(provider, "telephony")).toBe(provider);
  });

  it("checks normalized audio format support", () => {
    expect(
      supportsAudioFormat(provider, {
        encoding: "pcm_s16le",
        sampleRateHz: 16000,
        channels: 1,
      }),
    ).toBe(true);
  });
});
