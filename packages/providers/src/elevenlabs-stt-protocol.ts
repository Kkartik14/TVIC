import WebSocket from "ws";

import type { AudioFormat } from "@tvic/core";
import { PROVIDER_NAMES, STT_ERROR_CODES, TvicThrowableError } from "@tvic/core";

import type { ElevenLabsEntityDetection } from "./elevenlabs-batch-stt.js";
import {
  assertSttPcm16leFormat,
  providerError,
  socketCloseMetadata,
  validationError,
} from "./common.js";

export type ElevenLabsSttCommitStrategy = "manual" | "vad";
export type { ElevenLabsEntityDetection } from "./elevenlabs-batch-stt.js";

export interface ElevenLabsMessage {
  readonly message_type?: string;
  readonly text?: unknown;
  readonly error?: unknown;
  readonly language_code?: unknown;
  readonly words?: unknown;
  readonly [key: string]: unknown;
}

export interface PendingElevenLabsCommit {
  readonly committed: ElevenLabsMessage;
  readonly text: string;
  timestamped?: ElevenLabsMessage;
  entities?: readonly Readonly<Record<string, unknown>>[];
}

export function boundedElevenLabsWords(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4_096) return null;
  const words: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const word = entry as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    if (word.text !== undefined) {
      if (typeof word.text !== "string" || word.text.length > 256) return null;
      normalized.text = word.text;
    }
    for (const key of ["type"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "string" || word[key].length > 128) return null;
        normalized[key] = word[key];
      }
    }
    if (word.speaker_id !== undefined) {
      if (
        word.speaker_id !== null &&
        (typeof word.speaker_id !== "string" || word.speaker_id.length > 128)
      ) {
        return null;
      }
      normalized.speaker_id = word.speaker_id;
    }
    if (word.channel_index !== undefined) {
      if (
        word.channel_index !== null &&
        (typeof word.channel_index !== "number" ||
          !Number.isSafeInteger(word.channel_index) ||
          word.channel_index < 0)
      ) {
        return null;
      }
      normalized.channel_index = word.channel_index;
    }
    for (const key of ["start", "end"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "number" || !Number.isFinite(word[key]) || word[key] < 0) {
          return null;
        }
        normalized[key] = word[key];
      }
    }
    if (typeof word.start === "number" && typeof word.end === "number" && word.end < word.start) {
      return null;
    }
    if (word.logprob !== undefined) {
      if (typeof word.logprob !== "number" || !Number.isFinite(word.logprob)) return null;
      normalized.logprob = word.logprob;
    }
    words.push(normalized);
  }
  return words;
}

export function boundedElevenLabsEntities(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4_096) return null;
  const entities: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const entity: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(entry)) {
      if (key.length > 128 || Object.keys(entity).length >= 32) return null;
      if (typeof field === "string") {
        if (field.length > 1_024) return null;
        entity[key] = field;
      } else if (typeof field === "number") {
        if (!Number.isFinite(field)) return null;
        entity[key] = field;
      } else if (typeof field === "boolean") {
        entity[key] = field;
      } else {
        return null;
      }
    }
    entities.push(entity);
  }
  return entities;
}

export function isElevenLabsError(message: ElevenLabsMessage): boolean {
  return (
    message.error !== undefined ||
    message.message_type === "error" ||
    message.message_type === "auth_error" ||
    message.message_type === "quota_exceeded" ||
    message.message_type === "rate_limited" ||
    message.message_type === "transcriber_error" ||
    message.message_type === "input_error" ||
    message.message_type === "invalid_request" ||
    message.message_type === "commit_throttled" ||
    message.message_type === "unaccepted_terms" ||
    message.message_type === "queue_overflow" ||
    message.message_type === "resource_exhausted" ||
    message.message_type === "session_time_limit_exceeded" ||
    message.message_type === "chunk_size_exceeded" ||
    message.message_type === "insufficient_audio_activity"
  );
}

export function elevenLabsCloseError(code = 1006, reason?: Buffer) {
  const normalizedCode =
    code === 1006 ? STT_ERROR_CODES.unexpectedEof : STT_ERROR_CODES.protocolError;
  return providerError(
    normalizedCode,
    normalizedCode === STT_ERROR_CODES.unexpectedEof
      ? "ElevenLabs STT socket closed unexpectedly"
      : `ElevenLabs STT socket closed with code ${code}`,
    {
      provider: PROVIDER_NAMES.elevenlabsStt,
      retriable: normalizedCode === STT_ERROR_CODES.unexpectedEof,
      metadata: socketCloseMetadata(code, reason),
    },
  );
}

