import type { InputMediaEvent, MediaEvent, MediaEventType, OutputMediaEvent } from "@tvic/core";

export function isInputMediaEvent(event: MediaEvent): event is InputMediaEvent {
  return event.direction === "input";
}

export function isOutputMediaEvent(event: MediaEvent): event is OutputMediaEvent {
  return event.direction === "output";
}

export {
  PCM16_BYTES_PER_SAMPLE,
  assertPcm16leFormat,
  base64ToBytes,
  bytesToBase64,
  durationMsForPcm16le,
  frameCountForPcm16le,
  mulawToPcm16le,
  pcm16leToMulaw,
  resamplePcm16le,
  splitPcm16leFrames,
} from "./audio-codec.js";
export { AsyncQueue } from "./async-queue.js";
export {
  createAudioNormalizer,
  type AudioNormalizer,
  type AudioNormalizerOptions,
} from "./audio-normalizer.js";

export type { InputMediaEvent, MediaEvent, MediaEventType, OutputMediaEvent };
