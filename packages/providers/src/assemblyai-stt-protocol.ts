import {
  cancelledError,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  STT_ERROR_CODES,
  timeoutError,
  TvicThrowableError,
} from "@tvic/core";

import { providerError, socketCloseMetadata } from "./common.js";

export const ASSEMBLYAI_PROVIDER = PROVIDER_NAMES.assemblyaiStt;
export const ASSEMBLYAI_ERROR_CODE = PROVIDER_ERROR_CODES.assemblyaiStt;
export const ASSEMBLYAI_DEFAULT_URL = "wss://streaming.assemblyai.com/v3/ws";
export const ASSEMBLYAI_MIN_FRAME_MS = 50;
export const ASSEMBLYAI_TARGET_FRAME_MS = 100;
export const ASSEMBLYAI_CLOSE_TIMEOUT_MS = 2_000;
export const ASSEMBLYAI_BEGIN_TIMEOUT_MS = 10_000;
export const ASSEMBLYAI_MAX_PENDING_TURNS = 64;
export const ASSEMBLYAI_MAX_PENDING_TURN_BYTES = 64 * 1024;
export const ASSEMBLYAI_ERROR_CONTEXT = {
  provider: ASSEMBLYAI_PROVIDER,
  providerCode: ASSEMBLYAI_ERROR_CODE,
};

export interface AssemblyAiBeginMessage {
  readonly type: "Begin";
  readonly id?: unknown;
  readonly expires_at?: unknown;
}

export interface AssemblyAiTurnMessage {
  readonly type: "Turn";
  readonly turn_order?: unknown;
  readonly turn_is_formatted?: unknown;
  readonly end_of_turn?: unknown;
  readonly transcript?: unknown;
  readonly utterance?: unknown;
  readonly end_of_turn_confidence?: unknown;
  readonly words?: unknown;
  readonly language_code?: unknown;
  readonly language_confidence?: unknown;
  readonly speaker_label?: unknown;
  readonly speaker_confidence?: unknown;
}

export interface AssemblyAiSpeechStartedMessage {
  readonly type: "SpeechStarted";
  readonly timestamp?: unknown;
  readonly confidence?: unknown;
}

export interface AssemblyAiTerminationMessage {
  readonly type: "Termination";
}

export interface AssemblyAiErrorMessage {
  readonly type: "Error" | "error";
  readonly error?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

export type AssemblyAiMessage =
  | AssemblyAiBeginMessage
  | AssemblyAiTurnMessage
  | AssemblyAiSpeechStartedMessage
  | AssemblyAiTerminationMessage
  | AssemblyAiErrorMessage;

export function boundedAssemblyWords(
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
    for (const key of ["speaker", "speaker_label", "channel"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "string" || word[key].length > 128) return null;
        normalized[key] = word[key];
      }
    }
    for (const key of ["start", "end", "confidence"] as const) {
      if (word[key] !== undefined) {
        if (typeof word[key] !== "number" || !Number.isFinite(word[key])) return null;
        normalized[key] = word[key];
      }
    }
    words.push(normalized);
  }
  return words;
}

export function buildPrompt(
  basePrompt: string | undefined,
  language: string | undefined,
): string | undefined {
  return basePrompt && language
    ? `Transcribe ${language}. ${basePrompt}`
    : (basePrompt ?? (language ? `Transcribe ${language}.` : undefined));
}

export function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

export function bytesForMs(sampleRateHz: number, durationMs: number): number {
  return Math.round((sampleRateHz * durationMs * 2) / 1000);
}

export const validSilenceOption = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= 60_000);

function errorMessage(message: AssemblyAiErrorMessage): string {
  const candidate = [message.error, message.message].find(
    (value): value is string => typeof value === "string",
  );
  return candidate !== undefined
    ? boundedErrorMessage(candidate)
    : typeof message.code === "string"
      ? message.code
      : "AssemblyAI STT error";
}

const boundedErrorMessage = (value: string): string =>
  value.length <= 1_024 ? value : value.slice(0, 1_021) + "...";

export function assemblyAiCloseError(
  code = 1006,
  reason?: Buffer,
  sessionMetadata: Readonly<Record<string, unknown>> = {},
) {
  const normalizedCode =
    code === 1006
      ? STT_ERROR_CODES.unexpectedEof
      : code === 1008
        ? "stt.provider.auth_failed"
        : code === 1011 || code === 3005
          ? "stt.provider.service_unavailable"
          : code === 3008
            ? "stt.provider.input_rejected"
            : code === 3009
              ? "stt.provider.rate_limited"
              : code === 410 || code === 3006 || code === 3007
                ? "stt.provider.invalid_request"
                : STT_ERROR_CODES.protocolError;
  return providerError(
    normalizedCode,
    normalizedCode === STT_ERROR_CODES.unexpectedEof
      ? "AssemblyAI STT socket closed unexpectedly"
      : `AssemblyAI STT socket closed with code ${code}`,
    {
      provider: ASSEMBLYAI_PROVIDER,
      retriable:
        normalizedCode === STT_ERROR_CODES.unexpectedEof ||
        normalizedCode === "stt.provider.service_unavailable",
      metadata: {
        ...socketCloseMetadata(code, reason),
        assemblyai: sessionMetadata,
      },
    },
  );
}

export function assemblyAiProtocolError(message: AssemblyAiErrorMessage) {
  const providerCode =
    typeof message.code === "number" || typeof message.code === "string" ? message.code : undefined;
  const codeValue = typeof providerCode === "string" ? providerCode.toLowerCase() : "";
  const code =
    providerCode === 1008 || codeValue.includes("auth")
      ? "stt.provider.auth_failed"
      : providerCode === 1011 || providerCode === 3005
        ? "stt.provider.service_unavailable"
        : providerCode === 3008 || codeValue.includes("audio")
          ? "stt.provider.input_rejected"
          : providerCode === 3009 || codeValue.includes("rate") || codeValue.includes("limit")
            ? "stt.provider.rate_limited"
            : providerCode === 410 || providerCode === 3006 || providerCode === 3007
              ? "stt.provider.invalid_request"
              : "stt.provider.protocol_error";
  return providerError(code, errorMessage(message), {
    provider: ASSEMBLYAI_PROVIDER,
    retriable: code === "stt.provider.service_unavailable",
    metadata: { providerCode, assemblyai: message },
  });
}

export function assemblyAiProtocolFailure(message: string) {
  return providerError(STT_ERROR_CODES.protocolError, message, {
    provider: ASSEMBLYAI_PROVIDER,
    retriable: false,
  });
}

export function assemblyAiWriteFailure() {
  return providerError(
    STT_ERROR_CODES.transportWriteFailed,
    "AssemblyAI STT socket is not writable",
    {
      provider: ASSEMBLYAI_PROVIDER,
      metadata: { providerCode: ASSEMBLYAI_ERROR_CODE, operation: "audio" },
    },
  );
}

export function assemblyAiBeginCancelled(): TvicThrowableError {
  return TvicThrowableError.from(
    cancelledError("assemblyai.stt.begin_cancelled", "AssemblyAI STT startup was cancelled", {
      provider: ASSEMBLYAI_PROVIDER,
    }),
  );
}

export function assemblyAiBeginTimeout(): TvicThrowableError {
  return TvicThrowableError.from(
    timeoutError(
      "assemblyai.stt.begin_timeout",
      `AssemblyAI STT Begin timed out after ${ASSEMBLYAI_BEGIN_TIMEOUT_MS}ms`,
      { provider: ASSEMBLYAI_PROVIDER },
    ),
  );
}

export const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
