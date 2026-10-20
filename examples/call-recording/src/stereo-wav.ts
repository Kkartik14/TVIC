import type { AudioTapAudioFrame, AudioTapFrame, TurnId } from "voice-runtime";

export const RECORDING_SAMPLE_RATE_HZ = 16_000;
const MAX_EXAMPLE_WAV_DATA_BYTES = 64 * 1024 * 1024;

interface PositionedAudio {
  readonly frame: AudioTapAudioFrame;
  readonly startSample: number;
  readonly sampleCount: number;
}

interface ClearCutoff {
  readonly throughSequence: number;
  readonly timestampMs: number;
}

/** Builds a stereo PCM16 WAV with caller audio on the left and accepted agent audio on the right. */
export function buildStereoWav(frames: readonly AudioTapFrame[]): Buffer {
  if (
    frames.some((frame) => frame.type === "cleared" && frame.pendingSendTurnIdsTruncated === true)
  ) {
    throw new Error(
      "Cannot build an accurate WAV because pending send turn IDs were truncated; late agent audio cannot be identified safely",
    );
  }

  const confirmedThroughByTurn = confirmedAgentAudioThrough(frames);
  const clearCutoffAt = createClearCutoffLookup(frames);
  const lastSampleByDirection = new Map<AudioTapAudioFrame["direction"], number>();
  const positioned: PositionedAudio[] = [];
  let sampleCount = 0;
  for (const frame of frames
    .filter(isAudioFrame)
    .sort((left, right) => left.sequence - right.sequence)) {
    const confirmedThrough =
      frame.direction === "agent" && frame.turnId
        ? confirmedThroughByTurn.get(frame.turnId)
        : undefined;
    const confirmed = confirmedThrough !== undefined && frame.sequence <= confirmedThrough;
    const clearCutoffMs =
      frame.direction === "agent" && !confirmed ? clearCutoffAt(frame) : undefined;

    const frameSamples = validateAudioFrame(frame);
    const startSample = Math.max(
      timestampSample(frame),
      lastSampleByDirection.get(frame.direction) ?? 0,
    );
    const playableSamples =
      clearCutoffMs === undefined
        ? frameSamples
        : Math.min(
            frameSamples,
            Math.max(
              0,
              Math.floor((clearCutoffMs * RECORDING_SAMPLE_RATE_HZ) / 1_000) - startSample,
            ),
          );
    if (playableSamples === 0) continue;
    const endSample = startSample + playableSamples;
    if (
      !Number.isSafeInteger(startSample) ||
      !Number.isSafeInteger(endSample) ||
      endSample > MAX_EXAMPLE_WAV_DATA_BYTES / 4
    ) {
      throw new Error("Audio tap recording exceeds the example WAV size limit");
    }
    lastSampleByDirection.set(frame.direction, endSample);
    sampleCount = Math.max(sampleCount, endSample);
    positioned.push({ frame, startSample, sampleCount: playableSamples });
  }
  const dataBytes = sampleCount * 4;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > MAX_EXAMPLE_WAV_DATA_BYTES) {
    throw new Error("Audio tap recording exceeds the example WAV size limit");
  }
  const wav = Buffer.alloc(44 + dataBytes);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(RECORDING_SAMPLE_RATE_HZ, 24);
  wav.writeUInt32LE(RECORDING_SAMPLE_RATE_HZ * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  for (const audio of positioned) {
    const channel = audio.frame.direction === "caller" ? 0 : 1;
    const bytes = audio.frame.bytes;
    const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < audio.sampleCount; index += 1) {
      const sampleIndex = audio.startSample + index;
      const byteOffset = 44 + sampleIndex * 4 + channel * 2;
      wav.writeInt16LE(samples.getInt16(index * 2, true), byteOffset);
    }
  }

  return wav;
}

