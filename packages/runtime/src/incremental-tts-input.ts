import { timeoutError, validationError, TvicThrowableError } from "@tvic/core";
import type { TtsEvent, TtsFlushResult, TtsSession, TtsStream } from "@tvic/core";

import { abortPromise, cancelWithTimeout, withTimeout } from "./async-control.js";
import {
  CANCELLATION_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  TTS_FINISH_TIMEOUT_MS,
  TTS_FLUSH_TIMEOUT_MS,
  TTS_SEND_TIMEOUT_MS,
} from "./pipeline-constants.js";
import { MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES } from "./pipeline-constants.js";
import { runtimeResourceLimitError, utf8ByteLength } from "./pipeline-resource-limits.js";
import { closeAsyncIterator } from "./pipeline-helpers.js";

export interface IncrementalTtsInputOptions {
  readonly openSession: () => Promise<TtsSession>;
  /** Internal test seam; production pipeline uses STARTUP_TIMEOUT_MS. */
  readonly openTimeoutMs?: number;
  /** Bounds provider acceptance of incremental text. */
  readonly sendTimeoutMs?: number;
  /** Bounds provider acknowledgement of an incremental flush. */
  readonly flushTimeoutMs?: number;
  /** Bounds provider acceptance of the end-of-input marker. */
  readonly finishTimeoutMs?: number;
}

/**
 * Turns arbitrary LLM token fragments into sentence-sized TTS continuations.
 * The provider connection starts on the first token, flush acknowledgements are
 * tracked internally, and callers consume one ordinary TTS event stream.
 */
