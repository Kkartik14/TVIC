import {
  createDefaultIdGenerator,
  createMediaEvent,
  createSystemClock,
  cancelledError,
  evaluateProviderCompatibility,
  providerError,
  sameAudioFormat,
  STT_ERROR_CODES,
  STT_STREAM_ENDED_REASON,
  timeoutError,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type {
  AudioFormat,
  Clock,
  IdGenerator,
  InputAudioChunk,
  SessionId,
  SpeechToTextProvider,
  SttStream,
  TranscriptEvent,
} from "@tvic/core";
import {
  AsyncQueue,
  createAudioNormalizer,
  durationMsForPcm16le,
  frameCountForPcm16le,
} from "@tvic/media";
import type { AudioNormalizer } from "@tvic/media";

import { cancelWithTimeout, withTimeout } from "./async-control.js";
import {
  CANCELLATION_TIMEOUT_MS,
  STT_COMMIT_TIMEOUT_MS,
  STT_SEND_TIMEOUT_MS,
} from "./pipeline-constants.js";
import {
  getSttRecoveryControl,
  withSttReconnect,
  type SttReconnectOptions,
} from "./resilient-stt.js";

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

export type AudioNormalizationMode = "auto" | "never";

export interface SttSessionInputOptions {
  readonly format: AudioFormat;
  readonly normalization?: AudioNormalizationMode;
}

export interface SttSessionOptions {
  readonly provider: SpeechToTextProvider;
  readonly sessionId?: SessionId;
  /** The exact format opened with the provider. */
  readonly format: AudioFormat;
  /** Optional source format. Source bytes are normalized to `format` when enabled. */
  readonly input?: SttSessionInputOptions;
  readonly model?: string;
  /** Allows a custom/self-hosted STT endpoint to accept a model outside the dated catalog. */
  readonly allowUnknownModel?: boolean;
  readonly language?: string;
  readonly interimResults?: boolean;
  readonly vocabulary?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly openTimeoutMs?: number;
  /** Bounds provider acceptance of one audio command. */
  readonly sendTimeoutMs?: number;
  /** Bounds provider acceptance of one commit barrier. */
  readonly commitTimeoutMs?: number;
  /** Bounds an ordered close before the session switches to forced teardown. */
  readonly closeTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly sttReconnect?: boolean | SttReconnectOptions;
}

export interface SttSession {
  readonly sessionId: SessionId;
  readonly format: AudioFormat;
  readonly inputFormat: AudioFormat;
  readonly events: AsyncIterable<TranscriptEvent>;

  pushAudioChunk(chunk: InputAudioChunk): Promise<void>;
  pushAudio(
    bytes: Uint8Array,
    format: AudioFormat,
    options?: { readonly monotonicOffsetMs?: number },
  ): Promise<void>;
  pushPcm16(bytes: Uint8Array, options?: { readonly monotonicOffsetMs?: number }): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
}

export async function createSttSession(options: SttSessionOptions): Promise<SttSession> {
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  if (!Number.isFinite(openTimeoutMs) || openTimeoutMs <= 0) {
    throw TvicThrowableError.from(
      validationError(
        "stt.open_timeout_invalid",
        `STT open timeout must be a positive finite number, received ${openTimeoutMs}`,
      ),
    );
  }
  const closeTimeoutMs = options.closeTimeoutMs ?? CANCELLATION_TIMEOUT_MS;
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) {
    throw TvicThrowableError.from(
      validationError(
        "stt.close_timeout_invalid",
        `STT close timeout must be a positive finite number, received ${closeTimeoutMs}`,
      ),
    );
  }
  const sendTimeoutMs = options.sendTimeoutMs ?? STT_SEND_TIMEOUT_MS;
  if (!Number.isFinite(sendTimeoutMs) || sendTimeoutMs <= 0) {
    throw TvicThrowableError.from(
      validationError(
        "stt.send_timeout_invalid",
        `STT send timeout must be a positive finite number, received ${sendTimeoutMs}`,
      ),
    );
  }
  const commitTimeoutMs = options.commitTimeoutMs ?? STT_COMMIT_TIMEOUT_MS;
  if (!Number.isFinite(commitTimeoutMs) || commitTimeoutMs <= 0) {
    throw TvicThrowableError.from(
      validationError(
        "stt.commit_timeout_invalid",
        `STT commit timeout must be a positive finite number, received ${commitTimeoutMs}`,
      ),
    );
  }

  const inputFormat = options.input?.format ?? options.format;
  const requestedNormalization: unknown =
    options.input?.normalization ?? (options.input ? "auto" : "never");
  if (requestedNormalization !== "auto" && requestedNormalization !== "never") {
    throw TvicThrowableError.from(
      validationError(
        "stt.normalization_invalid",
        'STT normalization must be "auto" or "never", received ' + String(requestedNormalization),
      ),
    );
  }
  const normalization = requestedNormalization;
  if (normalization === "never" && !sameAudioFormat(inputFormat, options.format)) {
    throw TvicThrowableError.from(
      validationError(
        "stt.normalization_disabled_format_mismatch",
        `STT input format ${describeFormat(inputFormat)} does not match target ${describeFormat(options.format)} when normalization is disabled`,
      ),
    );
  }
  const normalizer =
    normalization === "auto"
      ? createAudioNormalizer({ inputFormat, outputFormat: options.format })
      : undefined;

  if (options.signal?.aborted) {
    throw TvicThrowableError.from(
      cancelledError("stt.open_cancelled", "STT session startup was cancelled"),
    );
  }

  const provider = options.sttReconnect
    ? withSttReconnect(
        options.provider,
        typeof options.sttReconnect === "boolean" ? {} : options.sttReconnect,
      )
    : options.provider;
  const compatibility = evaluateProviderCompatibility(provider, {
    kind: "stt",
    streaming: { input: true },
    inputFormat: options.format,
  });
  if (!compatibility.compatible) {
    const details = compatibility.issues.map(({ code, requirement }) => `${code}:${requirement}`);
    throw TvicThrowableError.from(
      validationError(
        "stt.provider_incompatible",
        `${provider.name} is incompatible with this STT session: ${details.join(", ")}`,
        {
          metadata: {
            provider: provider.name,
            kind: provider.kind,
            issues: compatibility.issues,
          },
        },
      ),
    );
  }

  const ids = options.idGenerator ?? createDefaultIdGenerator();
  const sessionId = options.sessionId ?? ids.session();
  const clock = options.clock ?? createSystemClock();
  const openAbort = new AbortController();
  const removeAbortListener = forwardAbort(options.signal, openAbort);
  const openRequest = {
    sessionId,
    format: options.format,
    interimResults: options.interimResults ?? true,
    signal: openAbort.signal,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.allowUnknownModel ? { allowUnknownModel: true } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.vocabulary !== undefined ? { vocabulary: options.vocabulary } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };

  let opening: Promise<SttStream> | undefined;
  let stream: SttStream;
  try {
    opening = provider.open(openRequest);
    opening.catch(() => undefined);
    const timedOpen = withTimeout(
      opening,
      openTimeoutMs,
      timeoutError("stt.open_timeout", `STT open timed out after ${openTimeoutMs}ms`),
      options.signal,
      cancelledError("stt.open_cancelled", "STT session startup was cancelled"),
    );
    stream = await timedOpen;
    // The signal can win in the same turn that the provider resolves. Do not
    // return a live session in that case, and clear opening so the catch path
    // does not close the same stream a second time.
    opening = undefined;
    if (options.signal?.aborted) {
      await closeStreamBounded(stream, closeTimeoutMs);
      throw cancelledError("stt.open_cancelled", "STT session startup was cancelled");
    }
  } catch (error) {
    openAbort.abort();
    if (opening) {
      void opening
        .then((lateStream) => closeStreamBounded(lateStream, closeTimeoutMs))
        .catch(() => undefined);
    }
    throw TvicThrowableError.from(error);
  } finally {
    removeAbortListener();
  }

  const session = new SttSessionImpl({
    stream,
    sessionId,
    format: options.format,
    inputFormat,
    normalizer,
    closeTimeoutMs,
    clock,
    ids,
    sendTimeoutMs,
    commitTimeoutMs,
  });
  session.attachAbortSignal(options.signal);
  return session;
}

