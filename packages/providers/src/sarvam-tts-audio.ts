import { PCM16_16K_MONO } from "@tvic/core";

import { MAX_PROVIDER_FRAME_BYTES } from "./common.js";

export function decodeSarvamTtsAudio(
  value: string,
  maxDecodedBytes = MAX_PROVIDER_FRAME_BYTES,
): Uint8Array {
  if (
    value.length === 0 ||
    !Number.isSafeInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    value.length > Math.ceil((maxDecodedBytes * 4) / 3) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error("invalid base64");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  const canonical = Buffer.from(bytes).toString("base64");
  if (bytes.byteLength === 0 || bytes.byteLength > maxDecodedBytes || canonical !== value) {
    throw new Error("invalid base64 audio");
  }
  const pcm = hasWavHeader(bytes) ? decodeSarvamWav(bytes) : bytes;
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error("invalid linear16 audio");
  }
  return pcm;
}

function hasWavHeader(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WAVE"
  );
}

function decodeSarvamWav(bytes: Uint8Array): Uint8Array {
  const buffer = Buffer.from(bytes);
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let audioFormat: number | undefined;
  let dataStart: number | undefined;
  let dataLength: number | undefined;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "data" && chunkLength === 0xffff_ffff) {
      dataStart = chunkStart;
      dataLength = buffer.byteLength - chunkStart;
      break;
    }
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buffer.byteLength) throw new Error("truncated wav");
    if (chunkId === "fmt " && chunkLength >= 16) {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataStart = chunkStart;
      dataLength = chunkLength;
    }
    offset = chunkEnd + (chunkLength % 2);
  }

  if (
    audioFormat !== 1 ||
    channels !== 1 ||
    sampleRate !== PCM16_16K_MONO.sampleRateHz ||
    bitsPerSample !== 16 ||
    dataStart === undefined ||
    dataLength === undefined
  ) {
    throw new Error("unsupported wav format");
  }
  const pcm = new Uint8Array(buffer.subarray(dataStart, dataStart + dataLength));
  if (pcm.byteLength % 2 !== 0) throw new Error("odd wav data length");
  return pcm;
}
