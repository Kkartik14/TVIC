import WebSocket from "ws";

import {
  normalizeUnknownError,
  nowTimestamp,
  providerError,
  STT_STREAM_ENDED_REASON,
  validationError,
} from "@tvic/core";
import type { AudioFormat, NormalizedError, Timestamp } from "@tvic/core";

export { providerError, unknownErrorMessage, validationError } from "@tvic/core";

export function providerStreamEnded(provider: string, code: string): NormalizedError {
  return providerError(code, `${provider} STT stream has ended`, {
    provider,
    retriable: false,
    metadata: { reason: STT_STREAM_ENDED_REASON },
  });
}

export function assertSupportedModel(
  provider: string,
  models: readonly string[],
  model: string,
  allowUnknownModel = false,
): void {
  if (allowUnknownModel || models.includes(model)) {
    return;
  }
  throw validationError("stt.model_unsupported", `${provider} does not support model ${model}`, {
    provider,
    metadata: { model, supportedModels: models },
  });
}

export function assertSttPcm16leFormat(format: AudioFormat): void {
  if (format.encoding !== "pcm_s16le") {
    throw validationError(
      "stt.audio_format_invalid",
      `STT adapters require pcm_s16le audio, received ${format.encoding}`,
    );
  }
  if (format.channels !== 1) {
    throw validationError(
      "stt.audio_format_invalid",
      `STT adapters require mono audio, received ${format.channels} channels`,
    );
  }
}

export function assertSttSampleRate(
  provider: string,
  sampleRateHz: number,
  supportedRatesHz: readonly number[],
): void {
  if (supportedRatesHz.includes(sampleRateHz)) {
    return;
  }
  throw validationError(
    "stt.sample_rate_unsupported",
    `${provider} STT supports sample rates ${supportedRatesHz.join(", ")} Hz, received ${sampleRateHz} Hz`,
    { provider, metadata: { sampleRateHz, supportedRatesHz } },
  );
}

export interface ProviderClock {
  now(): Timestamp;
}

export class SystemProviderClock implements ProviderClock {
  now(): Timestamp {
    return nowTimestamp();
  }
}

/** The minimal socket surface shared by `ws` and the Twilio media-stream socket. */
export interface WsLike {
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

/**
 * Sends on a socket only while it is OPEN, swallowing the race where the peer
 * closes between the readyState check and the write. A realtime send must never
 * throw into the call loop (that would misclassify a turn as failed). Returns
 * whether the frame was actually written.
 */
export function safeSend(socket: WsLike, data: string | Buffer): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

/** Closes a socket without throwing if it is already closing/closed. */
export function safeClose(socket: WsLike): void {
  try {
    socket.close();
  } catch {
    // The socket is already torn down, nothing to do.
  }
}

/** Default ceiling for a provider WebSocket handshake before it is abandoned. */
export const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;

export interface OpenWebSocketOptions {
  readonly timeoutMs?: number;
  /** Aborts the handshake (closing the socket), e.g. a caller-level startup timeout. */
  readonly signal?: AbortSignal;
}

/**
 * Resolves once the socket is open; rejects with the raw socket error, a connect
 * timeout, or an external abort, closing the socket in every failure case. A hung
 * connect must never wedge the call, and a timed-out startup must not leak a socket.
 */
export function openWebSocket(
  socket: WebSocket,
  options: OpenWebSocketOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? WEBSOCKET_CONNECT_TIMEOUT_MS;
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      safeClose(socket);
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      safeClose(socket);
      reject(new Error("WebSocket connect aborted"));
    };
    const timer = setTimeout(() => {
      cleanup();
      safeClose(socket);
      reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("open", onOpen);
    socket.on("error", onError);
  });
}

export interface NormalizeProviderErrorOptions {
  readonly code: string;
  readonly provider: string;
  readonly retriable?: boolean;
}

/** Pass an already-normalized error through unchanged; otherwise wrap it. */
export function normalizeProviderError(
  error: unknown,
  options: NormalizeProviderErrorOptions,
): NormalizedError {
  return normalizeUnknownError(error, {
    code: options.code,
    provider: options.provider,
    category: "provider",
    ...(options.retriable !== undefined ? { retriable: options.retriable } : {}),
  });
}

export function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}
