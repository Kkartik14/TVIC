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
  TVIC_ERROR_CODES.providerQuotaExceeded,
  TVIC_ERROR_CODES.providerTransportWriteFailed,
  TVIC_ERROR_CODES.providerTransportTimeout,
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

export function canonicalizeLocale(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

export function providerConnectionCancelled(provider: string, message: string): NormalizedError {
  return cancelledError("provider.connection_cancelled", message, { provider });
}

export const DEFAULT_PROVIDER_CAPABILITY_SNAPSHOT_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_CAPABILITY_SNAPSHOT_TIMEOUT_MS = 2_147_483_647;

export interface ProviderCapabilitySnapshotDeadline {
  readonly signal: AbortSignal;
  readonly timeoutError: () => TvicThrowableError | undefined;
  readonly dispose: () => void;
}

export function createProviderCapabilitySnapshotDeadline(
  provider: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs = DEFAULT_PROVIDER_CAPABILITY_SNAPSHOT_TIMEOUT_MS,
): ProviderCapabilitySnapshotDeadline {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_PROVIDER_CAPABILITY_SNAPSHOT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Provider capability snapshot timeout must be an integer from 1 to ${MAX_PROVIDER_CAPABILITY_SNAPSHOT_TIMEOUT_MS}`,
    );
  }

  const timeoutController = new AbortController();
  let timeoutFailure: TvicThrowableError | undefined;
  const timer = setTimeout(() => {
    timeoutFailure = TvicThrowableError.from(
      timeoutError(
        TVIC_ERROR_CODES.providerTransportTimeout,
        `${provider} capability snapshot setup timed out after ${timeoutMs}ms`,
        { provider, metadata: { timeoutMs } },
      ),
    );
    timeoutController.abort(timeoutFailure);
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: callerSignal
      ? AbortSignal.any([callerSignal, timeoutController.signal])
      : timeoutController.signal,
    timeoutError: () => timeoutFailure,
    dispose: () => clearTimeout(timer),
  };
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

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("Provider response byte limit must be a non-negative safe integer");
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Provider response aborted");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const maxChunks = 65_536;
  let bytes = new Uint8Array(0);
  let totalBytes = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const result = await readResponseChunk(reader, signal);
      if (result.done) break;
      chunkCount += 1;
      if (chunkCount > maxChunks) {
        void reader.cancel().catch(() => undefined);
        throw new RangeError("Provider response exceeded its chunk limit");
      }
      const chunk = result.value;
      const nextTotalBytes = totalBytes + chunk.byteLength;
      if (nextTotalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new RangeError("Provider response exceeded its byte limit");
      }
      if (chunk.byteLength === 0) continue;
      if (bytes.byteLength < nextTotalBytes) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextTotalBytes, Math.max(1_024, bytes.byteLength * 2)),
        );
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(bytes.subarray(0, totalBytes));
        bytes = expanded;
      }
      bytes.set(chunk, totalBytes);
      totalBytes = nextTotalBytes;
    }
  } catch (error) {
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => undefined);
    throw error;
  }
  return decoder.decode(bytes.subarray(0, totalBytes));
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (!signal) return reader.read();
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error("Provider response aborted"));

  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>>(
    (resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason ?? new Error("Provider response aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void reader.read().then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    },
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
  monotonicNowMs?(): number;
}

export class SystemProviderClock implements ProviderClock {
  now(): Timestamp {
    return nowTimestamp();
  }

  monotonicNowMs(): number {
    return performance.now();
  }
}

export function providerMonotonicNowMs(clock: ProviderClock): number {
  const value = clock.monotonicNowMs?.();
  return typeof value === "number" && Number.isFinite(value) ? value : performance.now();
}

export interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | Buffer, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export const MAX_PROVIDER_FRAME_BYTES = 1_048_576;

export const PROVIDER_OUTBOUND_HIGH_WATER_BYTES = 512 * 1024;
export const PROVIDER_OUTBOUND_HARD_LIMIT_BYTES = 2 * 1024 * 1024;

export const MAX_PROVIDER_LLM_OUTPUT_CHARS = 4_194_304;
export const MAX_PROVIDER_LLM_TOOL_ARGUMENT_CHARS = 1_048_576;
export const MAX_PROVIDER_LLM_TOOL_CALLS = 128;
export const MAX_PROVIDER_LLM_TOOL_FIELD_CHARS = 4_096;
export const MAX_PROVIDER_TTS_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MAX_PROVIDER_TTS_OUTPUT_CHUNKS = 16_384;
export const MAX_PROVIDER_TTS_PENDING_FLUSHES = 1_024;
export const MAX_PROVIDER_METADATA_BYTES = 16 * 1024;
export const MAX_PROVIDER_METADATA_DEPTH = 4;
export const MAX_PROVIDER_METADATA_KEYS = 64;
export const MAX_PROVIDER_METADATA_STRING_CHARS = 4_096;

export function boundedProviderMetadata(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const bounded = boundMetadataValue(value, 0);
  if (typeof bounded !== "object" || bounded === null || Array.isArray(bounded)) {
    return undefined;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_PROVIDER_METADATA_BYTES) {
      return { truncated: true };
    }
  } catch {
    return { truncated: true };
  }
  return bounded as Readonly<Record<string, unknown>>;
}

function boundMetadataValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? undefined : value;
  }
  if (typeof value === "string") {
    return value.slice(0, MAX_PROVIDER_METADATA_STRING_CHARS);
  }
  if (depth >= MAX_PROVIDER_METADATA_DEPTH) return "[MaxDepth]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PROVIDER_METADATA_KEYS)
      .map((item) => boundMetadataValue(item, depth + 1));
  }
  if (typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, MAX_PROVIDER_METADATA_KEYS)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const bounded = boundMetadataValue(descriptor.value, depth + 1);
    if (bounded !== undefined) result[key] = bounded;
  }
  return result;
}

export type ProviderSendCapacity = "open" | "high_water" | "hard_limit";

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

export function safeSend(socket: WsLike, data: string | Buffer): boolean {
  if (!canWriteProviderFrame(socket, data)) return false;
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

export function writeProviderFrame(
  socket: WsLike,
  data: string | Buffer,
  options: ProviderWriteOptions,
): void {
  if (safeSend(socket, data)) {
    return;
  }
  throw providerFrameWriteError(options);
}

export async function writeProviderAudioFrame(
  socket: WsLike,
  data: string | Buffer,
  options: Omit<ProviderWriteOptions, "operation">,
): Promise<void> {
  const writeOptions: ProviderWriteOptions = { ...options, operation: "audio" };
  if (!canWriteProviderFrame(socket, data)) throw providerFrameWriteError(writeOptions);
  await new Promise<void>((resolve, reject) => {
    try {
      socket.send(data, (error) => {
        if (error) {
          reject(
            providerFrameWriteError(
              writeOptions,
              `${options.provider} audio write did not complete`,
            ),
          );
          return;
        }
        resolve();
      });
    } catch {
      reject(
        providerFrameWriteError(writeOptions, `${options.provider} audio write did not complete`),
      );
    }
  });
}

function canWriteProviderFrame(socket: WsLike, data: string | Buffer): boolean {
  return socket.readyState === WebSocket.OPEN && providerSendCapacity(socket, data) === "open";
}

function providerFrameWriteError(
  options: ProviderWriteOptions,
  message = `${options.provider} ${options.operation} write was not accepted by the socket`,
): TvicThrowableError {
  return TvicThrowableError.from(
    providerError(STT_ERROR_CODES.transportWriteFailed, message, {
      provider: options.provider,
      retriable: true,
      metadata: { operation: options.operation, providerCode: options.code },
    }),
  );
}

export function safeClose(socket: WsLike): void {
  try {
    if (socket.readyState === WebSocket.CONNECTING) {
      const eventful = socket as WsLike & {
        once?: (event: "error", listener: () => void) => unknown;
      };
      eventful.once?.("error", () => undefined);
    }
    socket.close();
  } catch {}
}

export function socketCloseMetadata(
  code: number,
  reason?: Buffer,
): Readonly<Record<string, unknown>> {
  return {
    wsCloseCode: code,
    ...(reason && reason.length > 0 ? { wsCloseReason: reason.toString("utf8") } : {}),
  };
}

export const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;

export interface OpenWebSocketOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface WebSocketConnectFailure extends Error {
  readonly wsCloseCode?: number;
  readonly wsCloseReason?: string;
}

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
    if (options.signal?.aborted) onAbort();
  });
}

export interface NormalizeProviderErrorOptions {
  readonly code: string;
  readonly provider: string;
  readonly retriable?: boolean;
}

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

export function providerThrowableError(
  error: unknown,
  options: NormalizeProviderErrorOptions,
): TvicThrowableError {
  return TvicThrowableError.from(normalizeProviderError(error, options));
}

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
      ? STT_ERROR_CODES.authFailed
      : status === "402"
        ? STT_ERROR_CODES.quotaExceeded
        : status === "429"
          ? STT_ERROR_CODES.rateLimited
          : status === "400" || status === "410" || status === "422"
            ? STT_ERROR_CODES.invalidRequest
            : status?.startsWith("5")
              ? STT_ERROR_CODES.serviceUnavailable
              : wsCloseCode !== undefined && wsCloseCode !== 1006
                ? STT_ERROR_CODES.protocolError
                : STT_ERROR_CODES.connectFailed;
  return providerError(code, message, {
    provider: options.provider,
    retriable:
      code === STT_ERROR_CODES.connectFailed || code === STT_ERROR_CODES.serviceUnavailable,
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
