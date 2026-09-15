import type { TtsEvent, TtsSession, TtsStream } from "@tvic/core";

import { abortPromise } from "./async-control.js";
import { cancelProviderBounded, closeAsyncIterator } from "./pipeline-helpers.js";
import { MAX_RUNTIME_INCREMENTAL_TTS_BUFFER_BYTES } from "./pipeline-constants.js";
import { runtimeResourceLimitError, utf8ByteLength } from "./pipeline-resource-limits.js";

export interface IncrementalTtsInputOptions {
  readonly openSession: () => Promise<TtsSession>;
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
  readonly #started = deferred<boolean>();
  readonly #eventsAbort = new AbortController();
  #session: Promise<TtsSession | null> | null = null;
  #activeSession: TtsSession | null = null;
  #cancelPromise: Promise<void> | undefined;
  #buffer = "";
  #bufferBytes = 0;
  #finishing = false;
  #cancelled = false;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: IncrementalTtsInputOptions) {
    this.#openSession = options.openSession;
    this.opened = this.#started.promise;
    this.events = this.#forwardEvents();
  }

  pushToken(text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return this.#enqueue(async () => {
      if (this.#cancelled) return;
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
      const session = this.#ensureSession();
      const sentences = this.#takeCompleteSentences();
      for (const sentence of sentences) {
        const opened = await session;
        await opened.sendText(sentence);
        // Cartesia treats flush as an ordered boundary on one synthesis context.
        // Awaiting the acknowledgement prevents a second flush from overtaking the
        // first while audio from both boundaries is still being delivered.
        await opened.flush();
      }
    });
  }

  flushBoundary(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#cancelled || this.#buffer.length === 0) return;
      const session = await this.#ensureSession();
      const text = this.#takeBuffer();
      await session.sendText(text);
      await session.flush();
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
      if (this.#buffer.length > 0) {
        await session.sendText(this.#takeBuffer());
      }
      await session.finish();
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
      this.#session = this.#openSession().then((session) => {
        this.#activeSession = session;
        return session;
      });
      this.#session.catch(() => undefined);
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
    if (!this.#session) {
      this.#session = Promise.resolve(null);
      this.#started.resolve(false);
      return;
    }
    const activeSession = this.#activeSession;
    if (activeSession) {
      await cancelProviderBounded(
        () => activeSession.cancel(),
        "Incremental TTS cancellation timed out",
      );
      return;
    }
    // Cancellation must not wait for a provider handshake that has already
    // exceeded the caller's deadline. If the late session eventually arrives,
    // cancel it with the same bounded policy so the provider handle cannot leak.
    const sessionPromise = this.#session;
    void sessionPromise
      .then((session) => {
        if (!session) return;
        return cancelProviderBounded(
          () => session.cancel(),
          "Late incremental TTS cancellation timed out",
        );
      })
      .catch(() => undefined);
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
