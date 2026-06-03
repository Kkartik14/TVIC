import { describe, expect, it } from "vitest";

import { alignPcmToCallClock } from "../lib/align";

// 16 kHz mono s16le → 32 bytes per ms.
const RATE = 16000;
const BYTES_PER_MS = (RATE * 2) / 1000;

describe("alignPcmToCallClock", () => {
  it("places chunks relative to the call origin, padding the gap with silence", () => {
    // Two 1ms chunks in the raw stream: first captured at 110ms, second at 130ms.
    // Call origin (timeline.startMs) is 100ms.
    const chunkA = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // ... arbitrary nonzero
    const chunkB = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);
    const source = new Uint8Array([...chunkA, ...chunkB]);

    const aligned = alignPcmToCallClock(
      source,
      [
        { byteStart: 0, byteEnd: 8, monotonicOffsetMs: 110 },
        { byteStart: 8, byteEnd: 16, monotonicOffsetMs: 130 },
      ],
      RATE,
      100,
    );

    const offsetA = (110 - 100) * BYTES_PER_MS; // 320
    const offsetB = (130 - 100) * BYTES_PER_MS; // 960
    expect(aligned.byteLength).toBe(offsetB + 8);
    // chunk A at its post-origin offset, not at byte 0
    expect(Array.from(aligned.subarray(offsetA, offsetA + 8))).toEqual(Array.from(chunkA));
    // silence in the gap
    expect(Array.from(aligned.subarray(0, offsetA))).toEqual(new Array(offsetA).fill(0));
    // chunk B placed after the gap
    expect(Array.from(aligned.subarray(offsetB, offsetB + 8))).toEqual(Array.from(chunkB));
  });

  it("clamps chunks captured before the origin to t=0", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const aligned = alignPcmToCallClock(
      source,
      [{ byteStart: 0, byteEnd: 4, monotonicOffsetMs: 90 }],
      RATE,
      100, // origin after the chunk
    );
    expect(Array.from(aligned.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it("returns the raw source when there are no chunks", () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    expect(alignPcmToCallClock(source, [], RATE, 0)).toBe(source);
  });

  it("skips chunks beyond the maxBytes ceiling without allocating the full cap", () => {
    const chunkA = new Uint8Array([1, 2, 3, 4]); // placed at origin (byte 0)
    const chunkB = new Uint8Array([9, 9, 9, 9]); // would land far past the cap
    const source = new Uint8Array([...chunkA, ...chunkB]);
    const maxBytes = 1024;

    const aligned = alignPcmToCallClock(
      source,
      [
        { byteStart: 0, byteEnd: 4, monotonicOffsetMs: 0 },
        { byteStart: 4, byteEnd: 8, monotonicOffsetMs: 1_000_000 }, // ~32 GB offset
      ],
      RATE,
      0,
      maxBytes,
    );

    // Sized to the in-cap content only (chunk A), NOT the cap and NOT the 32GB offset.
    expect(aligned.byteLength).toBe(4);
    expect(aligned.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(Array.from(aligned.subarray(0, 4))).toEqual([1, 2, 3, 4]); // first chunk written
  });
});
