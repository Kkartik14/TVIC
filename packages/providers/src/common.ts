import WebSocket from "ws";

import {
  cancelledError,
  providerError as coreProviderError,
  normalizeUnknownError,
  normalizeLegacyError,
  nowTimestamp,
  isNormalizedError,
  STT_ERROR_CODES,
  STT_STREAM_ENDED_REASON,
  TVIC_ERROR_CODE_ALIASES,
  TVIC_ERROR_CODES,
  timeoutError,
  unknownErrorMessage,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type { AudioFormat, NormalizedError, Timestamp } from "@tvic/core";

export { unknownErrorMessage, validationError } from "@tvic/core";

const LEGACY_PROVIDER_ERROR_CODES: Readonly<Record<string, string>> = TVIC_ERROR_CODE_ALIASES;

const CANONICAL_NON_RETRIABLE_PROVIDER_CODES = new Set<string>([
  TVIC_ERROR_CODES.providerAuthFailed,
  TVIC_ERROR_CODES.providerInvalidRequest,
  TVIC_ERROR_CODES.providerInputRejected,
  TVIC_ERROR_CODES.providerProtocolInvalid,
  TVIC_ERROR_CODES.providerSessionExpired,
]);

interface ProviderErrorOptions {
  readonly retriable?: boolean;
  readonly provider?: string;
  readonly cause?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Creates the canonical provider error exposed by adapter streams. Legacy STT
 * provider codes are accepted at this internal boundary, but callers receive
 * the 1.1.0 code and a bounded legacyCode diagnostic for one compatibility
 * cycle. Vendor wire values belong in metadata, never in `error.code`.
 */
export function providerError(
  code: string,
  message: string,
  options: ProviderErrorOptions = {},
): NormalizedError {
  const canonicalCode = LEGACY_PROVIDER_ERROR_CODES[code] ?? code;
  const legacyCode = canonicalCode === code ? undefined : code;
  const metadata =
    options.metadata !== undefined || legacyCode !== undefined
      ? {
          ...(options.metadata ?? {}),
          ...(legacyCode !== undefined ? { legacyCode } : {}),
        }
      : undefined;
  const retriable =
    canonicalCode === TVIC_ERROR_CODES.providerRateLimited
      ? true
      : CANONICAL_NON_RETRIABLE_PROVIDER_CODES.has(canonicalCode)
        ? false
        : options.retriable;
  return coreProviderError(canonicalCode, message, {
    ...options,
    ...(retriable !== undefined ? { retriable } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

function canonicalizeProviderError(error: NormalizedError): NormalizedError {
  if (error.category !== "provider") return error;
  const canonicalCode = LEGACY_PROVIDER_ERROR_CODES[error.code] ?? error.code;
  if (canonicalCode === error.code) return error;
  return {
    ...error,
    code: canonicalCode,
    retriable:
      canonicalCode === TVIC_ERROR_CODES.providerRateLimited
        ? true
        : CANONICAL_NON_RETRIABLE_PROVIDER_CODES.has(canonicalCode)
          ? false
          : error.retriable,
    metadata: {
      ...(error.metadata ?? {}),
      legacyCode: error.code,
    },
  };
}

export function providerStreamEnded(provider: string, code: string): NormalizedError {
  return TvicThrowableError.from(
    providerError(code, `${provider} STT stream has ended`, {
      provider,
      retriable: false,
      metadata: { reason: STT_STREAM_ENDED_REASON },
    }),
  );
}

/**
 * Creates the terminal failure used when an adapter's event consumer falls
 * behind its bounded queue. Dropping a provider event would make the runtime
 * state incomplete, so adapters fail the stream and close the transport.
 */
export function providerEventQueueOverflow(
  provider: string,
  code: string = TVIC_ERROR_CODES.providerStreamBufferOverflow,
): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(code, `${provider} event queue exceeded its bounded capacity`, {
      provider,
      retriable: false,
    }),
  );
}

/** Creates the bounded terminal error for a raw provider frame that is too large. */
export function providerFrameTooLarge(provider: string): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(
      TVIC_ERROR_CODES.providerStreamBufferOverflow,
      `${provider} inbound frame exceeded ${MAX_PROVIDER_FRAME_BYTES} bytes`,
      {
        provider,
        retriable: false,
        metadata: { maxFrameBytes: MAX_PROVIDER_FRAME_BYTES },
      },
    ),
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
    validationError(
      TVIC_ERROR_CODES.providerModelUnsupported,
      `${provider} does not support model ${model}`,
      {
        provider,
        metadata: { model, supportedModels: models },
      },
    ),
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
  /** Bytes accepted by the implementation but not yet flushed to the peer. */
  readonly bufferedAmount?: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

/** Hard ceiling shared by provider WebSocket clients before JSON parsing. */
export const MAX_PROVIDER_FRAME_BYTES = 1_048_576;

/** Stop queueing new provider output once the socket has this much pending data. */
export const PROVIDER_OUTBOUND_HIGH_WATER_BYTES = 512 * 1024;
/** Close the provider transport rather than allowing its outbound queue to grow further. */
export const PROVIDER_OUTBOUND_HARD_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Lifetime ceilings for provider streams. A bounded event queue protects a
 * slow consumer, but a healthy consumer could otherwise leave a long-lived
 * LLM/TTS session retaining unbounded completion metadata.
 */
export const MAX_PROVIDER_LLM_OUTPUT_CHARS = 4_194_304;
export const MAX_PROVIDER_LLM_TOOL_ARGUMENT_CHARS = 1_048_576;
export const MAX_PROVIDER_LLM_TOOL_CALLS = 128;
export const MAX_PROVIDER_LLM_TOOL_FIELD_CHARS = 4_096;
export const MAX_PROVIDER_TTS_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MAX_PROVIDER_TTS_OUTPUT_CHUNKS = 16_384;
export const MAX_PROVIDER_TTS_PENDING_FLUSHES = 1_024;

export type ProviderSendCapacity = "open" | "high_water" | "hard_limit";

/**
 * Evaluates a prospective provider write against the socket's pending-byte
 * budget. Custom socket implementations that do not expose `bufferedAmount`
 * retain the old open/closed behavior; real `ws` sockets expose it and are
 * bounded before every output frame is accepted.
 */
export function providerSendCapacity(socket: WsLike, data: string | Buffer): ProviderSendCapacity {
  const bufferedAmount = socket.bufferedAmount;
  if (bufferedAmount === undefined) return "open";
  if (!Number.isSafeInteger(bufferedAmount) || bufferedAmount < 0) return "hard_limit";
  const frameBytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  const pendingBytes = bufferedAmount + frameBytes;
  if (!Number.isSafeInteger(pendingBytes) || pendingBytes > PROVIDER_OUTBOUND_HARD_LIMIT_BYTES) {
    return "hard_limit";
  }
  if (pendingBytes > PROVIDER_OUTBOUND_HIGH_WATER_BYTES) return "high_water";
  return "open";
}

export function rawDataByteLength(raw: WebSocket.RawData): number {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (Array.isArray(raw)) {
    let total = 0;
    for (const chunk of raw) {
      if (!Buffer.isBuffer(chunk)) return Number.POSITIVE_INFINITY;
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total)) return Number.POSITIVE_INFINITY;
    }
    return total;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Normalizes a ws RawData value only after its complete byte length is known.
 * In particular, fragmented Buffer[] frames are never concatenated before the
 * caller's size ceiling is checked.
 */
export function rawDataToBuffer(
  raw: WebSocket.RawData,
  maxBytes = MAX_PROVIDER_FRAME_BYTES,
): Buffer {
  const byteLength = rawDataByteLength(raw);
  if (!Number.isSafeInteger(byteLength) || byteLength > maxBytes) {
    throw new Error(`WebSocket frame exceeded ${maxBytes} bytes`);
  }
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw, byteLength);
  throw new Error("Unsupported WebSocket frame representation");
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
  if (providerSendCapacity(socket, data) !== "open") {
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
    if (socket.readyState === WebSocket.CONNECTING) {
      const eventful = socket as WsLike & {
        once?: (event: "error", listener: () => void) => unknown;
      };
      eventful.once?.("error", () => undefined);
    }
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
    // AbortSignal does not replay an abort event to listeners added after the
    // transition. Recheck after registration to close the small check/
    // subscribe race without leaving a handshake until its timeout.
    if (options.signal?.aborted) onAbort();
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
  return canonicalizeProviderError(
    normalizeUnknownError(error, {
      code: options.code,
      provider: options.provider,
      category: "provider",
      ...(options.retriable !== undefined ? { retriable: options.retriable } : {}),
    }),
  );
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
    return canonicalizeProviderError(error);
  }
  const legacy = normalizeLegacyError(error);
  if (legacy) {
    return canonicalizeProviderError(legacy);
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
    return canonicalizeProviderError(error);
  }
  const legacy = normalizeLegacyError(error);
  if (legacy) {
    return canonicalizeProviderError(legacy);
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
