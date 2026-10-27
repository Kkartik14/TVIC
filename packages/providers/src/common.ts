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
  TVIC_ERROR_NAMES,
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

/** Returns whether an untrusted STT vocabulary value is an array of strings. */
export function isSttVocabularyArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((term) => typeof term === "string");
}

/** Reject malformed vocabulary values before provider-specific limit checks use array methods. */
export function assertSttVocabularyArray(
  value: unknown,
  provider: string,
  options: { readonly message?: string } = {},
): asserts value is readonly string[] | undefined {
  if (value === undefined || isSttVocabularyArray(value)) return;
  throw TvicThrowableError.from(
    validationError(
      STT_ERROR_CODES.vocabularyInvalid,
      options.message ?? `${provider} STT vocabulary must be an array of strings`,
      { provider },
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
  const wsCloseCode = readUnknownProperty(error, "wsCloseCode");
  const wsCloseReason = readUnknownProperty(error, "wsCloseReason");
  const numericWsCloseCode = typeof wsCloseCode === "number" ? wsCloseCode : undefined;
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
              : numericWsCloseCode !== undefined && numericWsCloseCode !== 1006
                ? STT_ERROR_CODES.protocolError
                : STT_ERROR_CODES.connectFailed;
  return providerError(code, message, {
    provider: options.provider,
    retriable:
      code === STT_ERROR_CODES.connectFailed || code === STT_ERROR_CODES.serviceUnavailable,
    metadata: {
      providerCode: options.providerCode,
      ...(status ? { httpStatus: Number(status) } : {}),
      ...(numericWsCloseCode !== undefined ? { wsCloseCode: numericWsCloseCode } : {}),
      ...(typeof wsCloseReason === "string" ? { wsCloseReason } : {}),
    },
    cause: error,
  });
}

function readUnknownProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

const PROVIDER_CONNECTION_URL_PATTERN = /\b(?:wss?|https?):\/\/[^\s"'<>]+/gi;
const UNSEGMENTED_LANGUAGE_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Bopomofo}]/u;

const UNREDACTED_PROVIDER_METADATA_KEYS = new Set([
  "model",
  "provider",
  "providerCode",
  "providerModel",
  "httpStatus",
  "status",
  "requestId",
  "errorCode",
  "errorType",
]);

export function redactSttConnectionUrl(
  error: NormalizedError,
  vocabulary: readonly string[] = [],
): NormalizedError {
  return redactSttNormalizedError(error, vocabulary, true);
}

export function redactSttThrowableError(
  error: TvicThrowableError,
  vocabulary: readonly string[] = [],
): TvicThrowableError {
  return TvicThrowableError.from(redactSttNormalizedError(error.error, vocabulary, true));
}

function redactSttNormalizedError(
  error: NormalizedError,
  vocabulary: readonly string[],
  includeCause: boolean,
): NormalizedError {
  try {
    const redactions = [
      ...new Set((Array.isArray(vocabulary) ? vocabulary : []).filter(isRedactableVocabularyTerm)),
    ]
      .flatMap((term) => {
        try {
          return [
            term,
            encodeURIComponent(term),
            new URLSearchParams({ value: term }).toString().slice("value=".length),
          ];
        } catch {
          return [term];
        }
      })
      .sort((left, right) => right.length - left.length);
    const state = {
      redactions,
      active: new WeakSet<object>(),
      clones: new WeakMap<object, object>(),
      nodes: 0,
    };
    const cause = includeCause ? error.cause : undefined;
    return {
      ...error,
      message: redactSttValue(error.message, state) as string,
      ...(error.metadata !== undefined
        ? { metadata: redactSttValue(error.metadata, state) as Readonly<Record<string, unknown>> }
        : {}),
      ...(cause !== undefined ? { cause: redactSttValue(cause, state) } : { cause: undefined }),
    };
  } catch {
    const provider = safelyReadErrorField(() => error.provider, undefined);
    return {
      name: safelyReadErrorField(() => error.name, TVIC_ERROR_NAMES.ProviderError),
      code: safelyReadErrorField(() => error.code, STT_ERROR_CODES.connectFailed),
      category: safelyReadErrorField(() => error.category, "provider"),
      message: "STT provider failure; details were redacted",
      retriable: safelyReadErrorField(() => error.retriable, true),
      ...(provider !== undefined ? { provider } : {}),
      cause: undefined,
    };
  }
}

function safelyReadErrorField<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function isRedactableVocabularyTerm(term: string): boolean {
  if (typeof term !== "string") return false;
  const codePointLength = Array.from(term).length;
  return (
    codePointLength >= 3 || (codePointLength >= 2 && UNSEGMENTED_LANGUAGE_SCRIPT_PATTERN.test(term))
  );
}

function redactSttValue(
  value: unknown,
  state: {
    readonly redactions: readonly string[];
    readonly active: WeakSet<object>;
    readonly clones: WeakMap<object, object>;
    nodes: number;
  },
  key?: string,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    const withoutUrls = value.replace(PROVIDER_CONNECTION_URL_PATTERN, "[redacted URL]");
    return key !== undefined && UNREDACTED_PROVIDER_METADATA_KEYS.has(key)
      ? withoutUrls
      : redactVocabularyTerms(withoutUrls, state.redactions);
  }
  if (typeof value === "function" || typeof value === "symbol") return "[redacted]";
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 64 || state.nodes >= 4_096) return "[redacted]";
  if (state.active.has(value)) return "[circular]";
  const existingClone = state.clones.get(value);
  if (existingClone !== undefined) return existingClone;
  state.nodes += 1;

  if (Buffer.isBuffer(value)) {
    const clone = Buffer.from(value);
    state.clones.set(value, clone);
    return clone;
  }
  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    state.clones.set(value, clone);
    return clone;
  }
  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    state.clones.set(value, clone);
    return clone;
  }
  if (ArrayBuffer.isView(value)) {
    // Typed-array and DataView contents are binary, not text fields to redact.
    const clone = structuredClone(value);
    state.clones.set(value, clone);
    return clone;
  }

  state.active.add(value);
  if (value instanceof Error) {
    const errorValue: Record<string, unknown> = {
      name: value.name,
      message: redactSttValue(value.message, state, "message", depth + 1),
    };
    state.clones.set(value, errorValue);
    if (value.stack !== undefined) {
      errorValue.stack = redactSttValue(value.stack, state, "stack", depth + 1);
    }
    if ("cause" in value) {
      errorValue.cause = redactSttValue(value.cause, state, "cause", depth + 1);
    }
    for (const [key, entry] of Object.entries(value)) {
      errorValue[key] = redactSttValue(entry, state, key, depth + 1);
    }
    state.active.delete(value);
    return errorValue;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    state.clones.set(value, clone);
    for (const entry of value) clone.push(redactSttValue(entry, state, undefined, depth + 1));
    state.active.delete(value);
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    state.clones.set(value, clone);
    for (const [entryKey, entryValue] of value) {
      clone.set(
        redactSttValue(entryKey, state, undefined, depth + 1),
        redactSttValue(entryValue, state, undefined, depth + 1),
      );
    }
    state.active.delete(value);
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    state.clones.set(value, clone);
    for (const entry of value) clone.add(redactSttValue(entry, state, undefined, depth + 1));
    state.active.delete(value);
    return clone;
  }
  const clone: Record<string, unknown> = {};
  state.clones.set(value, clone);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    clone[entryKey] = redactSttValue(entryValue, state, entryKey, depth + 1);
  }
  state.active.delete(value);
  return clone;
}

