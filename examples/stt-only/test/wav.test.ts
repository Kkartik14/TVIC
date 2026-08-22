import { describe, expect, it } from "vitest";

import { parsePcm16Wav } from "../src/wav.js";

describe("parsePcm16Wav", () => {
  it("reads mono 16-bit PCM data and tolerates an odd-sized metadata chunk", () => {
    const wav = makeWav(new Uint8Array(640));
    const parsed = parsePcm16Wav(wav);

    expect(parsed.format).toEqual({ encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 });
    expect(parsed.bytes).toHaveLength(640);
  });

  it("rejects non-PCM WAV input", () => {
    expect(() => parsePcm16Wav(makeWav(new Uint8Array(2), { channels: 2 }))).toThrow("mono");
  });
});

function makeWav(data: Uint8Array, options: { readonly channels?: number } = {}): Uint8Array {
  const metadata = new TextEncoder().encode("J");
  const fmtLength = 16;
  const dataLength = data.byteLength;
  const totalLength = 12 + 8 + metadata.byteLength + 1 + 8 + fmtLength + 8 + dataLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, totalLength - 8, true);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  let offset = 12;
  bytes.set(new TextEncoder().encode("JUNK"), offset);
  view.setUint32(offset + 4, metadata.byteLength, true);
  bytes.set(metadata, offset + 8);
  offset += 8 + metadata.byteLength + 1;
  bytes.set(new TextEncoder().encode("fmt "), offset);
  view.setUint32(offset + 4, fmtLength, true);
  view.setUint16(offset + 8, 1, true);
  view.setUint16(offset + 10, options.channels ?? 1, true);
  view.setUint32(offset + 12, 16000, true);
  view.setUint32(offset + 16, 16000 * 2, true);
  view.setUint16(offset + 20, 2, true);
  view.setUint16(offset + 22, 16, true);
  offset += 8 + fmtLength;
  bytes.set(new TextEncoder().encode("data"), offset);
  view.setUint32(offset + 4, dataLength, true);
  bytes.set(data, offset + 8);
  return bytes;
}
