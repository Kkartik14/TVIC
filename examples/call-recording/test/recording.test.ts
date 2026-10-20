import { describe, expect, it } from "vitest";

import { PCM16_16K_MONO, type AudioTapAudioFrame, type AudioTapFrame } from "voice-runtime";
import { runMockCall } from "../src/mock-call.js";
import { buildStereoWav, RECORDING_SAMPLE_RATE_HZ } from "../src/stereo-wav.js";

describe("call recording example", () => {
  it("writes the mock call as timestamp-aligned stereo PCM", async () => {
    const recording = await runMockCall();
    const wav = buildStereoWav(recording.frames);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true) % 4).toBe(0);

    const lanes = decodeLanes(wav);
    const callerStart = firstNonZero(lanes.left);
    const agentStart = firstNonZero(lanes.right);
    expect(callerStart).toBeGreaterThanOrEqual(0);
    expect(agentStart).toBeGreaterThan(callerStart);
    expect(recording.turnsHandled).toBe(1);
    expect(recording.summary).toMatchObject({ enabled: true, droppedFrames: 0, droppedEvents: 0 });
    expect(recording.frames.some((frame) => frame.type === "playout" && frame.confirmed)).toBe(
      true,
    );
  });

  it("keeps transport-accepted agent audio when playout is not confirmed", () => {
    const turnId = "turn_unconfirmed" as never;
    const lanes = decodeLanes(buildStereoWav([audioFrame("agent", 0, 0, [300, 400], turnId)]));

    expect(lanes.right).toEqual([300, 400]);
  });

  it("keeps confirmed PCM and clips interrupted output at the clear timestamp", () => {
    const turnId = "turn_cleared" as never;
    const frames: AudioTapFrame[] = [
      audioFrame("caller", 0, 0, [100, 200]),
      audioFrame("agent", 1, 0.125, [300, 400], turnId),
      {
        type: "playout",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId,
        markId: "mark_before_clear",
        confirmed: true,
        sequence: 2,
        timestampMs: 0.25,
        throughSequence: 1,
      },
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId,
        sequence: 3,
        timestampMs: 0.375,
        throughSequence: 1,
        hadPendingSends: false,
      },
      audioFrame("agent", 4, 1, [500, 600], turnId),
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId,
        sequence: 5,
        timestampMs: 1.125,
        throughSequence: 4,
        hadPendingSends: false,
      },
      audioFrame("caller", 6, 0.25, [700, 800]),
    ];

    const lanes = decodeLanes(buildStereoWav(frames));
    expect(lanes.left.slice(0, 6)).toEqual([100, 200, 0, 0, 700, 800]);
    expect(lanes.right.slice(0, 4)).toEqual([0, 0, 300, 400]);
    expect(lanes.right.slice(16, 18)).toEqual([500, 600]);
    expect(lanes.right).toHaveLength(18);
  });

  it("truncates a long unconfirmed agent turn at its successful clear marker", () => {
    const turnId = "turn_interrupted_story" as never;
    const sampleCount = 29_200 * (RECORDING_SAMPLE_RATE_HZ / 1_000);
    const bytes = new Uint8Array(sampleCount * 2);
    for (let offset = 0; offset < bytes.length; offset += 2) bytes[offset] = 123;
    const longFrame: AudioTapAudioFrame = {
      ...audioFrame("agent", 0, 0, [123], turnId),
      bytes,
    };
    const wav = buildStereoWav([
      longFrame,
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId,
        sequence: 1,
        timestampMs: 3_283,
        throughSequence: 0,
        hadPendingSends: true,
      },
    ]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(view.getUint32(40, true)).toBe(52_528 * 4);
    expect(view.getInt16(wav.byteLength - 2, true)).toBe(123);
    expect(view.getInt16(wav.byteLength - 4, true)).toBe(0);
  });

  it("does not trim a later reply accepted after the clear was requested", () => {
    const interruptedTurn = "turn_interrupted" as never;
    const laterTurn = "turn_later" as never;
    const wav = buildStereoWav([
      audioFrame("agent", 0, 0, new Array(32_000).fill(123), interruptedTurn),
      audioFrame("agent", 2, 2_000, [321, 654], laterTurn),
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId: interruptedTurn,
        sequence: 3,
        timestampMs: 1_000,
        throughSequence: 0,
        hadPendingSends: false,
      },
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId: laterTurn,
        sequence: 4,
        timestampMs: 2_250,
        throughSequence: 2,
        hadPendingSends: false,
      },
    ]);
    const lanes = decodeLanes(wav);

    expect(lanes.right).toHaveLength(32_002);
    expect(lanes.right[15_999]).toBe(123);
    expect(lanes.right[16_000]).toBe(0);
    expect(lanes.right.slice(32_000, 32_002)).toEqual([321, 654]);
  });

  it("uses the clear timestamp when an in-flight send has no sequence boundary", () => {
    const turnId = "turn_pending_send" as never;
    const longFrame: AudioTapAudioFrame = {
      ...audioFrame("agent", 0, 0, [123], turnId),
      bytes: new Uint8Array(29_200 * (RECORDING_SAMPLE_RATE_HZ / 1_000) * 2),
    };
    const wav = buildStereoWav([
      longFrame,
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId,
        sequence: 1,
        timestampMs: 3_283,
        hadPendingSends: true,
      },
    ]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(view.getUint32(40, true)).toBe(52_528 * 4);
  });

  it("clips a pending same-turn frame beyond its watermark without clipping a later turn", () => {
    const interruptedTurn = "turn_pending_with_watermark" as never;
    const laterTurn = "turn_after_pending_clear" as never;
    const wav = buildStereoWav([
      audioFrame("agent", 1, 0, new Array(32_000).fill(123), interruptedTurn),
      audioFrame("agent", 3, 2_000, [321, 654], interruptedTurn),
      audioFrame("agent", 4, 2_000, [765, 876], laterTurn),
      {
        type: "cleared",
        direction: "agent",
        sessionId: "session_example" as never,
        turnId: interruptedTurn,
        sequence: 5,
        timestampMs: 1_000,
        throughSequence: 1,
        hadPendingSends: true,
      },
    ]);
    const lanes = decodeLanes(wav);

    expect(lanes.right).toHaveLength(32_002);
    expect(lanes.right[15_999]).toBe(123);
    expect(lanes.right[16_000]).toBe(0);
    expect(lanes.right.slice(32_000, 32_002)).toEqual([765, 876]);
  });

  it("clips late audio from an earlier pending turn without clipping a later reply", () => {
    const pendingTurn = "turn_pending_before_clear" as never;
    const clearingTurn = "turn_that_requested_clear" as never;
    const laterTurn = "turn_after_clear" as never;
    const clearFrame = {
      type: "cleared",
      direction: "agent",
      sessionId: "session_example" as never,
      turnId: clearingTurn,
      sequence: 5,
      timestampMs: 1_000,
      throughSequence: 1,
      hadPendingSends: true,
      pendingSendTurnIds: [pendingTurn],
    } as AudioTapFrame;
    const lanes = decodeLanes(
      buildStereoWav([
        audioFrame("agent", 4, 2_000, [123, 456], pendingTurn),
        clearFrame,
        audioFrame("agent", 6, 2_000, [765, 876], laterTurn),
      ]),
    );

    expect(lanes.right).toHaveLength(32_002);
    expect(lanes.right.slice(32_000, 32_002)).toEqual([765, 876]);
  });

  it("rejects a recording when a clear cannot identify every pending turn", () => {
    const interruptedTurn = "turn_pending_before_clear" as never;
    const laterTurn = "turn_after_clear" as never;

    expect(() =>
      buildStereoWav([
        audioFrame("agent", 0, 0, new Array(32_000).fill(123), interruptedTurn),
        {
          type: "cleared",
          direction: "agent",
          sessionId: "session_example" as never,
          turnId: interruptedTurn,
          sequence: 1,
          timestampMs: 1_000,
          throughSequence: 0,
          hadPendingSends: true,
          pendingSendTurnIdsTruncated: true,
        },
        audioFrame("agent", 3, 2_000, [321, 654], laterTurn),
      ]),
    ).toThrow("pending send turn IDs were truncated");
  });

  it("preserves same-channel samples when runtime timestamps overlap", () => {
    const frames: AudioTapFrame[] = [
      audioFrame("caller", 0, 0, [100, 200]),
      audioFrame("caller", 1, 0, [300, 400]),
    ];

    const lanes = decodeLanes(buildStereoWav(frames));
    expect(lanes.left.slice(0, 4)).toEqual([100, 200, 300, 400]);
  });

  it("accepts a timeline that reaches the exact 64 MiB WAV data limit", () => {
    const maxDataBytes = 64 * 1024 * 1024;
    const maxSamples = maxDataBytes / 4;
    const wav = buildStereoWav([
      audioFrame("caller", 0, ((maxSamples - 1) * 1_000) / 16_000, [123]),
    ]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(wav.byteLength).toBe(44 + maxDataBytes);
    expect(view.getUint32(40, true)).toBe(maxDataBytes);
    expect(view.getInt16(wav.byteLength - 4, true)).toBe(123);
  });

  it.each([
    {
      label: "unsupported channel count",
      frame: {
        ...audioFrame("caller", 0, 0, [100]),
        format: { ...PCM16_16K_MONO, channels: 2 },
      } as AudioTapAudioFrame,
      message: "expects mono 16 kHz pcm_s16le audio",
    },
    {
      label: "incomplete PCM16 sample",
      frame: { ...audioFrame("caller", 0, 0, [100]), bytes: new Uint8Array([1]) },
      message: "incomplete PCM16 sample",
    },
    {
      label: "invalid runtime timestamp",
      frame: audioFrame("caller", 0, Number.NaN, [100]),
      message: "invalid runtime timestamp",
    },
  ])("rejects $label", ({ frame, message }) => {
    expect(() => buildStereoWav([frame])).toThrow(message);
  });

  it("rejects timelines that exceed the in-memory WAV example limit", () => {
    const frames = [audioFrame("caller", 0, Number.MAX_SAFE_INTEGER, [100])];

    expect(() => buildStereoWav(frames)).toThrow("exceeds the example WAV size limit");
  });

  it("checks the WAV limit before reading oversized PCM bytes", () => {
    let bufferWasRead = false;
    const oversizedBytes = {
      byteLength: (16_777_216 + 1) * 2,
      byteOffset: 0,
      get buffer(): ArrayBuffer {
        bufferWasRead = true;
        throw new Error("PCM bytes were read before checking the WAV limit");
      },
    } as Uint8Array;
    const frame = { ...audioFrame("caller", 0, 0, [100]), bytes: oversizedBytes };

    expect(() => buildStereoWav([frame])).toThrow("exceeds the example WAV size limit");
    expect(bufferWasRead).toBe(false);
  });
});

function audioFrame(
  direction: "caller" | "agent",
  sequence: number,
  timestampMs: number,
  samples: readonly number[],
  turnId?: AudioTapAudioFrame["turnId"],
): AudioTapAudioFrame {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return {
    type: "audio",
    direction,
    sessionId: "session_example" as never,
    ...(turnId ? { turnId } : {}),
    sequence,
    timestampMs,
    format: PCM16_16K_MONO,
    bytes,
  };
}

function decodeLanes(wav: Uint8Array): { readonly left: number[]; readonly right: number[] } {
  const dataBytes = new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(40, true);
  const data = new DataView(wav.buffer, wav.byteOffset + 44, dataBytes);
  const left: number[] = [];
  const right: number[] = [];
  for (let offset = 0; offset < dataBytes; offset += 4) {
    left.push(data.getInt16(offset, true));
    right.push(data.getInt16(offset + 2, true));
  }
  return { left, right };
}

function firstNonZero(samples: readonly number[]): number {
  return samples.findIndex((sample) => sample !== 0);
}