function redactVocabularyTerms(value: string, terms: readonly string[]): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const allowEmbeddedMatch = UNSEGMENTED_LANGUAGE_SCRIPT_PATTERN.test(term);
    let offset = 0;
    while (offset < value.length) {
      const start = value.indexOf(term, offset);
      if (start < 0) break;
      const end = start + term.length;
      const first = codePointAt(value, start);
      const last = codePointBefore(value, end);
      const previous = codePointBefore(value, start);
      const next = codePointAt(value, end);
      const hasLeftWordBoundary = !isWordCharacter(first) || !isWordCharacter(previous);
      const hasRightWordBoundary = !isWordCharacter(last) || !isWordCharacter(next);
      if (allowEmbeddedMatch || (hasLeftWordBoundary && hasRightWordBoundary)) {
        ranges.push({ start, end });
      }
      offset = start + 1;
    }
  }
  if (ranges.length === 0) return value;

  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let result = "";
  let offset = 0;
  for (const { start, end } of merged) {
    result += value.slice(offset, start) + "[REDACTED]";
    offset = end;
  }
  return result + value.slice(offset);
}

function codePointAt(value: string, index: number): string | undefined {
  if (index >= value.length) return undefined;
  const codePoint = value.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const lastCodeUnit = value.charCodeAt(index - 1);
  if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && index > 1) {
    const previousCodeUnit = value.charCodeAt(index - 2);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
      return value.slice(index - 2, index);
    }
  }
  return value.slice(index - 1, index);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
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
