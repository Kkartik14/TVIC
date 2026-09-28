import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  sameAudioFormat,
  TvicThrowableError,
} from "@tvic/core";
import type { AudioFormat } from "@tvic/core";
import { providerError } from "./common.js";

export function assertContextId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error("ElevenLabs contextId must be a non-empty bounded string");
  }
}

export function assertMultiContextFormat(format: AudioFormat): void {
  if (!sameAudioFormat(format, PCM16_16K_MONO)) {
    throw error("ElevenLabs multi-context TTS requires 16kHz PCM16 mono output");
  }
}

export function assertText(value: unknown): asserts value is string {
  if (typeof value !== "string") throw error("ElevenLabs text must be a string");
}

export function decodePcm(value: string): Uint8Array {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw error("ElevenLabs returned malformed base64 audio");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw error("ElevenLabs returned malformed PCM16 audio");
  }
  return bytes;
}

export interface ParsedAlignment {
  readonly tokens: readonly string[];
  readonly startMs: readonly number[];
  readonly endMs: readonly number[];
}

export function parseAlignment(value: unknown): ParsedAlignment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const alignment = value as Record<string, unknown>;
  const tokens = alignment.chars ?? alignment.characters;
  const starts =
    alignment.char_start_times_ms ??
    alignment.charStartTimesMs ??
    alignment.character_start_times_seconds ??
    alignment.characterStartTimesSeconds;
  const durations = alignment.char_durations_ms ?? alignment.charDurationsMs;
  const ends = alignment.character_end_times_seconds ?? alignment.characterEndTimesSeconds;
  if (!Array.isArray(tokens) || !Array.isArray(starts)) return null;
  const timingLength = Array.isArray(durations)
    ? durations.length
    : Array.isArray(ends)
      ? ends.length
      : -1;
  if (
    tokens.length === 0 ||
    tokens.length > 4096 ||
    tokens.length !== timingLength ||
    !tokens.every((token) => typeof token === "string")
  ) {
    return null;
  }
  if (!starts.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)) {
    return null;
  }
  const startMs = starts.map((time) =>
    "character_start_times_seconds" in alignment || "characterStartTimesSeconds" in alignment
      ? (time as number) * 1_000
      : (time as number),
  );
  if (Array.isArray(durations)) {
    if (
      !durations.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)
    ) {
      return null;
    }
    return {
      tokens: tokens as string[],
      startMs,
      endMs: (durations as number[]).map((duration, index) => startMs[index]! + duration),
    };
  }
  if (
    !Array.isArray(ends) ||
    !ends.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)
  ) {
    return null;
  }
  return {
    tokens: tokens as string[],
    startMs,
    endMs: (ends as number[]).map((time) =>
      "character_end_times_seconds" in alignment || "characterEndTimesSeconds" in alignment
        ? time * 1_000
        : time,
    ),
  };
}

export function boundedProviderMessage(value: unknown): string {
  const raw =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : "ElevenLabs multi-context synthesis failed";
  return raw.length <= 1_024 ? raw : `${raw.slice(0, 1_021)}...`;
}

function error(message: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(PROVIDER_ERROR_CODES.elevenlabsTts, message, {
      provider: PROVIDER_NAMES.elevenlabs,
      retriable: false,
    }),
  );
}
