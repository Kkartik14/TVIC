import WebSocket from "ws";

import {
  cancelledError,
  normalizeUnknownError,
  normalizeLegacyError,
  nowTimestamp,
  providerError,
  isNormalizedError,
  STT_ERROR_CODES,
  STT_STREAM_ENDED_REASON,
  timeoutError,
  unknownErrorMessage,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type { AudioFormat, NormalizedError, Timestamp } from "@tvic/core";

export { providerError, unknownErrorMessage, validationError } from "@tvic/core";

export function providerStreamEnded(provider: string, code: string): NormalizedError {
  return TvicThrowableError.from(
    providerError(code, `${provider} STT stream has ended`, {
      provider,
      retriable: false,
      metadata: { reason: STT_STREAM_ENDED_REASON },
    }),
  );
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
  throw TvicThrowableError.from(
    validationError("stt.model_unsupported", `${provider} does not support model ${model}`, {
      provider,
      metadata: { model, supportedModels: models },
    }),
  );
}

export function assertSttPcm16leFormat(format: AudioFormat): void {
  if (format.encoding !== "pcm_s16le") {
    throw TvicThrowableError.from(
      validationError(
        "stt.audio_format_invalid",
        `STT adapters require pcm_s16le audio, received ${format.encoding}`,
      ),
    );
  }
  if (format.channels !== 1) {
    throw TvicThrowableError.from(
      validationError(
        "stt.audio_format_invalid",
        `STT adapters require mono audio, received ${format.channels} channels`,
      ),
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
  throw TvicThrowableError.from(
    validationError(
      "stt.sample_rate_unsupported",
      `${provider} STT supports sample rates ${supportedRatesHz.join(", ")} Hz, received ${sampleRateHz} Hz`,
      { provider, metadata: { sampleRateHz, supportedRatesHz } },
    ),
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
 * closes between the readyState check and the write. Returns whether the frame
 * was actually written; the owning adapter decides whether a false result is a
 * terminal failure or a best-effort teardown write.
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

export interface ProviderWriteOptions {
  readonly code: string;
  readonly provider: string;
  readonly operation: "audio" | "commit" | "initialize" | "keepalive" | "close";
}

/**
 * Turns a failed transport write into an observable provider failure. A boolean
 * `safeSend` result is useful at low-level transport call sites, but STT adapters
 * must not turn a dropped audio/control frame into a successful Promise<void>.
 */
export function writeProviderFrame(
  socket: WsLike,
  data: string | Buffer,
  options: ProviderWriteOptions,
): void {
  if (safeSend(socket, data)) {
    return;
  }
  throw TvicThrowableError.from(
    providerError(
      STT_ERROR_CODES.transportWriteFailed,
      `${options.provider} ${options.operation} write was not accepted by the socket`,
      {
        provider: options.provider,
        retriable: true,
        metadata: { operation: options.operation, providerCode: options.code },
      },
    ),
  );
}

/** Closes a socket without throwing if it is already closing/closed. */
export function safeClose(socket: WsLike): void {
  try {
    socket.close();
  } catch {
    // The socket is already torn down, nothing to do.
  }
}

/** Preserves provider WebSocket close evidence on normalized stream failures. */
export function socketCloseMetadata(
  code: number,
  reason?: Buffer,
): Readonly<Record<string, unknown>> {
  return {
    wsCloseCode: code,
    ...(reason && reason.length > 0 ? { wsCloseReason: reason.toString("utf8") } : {}),
  };
}

/** Default ceiling for a provider WebSocket handshake before it is abandoned. */
export const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;

export interface OpenWebSocketOptions {
  readonly timeoutMs?: number;
  /** Aborts the handshake (closing the socket), e.g. a caller-level startup timeout. */
  readonly signal?: AbortSignal;
}

interface WebSocketConnectFailure extends Error {
  readonly wsCloseCode?: number;
  readonly wsCloseReason?: string;
}

/**
 * Resolves once the socket is open; rejects with the raw socket error or a
 * throwable TVIC timeout/cancellation error, closing the socket in every
 * failure case. A hung connect must never wedge the call, and a timed-out
 * startup must not leak a socket.
 */
export function openWebSocket(
  socket: WebSocket,
  options: OpenWebSocketOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? WEBSOCKET_CONNECT_TIMEOUT_MS;
  if (options.signal?.aborted) {
    safeClose(socket);
    return Promise.reject(
      TvicThrowableError.from(
        cancelledError("provider.connection_cancelled", "WebSocket connect was cancelled"),
      ),
    );
  }
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
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
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      const message = `WebSocket closed before open${code ? ` (code ${code})` : ""}`;
      const error = new Error(message) as WebSocketConnectFailure;
      Object.defineProperties(error, {
        wsCloseCode: { configurable: true, enumerable: false, value: code },
        wsCloseReason: {
          configurable: true,
          enumerable: false,
          value: reason?.toString() ?? "",
        },
      });
      safeClose(socket);
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      safeClose(socket);
      reject(
        TvicThrowableError.from(
          cancelledError("provider.connection_cancelled", "WebSocket connect was cancelled"),
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      safeClose(socket);
      reject(
        TvicThrowableError.from(
          timeoutError(
            "provider.connection_timeout",
            `WebSocket connect timed out after ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("close", onClose);
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

/** Converts any provider failure into the throwable form exposed by streams. */
export function providerThrowableError(
  error: unknown,
  options: NormalizeProviderErrorOptions,
): TvicThrowableError {
  return TvicThrowableError.from(normalizeProviderError(error, options));
}

/** Classifies handshake failures before reconnect policy sees them. */
export function normalizeSttConnectionError(
  error: unknown,
  options: { readonly provider: string; readonly providerCode: string },
): NormalizedError {
  if (isNormalizedError(error)) {
    return error;
  }
  const legacy = normalizeLegacyError(error);
  if (legacy) {
    return legacy;
  }
  const message = unknownErrorMessage(error);
  const status = message.match(/\b(400|401|402|403|410|422|429|5\d\d)\b/)?.[1];
  const connectFailure = error as {
    readonly wsCloseCode?: unknown;
    readonly wsCloseReason?: unknown;
  };
  const wsCloseCode =
    typeof connectFailure.wsCloseCode === "number" ? connectFailure.wsCloseCode : undefined;
  const code =
    status === "401" || status === "403"
      ? "stt.provider.auth_failed"
      : status === "402"
        ? "stt.provider.quota_exceeded"
        : status === "429"
          ? "stt.provider.rate_limited"
          : status === "400" || status === "410" || status === "422"
            ? "stt.provider.invalid_request"
            : status?.startsWith("5")
              ? "stt.provider.service_unavailable"
              : wsCloseCode !== undefined && wsCloseCode !== 1006
                ? STT_ERROR_CODES.protocolError
                : "stt.transport.connect_failed";
  return providerError(code, message, {
    provider: options.provider,
    retriable:
      code === "stt.transport.connect_failed" || code === "stt.provider.service_unavailable",
    metadata: {
      providerCode: options.providerCode,
      ...(status ? { httpStatus: Number(status) } : {}),
      ...(wsCloseCode !== undefined ? { wsCloseCode } : {}),
      ...(typeof connectFailure.wsCloseReason === "string"
        ? { wsCloseReason: connectFailure.wsCloseReason }
        : {}),
    },
    cause: error,
  });
}

/** Normalizes an already-open socket error without parsing vendor text. */
export function normalizeSttSocketError(
  error: unknown,
  options: { readonly provider: string; readonly providerCode: string },
): NormalizedError {
  if (isNormalizedError(error)) {
    return error;
  }
  const legacy = normalizeLegacyError(error);
  if (legacy) {
    return legacy;
  }
  return providerError(STT_ERROR_CODES.connectFailed, unknownErrorMessage(error), {
    provider: options.provider,
    retriable: true,
    metadata: { providerCode: options.providerCode },
    cause: error,
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
