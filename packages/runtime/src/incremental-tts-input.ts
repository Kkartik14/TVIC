import { timeoutError, validationError, TvicThrowableError } from "@tvic/core";
import type { TtsEvent, TtsFlushResult, TtsSession, TtsStream } from "@tvic/core";

import { cancelWithTimeout, withTimeout } from "./async-control.js";
import {
  CANCELLATION_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  TTS_FINISH_TIMEOUT_MS,
  TTS_FLUSH_TIMEOUT_MS,
  TTS_SEND_TIMEOUT_MS,
} from "./pipeline-constants.js";

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
  readonly #flushes = new Set<Promise<TtsFlushResult>>();
  #flushFailed = false;
  #flushError: unknown;
  #session: Promise<TtsSession | null> | null = null;
  #sessionCancelPromise: Promise<void> | undefined;
  #buffer = "";
  #finishing = false;
  #cancelled = false;

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

  async pushToken(text: string): Promise<void> {
    if (!text || this.#cancelled) {
      return;
    }
    if (this.#finishing) {
      throw new Error("Cannot add TTS text after finishing input");
    }
    this.#buffer += text;
    const session = this.#ensureSession();
    const sentences = this.#takeCompleteSentences();
    for (const sentence of sentences) {
      const opened = await session;
      if (this.#cancelled) return;
      await this.#sendText(opened, sentence);
      if (this.#cancelled) return;
      this.#trackFlush(this.#flush(opened));
    }
  }

  async flushBoundary(): Promise<void> {
    if (this.#cancelled || this.#buffer.length === 0) {
      return;
    }
    const session = await this.#ensureSession();
    if (this.#cancelled) return;
    const text = this.#takeBuffer();
    await this.#sendText(session, text);
    if (this.#cancelled) return;
    this.#trackFlush(this.#flush(session));
  }

  async finish(): Promise<void> {
    if (this.#finishing || this.#cancelled) {
      return;
    }
    this.#finishing = true;
    if (!this.#session) {
      this.#session = Promise.resolve(null);
      this.#started.resolve(false);
      return;
    }
    const session = await this.#session;
    if (!session) {
      return;
    }
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
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    this.#cancelledSignal.resolve(undefined);
    if (!this.#session) {
      this.#session = Promise.resolve(null);
      this.#started.resolve(false);
      return;
    }
    const session = await this.#session.catch(() => null);
    // Bounded like every other provider-cancel path: a hanging session
    // cancel is abandoned (late settlement is already observed, so no
    // unhandled rejection) and teardown proceeds.
    await this.#cancelSession(session);
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
      // A provider may ignore the startup deadline or cancellation signal. If
      // it eventually hands us a session, still make a bounded best-effort
      // cleanup so a late connection cannot remain live.
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

  #cancelSession(session: TtsSession | null): Promise<void> {
    // Cancellation can win the startup race before a provider session exists.
    // Do not memoize that no-op: a late session must still be cancelled when
    // the provider eventually resolves the opening promise.
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

  async *#forwardEvents(): AsyncIterable<TtsEvent> {
    await this.#started.promise;
    const session = await this.#session;
    if (!session) {
      return;
    }
    yield* session.events;
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
const ENDS_SENTENCE = /[.!?…][\s"'’”)\]]*$/u;

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
