import type {
  InputAudioChunk,
  NormalizedError,
  ProviderEventId,
  SpeechToTextProvider,
  SttAudioWriteUsageOperation,
  SttOpenRequest,
  SttStream,
  SttTimestampOrigin,
  TranscriptEndpointEvent,
  TranscriptEvent,
} from "@tvic/core";
import {
  counterIdGenerator,
  countUnicodeCodePoints,
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
import { trackSttAudioWriteOutcome } from "./stt-audio-write-usage.js";
import { createSttAgentContextWaiter } from "./stt-agent-context.js";
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

class AmbiguousAgentContextHandoff extends Error {
  constructor(readonly failure: NormalizedError) {
    super(failure.message);
    this.name = "AmbiguousAgentContextHandoff";
  }
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
  readonly #pendingAgentContextEntries = new Set<
    Extract<SttJournalEntry, { readonly kind: "agent_context" }>
  >();
  readonly #contextUpdateErrorListeners = new Set<(error: NormalizedError) => void>();
  readonly #lifecycle = new AbortController();
  readonly #controller: SttCommandController;
  #state: SttRecoveryState = "healthy";
  #active: SttStream | undefined;
  #generation = 1;
  #generationOffsetMs = 0;
  #cursor = 0;
  #sequence = 1;
  #sessionAudioMs = 0;
  #latestAgentContext: { readonly context: string; readonly version: number } | undefined;
  #agentContextVersion = 0;
  #agentContextAppliedGeneration = 0;
  #agentContextAppliedVersion = 0;
  #agentContextDispatchedGeneration = 0;
  #agentContextDispatchedVersion = 0;
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
        replayBoundary: number;
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
      admitAgentContext: (context) => this.updateAgentContext(context),
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
        subscribeContextUpdateError: (listener) => {
          this.#contextUpdateErrorListeners.add(listener);
          return () => this.#contextUpdateErrorListeners.delete(listener);
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
      !this.#hasCommandCapacity() ||
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
    if (!this.#hasCommandCapacity()) {
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

  updateAgentContext(
    context: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const signal = options.signal;
    if (this.#closed || this.#closing || this.#terminal) {
      return Promise.reject(TvicThrowableError.from(closedError()));
    }
    if (signal?.aborted) {
      return Promise.reject(
        TvicThrowableError.from(contextUpdateCancelledError(this.#provider.name)),
      );
    }
    if (typeof context !== "string" || countUnicodeCodePoints(context) > 1_500) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            "provider.invalid_request",
            "STT agent context must not exceed 1500 characters",
            { provider: this.#provider.name },
          ),
        ),
      );
    }
    if (this.#active && typeof this.#active.updateAgentContext !== "function") {
      return Promise.reject(
        TvicThrowableError.from(
          providerError(
            STT_ERROR_CODES.contextUpdateFailed,
            "The STT stream does not implement agent context updates",
            { provider: this.#provider.name, retriable: false },
          ),
        ),
      );
    }

    this.#compactJournal(Date.now());
    const previousLatestContext = this.#latestAgentContext;
    const version = ++this.#agentContextVersion;
    this.#latestAgentContext = { context, version };
    const pending = this.#journal
      .slice(this.#cursor)
      .find(
        (entry): entry is Extract<SttJournalEntry, { kind: "agent_context" }> =>
          entry.kind === "agent_context" &&
          !entry.settled &&
          entry.signal === undefined &&
          signal === undefined &&
          !this.#pendingAgentContextEntries.has(entry),
      );
    if (pending) {
      pending.context = context;
      pending.version = version;
      return pending.waiter.promise;
    }
    if (!this.#hasCommandCapacity()) {
      const error = TvicThrowableError.from(bufferOverflowError());
      this.#failTerminal(error);
      return Promise.reject(error);
    }
    const waiter = createSttAgentContextWaiter();
    this.#journal.push({
      kind: "agent_context",
      context,
      version,
      settled: false,
      ...(signal !== undefined ? { signal } : {}),
      ...(previousLatestContext !== undefined ? { previousLatestContext } : {}),
      admittedAtMs: Date.now(),
      waiter,
    });
    const entry = this.#journal.at(-1);
    if (!entry || entry.kind !== "agent_context") {
      throw new Error("STT context journal entry was not appended");
    }
    if (signal) {
      const onAbort = (): void => {
        if (this.#latestAgentContext?.version === entry.version) {
          this.#latestAgentContext = entry.previousLatestContext;
        }
        this.#settleAgentContext(entry, contextUpdateCancelledError(this.#provider.name));
        this.#signalWork();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void waiter.promise.then(
        () => signal.removeEventListener("abort", onAbort),
        () => signal.removeEventListener("abort", onAbort),
      );
      if (signal.aborted) onAbort();
    }
    this.#signalWork();
    return waiter.promise;
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
        closeFailure = this.#terminalError ?? TvicThrowableError.from(error);
        this.#failTerminal(closeFailure);
      }
    } else if (!terminalAtStart) {
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

      let usageWrite: SttAudioWriteUsageOperation | undefined;
      try {
        if (entry.kind === "audio") {
          if (this.#provider.usageAccounting?.reportsAudioWrites !== true) {
            usageWrite = this.#request.usageReporter?.beginAudioWrite({
              byteLength: entry.chunk.audio.bytes.byteLength,
              format: entry.chunk.audio.format,
            });
          }
          const send = trackSttAudioWriteOutcome(
            Promise.resolve().then(() => stream.sendAudio(entry.chunk)),
            usageWrite,
            (error) => this.#failTerminal(error),
          );
          await withPreservedTimeout(
            send,
            this.#options.audioWriteTimeoutMs,
            audioWriteTimeoutError(
              this.#options.audioWriteErrorCode,
              `STT audio write was not accepted within ${this.#options.audioWriteTimeoutMs}ms`,
              this.#provider.name,
            ),
            this.#lifecycle.signal,
          );
          usageWrite = undefined;
          if (generation !== this.#generation || stream !== this.#active) {
            continue;
          }
          entry.dispatchedAtMs = Date.now();
          this.#cursor += 1;
        } else if (entry.kind === "agent_context") {
          if (entry.settled) {
            this.#cursor += 1;
          } else if (
            this.#agentContextDispatchedGeneration === generation &&
            entry.version <= this.#agentContextDispatchedVersion
          ) {
            this.#cursor += 1;
          } else if (
            this.#agentContextAppliedGeneration === generation &&
            entry.version <= this.#agentContextAppliedVersion
          ) {
            entry.settled = true;
            entry.waiter.resolve();
            this.#cursor += 1;
          } else {
            try {
              await this.#dispatchAgentContext(entry, stream, generation);
            } catch (error) {
              if (entry.signal?.aborted) {
                this.#settleAgentContext(entry, contextUpdateCancelledError(this.#provider.name));
                if (generation === this.#generation && stream === this.#active) {
                  this.#cursor += 1;
                }
                continue;
              }
              const failure =
                error instanceof AmbiguousAgentContextHandoff
                  ? error.failure
                  : normalizeGenerationError(error, this.#provider.name);
              this.#handleGenerationFailure(generation, stream, failure);
              continue;
            }
            if (generation !== this.#generation || stream !== this.#active) continue;
            this.#cursor += 1;
          }
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
      const nextGeneration = this.#generation + 1;
      try {
        await this.#dispatchLatestAgentContext(stream, nextGeneration);
      } catch (error) {
        const failure =
          error instanceof AmbiguousAgentContextHandoff
            ? error.failure
            : normalizeGenerationError(error, this.#provider.name);
        await closeSttStreamBounded(stream, { timeoutMs: this.#options.closeTimeoutMs });
        cause = failure;
        if (this.#agentContextDispatchedGeneration === nextGeneration) {
          this.#agentContextDispatchedGeneration = 0;
          this.#agentContextDispatchedVersion = 0;
        }
        if (!failure.retriable) {
          this.#failTerminal(failure);
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
      this.#generation = nextGeneration;
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
    let openedStream: SttStream | undefined;
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
      opening = undefined;
      openedStream = stream;
      if (this.#closed || this.#terminal || this.#lifecycle.signal.aborted) {
        await closeSttStreamBounded(stream, { timeoutMs: this.#options.closeTimeoutMs });
        openedStream = undefined;
        throw TvicThrowableError.from(closedError());
      }
      if (stream.timestampOrigin !== this.timestampOrigin) {
        await closeSttStreamBounded(stream, { timeoutMs: this.#options.closeTimeoutMs });
        openedStream = undefined;
        throw TvicThrowableError.from(
          validationError(
            "stt.reconnect.timestamp_origin_changed",
            "A reconnect generation declared a different STT timestamp origin",
            { provider: this.#provider.name },
          ),
        );
      }
      openedStream = undefined;
      return stream;
    } catch (error) {
      attempt.abort();
      if (openedStream) {
        await closeSttStreamBounded(openedStream, {
          timeoutMs: this.#options.closeTimeoutMs,
        }).catch(() => undefined);
      }
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
    const previousReplayBoundary = this.#replayBoundary;
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
    if (this.#generationWait?.replayBoundary === previousReplayBoundary) {
      this.#generationWait.replayBoundary = result.replayBoundary;
    }
  }

  #hasCommandCapacity(): boolean {
    const detachedContextWrites = [...this.#pendingAgentContextEntries].filter(
      (entry) => !this.#journal.includes(entry),
    ).length;
    return this.#journal.length + detachedContextWrites < this.#options.maxBufferedCommands;
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
      try {
        listener(state);
      } catch {}
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
      } else if (entry.kind === "agent_context" && !entry.settled) {
        entry.settled = true;
        entry.waiter.reject(throwable);
      }
    }
    for (const entry of this.#pendingAgentContextEntries) {
      this.#settleAgentContext(entry, throwable);
    }
  }

  #dispatchAgentContext(
    entry: Extract<SttJournalEntry, { readonly kind: "agent_context" }>,
    stream: SttStream,
    generation: number,
  ): Promise<void> {
    return this.#dispatchAgentContextValue(entry.context, entry.version, stream, generation, entry);
  }

  async #dispatchLatestAgentContext(stream: SttStream, generation: number): Promise<void> {
    for (let attempt = 0; attempt < this.#options.maxBufferedCommands; attempt += 1) {
      const latest = this.#latestAgentContext;
      if (latest === undefined) return;
      const dispatchedVersion =
        this.#agentContextDispatchedGeneration === generation
          ? this.#agentContextDispatchedVersion
          : 0;
      if (latest.version <= dispatchedVersion) return;
      const pending =
        this.#journal.find(
          (entry): entry is Extract<SttJournalEntry, { kind: "agent_context" }> =>
            entry.kind === "agent_context" && !entry.settled && entry.version === latest.version,
        ) ??
        [...this.#pendingAgentContextEntries].find(
          (entry) => !entry.settled && entry.version === latest.version,
        );
      await this.#dispatchAgentContextValue(
        latest.context,
        latest.version,
        stream,
        generation,
        pending,
      );
    }
    this.#failTerminal(bufferOverflowError());
  }

  #dispatchAgentContextValue(
    context: string,
    version: number,
    stream: SttStream,
    generation: number,
    entry?: Extract<SttJournalEntry, { readonly kind: "agent_context" }>,
  ): Promise<void> {
    if (entry) this.#pendingAgentContextEntries.add(entry);
    if (this.#agentContextDispatchedGeneration !== generation) {
      this.#agentContextDispatchedGeneration = generation;
      this.#agentContextDispatchedVersion = version;
    } else {
      this.#agentContextDispatchedVersion = Math.max(this.#agentContextDispatchedVersion, version);
    }
    return this.#startAgentContextUpdate(stream, context, entry?.signal).then(
      () => this.#finishAgentContextUpdate(entry, stream, generation, version),
      (error: unknown) => {
        this.#finishAgentContextUpdate(entry, stream, generation, version, error);
        throw error;
      },
    );
  }

  #finishAgentContextUpdate(
    entry: Extract<SttJournalEntry, { readonly kind: "agent_context" }> | undefined,
    stream: SttStream,
    generation: number,
    version: number,
    error?: unknown,
  ): void {
    if (entry?.signal?.aborted) return;
    if (!this.#isCurrentOrOpeningGeneration(generation, stream)) return;
    if (error === undefined) {
      this.#agentContextAppliedGeneration = generation;
      this.#agentContextAppliedVersion = Math.max(this.#agentContextAppliedVersion, version);
      for (const pending of [...this.#pendingAgentContextEntries]) {
        if (pending.version <= this.#agentContextAppliedVersion) this.#settleAgentContext(pending);
      }
      return;
    }
    if (this.#latestAgentContext && this.#latestAgentContext.version > version) return;
    if (entry && entry.version !== version) return;
    const contextError = TvicThrowableError.from(
      error instanceof AmbiguousAgentContextHandoff ? error.failure : error,
    );
    if (entry) {
      for (const pending of [...this.#pendingAgentContextEntries]) {
        if (pending.version <= version) this.#settleAgentContext(pending, contextError);
      }
      return;
    }
    for (const listener of this.#contextUpdateErrorListeners) {
      listener(contextError.error);
    }
  }

  #isCurrentOrOpeningGeneration(generation: number, stream: SttStream): boolean {
    return (
      (generation === this.#generation && stream === this.#active) ||
      (generation === this.#generation + 1 &&
        this.#active === undefined &&
        this.#state === "opening")
    );
  }

  #settleAgentContext(
    entry: Extract<SttJournalEntry, { readonly kind: "agent_context" }>,
    error?: unknown,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    this.#pendingAgentContextEntries.delete(entry);
    if (error === undefined) {
      entry.waiter.resolve();
      return;
    }
    entry.waiter.reject(TvicThrowableError.from(error));
  }

  #startAgentContextUpdate(
    stream: SttStream,
    context: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof stream.updateAgentContext !== "function") {
      return Promise.reject(
        providerError(
          STT_ERROR_CODES.contextUpdateFailed,
          "The STT stream does not implement agent context updates",
          { provider: this.#provider.name, retriable: false },
        ),
      );
    }
    const updateAbort = new AbortController();
    const onLifecycleAbort = (): void => {
      if (!updateAbort.signal.aborted) {
        updateAbort.abort(this.#lifecycle.signal.reason ?? closedError());
      }
    };
    const onCallerAbort = (): void => {
      if (!updateAbort.signal.aborted) {
        updateAbort.abort(contextUpdateCancelledError(this.#provider.name));
      }
    };
    if (this.#lifecycle.signal.aborted) onLifecycleAbort();
    else this.#lifecycle.signal.addEventListener("abort", onLifecycleAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener("abort", onCallerAbort, { once: true });
    const detachAbortListeners = (): void => {
      this.#lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
      signal?.removeEventListener("abort", onCallerAbort);
    };
    let providerWrite: Promise<void>;
    try {
      providerWrite = Promise.resolve(
        stream.updateAgentContext(context, { signal: updateAbort.signal }),
      );
    } catch {
      detachAbortListeners();
      return Promise.reject(
        providerError(STT_ERROR_CODES.contextUpdateFailed, "STT agent context update failed", {
          provider: this.#provider.name,
          retriable: true,
        }),
      );
    }
    const timeout = timeoutError(
      STT_ERROR_CODES.contextUpdateFailed,
      `STT agent context update timed out after ${this.#options.sendTimeoutMs}ms`,
      { provider: this.#provider.name, retriable: true },
    );
    return withPreservedTimeout(
      providerWrite,
      this.#options.sendTimeoutMs,
      timeout,
      updateAbort.signal,
    )
      .catch((error: unknown) => {
        if (error === timeout) {
          updateAbort.abort(timeout);
          throw new AmbiguousAgentContextHandoff(timeout);
        }
        if (signal?.aborted) {
          updateAbort.abort(contextUpdateCancelledError(this.#provider.name));
          throw contextUpdateCancelledError(this.#provider.name);
        }
        if (this.#lifecycle.signal.aborted) {
          updateAbort.abort(this.#lifecycle.signal.reason ?? closedError());
          throw this.#lifecycle.signal.reason ?? TvicThrowableError.from(closedError());
        }
        throw providerError(
          STT_ERROR_CODES.contextUpdateFailed,
          "STT agent context update failed",
          {
            provider: this.#provider.name,
            retriable: true,
          },
        );
      })
      .finally(detachAbortListeners);
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

function contextUpdateCancelledError(provider: string): NormalizedError {
  return providerError(
    STT_ERROR_CODES.contextUpdateFailed,
    "STT agent context update was cancelled before provider dispatch",
    { provider, retriable: true },
  );
}