interface SttSessionImplOptions {
  readonly stream: SttStream;
  readonly sessionId: SessionId;
  readonly format: AudioFormat;
  readonly inputFormat: AudioFormat;
  readonly normalizer: AudioNormalizer | undefined;
  readonly closeTimeoutMs: number;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly sendTimeoutMs: number;
  readonly commitTimeoutMs: number;
}

class SttSessionImpl implements SttSession {
  readonly sessionId: SessionId;
  readonly format: AudioFormat;
  readonly inputFormat: AudioFormat;
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly #stream: SttStream;
  readonly #format: AudioFormat;
  readonly #inputFormat: AudioFormat;
  readonly #normalizer: AudioNormalizer | undefined;
  readonly #closeTimeoutMs: number;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #sendTimeoutMs: number;
  readonly #commitTimeoutMs: number;
  // R2-05 LOCKED: bounded forward queue (1,024) + failTerminal on overflow.
  readonly #events = new AsyncQueue<TranscriptEvent>({ maxBuffered: 1_024 });
  #operations: Promise<void> = Promise.resolve();
  readonly #pendingOperationRejects = new Set<(error: unknown) => void>();
  #closePromise: Promise<void> | undefined;
  #forceClosePromise: Promise<void> | undefined;
  #forceCloseError: unknown;
  #lastCommit: { readonly generation: number; readonly promise: Promise<void> } | undefined;
  #inputGeneration = 0;
  #sourceSequence = 1;
  #pcmSequence = 1;
  #accepting = true;
  #closed = false;
  #terminal = false;
  #terminalError: TvicThrowableError | undefined;
  #forceClosed = false;
  #removeAbortListener: (() => void) | undefined;
  #providerClosePromise: Promise<void> | undefined;

