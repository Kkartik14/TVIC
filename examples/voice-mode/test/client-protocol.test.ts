import { describe, expect, it } from "vitest";

import { decodePcmFrame, encodePcmFrame } from "../public/voice-client.js";

describe("browser voice client framing", () => {
  it("round-trips the versioned PCM frame header and payload", () => {
    const frame = encodePcmFrame(new Int16Array([-32768, 0, 32767]), 7, 42.9);
    expect(decodePcmFrame(frame)).toEqual({
      sequence: 7,
      offsetMs: 42,
      samples: new Int16Array([-32768, 0, 32767]),
    });
  });

  it("rejects malformed, odd-sized, and unsupported frames", () => {
    expect(decodePcmFrame(new ArrayBuffer(11))).toBeNull();
    expect(decodePcmFrame(new ArrayBuffer(13))).toBeNull();
    const frame = encodePcmFrame(new Int16Array([1]), 1, 0);
    new DataView(frame).setUint8(0, 2);
    expect(decodePcmFrame(frame)).toBeNull();
  });
});
