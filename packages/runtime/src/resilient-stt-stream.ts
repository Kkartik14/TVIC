import type {
  InputAudioChunk,
  NormalizedError,
  ProviderEventId,
  SpeechToTextProvider,
  SttOpenRequest,
  SttStream,
  SttTimestampOrigin,
  TranscriptEndpointEvent,
  TranscriptEvent,
} from "@tvic/core";
import {
  counterIdGenerator,
  providerError,
  STT_ERROR_CODES,
  timeoutError,
  validationError,
  TvicThrowableError,
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";
import { abortPromise, returnAsyncIteratorWithTimeout, sleepWithAbort } from "./async-control.js";
import { CANCELLATION_TIMEOUT_MS } from "./pipeline-constants.js";
import { closeSttStreamBounded } from "./stt-cleanup.js";
import type { SttCommandController } from "./stt-command-controller.js";
import {
  STT_RECOVERY_CONTROL,
  type SttRecoveryControl,
  type SttRecoveryState,
} from "./resilient-stt-control.js";
import {
  compactJournal,
  findReplayStart,
  journalBytes,
  type SttJournalEntry,
} from "./resilient-stt-journal.js";
import {
  bufferOverflowError,
  closedError,
  audioWriteTimeoutError,
  isRecoveryExhausted,
  normalizeAudioOffsets,
  normalizeGenerationError,
  recoveryExhaustedError,
  sessionBufferOverflowError,
  withJitter,
  withPreservedTimeout,
  type ResolvedSttReconnectOptions,
} from "./resilient-stt-policy.js";

interface GenerationFailure {
  readonly kind: "failed";
  readonly error: unknown;
}

interface GenerationStable {
  readonly kind: "stable";
}

export class ResilientSttStream implements SttStream {
  readonly events: AsyncIterable<TranscriptEvent>;
  readonly commitMode: "provider" | "none";
  readonly timestampOrigin: SttTimestampOrigin;
  readonly #provider: SpeechToTextProvider;
  readonly #request: SttOpenRequest;
  readonly #options: ResolvedSttReconnectOptions;
  readonly #events: AsyncQueue<TranscriptEvent>;
  readonly #ids = counterIdGenerator<ProviderEventId>("stt_reconnect_event");
  readonly #failure: Promise<never>;
  #rejectFailure!: (error: unknown) => void;
  readonly #listeners = new Set<(state: SttRecoveryState) => void>();
  readonly #journal: SttJournalEntry[] = [];
  readonly #lifecycle = new AbortController();
  readonly #controller: SttCommandController;
  #state: SttRecoveryState = "healthy";
  #active: SttStream | undefined;
  #generation = 1;
  #generationOffsetMs = 0;
  #cursor = 0;
  #sequence = 1;
  #sessionAudioMs = 0;
  #closed = false;
  #closing = false;
  #terminal = false;
  #terminalError: TvicThrowableError | undefined;
  #recoveryPromise: Promise<void> | undefined;
  #failedStreamClosePromise: Promise<void> | undefined;
  #generationWait:
    | {
        readonly generation: number;
        readonly resolve: (outcome: GenerationFailure | GenerationStable) => void;
        readonly replayBoundary: number;
        readonly stableTimer: ReturnType<typeof setTimeout>;
        readonly deadlineTimer: ReturnType<typeof setTimeout>;
        stableReached: boolean;
      }
    | undefined;
  #replayStart = 0;
  #replayBoundary = 0;
  #heldEndpoints: Array<{ readonly event: TranscriptEndpointEvent; readonly generation: number }> =
    [];
  #wake: Promise<void> | undefined;
  #resolveWake: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;
  #streamClosePromise: Promise<void> | undefined;
  readonly #generationStops = new Map<number, AbortController>();
  readonly #generationIterators = new Map<number, AsyncIterator<TranscriptEvent>>();
  readonly #generationIteratorReturns = new Map<number, Promise<void>>();
  readonly #drainWaiters: Array<() => void> = [];

  constructor(
    provider: SpeechToTextProvider,
    request: SttOpenRequest,
    stream: SttStream,
    options: ResolvedSttReconnectOptions,
  ) {
    this.#provider = provider;
    this.#request = request;
    this.#options = options;
    this.#active = stream;
    this.commitMode = stream.commitMode ?? "provider";
    this.timestampOrigin = stream.timestampOrigin!;
    this.#events = new AsyncQueue({ maxBuffered: 1_024 });
    this.events = this.#events;
    this.#failure = new Promise<never>((_, reject) => {
      this.#rejectFailure = reject;
    });
    this.#failure.catch(() => undefined);
    this.#controller = {
      failure: this.#failure,
      admitAudio: (chunk) => this.sendAudio(chunk),
      admitCommit: () => this.commit(),
      drain: () => this.close(),
      abort: (error) => this.#abort(error),
    };
    Object.defineProperty(this, STT_RECOVERY_CONTROL, {
      configurable: false,
      enumerable: false,
      value: {
        controller: this.#controller,
        state: () => this.#state,
        subscribe: (listener: (state: SttRecoveryState) => void) => {
          this.#listeners.add(listener);
          return () => this.#listeners.delete(listener);
        },
      } satisfies SttRecoveryControl,
      writable: false,
    });
    void this.#consumeGeneration(1, stream);
    void this.#runJournal();
  }

  sendAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#closed || this.#closing || this.#terminal) {
      return Promise.reject(TvicThrowableError.from(closedError()));
    }
    const bytes = chunk.audio.bytes.byteLength;
    this.#compactJournal(Date.now());
    if (
      this.#journal.length >= this.#options.maxBufferedCommands ||
      journalBytes(this.#journal) + bytes > this.#options.maxBufferedBytes
    ) {
      const error = TvicThrowableError.from(bufferOverflowError());
      this.#failTerminal(error);
      return Promise.reject(error);
    }
    const copied: InputAudioChunk = {
      ...chunk,
      audio: { ...chunk.audio, bytes: new Uint8Array(chunk.audio.bytes) },
    };
    this.#journal.push({
      kind: "audio",
      chunk: copied,
      bytes,
      offsetMs: this.#sessionAudioMs,
      admittedAtMs: Date.now(),
    });
    this.#sessionAudioMs += copied.audio.durationMs;
    this.#signalWork();
    return Promise.resolve();
  }

  commit(): Promise<void> {
    if (this.#closed || this.#closing || this.#terminal) {
      return Promise.reject(TvicThrowableError.from(closedError()));
    }
    this.#compactJournal(Date.now());
    if (this.#journal.length >= this.#options.maxBufferedCommands) {
      const error = TvicThrowableError.from(bufferOverflowError());
      this.#failTerminal(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.#journal.push({
        kind: "commit",
        admittedAtMs: Date.now(),
        settled: false,
        resolve,
        reject,
      });
      this.#signalWork();
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#closePromise = this.#closeGracefully();
    return this.#closePromise;
  }

  async #closeGracefully(): Promise<void> {
    if (this.#closed && !this.#terminal) {
      return;
    }
    const terminalAtStart = this.#terminal;
    let closeFailure: TvicThrowableError | undefined;
    this.#closing = true;
    this.#signalWork();
    if (!this.#terminal) {
      try {
        await withPreservedTimeout(
          this.#waitForJournalDrain(),
          this.#options.closeTimeoutMs,
          timeoutError(
            "stt.close_timeout",
            `STT command drain timed out after ${CANCELLATION_TIMEOUT_MS}ms`,
            { provider: this.#provider.name },
          ),
          this.#lifecycle.signal,
        );
      } catch (error) {
        // #failTerminal aborts the lifecycle to wake this wait. In that case
        // the abort error is only a wake-up signal; preserve the original
        // provider/timeout failure that was latched by the terminal path.
        closeFailure = this.#terminalError ?? TvicThrowableError.from(error);
        this.#failTerminal(closeFailure);
      }
    } else if (!terminalAtStart) {
      // A command or generation can fail while the close drain is waiting.
      // Preserve that failure instead of reporting a successful close.
      closeFailure = this.#terminalError;
    }
    this.#closed = true;
    this.#setState("closed");
    this.#lifecycle.abort();
    this.#clearGenerationWait({
      kind: "failed",
      error: TvicThrowableError.from(closedError()),
    });
    this.#rejectPending(closedError());
    this.#notifyProgress();
    await this.#waitForFailedStreamClose();
    await this.#closeActive();
    this.#events.close();
    if (closeFailure) {
      throw closeFailure;
    }
  }

  async #abort(error: unknown = closedError()): Promise<void> {
    if (this.#closed) {
      return;
    }
    const throwable = TvicThrowableError.from(error);
    this.#closed = true;
    this.#closing = true;
    this.#setState("closed");
    this.#lifecycle.abort();
    this.#clearGenerationWait({ kind: "failed", error: throwable });
    this.#rejectPending(throwable);
    this.#notifyProgress();
    this.#signalWork();
    await this.#waitForFailedStreamClose();
    await this.#closeActive();
    this.#events.close();
  }

  async #runJournal(): Promise<void> {
    while (!this.#closed && !this.#terminal) {
      const entry = this.#journal[this.#cursor];
      if (!entry) {
        if (this.#closing) {
          return;
        }
        await this.#waitForWork();
        continue;
      }
      const generation = this.#generation;
      const stream = this.#active;
      if (!stream || (this.#state !== "healthy" && this.#state !== "probationary")) {
        await this.#waitForWork();
        continue;
      }

      try {
        if (entry.kind === "audio") {
          await withPreservedTimeout(
            Promise.resolve().then(() => stream.sendAudio(entry.chunk)),
            this.#options.audioWriteTimeoutMs,
            audioWriteTimeoutError(
              this.#options.audioWriteErrorCode,
              `STT audio write was not accepted within ${this.#options.audioWriteTimeoutMs}ms`,
              this.#provider.name,
            ),
            this.#lifecycle.signal,
          );
          if (generation !== this.#generation || stream !== this.#active) {
            // The provider operation settled after this generation was fenced.
            // Leave the cursor on the entry so the recovered stream replays it.
            continue;
          }
          entry.dispatchedAtMs = Date.now();
          this.#cursor += 1;
        } else if (this.commitMode === "none") {
          if (generation !== this.#generation || stream !== this.#active) {
            continue;
          }
          entry.settled = true;
          entry.resolve();
          this.#cursor += 1;
        } else {
          await withPreservedTimeout(
            Promise.resolve().then(() => stream.commit()),
            this.#options.commitTimeoutMs,
            timeoutError(
              "stt.commit_timeout",
              `STT commit was not accepted within ${this.#options.commitTimeoutMs}ms`,
            ),
            this.#lifecycle.signal,
          );
          if (generation !== this.#generation || stream !== this.#active) {
            continue;
          }
          entry.settled = true;
          entry.resolve();
          this.#cursor += 1;
        }
        this.#notifyProgress();
        this.#compactJournal(Date.now());
        this.#releaseHeldEndpoints();
      } catch (error) {
        this.#handleGenerationFailure(generation, stream, error);
      }
    }
  }

  async #consumeGeneration(generation: number, stream: SttStream): Promise<void> {
    let iterator: AsyncIterator<TranscriptEvent> | undefined;
    let naturallyDone = false;
    const stop = new AbortController();
    const stopped = abortPromise(stop.signal);
    try {
      iterator = stream.events[Symbol.asyncIterator]();
      this.#generationStops.set(generation, stop);
      this.#generationIterators.set(generation, iterator);
      while (true) {
        const next = iterator.next();
        next.catch(() => undefined);
        const step = await Promise.race([
          next.then((result) => ({ kind: "event" as const, result })),
          stopped.then(() => ({ kind: "stopped" as const })),
        ]);
        if (step.kind === "stopped") {
          return;
        }
        if (step.result.done) {
          naturallyDone = true;
          break;
        }
        const event = step.result.value;
        if (this.#closed || generation !== this.#generation || stream !== this.#active) {
          continue;
        }
        if (event.sessionId !== this.#request.sessionId) {
          this.#handleGenerationFailure(
            generation,
            stream,
            providerError("provider.identity_mismatch", "STT event session identity mismatch", {
              provider: this.#provider.name,
              retriable: false,
            }),
          );
          return;
        }
        this.#forwardGenerationEvent(event, generation);
      }
      if (
        !this.#closed &&
        !this.#terminal &&
        generation === this.#generation &&
        stream === this.#active
      ) {
        this.#handleGenerationFailure(
          generation,
          stream,
          providerError(STT_ERROR_CODES.unexpectedEof, "STT provider stream ended unexpectedly", {
            provider: this.#provider.name,
            retriable: true,
          }),
        );
      }
    } catch (error) {
      if (
        !this.#closed &&
        !this.#terminal &&
        generation === this.#generation &&
        stream === this.#active
      ) {
        this.#handleGenerationFailure(
          generation,
          stream,
          normalizeGenerationError(error, this.#provider.name),
        );
      }
    } finally {
      // Release the generation-local abort listener even when the provider
      // ends naturally. A completed generation must not retain a listener
      // until the whole reconnect wrapper is collected.
      stop.abort();
      if (this.#generationStops.get(generation) === stop) {
        this.#generationStops.delete(generation);
      }
      if (iterator && this.#generationIterators.get(generation) === iterator) {
        this.#generationIterators.delete(generation);
      }
      if (iterator && !naturallyDone) {
        await this.#returnGenerationIterator(generation, iterator);
      }
    }
  }

  #forwardGenerationEvent(event: TranscriptEvent, generation: number): void {
    const normalized = normalizeAudioOffsets(event, this.timestampOrigin, this.#generationOffsetMs);
    if (
      normalized.type === "stt.endpoint" &&
      (this.#state !== "healthy" || this.#cursor < this.#replayBoundary)
    ) {
      if (this.#heldEndpoints.length >= this.#options.maxBufferedCommands) {
        this.#failTerminal(bufferOverflowError());
        return;
      }
      this.#heldEndpoints.push({ event: normalized, generation });
      return;
    }
    this.#emit(normalized, generation);
  }

  #emit(event: TranscriptEvent, generation: number): void {
    if (this.#closed || this.#terminal) {
      return;
    }
    const publicEvent = {
      ...event,
      id: this.#ids.next(),
      sequence: this.#sequence++,
      metadata: {
        ...(event.metadata ?? {}),
        reconnect: { generation },
      },
    } as TranscriptEvent;
    if (!this.#events.push(publicEvent)) {
      this.#failTerminal(sessionBufferOverflowError());
    }
  }

  #handleGenerationFailure(generation: number, stream: SttStream, source: unknown): void {
    const stale = generation !== this.#generation || stream !== this.#active;
    if (this.#closed || this.#terminal || stale) {
      return;
    }
    this.#stopGeneration(generation);
    this.#heldEndpoints.splice(0);
    const error = normalizeGenerationError(source, this.#provider.name);
    const failedStream = this.#active;
    this.#active = undefined;
    this.#replayStart = findReplayStart(
      this.#journal,
      this.#cursor,
      Date.now(),
      this.#options.uncertainWindowMs,
    );
    this.#replayBoundary = this.#journal.length;
    this.#cursor = this.#replayStart;
    this.#signalWork();
    this.#failedStreamClosePromise = failedStream
      ? closeSttStreamBounded(failedStream, { timeoutMs: this.#options.closeTimeoutMs })
      : undefined;
    if (this.#closing) {
      // A failure while graceful close is draining admitted work is not an
      // ordinary caller-requested close. Surface it through both the close
      // promise and the controller supervisor instead of resolving cleanup as
      // if every command had been accepted.
      this.#failTerminal(error);
      return;
    }
    if (!error.retriable) {
      this.#failTerminal(error);
      return;
    }
    this.#setState("recovering");
    this.#clearGenerationWait({ kind: "failed", error });
    void this.#startRecovery(error);
  }

  async #startRecovery(source: NormalizedError): Promise<void> {
    if (this.#recoveryPromise || this.#closed || this.#terminal) {
      return this.#recoveryPromise ?? Promise.resolve();
    }
    this.#recoveryPromise = this.#recover(source)
      .catch((error) => this.#failTerminal(normalizeGenerationError(error, this.#provider.name)))
      .finally(() => {
        this.#recoveryPromise = undefined;
      });
    await this.#recoveryPromise;
  }

  async #recover(source: NormalizedError): Promise<void> {
    const startedAtMs = Date.now();
    let attempts = 0;
    let quickFailures = 0;
    let backoffMs = this.#options.initialBackoffMs;
    let cause: NormalizedError = source;

    while (!this.#closed && !this.#terminal) {
      if (this.#failedStreamClosePromise) {
        const remainingMs = this.#options.maxRecoveryDurationMs - (Date.now() - startedAtMs);
        if (remainingMs <= 0) {
          this.#failTerminal(recoveryExhaustedError(cause));
          return;
        }
        await withPreservedTimeout(
          this.#failedStreamClosePromise,
          remainingMs,
          recoveryExhaustedError(cause),
          this.#lifecycle.signal,
        );
        this.#failedStreamClosePromise = undefined;
      }
      const elapsed = Date.now() - startedAtMs;
      if (elapsed >= this.#options.maxRecoveryDurationMs || attempts >= this.#options.maxAttempts) {
        this.#failTerminal(recoveryExhaustedError(cause));
        return;
      }
      const remainingMs = this.#options.maxRecoveryDurationMs - elapsed;
      await this.#sleep(Math.min(withJitter(backoffMs, this.#options.jitter), remainingMs));
      if (this.#closed || this.#terminal) {
        return;
      }
      if (Date.now() - startedAtMs >= this.#options.maxRecoveryDurationMs) {
        this.#failTerminal(recoveryExhaustedError(cause));
        return;
      }
      attempts += 1;
      this.#setState("opening");
      let stream: SttStream;
      try {
        stream = await this.#openAttempt(
          Math.min(
            this.#options.connectTimeoutMs,
            this.#options.maxRecoveryDurationMs - (Date.now() - startedAtMs),
          ),
        );
      } catch (error) {
        cause = normalizeGenerationError(error, this.#provider.name);
        if (!cause.retriable) {
          this.#failTerminal(cause);
          return;
        }
        quickFailures += 1;
        if (quickFailures >= this.#options.maxQuickFailures) {
          this.#failTerminal(recoveryExhaustedError(cause));
          return;
        }
        backoffMs = Math.min(this.#options.maxBackoffMs, Math.max(1, backoffMs * 2));
        continue;
      }
      this.#generation += 1;
      this.#active = stream;
      this.#generationOffsetMs = this.#generationAudioOffset();
      this.#setState("probationary");
      void this.#consumeGeneration(this.#generation, stream);
      const outcome = await this.#waitForGeneration(
        this.#generation,
        Math.max(1, this.#options.maxRecoveryDurationMs - (Date.now() - startedAtMs)),
        recoveryExhaustedError(cause),
        this.#replayBoundary,
      );
      if (outcome.kind === "stable") {
        this.#setState("healthy");
        this.#replayStart = this.#cursor;
        this.#releaseHeldEndpoints();
        this.#replayBoundary = 0;
        return;
      }
      cause = normalizeGenerationError(outcome.error, this.#provider.name);
      if (!cause.retriable || isRecoveryExhausted(cause)) {
        this.#failTerminal(cause);
        return;
      }
      quickFailures += 1;
      if (quickFailures >= this.#options.maxQuickFailures) {
        this.#failTerminal(recoveryExhaustedError(cause));
        return;
      }
      backoffMs = Math.min(this.#options.maxBackoffMs, Math.max(1, backoffMs * 2));
    }
  }
  async #openAttempt(timeoutMs = this.#options.connectTimeoutMs): Promise<SttStream> {
    const attempt = new AbortController();
    const onAbort = (): void => attempt.abort();
    this.#lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    let opening: Promise<SttStream> | undefined;
    try {
      opening = Promise.resolve(this.#provider.open({ ...this.#request, signal: attempt.signal }));
      opening.catch(() => undefined);
      const stream = await withPreservedTimeout(
        opening,
        timeoutMs,
        timeoutError(
          STT_ERROR_CODES.connectTimeout,
          `STT reconnect open timed out after ${timeoutMs}ms`,
          { provider: this.#provider.name },
        ),
        this.#lifecycle.signal,
      );
      // Only timeout/rejection paths may use the late-open cleanup below. A
      // resolved stream must not be closed again if post-open validation fails.
      opening = undefined;
      if (this.#closed || this.#terminal || this.#lifecycle.signal.aborted) {
        await closeSttStreamBounded(stream, { timeoutMs: this.#options.closeTimeoutMs });
        throw TvicThrowableError.from(closedError());
      }
      if (stream.timestampOrigin !== this.timestampOrigin) {
        await closeSttStreamBounded(stream, { timeoutMs: this.#options.closeTimeoutMs });
        throw TvicThrowableError.from(
          validationError(
            "stt.reconnect.timestamp_origin_changed",
            "A reconnect generation declared a different STT timestamp origin",
            { provider: this.#provider.name },
          ),
        );
      }
      return stream;
    } catch (error) {
      attempt.abort();
      if (opening) {
        void opening
          .then((lateStream) =>
            closeSttStreamBounded(lateStream, { timeoutMs: this.#options.closeTimeoutMs }),
          )
          .catch(() => undefined);
      }
      throw TvicThrowableError.from(normalizeGenerationError(error, this.#provider.name));
    } finally {
      this.#lifecycle.signal.removeEventListener("abort", onAbort);
    }
  }
  #waitForGeneration(
    generation: number,
    timeoutMs: number,
    deadlineError: NormalizedError,
    replayBoundary: number,
  ): Promise<GenerationFailure | GenerationStable> {
    return new Promise((resolve) => {
      const settleStable = (): void => {
        const wait = this.#generationWait;
        if (
          !wait ||
          wait.generation !== generation ||
          !wait.stableReached ||
          this.#cursor < wait.replayBoundary
        ) {
          return;
        }
        this.#clearGenerationWait();
        resolve({ kind: "stable" });
      };
      const deadlineTimer = setTimeout(() => {
        if (this.#generationWait?.generation !== generation || this.#closed || this.#terminal) {
          return;
        }
        this.#clearGenerationWait();
        resolve({ kind: "failed", error: deadlineError });
      }, timeoutMs);
      const stableTimer = setTimeout(
        () => {
          const wait = this.#generationWait;
          if (!wait || wait.generation !== generation || this.#closed || this.#terminal) {
            return;
          }
          wait.stableReached = true;
          settleStable();
        },
        Math.min(this.#options.stableUptimeMs, timeoutMs),
      );
      this.#generationWait = {
        generation,
        resolve,
        replayBoundary,
        stableTimer,
        deadlineTimer,
        stableReached: false,
      };
    });
  }

  #clearGenerationWait(outcome?: GenerationFailure | GenerationStable): void {
    const wait = this.#generationWait;
    if (!wait) {
      return;
    }
    clearTimeout(wait.stableTimer);
    clearTimeout(wait.deadlineTimer);
    this.#generationWait = undefined;
    if (outcome) {
      wait.resolve(outcome);
    }
  }

  #generationAudioOffset(): number {
    for (let index = this.#replayStart; index < this.#journal.length; index += 1) {
      const entry = this.#journal[index];
      if (entry?.kind === "audio") {
        return entry.offsetMs;
      }
    }
    return this.#sessionAudioMs;
  }

  #compactJournal(nowMs: number): void {
    const result = compactJournal(
      this.#journal,
      this.#cursor,
      this.#replayStart,
      this.#replayBoundary,
      nowMs,
      this.#options.uncertainWindowMs,
    );
    this.#cursor = result.cursor;
    this.#replayStart = result.replayStart;
    this.#replayBoundary = result.replayBoundary;
  }

  #releaseHeldEndpoints(): void {
    if (this.#state !== "healthy" || this.#cursor < this.#replayBoundary) {
      return;
    }
    const held = this.#heldEndpoints.splice(0);
    for (const { event, generation } of held) {
      this.#emit(event, generation);
    }
  }

  #setState(state: SttRecoveryState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    for (const listener of this.#listeners) {
      // Observers are hooks and must not be able to strand recovery or close.
      try {
        listener(state);
      } catch {
        // Intentionally ignored; the wrapper owns the lifecycle transition.
      }
    }
    this.#signalWork();
  }

  #signalWork(): void {
    this.#resolveWake?.();
    this.#resolveWake = undefined;
    this.#wake = undefined;
  }

  async #waitForWork(): Promise<void> {
    if (
      this.#closed ||
      this.#terminal ||
      (this.#journal[this.#cursor] !== undefined &&
        this.#active !== undefined &&
        (this.#state === "healthy" || this.#state === "probationary"))
    ) {
      return;
    }
    this.#wake = new Promise<void>((resolve) => {
      this.#resolveWake = resolve;
    });
    await this.#wake;
  }

  async #waitForJournalDrain(): Promise<void> {
    if (this.#cursor >= this.#journal.length || this.#terminal) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  #notifyProgress(): void {
    const wait = this.#generationWait;
    if (wait?.stableReached && this.#cursor >= wait.replayBoundary) {
      this.#clearGenerationWait();
      wait.resolve({ kind: "stable" });
    }
    if (this.#cursor >= this.#journal.length || this.#terminal || this.#closed) {
      for (const resolve of this.#drainWaiters.splice(0)) {
        resolve();
      }
    }
  }

  #rejectPending(error: unknown): void {
    const throwable = TvicThrowableError.from(error);
    for (const entry of this.#journal) {
      if (entry.kind === "commit" && !entry.settled) {
        entry.settled = true;
        entry.reject(throwable);
      }
    }
  }
  #failTerminal(error: unknown): void {
    if (this.#terminal || this.#closed) {
      return;
    }
    const throwable = TvicThrowableError.from(error);
    this.#terminal = true;
    this.#terminalError ??= throwable;
    this.#setState("failed");
    this.#clearGenerationWait({ kind: "failed", error: throwable });
    this.#lifecycle.abort();
    this.#rejectPending(throwable);
    this.#rejectFailure(throwable);
    this.#events.fail(throwable);
    this.#notifyProgress();
    void this.#closeActive();
    this.#signalWork();
  }
  async #closeActive(): Promise<void> {
    if (this.#streamClosePromise) {
      return this.#streamClosePromise;
    }
    const stream = this.#active;
    this.#active = undefined;
    this.#stopGeneration(this.#generation);
    this.#streamClosePromise = stream
      ? closeSttStreamBounded(stream, { timeoutMs: this.#options.closeTimeoutMs })
      : Promise.resolve();
    await this.#streamClosePromise;
  }
  #stopGeneration(generation: number): void {
    this.#generationStops.get(generation)?.abort();
    const iterator = this.#generationIterators.get(generation);
    if (iterator) {
      void this.#returnGenerationIterator(generation, iterator).catch(() => undefined);
    }
  }

  async #returnGenerationIterator(
    generation: number,
    iterator: AsyncIterator<TranscriptEvent>,
  ): Promise<void> {
    const existing = this.#generationIteratorReturns.get(generation);
    if (existing) {
      await existing;
      return;
    }
    let returning: Promise<void>;
    returning = returnAsyncIteratorWithTimeout(iterator, CANCELLATION_TIMEOUT_MS).finally(() => {
      if (this.#generationIteratorReturns.get(generation) === returning) {
        this.#generationIteratorReturns.delete(generation);
      }
    });
    this.#generationIteratorReturns.set(generation, returning);
    await returning;
  }

  async #waitForFailedStreamClose(): Promise<void> {
    const closing = this.#failedStreamClosePromise;
    if (!closing) {
      return;
    }
    await closing;
    this.#failedStreamClosePromise = undefined;
  }

  async #sleep(milliseconds: number): Promise<void> {
    await sleepWithAbort(this.#lifecycle.signal, milliseconds);
  }
}
