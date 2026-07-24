import type { TtsEvent, TtsSession, TtsStream } from "@tvic/core";

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
  readonly #flushes: Promise<number>[] = [];
  #session: Promise<TtsSession | null> | null = null;
  #buffer = "";
  #finishing = false;
  #cancelled = false;

  constructor(options: IncrementalTtsInputOptions) {
    this.#openSession = options.openSession;
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
      await opened.sendText(sentence);
      this.#trackFlush(opened.flush());
    }
  }

  async flushBoundary(): Promise<void> {
    if (this.#cancelled || this.#buffer.length === 0) {
      return;
    }
    const session = await this.#ensureSession();
    const text = this.#takeBuffer();
    await session.sendText(text);
    this.#trackFlush(session.flush());
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
    if (this.#buffer.length > 0) {
      await session.sendText(this.#takeBuffer());
    }
    await session.finish();
    await Promise.all(this.#flushes);
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    if (!this.#session) {
      this.#session = Promise.resolve(null);
      this.#started.resolve(false);
      return;
    }
    const session = await this.#session.catch(() => null);
    await session?.cancel();
  }

  #ensureSession(): Promise<TtsSession> {
    if (!this.#session) {
      this.#session = this.#openSession();
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

  async *#forwardEvents(): AsyncIterable<TtsEvent> {
    await this.#started.promise;
    const session = await this.#session;
    if (!session) {
      return;
    }
    yield* session.events;
  }

  #trackFlush(flush: Promise<number>): void {
    flush.catch(() => undefined);
    this.#flushes.push(flush);
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