function confirmedAgentAudioThrough(frames: readonly AudioTapFrame[]): Map<TurnId, number> {
  const confirmed = new Map<TurnId, number>();
  for (const frame of frames) {
    if (frame.type !== "playout" || !frame.confirmed || frame.throughSequence === undefined) {
      continue;
    }
    confirmed.set(frame.turnId, Math.max(confirmed.get(frame.turnId) ?? -1, frame.throughSequence));
  }
  return confirmed;
}

function createClearCutoffLookup(
  frames: readonly AudioTapFrame[],
): (frame: AudioTapAudioFrame) => number | undefined {
  const cutoffs: ClearCutoff[] = frames
    .filter(
      (
        frame,
      ): frame is Extract<AudioTapFrame, { readonly type: "cleared" }> & {
        readonly throughSequence: number;
      } =>
        frame.type === "cleared" &&
        frame.throughSequence !== undefined &&
        Number.isSafeInteger(frame.throughSequence) &&
        frame.throughSequence >= 0 &&
        Number.isFinite(frame.timestampMs) &&
        frame.timestampMs >= 0,
    )
    .map((frame) => ({
      throughSequence: frame.throughSequence,
      timestampMs: frame.timestampMs,
    }))
    .sort((left, right) => left.throughSequence - right.throughSequence);
  const pendingTurnCutoff = new Map<TurnId, number>();
  for (const frame of frames) {
    if (
      frame.type !== "cleared" ||
      !frame.hadPendingSends ||
      !Number.isFinite(frame.timestampMs) ||
      frame.timestampMs < 0
    ) {
      continue;
    }
    const pendingTurnIds = frame.pendingSendTurnIds?.length
      ? frame.pendingSendTurnIds
      : frame.turnId
        ? [frame.turnId]
        : [];
    for (const turnId of pendingTurnIds) {
      pendingTurnCutoff.set(
        turnId,
        Math.min(pendingTurnCutoff.get(turnId) ?? Number.POSITIVE_INFINITY, frame.timestampMs),
      );
    }
  }
  const earliestTimestampFrom = new Array<number>(cutoffs.length);
  for (let index = cutoffs.length - 1; index >= 0; index -= 1) {
    earliestTimestampFrom[index] = Math.min(
      cutoffs[index]!.timestampMs,
      earliestTimestampFrom[index + 1] ?? Number.POSITIVE_INFINITY,
    );
  }

  return (audioFrame) => {
    let low = 0;
    let high = cutoffs.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (cutoffs[middle]!.throughSequence < audioFrame.sequence) low = middle + 1;
      else high = middle;
    }
    const sequenceCutoff = earliestTimestampFrom[low];
    const pendingTurnCutoffMs = audioFrame.turnId
      ? pendingTurnCutoff.get(audioFrame.turnId)
      : undefined;
    const values = [sequenceCutoff, pendingTurnCutoffMs].filter(
      (value): value is number => value !== undefined,
    );
    return values.length > 0 ? Math.min(...values) : undefined;
  };
}

function isAudioFrame(frame: AudioTapFrame): frame is AudioTapAudioFrame {
  return frame.type === "audio";
}

function validateAudioFrame(frame: AudioTapAudioFrame): number {
  if (
    frame.format.encoding !== "pcm_s16le" ||
    frame.format.channels !== 1 ||
    frame.format.sampleRateHz !== RECORDING_SAMPLE_RATE_HZ
  ) {
    throw new Error("This example WAV writer expects mono 16 kHz pcm_s16le audio");
  }
  if (frame.bytes.byteLength % 2 !== 0) {
    throw new Error("An audio tap frame contains an incomplete PCM16 sample");
  }
  if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) {
    throw new Error("An audio tap frame has an invalid runtime timestamp");
  }

  return frame.bytes.byteLength / 2;
}

function timestampSample(frame: AudioTapAudioFrame): number {
  const sample = Math.round((frame.timestampMs * RECORDING_SAMPLE_RATE_HZ) / 1_000);
  if (!Number.isSafeInteger(sample)) {
    throw new Error("Audio tap recording exceeds the example WAV size limit");
  }
  return sample;
}
