import { timeoutError, validationError, TvicThrowableError, TVIC_ERROR_CODES } from "@tvic/core";
import type { TtsEvent, TtsFlushResult, TtsSession, TtsStream } from "@tvic/core";

import { abortPromise, cancelWithTimeout, withTimeout } from "./async-control.js";
import {
  CANCELLATION_TIMEOUT_MS,
  DEFAULT_RUNTIME_INCREMENTAL_TTS_BATCH_CHARACTERS,
  MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES,
  STARTUP_TIMEOUT_MS,
  TTS_FINISH_TIMEOUT_MS,
  TTS_FLUSH_TIMEOUT_MS,
  TTS_SEND_TIMEOUT_MS,
} from "./pipeline-constants.js";
import {
  runtimeResourceLimitError,
  utf8ByteLengthWithinLimit,
} from "./pipeline-resource-limits.js";
import { closeAsyncIterator } from "./pipeline-helpers.js";

export interface IncrementalTtsInputOptions {
  readonly openSession: () => Promise<TtsSession>;
  readonly openTimeoutMs?: number;
  readonly sendTimeoutMs?: number;
  readonly flushTimeoutMs?: number;
  readonly finishTimeoutMs?: number;
  readonly maxBatchCharacters?: number;
}

export class IncrementalTtsInput implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly opened: Promise<boolean>;
  readonly #openSession: () => Promise<TtsSession>;
  readonly #openTimeoutMs: number;
  readonly #sendTimeoutMs: number;
  readonly #flushTimeoutMs: number;
  readonly #finishTimeoutMs: number;
  readonly #maxBatchCharacters: number;
  readonly #started = deferred<boolean>();
  readonly #cancelledSignal = deferred<void>();
  readonly #eventsAbort = new AbortController();
  readonly #flushes = new Set<Promise<TtsFlushResult>>();
  #flushFailed = false;
  #flushError: unknown;
  #session: Promise<TtsSession | null> | null = null;
  #sessionCancelPromise: Promise<void> | undefined;
  #buffer = "";
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
    this.#maxBatchCharacters =
      options.maxBatchCharacters ?? DEFAULT_RUNTIME_INCREMENTAL_TTS_BATCH_CHARACTERS;
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
    if (!Number.isSafeInteger(this.#maxBatchCharacters) || this.#maxBatchCharacters < 1) {
      throw TvicThrowableError.from(
        validationError(
          TVIC_ERROR_CODES.providerInvalidRequest,
          "maxBatchCharacters must be a positive safe integer",
        ),
      );
    }
    this.opened = this.#started.promise;
    this.events = this.#forwardEvents();
  }

  pushToken(text: string): Promise<void> {
    if (!text) return Promise.resolve();
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
      const nextBuffer = this.#buffer + text;
      const nextBufferBytes = utf8ByteLengthWithinLimit(
        nextBuffer,
        MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES,
      );
      if (nextBufferBytes === undefined) {
        this.#buffer = "";
        throw runtimeResourceLimitError(
          "incremental TTS input buffer",
          "bytes",
          MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES,
        );
      }
      this.#buffer = nextBuffer;
      const batches = SENTENCE_TERMINAL.test(text) ? this.#takeCompleteSentences() : [];
      for (const batch of batches) {
        const opened = await session;
        if (this.#cancelled) return;
        await this.#sendText(opened, batch);
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
      await this.#sendTextBatches(session, text);
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
        await this.#sendTextBatches(session, this.#takeBuffer());
      }
      if (this.#cancelled) return;
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

  async #sendTextBatches(session: TtsSession, text: string): Promise<void> {
    for (const batch of splitTextIntoBatches(text, this.#maxBatchCharacters)) {
      if (this.#cancelled) return;
      await this.#sendText(session, batch);
    }
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
    const batches: string[] = [];
    let batch: string[] = [];
    let batchCharacters = 0;
    let consumed = 0;
    let sentenceCount = 0;
    const flushBatch = (): void => {
      if (batchCharacters === 0) return;
      batches.push(batch.join(""));
      batch = [];
      batchCharacters = 0;
    };
    for (const segment of sentenceSegmenter.segment(this.#buffer)) {
      const end = segment.index + segment.segment.length;
      if (!ENDS_SENTENCE.test(segment.segment)) {
        break;
      }
      sentenceCount += 1;
      for (const character of segment.segment) {
        if (batchCharacters + character.length > this.#maxBatchCharacters) {
          const text = batch.join("");
          const boundary = findBatchBoundary(text, this.#maxBatchCharacters);
          if (boundary > 0 && boundary < text.length) {
            batches.push(text.slice(0, boundary));
            batch = [...text.slice(boundary)];
            batchCharacters = text.length - boundary;
          } else {
            flushBatch();
          }
        }
        batch.push(character);
        batchCharacters += character.length;
      }
      if (sentenceCount <= INDIVIDUAL_TTS_SENTENCES_PER_PUSH) flushBatch();
      consumed = end;
    }
    flushBatch();
    this.#buffer = this.#buffer.slice(consumed);
    return batches;
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
const SENTENCE_TERMINAL = /(?:\p{Sentence_Terminal}|…)/u;
const ENDS_SENTENCE = /(?:\p{Sentence_Terminal}|…)[\s\p{Pe}\p{Pf}"'’”]*$/u;
const INDIVIDUAL_TTS_SENTENCES_PER_PUSH = 32;

function splitTextIntoBatches(text: string, maximumCharacters: number): readonly string[] {
  const batches: string[] = [];
  let remaining = text;
  while (remaining.length > maximumCharacters) {
    const boundary = findBatchBoundary(remaining, maximumCharacters);
    batches.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining.length > 0) batches.push(remaining);
  return batches;
}

function findBatchBoundary(text: string, maximumCharacters: number): number {
  let characters = 0;
  let lastWordBoundary = 0;
  let firstNonWhitespace = false;
  let safeBoundary = 0;
  for (const character of text) {
    if (characters + character.length > maximumCharacters) break;
    characters += character.length;
    safeBoundary = characters;
    if (/\s/u.test(character)) {
      if (firstNonWhitespace) lastWordBoundary = characters;
    } else {
      firstNonWhitespace = true;
    }
  }
  return lastWordBoundary > 0 ? lastWordBoundary : safeBoundary;
}

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