  constructor(options: SttSessionImplOptions) {
    this.#stream = options.stream;
    this.sessionId = options.sessionId;
    this.#format = options.format;
    this.format = options.format;
    this.#inputFormat = options.inputFormat;
    this.inputFormat = options.inputFormat;
    this.#normalizer = options.normalizer;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#sendTimeoutMs = options.sendTimeoutMs;
    this.#commitTimeoutMs = options.commitTimeoutMs;
    this.events = this.#events;
    void this.#forwardEvents();
  }

  attachAbortSignal(signal: AbortSignal | undefined): void {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      void this.#closeNow().catch(() => undefined);
      return;
    }
    const onAbort = (): void => void this.#closeNow().catch(() => undefined);
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    this.#removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  pushAudioChunk(chunk: InputAudioChunk): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(this.#notAcceptingError());
    }
    if (chunk.sessionId !== this.sessionId) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "stt.audio_session_mismatch",
            `Audio chunk belongs to ${chunk.sessionId}, expected ${this.sessionId}`,
          ),
        ),
      );
    }
    if (!sameAudioFormat(chunk.audio.format, this.#inputFormat)) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "stt.audio_format_mismatch",
            `Audio chunk format does not match the session input format ${describeFormat(this.#inputFormat)}`,
          ),
        ),
      );
    }
    const sourceChunk: InputAudioChunk = {
      ...chunk,
      audio: {
        ...chunk.audio,
        bytes: new Uint8Array(chunk.audio.bytes),
      },
    };
    this.#inputGeneration += 1;
    return this.#enqueue(() => this.#normalizeAndSend(sourceChunk));
  }

  pushAudio(
    bytes: Uint8Array,
    format: AudioFormat,
    options: { readonly monotonicOffsetMs?: number } = {},
  ): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(this.#notAcceptingError());
    }
    if (!sameAudioFormat(format, this.#inputFormat)) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "stt.audio_format_mismatch",
            `Audio format does not match the session input format ${describeFormat(this.#inputFormat)}`,
          ),
        ),
      );
    }
    const frameBytes = bytesPerFrame(format);
    if (bytes.byteLength % frameBytes !== 0) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "stt.audio_incomplete_frame",
            `Audio must contain complete frames of ${frameBytes} bytes`,
          ),
        ),
      );
    }
    if (
      options.monotonicOffsetMs !== undefined &&
      (!Number.isFinite(options.monotonicOffsetMs) || options.monotonicOffsetMs < 0)
    ) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "stt.audio_offset_invalid",
            `Audio monotonic offset must be a non-negative finite number, received ${options.monotonicOffsetMs}`,
          ),
        ),
      );
    }

    const audioBytes = new Uint8Array(bytes);
    const chunk: InputAudioChunk = createMediaEvent({
      id: this.#ids.mediaEvent(),
      type: "media.audio.chunk",
      sessionId: this.sessionId,
      sequence: this.#sourceSequence,
      direction: "input",
      timestamp: this.#clock.now(),
      monotonicOffsetMs: options.monotonicOffsetMs ?? this.#clock.monotonicMs(),
      audio: {
        format,
        durationMs: (audioBytes.byteLength / frameBytes / format.sampleRateHz) * 1000,
        frameCount: audioBytes.byteLength / frameBytes,
        bytes: audioBytes,
      },
    });
    this.#sourceSequence += 1;
    return this.pushAudioChunk(chunk);
  }

  /** Push PCM16LE bytes using the session's configured source format. */
  async pushPcm16(
    bytes: Uint8Array,
    options: { readonly monotonicOffsetMs?: number } = {},
  ): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(this.#notAcceptingError());
    }
    if (this.#inputFormat.encoding !== "pcm_s16le" || this.#inputFormat.channels !== 1) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "stt.audio_format_invalid",
            "pushPcm16 requires a mono pcm_s16le input format",
          ),
        ),
      );
    }
    if (bytes.byteLength % 2 !== 0) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError("stt.audio_odd_byte_length", "PCM16 audio must contain complete samples"),
        ),
      );
    }
    return this.pushAudio(bytes, this.#inputFormat, options);
  }

  commit(): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(this.#notAcceptingError());
    }
    const generation = this.#inputGeneration;
    if (this.#lastCommit?.generation === generation) {
      return this.#lastCommit.promise;
    }

    const promise = this.#enqueue(async () => {
      this.#assertProviderOpen();
      await this.#finishNormalizer(false);
      await this.#commitProvider();
    });
    this.#lastCommit = { generation, promise };
    void promise.catch(() => {
      if (this.#lastCommit?.promise === promise) {
        this.#lastCommit = undefined;
      }
    });
    return promise;
  }

  close(): Promise<void> {
    if (this.#forceClosePromise) {
      return this.#forceClosePromise;
    }
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#accepting = false;
    const ordered = this.#enqueue(async () => {
      let failure: unknown;
      try {
        if (!this.#terminal) {
          await this.#finishNormalizer(true);
        }
      } catch (error) {
        failure = error;
      }
      try {
        await this.#startProviderClose();
      } catch (error) {
        failure ??= error;
      } finally {
        this.#closed = true;
        this.#removeAbortListener?.();
        this.#removeAbortListener = undefined;
        this.#events.close();
      }
      if (failure !== undefined) {
        throw failure;
      }
    });
    const timeout = timeoutError(
      "stt.close_timeout",
      `STT close timed out after ${this.#closeTimeoutMs}ms`,
    );
    const promise = withTimeout(ordered, this.#closeTimeoutMs, timeout).catch(async (error) => {
      if (error === timeout) {
        // The ordered close has already spent the public close budget waiting
        // for provider work. Forced teardown must not wait for that provider
        // close a second time.
        await this.#closeNow(false).catch(() => undefined);
      }
      throw error;
    });
    this.#closePromise = promise;
    return promise;
  }

  async #closeNow(waitForProvider = true): Promise<void> {
    if (this.#forceClosePromise) {
      return this.#forceClosePromise;
    }
    this.#forceClosePromise = this.#performCloseNow(waitForProvider);
    return this.#forceClosePromise;
  }

  async #performCloseNow(waitForProvider: boolean): Promise<void> {
    if (this.#forceClosed) {
      return;
    }
    this.#forceClosed = true;
    const error = TvicThrowableError.from(
      validationError("stt.session_closed", "STT session closed before queued work ran"),
    );
    this.#markTerminal(error);
    this.#closed = true;
    this.#forceCloseError = error;
    for (const reject of this.#pendingOperationRejects) {
      reject(error);
    }
    this.#pendingOperationRejects.clear();
    const recovery = getSttRecoveryControl(this.#stream);
    if (recovery) {
      if (waitForProvider) {
        await cancelWithTimeout(() => recovery.controller.abort(error), this.#closeTimeoutMs).catch(
          () => undefined,
        );
      } else {
        // The ordered close already spent its public budget. Start resilient
        // teardown without waiting through a second recovery close budget.
        void recovery.controller.abort(error).catch(() => undefined);
      }
    } else if (waitForProvider) {
      await this.#closeProviderBounded(this.#closeTimeoutMs);
    } else {
      // Invoke provider close, but do not spend another timeout waiting for a
      // provider that already ignored the ordered close deadline.
      void this.#startProviderClose().catch(() => undefined);
    }
    this.#events.close();
  }

  async #forwardEvents(): Promise<void> {
    try {
      for await (const event of this.#stream.events) {
        // E-08/L-13 style identity fence: a provider event for another
        // session can never enter this session's queue. Fails the stream
        // once with provider.identity_mismatch; the session stays usable
        // only before terminal.
        if (event.sessionId !== this.sessionId) {
          const error = TvicThrowableError.from(
            providerError("provider.identity_mismatch", "STT event session identity mismatch", {
              retriable: false,
            }),
          );
          this.#markTerminal(error);
          this.#events.fail(error);
          await this.#closeProviderBounded(this.#closeTimeoutMs);
          return;
        }
        if (!this.#events.push(event)) {
          const error = TvicThrowableError.from(
            providerError(
              STT_ERROR_CODES.sessionBufferOverflow,
              "STT session event queue overflowed",
              {
                retriable: false,
              },
            ),
          );
          this.#markTerminal(error);
          this.#events.fail(error);
          // P-33: close the child stream inline so overflow cannot leave a
          // live provider behind when the session owner never calls close().
          await this.#closeProviderBounded(this.#closeTimeoutMs);
          return;
        }
      }
      this.#markTerminal(this.#streamEndedError());
      this.#events.close();
    } catch (error) {
      const throwable = TvicThrowableError.from(error);
      this.#markTerminal(throwable);
      this.#events.fail(throwable);
      await this.#closeProviderBounded(this.#closeTimeoutMs);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let settled = false;
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const rejectPending = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      rejectResult(error);
    };
    this.#pendingOperationRejects.add(rejectPending);
    const run = this.#operations.then(
      () => {
        if (this.#forceClosed) {
          throw (
            this.#forceCloseError ??
            TvicThrowableError.from(validationError("stt.session_closed", "STT session is closed"))
          );
        }
        return operation();
      },
      () => {
        if (this.#forceClosed) {
          throw (
            this.#forceCloseError ??
            TvicThrowableError.from(validationError("stt.session_closed", "STT session is closed"))
          );
        }
        return operation();
      },
    );
    this.#operations = run.then(
      () => undefined,
      () => undefined,
    );
    void run.then(
      (value) => {
        this.#pendingOperationRejects.delete(rejectPending);
        if (!settled) {
          settled = true;
          resolveResult(value);
        }
      },
      (error: unknown) => {
        this.#pendingOperationRejects.delete(rejectPending);
        if (!settled) {
          settled = true;
          rejectResult(TvicThrowableError.from(error));
        }
      },
    );
    return result;
  }

  #assertProviderOpen(): void {
    if (this.#closed) {
      throw TvicThrowableError.from(validationError("stt.session_closed", "STT session is closed"));
    }
    if (this.#terminal) {
      throw this.#terminalError ?? this.#streamEndedError();
    }
  }

  async #normalizeAndSend(sourceChunk: InputAudioChunk): Promise<void> {
    this.#assertProviderOpen();
    const sourceBytes = sourceChunk.audio.bytes;
    if (!this.#normalizer) {
      await this.#sendAudioToProvider(sourceChunk);
      return;
    }
    const normalized = this.#normalizer.push(sourceBytes);
    if (normalized.byteLength === 0) {
      return;
    }
    await this.#sendAudioToProvider(this.#targetChunk(normalized, sourceChunk));
  }

  async #finishNormalizer(terminal: boolean): Promise<void> {
    if (!this.#normalizer) {
      return;
    }
    const normalized = terminal ? this.#normalizer.finish() : this.#normalizer.finishSegment();
    if (normalized.byteLength === 0) {
      return;
    }
    this.#assertProviderOpen();
    await this.#sendAudioToProvider(this.#targetChunk(normalized));
  }

  async #sendAudioToProvider(chunk: InputAudioChunk): Promise<void> {
    const timeout = timeoutError(
      "stt.send_timeout",
      `STT audio send timed out after ${this.#sendTimeoutMs}ms`,
      { retriable: false },
    );
    try {
      await withTimeout(
        Promise.resolve().then(() => this.#stream.sendAudio(chunk)),
        this.#sendTimeoutMs,
        timeout,
      );
    } catch (error) {
      if (error === timeout) {
        this.#failProviderOperation(timeout);
      }
      throw error;
    }
  }

  async #commitProvider(): Promise<void> {
    const timeout = timeoutError(
      "stt.commit_timeout",
      `STT commit timed out after ${this.#commitTimeoutMs}ms`,
      { retriable: false },
    );
    try {
      await withTimeout(
        Promise.resolve().then(() => this.#stream.commit()),
        this.#commitTimeoutMs,
        timeout,
      );
    } catch (error) {
      if (error === timeout) {
        this.#failProviderOperation(timeout);
      }
      throw error;
    }
  }

  #failProviderOperation(error: unknown): void {
    if (this.#terminal || this.#closed) {
      return;
    }
    const throwable = TvicThrowableError.from(error);
    this.#markTerminal(throwable);
    this.#events.fail(throwable);
    // The provider operation may still settle later. Close is shared and
    // bounded so a late settlement cannot keep the session alive or trigger a
    // second provider close call.
    void this.#closeProviderBounded(this.#closeTimeoutMs);
  }

  #markTerminal(error?: unknown): void {
    this.#terminal = true;
    this.#accepting = false;
    if (error !== undefined && !this.#terminalError) {
      this.#terminalError = TvicThrowableError.from(error);
    }
    this.#removeAbortListener?.();
    this.#removeAbortListener = undefined;
  }

  #notAcceptingError(): TvicThrowableError {
    if (this.#terminal && !this.#closed && !this.#forceClosed && this.#terminalError) {
      return this.#terminalError;
    }
    return TvicThrowableError.from(validationError("stt.session_closed", "STT session is closed"));
  }

  #streamEndedError(): TvicThrowableError {
    return TvicThrowableError.from(
      providerError("stt.stream_ended", "STT provider stream has ended", {
        retriable: false,
        metadata: { reason: STT_STREAM_ENDED_REASON },
      }),
    );
  }

  #startProviderClose(): Promise<void> {
    if (!this.#providerClosePromise) {
      this.#providerClosePromise = Promise.resolve().then(() => this.#stream.close());
    }
    return this.#providerClosePromise;
  }

  async #closeProviderBounded(timeoutMs: number): Promise<void> {
    await cancelWithTimeout(() => this.#startProviderClose(), timeoutMs).catch(() => undefined);
  }

  #targetChunk(bytes: Uint8Array, source?: InputAudioChunk): InputAudioChunk {
    return createMediaEvent({
      id: this.#ids.mediaEvent(),
      type: "media.audio.chunk",
      sessionId: this.sessionId,
      sequence: this.#pcmSequence++,
      direction: "input",
      timestamp: source?.timestamp ?? this.#clock.now(),
      monotonicOffsetMs: source?.monotonicOffsetMs ?? this.#clock.monotonicMs(),
      ...(source?.metadata !== undefined ? { metadata: source.metadata } : {}),
      audio: {
        format: this.#format,
        durationMs: durationMsForPcm16le(bytes, this.#format.sampleRateHz),
        frameCount: frameCountForPcm16le(bytes),
        bytes: new Uint8Array(bytes),
      },
    });
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function describeFormat(format: AudioFormat): string {
  return `${format.encoding}/${format.sampleRateHz}Hz/${format.channels}ch`;
}

function bytesPerFrame(format: AudioFormat): number {
  const bytesPerSample = format.encoding === "pcm_f32le" ? 4 : 2;
  return bytesPerSample * format.channels;
}

async function closeStreamBounded(stream: SttStream, timeoutMs: number): Promise<void> {
  await cancelWithTimeout(() => stream.close(), timeoutMs).catch(() => undefined);
}
