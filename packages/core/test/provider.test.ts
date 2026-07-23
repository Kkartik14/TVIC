import { describe, expect, it } from "vitest";

import {
  PCM16_16K_MONO,
  evaluateProviderCompatibility,
  sameAudioFormat,
  type Provider,
} from "../src/index.js";

const provider = {
  name: "test-realtime",
  kind: "realtime_model",
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
        kind: "realtime_model",
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
    expect(result.issues.map(({ code, requirement }) => ({ code, requirement }))).toEqual([
      { code: "kind.unsupported", requirement: "kind" },
      { code: "cancellation.unsupported", requirement: "cancellation.buffer" },
      { code: "playout.unsupported", requirement: "playout.acknowledgement" },
      { code: "transport.unsupported", requirement: "transport" },
      { code: "audio.output_unsupported", requirement: "outputFormat" },
      { code: "language.unsupported", requirement: "language" },
      { code: "model.unsupported", requirement: "model" },
      { code: "voice.unsupported", requirement: "voice" },
      { code: "turn_detection.unsupported", requirement: "turn_detection" },
      { code: "region.unsupported", requirement: "region" },
      { code: "data_policy.unsupported", requirement: "data_policy" },
      { code: "tools.unsupported", requirement: "parallelToolCalls" },
      { code: "call_control.unsupported", requirement: "callControl.outbound" },
    ]);
  });

  it("does not require optional capabilities when a requirement is false or absent", () => {
    expect(
      evaluateProviderCompatibility(provider, {
        kind: "realtime_model",
        streaming: { input: false },
        cancellation: { buffer: false },
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
