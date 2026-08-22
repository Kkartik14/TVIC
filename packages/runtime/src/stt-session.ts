import {
  createDefaultIdGenerator,
  createSystemClock,
  evaluateProviderCompatibility,
  providerError,
  sameAudioFormat,
  STT_STREAM_ENDED_REASON,
  validationError,
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

import { abortPromise, withTimeout } from "./internal/async.js";

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
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
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
    throw validationError(
      "stt.open_timeout_invalid",
      `STT open timeout must be a positive finite number, received ${openTimeoutMs}`,
    );
  }

  const inputFormat = options.input?.format ?? options.format;
  const normalization = options.input?.normalization ?? (options.input ? "auto" : "never");
  if (normalization === "never" && !sameAudioFormat(inputFormat, options.format)) {
    throw validationError(
      "stt.normalization_disabled_format_mismatch",
      `STT input format ${describeFormat(inputFormat)} does not match target ${describeFormat(options.format)} when normalization is disabled`,
    );
  }
  const normalizer =
    normalization === "auto"
      ? createAudioNormalizer({ inputFormat, outputFormat: options.format })
      : undefined;

  const compatibility = evaluateProviderCompatibility(options.provider, {
    kind: "stt",
    streaming: { input: true },
    inputFormat: options.format,
  });
  if (!compatibility.compatible) {
    const details = compatibility.issues.map(({ code, requirement }) => `${code}:${requirement}`);
    throw validationError(
      "stt.provider_incompatible",
      `${options.provider.name} is incompatible with this STT session: ${details.join(", ")}`,
      {
        metadata: {
          provider: options.provider.name,
          kind: options.provider.kind,
          issues: compatibility.issues,
        },
      },
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

  const opening = options.provider.open(openRequest);
  opening.catch(() => undefined);
  let stream: SttStream;
  try {
    const timedOpen = withTimeout(opening, openTimeoutMs);
    stream = options.signal
      ? await Promise.race([
          timedOpen,
          abortPromise(options.signal).then(() => {
            throw new Error("STT session startup aborted");
          }),
        ])
      : await timedOpen;
  } catch (error) {
    openAbort.abort();
    void opening.then((lateStream) => lateStream.close()).catch(() => undefined);
    throw error;
  } finally {
    removeAbortListener();
  }

  const session = new SttSessionImpl({
    stream,
    sessionId,
    format: options.format,
    inputFormat,
    normalizer,
    clock,
    ids,
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
  readonly clock: Clock;
  readonly ids: IdGenerator;
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
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #events = new AsyncQueue<TranscriptEvent>();
  #operations: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #lastCommit: { readonly generation: number; readonly promise: Promise<void> } | undefined;
  #inputGeneration = 0;
  #sourceSequence = 1;
  #pcmSequence = 1;
  #accepting = true;
  #closed = false;
  #terminal = false;
  #removeAbortListener: (() => void) | undefined;

  constructor(options: SttSessionImplOptions) {
    this.#stream = options.stream;
    this.sessionId = options.sessionId;
    this.#format = options.format;
    this.format = options.format;
    this.#inputFormat = options.inputFormat;
    this.inputFormat = options.inputFormat;
    this.#normalizer = options.normalizer;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.events = this.#events;
    void this.#forwardEvents();
  }

  attachAbortSignal(signal: AbortSignal | undefined): void {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      void this.close().catch(() => undefined);
      return;
    }
    const onAbort = (): void => void this.close().catch(() => undefined);
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    this.#removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  pushAudioChunk(chunk: InputAudioChunk): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(validationError("stt.session_closed", "STT session is closed"));
    }
    if (chunk.sessionId !== this.sessionId) {
      return Promise.reject(
        validationError(
          "stt.audio_session_mismatch",
          `Audio chunk belongs to ${chunk.sessionId}, expected ${this.sessionId}`,
        ),
      );
    }
    if (!sameAudioFormat(chunk.audio.format, this.#inputFormat)) {
      return Promise.reject(
        validationError(
          "stt.audio_format_mismatch",
          `Audio chunk format does not match the session input format ${describeFormat(this.#inputFormat)}`,
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
    if (!sameAudioFormat(format, this.#inputFormat)) {
      return Promise.reject(
        validationError(
          "stt.audio_format_mismatch",
          `Audio format does not match the session input format ${describeFormat(this.#inputFormat)}`,
        ),
      );
    }
    const frameBytes = bytesPerFrame(format);
    if (bytes.byteLength % frameBytes !== 0) {
      return Promise.reject(
        validationError(
          "stt.audio_incomplete_frame",
          `Audio must contain complete frames of ${frameBytes} bytes`,
        ),
      );
    }
    if (
      options.monotonicOffsetMs !== undefined &&
      (!Number.isFinite(options.monotonicOffsetMs) || options.monotonicOffsetMs < 0)
    ) {
      return Promise.reject(
        validationError(
          "stt.audio_offset_invalid",
          `Audio monotonic offset must be a non-negative finite number, received ${options.monotonicOffsetMs}`,
        ),
      );
    }

    const audioBytes = new Uint8Array(bytes);
    const chunk: InputAudioChunk = {
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
    };
    this.#sourceSequence += 1;
    return this.pushAudioChunk(chunk);
  }

  /** Push PCM16LE bytes using the session's configured source format. */
  async pushPcm16(
    bytes: Uint8Array,
    options: { readonly monotonicOffsetMs?: number } = {},
  ): Promise<void> {
    if (this.#inputFormat.encoding !== "pcm_s16le" || this.#inputFormat.channels !== 1) {
      return Promise.reject(
        validationError(
          "stt.audio_format_invalid",
          "pushPcm16 requires a mono pcm_s16le input format",
        ),
      );
    }
    if (bytes.byteLength % 2 !== 0) {
      return Promise.reject(
        validationError("stt.audio_odd_byte_length", "PCM16 audio must contain complete samples"),
      );
    }
    return this.pushAudio(bytes, this.#inputFormat, options);
  }

  commit(): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(validationError("stt.session_closed", "STT session is closed"));
    }
    const generation = this.#inputGeneration;
    if (this.#lastCommit?.generation === generation) {
      return this.#lastCommit.promise;
    }

    const promise = this.#enqueue(async () => {
      this.#assertProviderOpen();
      await this.#finishNormalizer(false);
      await this.#stream.commit();
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
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#accepting = false;
    const promise = this.#enqueue(async () => {
      let failure: unknown;
      try {
        if (!this.#terminal) {
          await this.#finishNormalizer(true);
        }
      } catch (error) {
        failure = error;
      }
      try {
        await this.#stream.close();
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
    this.#closePromise = promise;
    return promise;
  }

  async #forwardEvents(): Promise<void> {
    try {
      for await (const event of this.#stream.events) {
        this.#events.push(event);
      }
      this.#terminal = true;
      this.#events.close();
    } catch (error) {
      this.#terminal = true;
      this.#events.fail(error);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operations.then(operation, operation);
    this.#operations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #assertProviderOpen(): void {
    if (this.#closed) {
      throw validationError("stt.session_closed", "STT session is closed");
    }
    if (this.#terminal) {
      throw providerError("stt.stream_ended", "STT provider stream has ended", {
        retriable: false,
        metadata: { reason: STT_STREAM_ENDED_REASON },
      });
    }
  }

  async #normalizeAndSend(sourceChunk: InputAudioChunk): Promise<void> {
    this.#assertProviderOpen();
    const sourceBytes = sourceChunk.audio.bytes;
    if (!this.#normalizer) {
      await this.#stream.sendAudio(sourceChunk);
      return;
    }
    const normalized = this.#normalizer.push(sourceBytes);
    if (normalized.byteLength === 0) {
      return;
    }
    await this.#stream.sendAudio(this.#targetChunk(normalized, sourceChunk));
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
    await this.#stream.sendAudio(this.#targetChunk(normalized));
  }

  #targetChunk(bytes: Uint8Array, source?: InputAudioChunk): InputAudioChunk {
    return {
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
    };
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
