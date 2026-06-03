export interface AlignChunk {
  /** Inclusive start byte of this chunk within the raw concatenated PCM. */
  readonly byteStart: number;
  /** Exclusive end byte of this chunk within the raw concatenated PCM. */
  readonly byteEnd: number;
  /** Absolute call-clock offset (ms) at which this chunk was captured. */
  readonly monotonicOffsetMs: number;
}

/**
 * Places each PCM chunk at `(monotonicOffsetMs - originMs)` on the call clock,
 * filling gaps with silence, so the resulting track's t=0 is exactly `originMs`
 * (the same origin the UI uses when it seeks `turnStartMs - timeline.startMs`).
 * Pure and origin-explicit so seek math and audio share one clock.
 */
export function alignPcmToCallClock(
  source: Uint8Array,
  chunks: readonly AlignChunk[],
  sampleRateHz: number,
  originMs: number,
  /** Hard ceiling on the reconstructed track size, so a bad offset can't OOM. */
  maxBytes = Number.POSITIVE_INFINITY,
): Uint8Array {
  if (chunks.length === 0) {
    return source;
  }

  const bytesPerMs = (sampleRateHz * 2) / 1000;
  const destByte = (offsetMs: number): number => {
    const b = Math.max(0, Math.round((offsetMs - originMs) * bytesPerMs));
    return b - (b % 2); // keep 16-bit sample alignment
  };

  // Size the buffer only from chunks that fit under the cap, so a single far-future
  // (corrupt) offset that will be skipped anyway can't force a cap-sized allocation.
  let totalBytes = 0;
  for (const chunk of chunks) {
    const end = destByte(chunk.monotonicOffsetMs) + Math.max(0, chunk.byteEnd - chunk.byteStart);
    if (end <= maxBytes) {
      totalBytes = Math.max(totalBytes, end);
    }
  }

  const aligned = new Uint8Array(totalBytes);
  for (const chunk of chunks) {
    const slice = source.subarray(chunk.byteStart, chunk.byteEnd);
    const dest = destByte(chunk.monotonicOffsetMs);
    // A chunk that would land beyond the sized buffer (i.e. beyond the cap) is skipped
    // rather than truncating mid-frame.
    if (dest + slice.byteLength <= aligned.byteLength) {
      aligned.set(slice, dest);
    }
  }
  return aligned;
}
