import { TvicThrowableError, validationError } from "@tvic/core";
import type { AudioFormat } from "@tvic/core";

export const PCM16_BYTES_PER_SAMPLE = 2;

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function mulawToPcm16le(mulaw: Uint8Array): Uint8Array {
  const pcm = new Uint8Array(mulaw.length * PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

  for (let i = 0; i < mulaw.length; i += 1) {
    view.setInt16(i * PCM16_BYTES_PER_SAMPLE, decodeMulawSample(mulaw[i] ?? 0), true);
  }

  return pcm;
}

export function pcm16leToMulaw(pcm: Uint8Array): Uint8Array {
  const samples = Math.floor(pcm.byteLength / PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * PCM16_BYTES_PER_SAMPLE);
  const mulaw = new Uint8Array(samples);

  for (let i = 0; i < samples; i += 1) {
    mulaw[i] = encodeMulawSample(view.getInt16(i * PCM16_BYTES_PER_SAMPLE, true));
  }

  return mulaw;
}

/**
 * v0.1 normalized audio is frozen to **pcm_s16le, mono**. The frame/duration/
 * resample helpers below compute on interleaved-sample assumptions that only hold
 * for a single channel, so a stereo format would silently corrupt timing. We
 * reject it at the boundary rather than miscompute.
 */
export function assertPcm16leFormat(format: AudioFormat): void {
  if (format.encoding !== "pcm_s16le") {
    throw TvicThrowableError.from(
      validationError(
        "media.audio_format_invalid",
        `Expected pcm_s16le audio, received ${format.encoding}`,
        { metadata: { format } },
      ),
    );
  }
  if (format.channels !== 1) {
    throw TvicThrowableError.from(
      validationError(
        "media.audio_format_invalid",
        `Expected mono audio (v0.1 normalized), received ${format.channels} channels`,
        { metadata: { format } },
      ),
    );
  }
}

export function resamplePcm16le(
  pcm: Uint8Array,
  fromSampleRateHz: number,
  toSampleRateHz: number,
): Uint8Array {
  if (fromSampleRateHz === toSampleRateHz) {
    return pcm;
  }

  const inputSamples = Math.floor(pcm.byteLength / PCM16_BYTES_PER_SAMPLE);
  if (inputSamples === 0) {
    return new Uint8Array();
  }

  const outputSamples = Math.max(1, Math.round((inputSamples * toSampleRateHz) / fromSampleRateHz));
  const input = new DataView(pcm.buffer, pcm.byteOffset, inputSamples * PCM16_BYTES_PER_SAMPLE);
  const output = new Uint8Array(outputSamples * PCM16_BYTES_PER_SAMPLE);
  const out = new DataView(output.buffer);

  for (let i = 0; i < outputSamples; i += 1) {
    const sourceIndex = (i * (inputSamples - 1)) / Math.max(1, outputSamples - 1);
    const left = Math.floor(sourceIndex);
    const right = Math.min(inputSamples - 1, left + 1);
    const fraction = sourceIndex - left;
    const leftSample = input.getInt16(left * PCM16_BYTES_PER_SAMPLE, true);
    const rightSample = input.getInt16(right * PCM16_BYTES_PER_SAMPLE, true);
    const sample = Math.round(leftSample + (rightSample - leftSample) * fraction);
    out.setInt16(i * PCM16_BYTES_PER_SAMPLE, sample, true);
  }

  return output;
}

export function frameCountForPcm16le(bytes: Uint8Array): number {
  return Math.floor(bytes.byteLength / PCM16_BYTES_PER_SAMPLE);
}

export function durationMsForPcm16le(bytes: Uint8Array, sampleRateHz: number): number {
  return (frameCountForPcm16le(bytes) / sampleRateHz) * 1000;
}

export function splitPcm16leFrames(
  bytes: Uint8Array,
  format: AudioFormat,
  frameDurationMs: number,
): readonly Uint8Array[] {
  assertPcm16leFormat(format);
  const samplesPerFrame = Math.max(1, Math.round((format.sampleRateHz * frameDurationMs) / 1000));
  const bytesPerFrame = samplesPerFrame * PCM16_BYTES_PER_SAMPLE * format.channels;
  const frames: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.byteLength; offset += bytesPerFrame) {
    frames.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + bytesPerFrame)));
  }

  return frames;
}

function decodeMulawSample(sample: number): number {
  const value = ~sample & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let decoded = ((mantissa << 3) + MULAW_BIAS) << exponent;
  decoded -= MULAW_BIAS;
  return sign ? -decoded : decoded;
}

function encodeMulawSample(sample: number): number {
  let pcm = Math.max(-MULAW_CLIP, Math.min(MULAW_CLIP, sample));
  const sign = pcm < 0 ? 0x80 : 0x00;
  if (pcm < 0) {
    pcm = -pcm;
  }
  pcm += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
