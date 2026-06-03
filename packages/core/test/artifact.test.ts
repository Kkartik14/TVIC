import { describe, expect, it } from "vitest";

import {
  isReconstructableAudioFormat,
  isSampleRateHz,
  parseCallArtifactManifest,
} from "../src/index.js";

const valid = {
  version: "0.1.0",
  callId: "call_1",
  createdAt: "2026-05-20T00:00:00.000Z",
  updatedAt: "2026-05-20T00:00:01.000Z",
  files: { trace: "call.jsonl", manifest: "manifest.json" },
  privacy: { consentMode: "record", persistAudio: true, redactPii: false },
  payloads: [],
  writeFailures: 0,
};

describe("parseCallArtifactManifest", () => {
  it("accepts a valid manifest, with identity optional", () => {
    const legacyWithoutIdentity = parseCallArtifactManifest(valid);
    expect(legacyWithoutIdentity.ok).toBe(true);
    if (legacyWithoutIdentity.ok) {
      expect(legacyWithoutIdentity.manifest.integrity).toBe("incomplete");
    }
    const withIdentity = parseCallArtifactManifest({ ...valid, sessionId: "s", traceId: "t" });
    expect(withIdentity.ok).toBe(true);
    if (withIdentity.ok) {
      expect(withIdentity.manifest.integrity).toBe("complete");
    }
  });

  it("rejects malformed manifests with a reason (never throws or trusts them)", () => {
    expect(parseCallArtifactManifest(null).ok).toBe(false);
    expect(parseCallArtifactManifest("nope").ok).toBe(false);
    // The exact bug the audit called out: a string writeFailures must not pass.
    expect(parseCallArtifactManifest({ ...valid, writeFailures: "0" }).ok).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, writeFailures: null }).ok).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, callId: "" }).ok).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, privacy: undefined }).ok).toBe(false);
    expect(
      parseCallArtifactManifest({ ...valid, privacy: { ...valid.privacy, consentMode: "yes" } }).ok,
    ).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, payloads: "[]" }).ok).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, sessionId: 5 }).ok).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, traceId: "" }).ok).toBe(false);
    expect(parseCallArtifactManifest({ ...valid, integrity: "complete" }).ok).toBe(false);
    expect(
      parseCallArtifactManifest({
        ...valid,
        sessionId: "s",
        traceId: "t",
        files: { trace: "call.jsonl", manifest: "manifest.json", inputAudio: "output.pcm" },
      }).ok,
    ).toBe(false);
    const result = parseCallArtifactManifest({ ...valid, files: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed payloads instead of casting disk data into the manifest contract", () => {
    const payload = {
      payloadRef: "payload_1",
      file: "input.pcm",
      byteRange: { start: 0, endExclusive: 640 },
      monotonicOffsetMs: 10,
      durationMs: 20,
      format: { encoding: "pcm_s16le", channels: 1, sampleRateHz: 16000 },
    };
    expect(parseCallArtifactManifest({ ...valid, payloads: [payload] }).ok).toBe(true);
    expect(
      parseCallArtifactManifest({
        ...valid,
        payloads: [{ ...payload, byteRange: { start: 0.5, endExclusive: 640 } }],
      }).ok,
    ).toBe(false);
    expect(
      parseCallArtifactManifest({
        ...valid,
        payloads: [
          { ...payload, format: { encoding: "pcm_s16le", channels: 1, sampleRateHz: 12345 } },
        ],
      }).ok,
    ).toBe(false);
  });
});

describe("isReconstructableAudioFormat", () => {
  it("guards the closed SampleRateHz union", () => {
    expect(isSampleRateHz(16000)).toBe(true);
    expect(isSampleRateHz(12345)).toBe(false);
  });

  it("accepts pcm_s16le mono with a supported sample rate", () => {
    expect(
      isReconstructableAudioFormat({ encoding: "pcm_s16le", channels: 1, sampleRateHz: 16000 }),
    ).toBe(true);
    expect(
      isReconstructableAudioFormat({ encoding: "pcm_s16le", channels: 1, sampleRateHz: 8000 }),
    ).toBe(true);
  });

  it("rejects dangerous or invalid formats (the WAV-writer crash surface)", () => {
    expect(
      isReconstructableAudioFormat({ encoding: "pcm_s16le", channels: 1, sampleRateHz: 1e20 }),
    ).toBe(false);
    expect(
      isReconstructableAudioFormat({ encoding: "pcm_s16le", channels: 1, sampleRateHz: 16000.5 }),
    ).toBe(false);
    expect(
      isReconstructableAudioFormat({ encoding: "pcm_s16le", channels: 1, sampleRateHz: 12345 }),
    ).toBe(false);
    expect(
      isReconstructableAudioFormat({ encoding: "mulaw", channels: 1, sampleRateHz: 8000 }),
    ).toBe(false);
    expect(
      isReconstructableAudioFormat({ encoding: "pcm_s16le", channels: 2, sampleRateHz: 16000 }),
    ).toBe(false);
    expect(isReconstructableAudioFormat(null)).toBe(false);
    expect(isReconstructableAudioFormat({})).toBe(false);
  });

  it("isSampleRateHz accepts only the closed SampleRateHz set (sound guard)", () => {
    expect(isSampleRateHz(16000)).toBe(true);
    expect(isSampleRateHz(48000)).toBe(true);
    // a safe integer in [8000,48000] that is NOT a contract rate must be rejected.
    expect(isSampleRateHz(12345)).toBe(false);
    expect(isSampleRateHz(16000.5)).toBe(false);
    expect(isSampleRateHz("16000")).toBe(false);
  });
});
