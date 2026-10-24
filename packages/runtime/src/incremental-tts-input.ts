import {
  createTtsTextPartBatches,
  timeoutError,
  validateTtsTextOperations,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import type { TtsEvent, TtsFlushResult, TtsSession, TtsStream, TtsTextOperation } from "@tvic/core";

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
import {
  TTS_BOUNDARY_COMPLETE,
  TTS_BOUNDARY_INCOMPLETE,
  TtsOperationBoundaryMatcher,
  type TtsOperationBoundaryCursor,
} from "./tts-operation-boundaries.js";

export interface IncrementalTtsInputOptions {
  readonly openSession: () => Promise<TtsSession>;
  readonly textOperations?: readonly TtsTextOperation[];
  readonly operationBoundaryMatcher?: TtsOperationBoundaryMatcher;
  readonly onTextOperationsNotApplied?: (count: number) => void;
  readonly openTimeoutMs?: number;
  readonly sendTimeoutMs?: number;
  readonly flushTimeoutMs?: number;
  readonly finishTimeoutMs?: number;
}

export class IncrementalTtsInput implements TtsStream {
  readonly events: AsyncIterable<TtsEvent>;
  readonly opened: Promise<boolean>;
  readonly #openSession: () => Promise<TtsSession>;
  readonly #textOperations: readonly TtsTextOperation[];
  readonly #operationBoundaryMatcher: TtsOperationBoundaryMatcher | undefined;
  readonly #operationBoundaryCursor: TtsOperationBoundaryCursor | undefined;
  readonly #onTextOperationsNotApplied: ((count: number) => void) | undefined;
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
  #sentenceBoundaries: number[] = [];
  #finishing = false;
  #cancelled = false;
  #cancelPromise: Promise<void> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  readonly #appliedTextOperationMatches = new Set<string>();

  constructor(options: IncrementalTtsInputOptions) {
    this.#openSession = options.openSession;
    this.#textOperations = validateTtsTextOperations(options.textOperations ?? []);
    this.#operationBoundaryMatcher =
      options.operationBoundaryMatcher ??
      (this.#textOperations.length > 0
        ? new TtsOperationBoundaryMatcher(this.#textOperations)
        : undefined);
    this.#onTextOperationsNotApplied = options.onTextOperationsNotApplied;
    this.#operationBoundaryCursor = this.#operationBoundaryMatcher?.createCursor();
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
      const duplicateMatch = this.#operationBoundaryCursor?.append(text);
      if (duplicateMatch !== undefined) {
        throw invalidTextOperationError("A configured TTS text operation matched more than once");
      }
      const previousBufferLength = this.#buffer.length;
      this.#buffer += text;
      this.#bufferBytes += textBytes;
      this.#refreshSentenceBoundaries(previousBufferLength, text);
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
      const incompleteSuffixLength =
        this.#operationBoundaryCursor?.longestProperPrefixSuffixLength() ?? 0;
      const candidateLength = this.#buffer.length - incompleteSuffixLength;
      const safeLength =
        this.#operationBoundaryCursor?.safePrefixLength(candidateLength) ?? candidateLength;
      if (safeLength === 0) return;
      const session = await this.#ensureSession();
      if (this.#cancelled) return;
      const text = this.#buffer.slice(0, safeLength);
      this.#consumeBufferPrefix(safeLength);
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
      const unappliedOperationCount = this.#textOperations.filter(
        (operation) => !this.#appliedTextOperationMatches.has(operation.match),
      ).length;
      if (unappliedOperationCount > 0) {
        this.#onTextOperationsNotApplied?.(unappliedOperationCount);
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
    const duplicateMatch = this.#operationBoundaryMatcher?.findDuplicateOperationMatch(text);
    if (duplicateMatch !== undefined) {
      throw invalidTextOperationError("A configured TTS text operation matched more than once");
    }
    const operations = this.#textOperations.filter((operation) => text.includes(operation.match));
    if (operations.length > 0) {
      if (operations.some((operation) => this.#appliedTextOperationMatches.has(operation.match))) {
        throw invalidTextOperationError("A configured TTS text operation matched more than once");
      }
      const sendTextParts = session.sendTextParts;
      if (!sendTextParts) {
        throw TvicThrowableError.from(
          validationError(
            "provider.invalid_request",
            "The opened TTS session does not support the selected typed text operations",
          ),
        );
      }
      for (const parts of createTtsTextPartBatches(text, operations)) {
        if (this.#cancelled) return;
        await withTimeout(
          Promise.resolve().then(() => sendTextParts.call(session, parts)),
          this.#sendTimeoutMs,
          timeoutError(
            "tts.send_timeout",
            `TTS text send timed out after ${this.#sendTimeoutMs}ms`,
          ),
        );
      }
      if (this.#cancelled) return;
      for (const operation of operations) {
        this.#appliedTextOperationMatches.add(operation.match);
      }
      return;
    }
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
    this.#sentenceBoundaries = [];
    this.#operationBoundaryCursor?.discardPrefix(text.length);
    return text;
  }

  #refreshSentenceBoundaries(previousBufferLength: number, appendedText: string): void {
    const previousCodeUnit =
      previousBufferLength > 0 ? this.#buffer.charCodeAt(previousBufferLength - 1) : 0;
    const nextCodeUnit = appendedText.length > 0 ? appendedText.charCodeAt(0) : 0;
    const completedSupplementaryTerminal =
      previousCodeUnit >= 0xd800 &&
      previousCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff &&
      HAS_SENTENCE_TERMINAL.test(
        this.#buffer.slice(previousBufferLength - 1, previousBufferLength + 1),
      );
    if (HAS_SENTENCE_TERMINAL.test(appendedText) || completedSupplementaryTerminal) {
      const boundaries: number[] = [];
      for (const segment of sentenceSegmenter.segment(this.#buffer)) {
        const end = segment.index + segment.segment.length;
        if (!ENDS_SENTENCE.test(segment.segment)) break;
        boundaries.push(end);
      }
      this.#sentenceBoundaries = boundaries;
      return;
    }

    const lastBoundaryIndex = this.#sentenceBoundaries.length - 1;
    const lastBoundary = this.#sentenceBoundaries[lastBoundaryIndex];
    if (lastBoundary === undefined || lastBoundary !== previousBufferLength) return;
    const trailingExtension = /^[\s\p{Pe}\p{Pf}"'’”]*/u.exec(appendedText)?.[0].length ?? 0;
    if (trailingExtension > 0) {
      this.#sentenceBoundaries[lastBoundaryIndex] = lastBoundary + trailingExtension;
    }
  }

  #consumeBufferPrefix(consumed: number): void {
    if (consumed === 0) return;
    this.#buffer = this.#buffer.slice(consumed);
    this.#bufferBytes = utf8ByteLength(this.#buffer);
    this.#sentenceBoundaries = this.#sentenceBoundaries
      .filter((boundary) => boundary > consumed)
      .map((boundary) => boundary - consumed);
    this.#operationBoundaryCursor?.discardPrefix(consumed);
  }

  #takeCompleteSentences(): readonly string[] {
    if (!this.#operationBoundaryMatcher) {
      const sentences: string[] = [];
      let sentenceStart = 0;
      for (const end of this.#sentenceBoundaries) {
        sentences.push(this.#buffer.slice(sentenceStart, end));
        sentenceStart = end;
      }
      this.#consumeBufferPrefix(sentenceStart);
      return sentences;
    }

    const boundaries = this.#sentenceBoundaries;
    const classification = this.#operationBoundaryCursor?.classify(boundaries);
    if (!classification) return [];
    if (classification.duplicateMatch !== undefined) {
      throw invalidTextOperationError("A configured TTS text operation matched more than once");
    }
    const boundaryKinds = classification.kinds;
    const sentences: string[] = [];
    let sentenceStart = 0;
    let consumed = 0;
    for (const [index, end] of boundaries.entries()) {
      const boundaryKind = boundaryKinds[index];
      if (boundaryKind === TTS_BOUNDARY_INCOMPLETE) break;
      if (boundaryKind === TTS_BOUNDARY_COMPLETE) continue;
      sentences.push(this.#buffer.slice(sentenceStart, end));
      sentenceStart = end;
      consumed = end;
    }

    this.#consumeBufferPrefix(consumed);
    return sentences;
  }
}

function invalidTextOperationError(message: string): TvicThrowableError {
  return TvicThrowableError.from(validationError("provider.invalid_request", message));
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
const HAS_SENTENCE_TERMINAL = /\p{Sentence_Terminal}/u;
const ENDS_SENTENCE = /\p{Sentence_Terminal}[\s\p{Pe}\p{Pf}"'’”]*$/u;

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
