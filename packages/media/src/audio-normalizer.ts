import {
  PCM16_16K_MONO,
  isSampleRateHz,
  sameAudioFormat,
  validationError,
  type AudioFormat,
  TvicThrowableError,
} from "@tvic/core";

import { PCM16_BYTES_PER_SAMPLE } from "./audio-codec.js";

const FILTER_HALF_WIDTH = 16;
const PI = Math.PI;

export interface AudioNormalizerOptions {
  readonly inputFormat: AudioFormat;
  readonly outputFormat?: AudioFormat;
  readonly channelPolicy?: "average" | "left";
}

export interface AudioNormalizer {
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;

  push(bytes: Uint8Array): Uint8Array;
  finishSegment(): Uint8Array;
  finish(): Uint8Array;
}

/**
 * Converts supported PCM source frames into PCM16LE mono while preserving
 * sample-clock phase across arbitrary realtime chunk boundaries.
 *
 * The FIR is intentionally small and deterministic. It is causal with a
 * bounded look-ahead: ordinary pushes emit only samples whose filter support is
 * present, while an explicit segment/stream finish uses the final source sample
 * as the endpoint. This prevents packet boundaries from becoming resampling
 * boundaries.
 */
export function createAudioNormalizer(options: AudioNormalizerOptions): AudioNormalizer {
  const outputFormat = options.outputFormat ?? PCM16_16K_MONO;
  validateFormat(options.inputFormat, "input");
  validateOutputFormat(outputFormat);
  const channelPolicy = options.channelPolicy ?? "average";
  if (
    options.inputFormat.channels === 2 &&
    channelPolicy !== "average" &&
    channelPolicy !== "left"
  ) {
    throw TvicThrowableError.from(
      validationError(
        "audio.normalization.channel_policy_invalid",
        `Unsupported stereo channel policy ${channelPolicy}`,
      ),
    );
  }

  return new PcmAudioNormalizer(options.inputFormat, outputFormat, channelPolicy);
}

interface SampleDecoder {
  readonly bytesPerFrame: number;
  decode(bytes: Uint8Array): readonly number[];
}

class PcmAudioNormalizer implements AudioNormalizer {
  readonly #inputFormat: AudioFormat;
  readonly #outputFormat: AudioFormat;
  readonly #decoder: SampleDecoder;
  readonly #resampler: StreamingFirResampler;
  readonly #direct: boolean;
  readonly #sameRate: boolean;
  #finished = false;
  #segmentFinished = false;

  constructor(
    inputFormat: AudioFormat,
    outputFormat: AudioFormat,
    channelPolicy: "average" | "left",
  ) {
    this.#inputFormat = inputFormat;
    this.#outputFormat = outputFormat;
    this.#decoder = createDecoder(inputFormat, channelPolicy);
    this.#resampler = new StreamingFirResampler(
      inputFormat.sampleRateHz,
      outputFormat.sampleRateHz,
    );
    this.#direct = sameAudioFormat(inputFormat, outputFormat);
    this.#sameRate = inputFormat.sampleRateHz === outputFormat.sampleRateHz;
  }

  get inputFormat(): AudioFormat {
    return this.#inputFormat;
  }

  get outputFormat(): AudioFormat {
    return this.#outputFormat;
  }

  push(bytes: Uint8Array): Uint8Array {
    this.#assertOpen();
    if (bytes.byteLength % this.#decoder.bytesPerFrame !== 0) {
      throw TvicThrowableError.from(
        validationError(
          "audio.normalization.incomplete_frame",
          `Audio input must contain complete frames of ${this.#decoder.bytesPerFrame} bytes`,
        ),
      );
    }
    if (bytes.byteLength === 0) {
      return new Uint8Array();
    }

    if (this.#direct) {
      return new Uint8Array(bytes);
    }

    const samples = this.#decoder.decode(bytes);
    this.#segmentFinished = false;
    if (this.#sameRate) {
      return this.#encode(samples);
    }
    this.#resampler.push(samples);
    return this.#encode(this.#resampler.produce(false));
  }

  finishSegment(): Uint8Array {
    this.#assertOpen();
    if (this.#segmentFinished) {
      return new Uint8Array();
    }
    this.#segmentFinished = true;
    if (this.#sameRate) {
      return new Uint8Array();
    }
    return this.#encode(this.#resampler.produce(true));
  }

  finish(): Uint8Array {
    if (this.#finished) {
      return new Uint8Array();
    }
    const tail = this.finishSegment();
    this.#finished = true;
    return tail;
  }

  #assertOpen(): void {
    if (this.#finished) {
      throw TvicThrowableError.from(
        validationError(
          "audio.normalization.finished",
          "Audio normalizer has already been finished",
        ),
      );
    }
  }

  #encode(samples: readonly number[]): Uint8Array {
    const output = new Uint8Array(samples.length * PCM16_BYTES_PER_SAMPLE);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
      const integer = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      view.setInt16(index * PCM16_BYTES_PER_SAMPLE, integer, true);
    }
    return output;
  }
}

