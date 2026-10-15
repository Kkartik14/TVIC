import { MAX_PROVIDER_FRAME_BYTES } from "./common.js";

export const WEB_CLIENT_AUDIO_DEFAULTS = {
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  maxSessionDurationMs: 45 * 60_000,
  maxBinaryFrameBytes: 65_536,
  maxInputBytesPerSecond: 128_000,
  maxPendingEvents: 512,
  maxInputFramesPerSecond: 200,
  maxPendingAcks: 128,
};

export const MAX_CONTROL_BYTES_PER_SECOND = 16_384;
export const MAX_CONTROL_FRAMES_PER_SECOND = 50;
export const MAX_INPUT_BYTES_PER_SECOND = 1_000_000;
export const MAX_INPUT_FRAMES_PER_SECOND = 1_000;
export const MAX_PENDING_EVENTS = 2_048;
const MIN_HEARTBEAT_INTERVAL_MS = 100;
const MIN_HEARTBEAT_TIMEOUT_MS = 200;
const MIN_WEB_CLIENT_AUDIO_FRAME_BYTES = 14;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export function boundedIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

export function positiveSafeIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

export interface WebClientAudioLimitOptions {
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxBinaryFrameBytes?: number;
  readonly maxInputBytesPerSecond?: number;
  readonly maxInputFramesPerSecond?: number;
  readonly maxPendingEvents?: number;
  readonly maxPendingAcks?: number;
}

export interface ResolvedWebClientAudioLimits {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxSessionDurationMs: number;
  readonly maxBinaryFrameBytes: number;
  readonly maxInputBytesPerSecond: number;
  readonly maxInputFramesPerSecond: number;
  readonly maxPendingEvents: number;
  readonly maxPendingAcks: number;
}

export function resolveWebClientAudioLimits(
  options: WebClientAudioLimitOptions,
): ResolvedWebClientAudioLimits {
  const configuredMaxBinaryFrameBytes = positiveSafeIntegerOption(
    "maxBinaryFrameBytes",
    options.maxBinaryFrameBytes,
    WEB_CLIENT_AUDIO_DEFAULTS.maxBinaryFrameBytes,
  );
  if (configuredMaxBinaryFrameBytes < MIN_WEB_CLIENT_AUDIO_FRAME_BYTES) {
    throw new RangeError("maxBinaryFrameBytes must be at least 14 bytes");
  }
  const heartbeatIntervalMs = boundedIntegerOption(
    "heartbeatIntervalMs",
    options.heartbeatIntervalMs,
    WEB_CLIENT_AUDIO_DEFAULTS.heartbeatIntervalMs,
    MIN_HEARTBEAT_INTERVAL_MS,
    60_000,
  );
  const heartbeatTimeoutMs = boundedIntegerOption(
    "heartbeatTimeoutMs",
    options.heartbeatTimeoutMs,
    WEB_CLIENT_AUDIO_DEFAULTS.heartbeatTimeoutMs,
    MIN_HEARTBEAT_TIMEOUT_MS,
    120_000,
  );
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new RangeError("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
  }
  const maxSessionDurationMs = boundedIntegerOption(
    "maxSessionDurationMs",
    options.maxSessionDurationMs,
    WEB_CLIENT_AUDIO_DEFAULTS.maxSessionDurationMs,
    1,
    MAX_NODE_TIMER_DELAY_MS,
  );
  return {
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    maxSessionDurationMs,
    maxBinaryFrameBytes: Math.min(configuredMaxBinaryFrameBytes, MAX_PROVIDER_FRAME_BYTES),
    maxInputBytesPerSecond: boundedIntegerOption(
      "maxInputBytesPerSecond",
      options.maxInputBytesPerSecond,
      WEB_CLIENT_AUDIO_DEFAULTS.maxInputBytesPerSecond,
      1,
      MAX_INPUT_BYTES_PER_SECOND,
    ),
    maxInputFramesPerSecond: boundedIntegerOption(
      "maxInputFramesPerSecond",
      options.maxInputFramesPerSecond,
      WEB_CLIENT_AUDIO_DEFAULTS.maxInputFramesPerSecond,
      1,
      MAX_INPUT_FRAMES_PER_SECOND,
    ),
    maxPendingEvents: boundedIntegerOption(
      "maxPendingEvents",
      options.maxPendingEvents,
      WEB_CLIENT_AUDIO_DEFAULTS.maxPendingEvents,
      1,
      MAX_PENDING_EVENTS,
    ),
    maxPendingAcks: Math.min(
      positiveSafeIntegerOption(
        "maxPendingAcks",
        options.maxPendingAcks,
        WEB_CLIENT_AUDIO_DEFAULTS.maxPendingAcks,
      ),
      WEB_CLIENT_AUDIO_DEFAULTS.maxPendingAcks,
    ),
  };
}