export function elevenLabsProtocolError(message: ElevenLabsMessage) {
  const type = typeof message.message_type === "string" ? message.message_type : "error";
  const code =
    type === "auth_error"
      ? "stt.provider.auth_failed"
      : type === "quota_exceeded"
        ? "stt.provider.quota_exceeded"
        : type === "rate_limited" || type === "commit_throttled"
          ? "stt.provider.rate_limited"
          : type === "input_error" ||
              type === "chunk_size_exceeded" ||
              type === "insufficient_audio_activity"
            ? "stt.provider.input_rejected"
            : type === "session_time_limit_exceeded"
              ? "stt.provider.session_expired"
              : type === "invalid_request" || type === "unaccepted_terms"
                ? "stt.provider.invalid_request"
                : "stt.provider.protocol_error";
  return providerError(
    code,
    typeof message.error === "string"
      ? boundedErrorMessage(message.error)
      : `ElevenLabs STT ${type}`,
    {
      provider: PROVIDER_NAMES.elevenlabsStt,
      retriable: false,
      metadata: { providerCode: type },
    },
  );
}

function boundedErrorMessage(value: string): string {
  return value.length <= 1_024 ? value : value.slice(0, 1_021) + "...";
}

export function closeElevenLabsSocket(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // The socket is already torn down.
  }
  if (socket.readyState === WebSocket.CLOSED || typeof socket.terminate !== "function") return;
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 250);
  timer.unref?.();
}

export function assertElevenLabsSttFormat(format: unknown): asserts format is AudioFormat {
  if (typeof format !== "object" || format === null) {
    throw TvicThrowableError.from(
      validationError("stt.audio_format_invalid", "ElevenLabs STT audio format is invalid", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  assertSttPcm16leFormat(format as AudioFormat);
}

export function assertElevenLabsSttModel(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "ElevenLabs STT model id is invalid", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
}

export function assertElevenLabsRealtimeOptions(options: {
  readonly commitStrategy: ElevenLabsSttCommitStrategy;
  readonly secondaryLanguages: readonly string[] | undefined;
  readonly noVerbatim: boolean | undefined;
  readonly entityDetection: ElevenLabsEntityDetection | undefined;
  readonly filterBackgroundAudio: boolean | undefined;
  readonly enableLogging: boolean | undefined;
  readonly previousText: string | undefined;
}): void {
  if (options.commitStrategy !== "manual" && options.commitStrategy !== "vad") {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "ElevenLabs commitStrategy is invalid", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
  if (
    options.secondaryLanguages !== undefined &&
    (!Array.isArray(options.secondaryLanguages) ||
      options.secondaryLanguages.some(
        (language) => typeof language !== "string" || language.length === 0 || language.length > 64,
      ))
  ) {
    throw TvicThrowableError.from(
      validationError(
        "provider.invalid_request",
        "ElevenLabs secondaryLanguages must contain non-empty language codes",
        { provider: PROVIDER_NAMES.elevenlabsStt },
      ),
    );
  }
  if (options.entityDetection !== undefined) {
    const entities =
      typeof options.entityDetection === "string"
        ? [options.entityDetection]
        : options.entityDetection;
    if (
      !Array.isArray(entities) ||
      entities.length === 0 ||
      entities.length > 65 ||
      entities.some(
        (entity) => typeof entity !== "string" || entity.length === 0 || entity.length > 128,
      )
    ) {
      throw TvicThrowableError.from(
        validationError(
          "provider.invalid_request",
          "ElevenLabs entityDetection must contain one to 65 bounded entity types",
          { provider: PROVIDER_NAMES.elevenlabsStt },
        ),
      );
    }
  }
  for (const [name, value] of [
    ["noVerbatim", options.noVerbatim],
    ["filterBackgroundAudio", options.filterBackgroundAudio],
    ["enableLogging", options.enableLogging],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw TvicThrowableError.from(
        validationError("provider.invalid_request", `ElevenLabs ${name} must be a boolean`, {
          provider: PROVIDER_NAMES.elevenlabsStt,
        }),
      );
    }
  }
  if (
    options.previousText !== undefined &&
    (typeof options.previousText !== "string" || options.previousText.length > 4_096)
  ) {
    throw TvicThrowableError.from(
      validationError("provider.invalid_request", "ElevenLabs previousText is too long", {
        provider: PROVIDER_NAMES.elevenlabsStt,
      }),
    );
  }
}
