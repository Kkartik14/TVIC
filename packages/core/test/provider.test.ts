import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  evaluateProviderCompatibility,
  sameAudioFormat,
  type Provider,
} from "../src/index.js";

const provider = {
  name: "test-tts",
  kind: "tts",
  version: "1.0.0",
  region: "in",
  capabilities: {
    streaming: { input: true, output: true, native: true },
    cancellation: { request: true, output: true, buffer: false, truncation: true },
    transports: ["websocket", "webrtc"],
    audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
    languages: ["en", "hi"],
    models: ["voice-1"],
    voices: ["calm"],
    turnDetection: ["provider", "manual"],
    tools: { functionCalling: true, parallelCalls: false },
    playout: { clearBuffer: false, acknowledgement: false, position: true },
    regions: ["in"],
    dataPolicies: ["zero_retention"],
  },
} as const satisfies Provider;

describe("provider capability negotiation", () => {
  it("accepts a provider only when all hard requirements are met", () => {
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        streaming: { input: true, output: true, native: true },
        cancellation: { request: true, truncation: true },
        transport: "websocket",
        inputFormat: PCM16_16K_MONO,
        outputFormat: PCM16_16K_MONO,
        language: "hi",
        model: "voice-1",
        voice: "calm",
        turnDetection: "provider",
        functionCalling: true,
        playout: { position: true },
        region: "in",
        dataPolicy: "zero_retention",
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("returns every incompatibility with a stable code and requirement path", () => {
    const result = evaluateProviderCompatibility(provider, {
      kind: "stt",
      streaming: { output: true },
      cancellation: { buffer: true },
      transport: "sip",
      outputFormat: { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
      language: "fr",
      model: "voice-2",
      voice: "bright",
      turnDetection: "semantic",
      parallelToolCalls: true,
      playout: { acknowledgement: true },
      callControl: ["outbound"],
      region: "eu",
      dataPolicy: "no_training",
    });

    expect(result.compatible).toBe(false);
    expect(result.issues.map(({ code, requirement }) => `${code}:${requirement}`).sort()).toEqual(
      [
        "audio.output_unsupported:outputFormat",
        "call_control.unsupported:callControl.outbound",
        "cancellation.unsupported:cancellation.buffer",
        "data_policy.unsupported:data_policy",
        "kind.unsupported:kind",
        "language.unsupported:language",
        "model.unsupported:model",
        "playout.unsupported:playout.acknowledgement",
        "region.unsupported:region",
        "tools.unsupported:parallelToolCalls",
        "transport.unsupported:transport",
        "turn_detection.unsupported:turn_detection",
        "voice.unsupported:voice",
      ].sort(),
    );
  });

  it("does not require omitted optional capabilities", () => {
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "tts",
        functionCalling: false,
        parallelToolCalls: false,
      }),
    ).toEqual({ compatible: true, issues: [] });
  });

  it("compares normalized audio formats by encoding, rate, and channels", () => {
    expect(sameAudioFormat(PCM16_16K_MONO, { ...PCM16_16K_MONO, frameDurationMs: 20 })).toBe(true);
    expect(
      sameAudioFormat(PCM16_16K_MONO, {
        encoding: "pcm_s16le",
        sampleRateHz: 24000,
        channels: 1,
      }),
    ).toBe(false);
  });
});
