import type { PayloadRef } from "./ids.js";

/**
 * Encodings carried on the wire by upstream providers. Adapters MUST decode or
 * convert to a NormalizedAudioEncoding before emitting MediaEvent at the runtime
 * boundary. These show up only inside adapter-internal transport types.
 */
export type TransportAudioEncoding =
  | "pcm_s16le"
  | "pcm_s16be"
  | "pcm_f32le"
  | "mulaw"
  | "alaw"
  | "opus"
  | "g722"
  | "mp3"
  | "ogg_opus";

/**
 * The only encodings allowed in MediaEvent payloads. The runtime contract is
 * PCM-only at the boundary; provider-specific encodings must be decoded at the
 * adapter edge.
 */
export type NormalizedAudioEncoding = "pcm_s16le" | "pcm_s16be" | "pcm_f32le";

export type SampleRateHz = 8000 | 16000 | 22050 | 24000 | 44100 | 48000;

export type ChannelLayout = 1 | 2;

export interface TransportAudioFormat {
  readonly encoding: TransportAudioEncoding;
  readonly sampleRateHz: SampleRateHz;
  readonly channels: ChannelLayout;
  readonly frameDurationMs?: number;
}

export interface AudioFormat {
  readonly encoding: NormalizedAudioEncoding;
  readonly sampleRateHz: SampleRateHz;
  readonly channels: ChannelLayout;
  readonly frameDurationMs?: number;
}

export type AudioPayloadData =
  | { readonly kind: "inline"; readonly bytes: Uint8Array }
  | { readonly kind: "ref"; readonly ref: PayloadRef };

export interface AudioPayload {
  readonly format: AudioFormat;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly data: AudioPayloadData;
  readonly checksum?: string;
}
