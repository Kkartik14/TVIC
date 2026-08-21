import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO } from "@tvic/core";

import { createAudioNormalizer, frameCountForPcm16le } from "../src/index.js";

describe("AudioNormalizer", () => {
  it("passes through an already-canonical PCM16 stream without changing bytes", () => {
    const input = pcm16Bytes([0, 1000, -2000]);
    const normalizer = createAudioNormalizer({
      inputFormat: PCM16_16K_MONO,
      outputFormat: PCM16_16K_MONO,
    });

    const output = normalizer.push(input);

    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(normalizer.finish()).toEqual(new Uint8Array());
  });

  it("converts 8 kHz to 16 kHz and emits the terminal tail on finish", () => {
    const normalizer = createAudioNormalizer({
      inputFormat: { encoding: "pcm_s16le", sampleRateHz: 8000, channels: 1 },
    });

    const first = normalizer.push(pcm16Bytes(new Array(160).fill(500)));
    const tail = normalizer.finish();

    expect(frameCountForPcm16le(concat(first, tail))).toBe(320);
    expect(normalizer.finish()).toEqual(new Uint8Array());
    expect(() => normalizer.push(new Uint8Array(2))).toThrow(/finished/);
  });

  it("is invariant to realtime chunk boundaries", () => {
    const source = new Array(960)
      .fill(0)
      .map((_, index) => Math.round(Math.sin(index / 19) * 18_000));
    const oneShot = createAudioNormalizer({
      inputFormat: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 },
    });
    const expected = concat(oneShot.push(pcm16Bytes(source)), oneShot.finish());

    const chunked = createAudioNormalizer({
      inputFormat: { encoding: "pcm_s16le", sampleRateHz: 48000, channels: 1 },
    });
    const pieces: Uint8Array[] = [];
    let offset = 0;
    for (const size of [37, 113, 29, 251, 7, 89, 434]) {
      pieces.push(chunked.push(pcm16Bytes(source.slice(offset, offset + size))));
      offset += size;
    }
    pieces.push(chunked.finish());

    expect(concat(...pieces)).toEqual(expected);
    expect(frameCountForPcm16le(expected)).toBe(320);
  });

  it("decodes big-endian PCM and averages stereo input", () => {
    const normalizer = createAudioNormalizer({
      inputFormat: { encoding: "pcm_s16be", sampleRateHz: 16000, channels: 2 },
    });
    const source = new Uint8Array(4);
    const view = new DataView(source.buffer);
    view.setInt16(0, 10_000, false);
    view.setInt16(2, -2_000, false);

    const output = normalizer.push(source);
    const samples = pcm16Samples(output);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeCloseTo(4_000, -2);
  });

  it("converts and clamps finite Float32 input but rejects non-finite samples", () => {
    const normalizer = createAudioNormalizer({
      inputFormat: { encoding: "pcm_f32le", sampleRateHz: 16000, channels: 1 },
    });
    const source = new Uint8Array(12);
    const view = new DataView(source.buffer);
    view.setFloat32(0, -2, true);
    view.setFloat32(4, 0.5, true);
    view.setFloat32(8, 2, true);

    expect(pcm16Samples(normalizer.push(source))).toEqual([-32768, 16384, 32767]);

    const invalid = new Uint8Array(4);
    new DataView(invalid.buffer).setFloat32(0, Number.NaN, true);
    expect(() => normalizer.push(invalid)).toThrow(/not finite/);
  });

  it("rejects incomplete frames and does not mutate source bytes", () => {
    const normalizer = createAudioNormalizer({
      inputFormat: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 2 },
    });
    const source = new Uint8Array([1, 2, 3]);
    const before = new Uint8Array(source);

    expect(() => normalizer.push(source)).toThrow(/complete frames/);
    expect(source).toEqual(before);
  });
});

function pcm16Bytes(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function pcm16Samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