export class IncrementalTtsInput implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly opened: Promise<boolean>;
  readonly #openSession: () => Promise<TtsSession>;
  readonly #openTimeoutMs: number;
  readonly #sendTimeoutMs: number;
  readonly #flushTimeoutMs: number;
  readonly #finishTimeoutMs: number;
  readonly #started = deferred<boolean>();
  readonly #cancelledSignal = deferred<void>();
  readonly #eventsAbort = new AbortController();
  readonly #flushes = new Set<Promise<TtsFlushResult>>();
  #flushFailed = false;
  #flushError: unknown;
  #session: Promise<TtsSession | null> | null = null;
  #sessionCancelPromise: Promise<void> | undefined;
  #buffer = "";
  #bufferBytes = 0;
  #finishing = false;
  #cancelled = false;
  #cancelPromise: Promise<void> | undefined;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: IncrementalTtsInputOptions) {
    this.#openSession = options.openSession;
    this.#openTimeoutMs = options.openTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.#sendTimeoutMs = options.sendTimeoutMs ?? TTS_SEND_TIMEOUT_MS;
    this.#flushTimeoutMs = options.flushTimeoutMs ?? TTS_FLUSH_TIMEOUT_MS;
    this.#finishTimeoutMs = options.finishTimeoutMs ?? TTS_FINISH_TIMEOUT_MS;
    for (const [name, value] of [
      ["openTimeoutMs", this.#openTimeoutMs],
      ["sendTimeoutMs", this.#sendTimeoutMs],
      ["flushTimeoutMs", this.#flushTimeoutMs],
      ["finishTimeoutMs", this.#finishTimeoutMs],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw TvicThrowableError.from(invalidTimeoutError(name, value));
      }
    }
    this.opened = this.#started.promise;
    this.events = this.#forwardEvents();
  }

  pushToken(text: string): Promise<void> {
    if (!text) return Promise.resolve();
    // Start the provider session at admission time. The operation itself is
    // still serialized below, but cancellation that races the first queued
    // operation must observe the same closed-session rejection as a normal
    // in-flight push rather than silently disappearing before startup begins.
    const session = this.#ensureSession();
    session.catch(() => undefined);
    return this.#enqueue(async () => {
      if (this.#cancelled) {
        await session;
        return;
      }
      if (this.#finishing) {
        throw new Error("Cannot add TTS text after finishing input");
      }
      const textBytes = utf8ByteLength(text);
      if (
        !Number.isSafeInteger(textBytes) ||
        this.#bufferBytes + textBytes > MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES
      ) {
        this.#buffer = "";
        this.#bufferBytes = 0;
        throw runtimeResourceLimitError(
          "incremental TTS input buffer",
          "bytes",
          MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES,
        );
      }
      this.#buffer += text;
      this.#bufferBytes += textBytes;
      const sentences = this.#takeCompleteSentences();
      for (const sentence of sentences) {
        const opened = await session;
        if (this.#cancelled) return;
        await this.#sendText(opened, sentence);
        if (this.#cancelled) return;
        await this.#flushAndRemember(opened);
      }
    });
  }

  flushBoundary(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#cancelled || this.#buffer.length === 0) return;
      const session = await this.#ensureSession();
      if (this.#cancelled) return;
      const text = this.#takeBuffer();
      await this.#sendText(session, text);
      if (this.#cancelled) return;
      await this.#flushAndRemember(session);
    });
  }

  finish(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#finishing || this.#cancelled) return;
      this.#finishing = true;
      if (!this.#session) {
        this.#session = Promise.resolve(null);
        this.#started.resolve(false);
        return;
      }
      const session = await this.#session;
      if (!session) return;
      if (this.#cancelled) return;
      if (this.#buffer.length > 0) {
        await this.#sendText(session, this.#takeBuffer());
        if (this.#cancelled) return;
      }
      await this.#finishSession(session);
      await Promise.all(this.#flushes);
      if (this.#flushFailed) {
        throw this.#flushError;
      }
    });
  }

  async cancel(): Promise<void> {
    if (!this.#cancelPromise) {
      this.#cancelPromise = this.#cancelInternal();
    }
    await this.#cancelPromise;
  }

  #ensureSession(): Promise<TtsSession> {
    if (!this.#session) {
      const opening = Promise.resolve().then(() => this.#openSession());
      opening.catch(() => undefined);
      const timeout = timeoutError(
        "tts.open_timeout",
        `TTS session open timed out after ${this.#openTimeoutMs}ms`,
      );
      let timedOut = false;
      const boundedOpening = withTimeout(opening, this.#openTimeoutMs, timeout).catch((error) => {
        if (error === timeout) timedOut = true;
        throw error;
      });
      this.#session = Promise.race([
        boundedOpening,
        this.#cancelledSignal.promise.then(() => null),
      ]);
      // A provider may ignore the startup deadline or cancellation signal. If it
      // eventually hands us a session, still make a bounded best-effort cleanup.
      void opening
        .then((session) => {
          if (this.#cancelled || timedOut) {
            return this.#cancelSession(session);
          }
          return undefined;
        })
        .catch(() => undefined);
      this.#started.resolve(true);
    }
    return this.#session.then((session) => {
      if (!session) {
        throw new Error("Incremental TTS input is closed");
      }
      return session;
    });
  }

  async #cancelInternal(): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#eventsAbort.abort();
    this.#cancelledSignal.resolve(undefined);
    if (!this.#session) {
      this.#session = Promise.resolve(null);
      this.#started.resolve(false);
      return;
    }
    const session = await this.#session.catch(() => null);
    // Bounded like every other provider-cancel path: a hanging session cancel is
    // abandoned and its late settlement is observed by the promise chain above.
    await this.#cancelSession(session);
  }

  #cancelSession(session: TtsSession | null): Promise<void> {
    if (!session) {
      return Promise.resolve();
    }
    if (!this.#sessionCancelPromise) {
      this.#sessionCancelPromise = cancelWithTimeout(
        () => session.cancel(),
        CANCELLATION_TIMEOUT_MS,
      ).catch(() => undefined);
    }
    return this.#sessionCancelPromise;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.#operationTail.then(operation);
    // Keep the queue usable after a provider failure while returning the original
    // rejection to the operation's caller.
    this.#operationTail = queued.catch(() => undefined);
    return queued;
  }

  async *#forwardEvents(): AsyncIterable<TtsEvent> {
    await this.#started.promise;
    const session = await Promise.race([
      this.#session,
      abortPromise(this.#eventsAbort.signal).then(() => null),
    ]);
    if (!session) {
      return;
    }
    const iterator = session.events[Symbol.asyncIterator]();
    try {
      while (!this.#eventsAbort.signal.aborted) {
        const next = iterator.next();
        next.catch(() => undefined);
        const step = await Promise.race([
          next,
          abortPromise(this.#eventsAbort.signal).then(() => ({
            done: true as const,
            value: undefined as never,
          })),
        ]);
        if (step.done) return;
        yield step.value;
      }
    } finally {
      await closeAsyncIterator(iterator, "Incremental TTS event iterator cleanup timed out");
    }
  }

  async #flushAndRemember(session: TtsSession): Promise<void> {
    const flush = this.#flush(session);
    this.#trackFlush(flush);
    // Flush failures are retained and surfaced from finish(), so a streaming
    // caller can continue receiving later text while the boundary is observed.
    await flush.catch(() => undefined);
  }

  #trackFlush(flush: Promise<TtsFlushResult>): void {
    void flush.catch((error: unknown) => {
      this.#flushFailed = true;
      this.#flushError ??= error;
    });
    this.#flushes.add(flush);
    void flush
      .finally(() => {
        this.#flushes.delete(flush);
      })
      .catch(() => undefined);
  }

  async #sendText(session: TtsSession, text: string): Promise<void> {
    await withTimeout(
      Promise.resolve().then(() => session.sendText(text)),
      this.#sendTimeoutMs,
      timeoutError("tts.send_timeout", `TTS text send timed out after ${this.#sendTimeoutMs}ms`),
    );
  }

  #flush(session: TtsSession): Promise<TtsFlushResult> {
    return withTimeout(
      Promise.resolve().then(() => session.flush()),
      this.#flushTimeoutMs,
      timeoutError("tts.flush_timeout", `TTS flush timed out after ${this.#flushTimeoutMs}ms`),
    );
  }

  async #finishSession(session: TtsSession): Promise<void> {
    await withTimeout(
      Promise.resolve().then(() => session.finish()),
      this.#finishTimeoutMs,
      timeoutError("tts.finish_timeout", `TTS finish timed out after ${this.#finishTimeoutMs}ms`),
    );
  }

  #takeBuffer(): string {
    const text = this.#buffer;
    this.#buffer = "";
    this.#bufferBytes = 0;
    return text;
  }

  #takeCompleteSentences(): readonly string[] {
    const sentences: string[] = [];
    let consumed = 0;
    for (const segment of sentenceSegmenter.segment(this.#buffer)) {
      const end = segment.index + segment.segment.length;
      if (!ENDS_SENTENCE.test(segment.segment)) {
        break;
      }
      sentences.push(segment.segment);
      consumed = end;
    }
    this.#buffer = this.#buffer.slice(consumed);
    this.#bufferBytes = utf8ByteLength(this.#buffer);
    return sentences;
  }
}

function invalidTimeoutError(
  name: "openTimeoutMs" | "sendTimeoutMs" | "flushTimeoutMs" | "finishTimeoutMs",
  value: number,
): ReturnType<typeof validationError> {
  const message = `${name} must be a positive finite number, received ${value}`;
  switch (name) {
    case "openTimeoutMs":
      return validationError("tts.open_timeout_invalid", message);
    case "sendTimeoutMs":
      return validationError("tts.send_timeout_invalid", message);
    case "flushTimeoutMs":
      return validationError("tts.flush_timeout_invalid", message);
    case "finishTimeoutMs":
      return validationError("tts.finish_timeout_invalid", message);
  }
}

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const ENDS_SENTENCE = /[.!?…][\s"'’”)[\]]*$/u;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
