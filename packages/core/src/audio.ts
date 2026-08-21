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

export interface AudioPayload {
  readonly format: AudioFormat;
  readonly durationMs: number;
  readonly frameCount: number;
  readonly bytes: Uint8Array;
  readonly checksum?: string;
}

/**
 * True when an (untrusted, disk-read) audio format can be safely reconstructed into a
 * playable WAV: 16-bit little-endian PCM, mono, with one of the contract's supported
 * sample rates. Guards the WAV writer's `writeUInt32LE`, which throws on a non-integer
 * or out-of-uint32-range sample/byte rate, so one corrupt manifest can't 500 the
 * audio route.
 */
// The closed set of `SampleRateHz` values. Keep this in one place so runtime guards
// cannot drift from the contract's literal union.
const ALLOWED_SAMPLE_RATES: ReadonlySet<number> = new Set<SampleRateHz>([
  8000, 16000, 22050, 24000, 44100, 48000,
]);

export function isSampleRateHz(value: unknown): value is SampleRateHz {
  return typeof value === "number" && ALLOWED_SAMPLE_RATES.has(value);
}

export function isReconstructableAudioFormat(format: unknown): format is AudioFormat {
  if (format === null || typeof format !== "object") {
    return false;
  }
  const f = format as Record<string, unknown>;
  return (
    f.encoding === "pcm_s16le" &&
    f.channels === 1 &&
    isSampleRateHz(f.sampleRateHz) &&
    (f.frameDurationMs === undefined ||
      (typeof f.frameDurationMs === "number" &&
        Number.isFinite(f.frameDurationMs) &&
        f.frameDurationMs > 0))
  );
}