class StreamingFirResampler {
  readonly #inputRateHz: number;
  readonly #outputRateHz: number;
  readonly #cutoff: number;
  readonly #phaseCount: number;
  readonly #filters: readonly (readonly number[])[];
  readonly #samples: number[] = [];
  #bufferStartIndex = 0;
  #totalInputFrames = 0;
  #nextOutputIndex = 0;

  constructor(inputRateHz: number, outputRateHz: number) {
    this.#inputRateHz = inputRateHz;
    this.#outputRateHz = outputRateHz;
    this.#cutoff = 0.5 * Math.min(1, outputRateHz / inputRateHz);
    this.#phaseCount = outputRateHz / greatestCommonDivisor(inputRateHz, outputRateHz);
    this.#filters = Array.from({ length: this.#phaseCount }, (_, phase) => {
      const fractionalPosition = phase / this.#phaseCount;
      return Array.from({ length: FILTER_HALF_WIDTH * 2 }, (_, index) =>
        this.#kernel(index - FILTER_HALF_WIDTH + 1 - fractionalPosition),
      );
    });
  }

  push(samples: readonly number[]): void {
    this.#samples.push(...samples);
    this.#totalInputFrames += samples.length;
  }

  produce(finalize: boolean): readonly number[] {
    if (this.#totalInputFrames === 0) {
      return [];
    }

    const targetCount = finalize
      ? Math.round((this.#totalInputFrames * this.#outputRateHz) / this.#inputRateHz)
      : Number.POSITIVE_INFINITY;
    const output: number[] = [];
    while (this.#nextOutputIndex < targetCount) {
      const position = (this.#nextOutputIndex * this.#inputRateHz) / this.#outputRateHz;
      if (!finalize && position + FILTER_HALF_WIDTH >= this.#totalInputFrames) {
        break;
      }
      output.push(this.#sampleAt(position));
      this.#nextOutputIndex += 1;
    }

    this.#trim();
    return output;
  }

  #sampleAt(position: number): number {
    const center = Math.floor(position);
    const fractionalPosition = position - center;
    const phaseIndex = Math.round(fractionalPosition * this.#phaseCount) % this.#phaseCount;
    const filter = this.#filters[phaseIndex] ?? this.#filters[0] ?? [];
    let weighted = 0;
    let weightTotal = 0;
    for (let index = 0; index < filter.length; index += 1) {
      const offset = index - FILTER_HALF_WIDTH + 1;
      const sourceIndex = center + offset;
      const weight = filter[index] ?? 0;
      if (weight === 0) {
        continue;
      }
      weighted += this.#read(sourceIndex) * weight;
      weightTotal += weight;
    }
    return weightTotal === 0 ? this.#read(center) : weighted / weightTotal;
  }

  #kernel(distance: number): number {
    const normalizedDistance = Math.abs(distance);
    if (normalizedDistance >= FILTER_HALF_WIDTH) {
      return 0;
    }
    const sincArgument = 2 * this.#cutoff * distance;
    const sinc = sincArgument === 0 ? 1 : Math.sin(PI * sincArgument) / (PI * sincArgument);
    const window = 0.5 * (1 + Math.cos((PI * normalizedDistance) / FILTER_HALF_WIDTH));
    return 2 * this.#cutoff * sinc * window;
  }

  #read(index: number): number {
    if (this.#totalInputFrames === 0) {
      return 0;
    }
    const boundedIndex = Math.max(0, Math.min(this.#totalInputFrames - 1, index));
    if (boundedIndex < this.#bufferStartIndex) {
      return this.#samples[0] ?? 0;
    }
    return this.#samples[boundedIndex - this.#bufferStartIndex] ?? this.#samples.at(-1) ?? 0;
  }

  #trim(): void {
    const nextPosition = (this.#nextOutputIndex * this.#inputRateHz) / this.#outputRateHz;
    const keepFrom = Math.max(
      0,
      Math.floor(nextPosition) - FILTER_HALF_WIDTH - 2,
      this.#totalInputFrames - FILTER_HALF_WIDTH * 2 - 2,
    );
    const remove = keepFrom - this.#bufferStartIndex;
    if (remove <= 0) {
      return;
    }
    this.#samples.splice(0, Math.min(remove, this.#samples.length));
    this.#bufferStartIndex = keepFrom;
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function createDecoder(format: AudioFormat, channelPolicy: "average" | "left"): SampleDecoder {
  const bytesPerSample = format.encoding === "pcm_f32le" ? 4 : PCM16_BYTES_PER_SAMPLE;
  const bytesPerFrame = bytesPerSample * format.channels;
  const littleEndian = format.encoding !== "pcm_s16be";
  return {
    bytesPerFrame,
    decode(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const frameCount = bytes.byteLength / bytesPerFrame;
      const mono = new Array<number>(frameCount);
      for (let frame = 0; frame < frameCount; frame += 1) {
        let value = 0;
        for (let channel = 0; channel < format.channels; channel += 1) {
          const offset = frame * bytesPerFrame + channel * bytesPerSample;
          const sample =
            format.encoding === "pcm_f32le"
              ? view.getFloat32(offset, true)
              : view.getInt16(offset, littleEndian) / 32768;
          if (!Number.isFinite(sample)) {
            throw TvicThrowableError.from(
              validationError(
                "audio.normalization.float_non_finite",
                `Audio float sample at frame ${frame}, channel ${channel} is not finite`,
              ),
            );
          }
          const clamped = Math.max(-1, Math.min(1, sample));
          if (channelPolicy === "left" && channel > 0) {
            continue;
          }
          value += clamped;
        }
        mono[frame] = channelPolicy === "average" ? value / format.channels : value;
      }
      return mono;
    },
  };
}

function validateFormat(format: AudioFormat, side: "input" | "output"): void {
  if (!isSampleRateHz(format.sampleRateHz)) {
    throw TvicThrowableError.from(
      validationError(
        "audio.normalization.sample_rate_unsupported",
        `Unsupported ${side} sample rate ${format.sampleRateHz}Hz`,
      ),
    );
  }
  if (format.channels !== 1 && format.channels !== 2) {
    throw TvicThrowableError.from(
      validationError(
        "audio.normalization.channels_unsupported",
        `Unsupported ${side} channel count ${format.channels}`,
      ),
    );
  }
  if (
    format.encoding !== "pcm_s16le" &&
    format.encoding !== "pcm_s16be" &&
    format.encoding !== "pcm_f32le"
  ) {
    throw TvicThrowableError.from(
      validationError(
        "audio.normalization.input_encoding_unsupported",
        `Unsupported ${side} encoding ${format.encoding}`,
      ),
    );
  }
}

function validateOutputFormat(format: AudioFormat): void {
  validateFormat(format, "output");
  if (format.encoding !== "pcm_s16le" || format.channels !== 1) {
    throw TvicThrowableError.from(
      validationError(
        "audio.normalization.target_unsupported",
        "Audio normalizer output must be mono pcm_s16le",
      ),
    );
  }
}
