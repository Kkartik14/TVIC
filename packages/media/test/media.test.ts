import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, RUNTIME_SAMPLE_RATE_HZ, TELEPHONY_SAMPLE_RATE_HZ } from "@tvic/core";
import type { AudioFormat, MediaEvent, MediaEventId, SessionId, Timestamp } from "@tvic/core";

import {
  assertPcm16leFormat,
  durationMsForPcm16le,
  frameCountForPcm16le,
  isInputMediaEvent,
  isOutputMediaEvent,
  mulawToPcm16le,
  pcm16leToMulaw,
  resamplePcm16le,
} from "../src/index.js";

describe("assertPcm16leFormat", () => {
  it("accepts pcm_s16le mono and rejects stereo / non-pcm", () => {
    expect(() => assertPcm16leFormat(PCM16_16K_MONO)).not.toThrow();
    expect(() =>
      assertPcm16leFormat({ encoding: "pcm_s16le", sampleRateHz: 16000, channels: 2 }),
    ).toThrow(/mono/);
    expect(() =>
      assertPcm16leFormat({
        encoding: "mulaw",
        sampleRateHz: 8000,
        channels: 1,
      } as unknown as AudioFormat),
    ).toThrow(/pcm_s16le/);
  });
});

const sessionId = "session_test" as SessionId;
const timestamp = "2026-05-20T00:00:00.000Z" as Timestamp;

function event(id: string, direction: MediaEvent["direction"]): MediaEvent {
  if (direction === "output") {
    return {
      id: id as MediaEventId,
      type: "media.audio.chunk",
      sessionId,
      sequence: 1,
      direction,
      timestamp,
      monotonicOffsetMs: 1,
      audio: {
        format: PCM16_16K_MONO,
        durationMs: 20,
        frameCount: 320,
        bytes: new Uint8Array([1, 2, 3]),
      },
    };
  }

  return {
    id: id as MediaEventId,
    type: "media.audio.chunk",
    sessionId,
    sequence: 1,
    direction: "input",
    timestamp,
    monotonicOffsetMs: 1,
    audio: {
      format: PCM16_16K_MONO,
      durationMs: 20,
      frameCount: 320,
      bytes: new Uint8Array([1, 2, 3]),
    },
  };
}

describe("media utilities", () => {
  it("narrows normalized events by direction", () => {
    const input = event("media_input", "input");
    const output = event("media_output", "output");
    expect(isInputMediaEvent(input)).toBe(true);
    expect(isOutputMediaEvent(output)).toBe(true);
  });

  it("accepts explicit commit and interrupt input events", () => {
    const base = {
      id: "media_control" as MediaEventId,
      sessionId,
      sequence: 2,
      direction: "input" as const,
      timestamp,
      monotonicOffsetMs: 2,
    };

    expect(isInputMediaEvent({ ...base, type: "media.turn.commit_requested" })).toBe(true);
    expect(isInputMediaEvent({ ...base, type: "media.interrupt.requested" })).toBe(true);
  });

  it("round-trips PCM and mulaw edge encoding", () => {
    const pcm = new Uint8Array([0, 0, 255, 127, 0, 128, 16, 0]);
    const mulaw = pcm16leToMulaw(pcm);
    const decoded = mulawToPcm16le(mulaw);

    expect(mulaw.byteLength).toBe(4);
    expect(decoded.byteLength).toBe(pcm.byteLength);
    expect(frameCountForPcm16le(decoded)).toBe(4);
    expect(durationMsForPcm16le(decoded, TELEPHONY_SAMPLE_RATE_HZ)).toBe(0.5);
  });

  it("matches known G.711 mulaw reference sample values", () => {
    const mulaw = new Uint8Array([0xff, 0x7f, 0x80, 0x00, 0xd5, 0x55, 0xfe, 0x7e]);
    const decoded = mulawToPcm16le(mulaw);

    expect(pcm16Samples(decoded)).toEqual([0, 0, 32124, -32124, 716, -716, 8, -8]);
    expect(pcm16leToMulaw(pcm16Bytes([0, 32124, -32124, 716, -716, 8, -8]))).toEqual(
      new Uint8Array([0xff, 0x80, 0x00, 0xd5, 0x55, 0xfe, 0x7e]),
    );
  });

  it("resamples PCM frames between Twilio and normalized rates", () => {
    const pcm8k = new Uint8Array(160 * 2);
    const pcm16k = resamplePcm16le(pcm8k, TELEPHONY_SAMPLE_RATE_HZ, RUNTIME_SAMPLE_RATE_HZ);

    expect(frameCountForPcm16le(pcm16k)).toBe(320);
  });

  it("linearly resamples PCM ramps", () => {
    const ramp = pcm16Bytes([0, 1000, 2000]);
    const upsampled = resamplePcm16le(ramp, 3, 5);

    expect(pcm16Samples(upsampled)).toEqual([0, 500, 1000, 1500, 2000]);
  });
});

function pcm16Bytes(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function pcm16Samples(bytes: Uint8Array): readonly number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    samples.push(view.getInt16(offset, true));
  }
  return samples;
}
