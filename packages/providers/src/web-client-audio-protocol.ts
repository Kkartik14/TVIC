import type { AudioFormat } from "@tvic/core";
import { isSampleRateHz } from "@tvic/core";
import type { WebClientAudioSocket } from "./web-client-audio.js";

export type WebClientAudioMode = "push_to_talk" | "continuous";

export const MAX_WEB_CONTROL_FRAME_BYTES = 4_096;
export const MAX_WEB_AUDIO_SEQUENCE = 0xffff_ffff;
export const PENDING_ACCEPT_TIMEOUT_MS = 30_000;

export function isMode(value: unknown): value is WebClientAudioMode {
  return value === "push_to_talk" || value === "continuous";
}

export function normalizeSequenceRange(
  value: readonly unknown[],
): readonly [number, number] | null {
  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end > MAX_WEB_AUDIO_SEQUENCE
  ) {
    return null;
  }
  return [start, end];
}

export function parseAudioFormat(value: unknown): AudioFormat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    !isNormalizedAudioEncoding(record.encoding) ||
    !isSampleRateHz(record.sampleRateHz) ||
    !isChannelLayout(record.channels)
  ) {
    return null;
  }
  return {
    encoding: record.encoding,
    sampleRateHz: record.sampleRateHz,
    channels: record.channels,
  };
}

function isNormalizedAudioEncoding(value: unknown): value is AudioFormat["encoding"] {
  return value === "pcm_s16le" || value === "pcm_s16be" || value === "pcm_f32le";
}

function isChannelLayout(value: unknown): value is AudioFormat["channels"] {
  return value === 1 || value === 2;
}

export function closeSocket(socket: WebClientAudioSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Pending transport teardown is best-effort.
  }
}
