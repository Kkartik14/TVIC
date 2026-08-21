import { readFile } from "node:fs/promises";

import { isSampleRateHz, type AudioFormat } from "@tvic/core";

export interface Pcm16Wav {
  readonly format: AudioFormat;
  readonly bytes: Uint8Array;
}

export async function readPcm16Wav(path: string): Promise<Pcm16Wav> {
  return parsePcm16Wav(new Uint8Array(await readFile(path)), path);
}

export function parsePcm16Wav(bytes: Uint8Array, source = "WAV input"): Pcm16Wav {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error(`${source} must be a RIFF/WAVE file`);
  }

  let format: AudioFormat | undefined;
  let data: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      offset + 4,
      true,
    );
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkLength;
    if (bodyEnd > bytes.byteLength) {
      throw new Error(`${source} contains a truncated ${chunkType} chunk`);
    }

    if (chunkType === "fmt ") {
      if (chunkLength < 16) {
        throw new Error(`${source} has an incomplete fmt chunk`);
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + bodyStart, chunkLength);
      const audioFormat = view.getUint16(0, true);
      const channels = view.getUint16(2, true);
      const sampleRate = view.getUint32(4, true);
      const bitsPerSample = view.getUint16(14, true);
      if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error(`${source} must contain mono 16-bit PCM audio`);
      }
      if (!isSampleRateHz(sampleRate)) {
        throw new Error(`Unsupported WAV sample rate: ${sampleRate}Hz`);
      }
      format = {
        encoding: "pcm_s16le",
        sampleRateHz: sampleRate,
        channels: 1,
      } satisfies AudioFormat;
    } else if (chunkType === "data") {
      data = new Uint8Array(bytes.slice(bodyStart, bodyEnd));
    }

    offset = bodyEnd + (chunkLength % 2);
  }

  if (!format) {
    throw new Error(`${source} is missing a PCM fmt chunk`);
  }
  if (!data) {
    throw new Error(`${source} is missing a data chunk`);
  }
  if (data.byteLength % 2 !== 0) {
    throw new Error(`${source} contains an odd number of PCM bytes`);
  }
  return { format, bytes: data };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
