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
} from "@tvic/core";
import { AsyncQueue } from "@tvic/media";

import type { SttCommandController } from "./stt-command-controller.js";
import {
  compactJournal,
  findReplayStart,
  journalBytes,
  type SttJournalEntry,
} from "./resilient-stt-journal.js";
import {
  bufferOverflowError,
  closedError,
  normalizeAudioOffsets,
  normalizeGenerationError,
  recoveryExhaustedError,
  resolveOptions,
  sameOptions,
  withJitter,
  withPreservedTimeout,
  type ResolvedSttReconnectOptions,
} from "./resilient-stt-policy.js";

export interface SttReconnectOptions {
  readonly maxAttempts?: number;
  readonly connectTimeoutMs?: number;
  readonly maxRecoveryDurationMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitter?: boolean;
  readonly stableUptimeMs?: number;
  readonly maxQuickFailures?: number;
  readonly uncertainWindowMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedCommands?: number;
  readonly commitTimeoutMs?: number;
}

export type SttRecoveryState =
  | "healthy"
  | "recovering"
  | "opening"
  | "probationary"
  | "failed"
  | "closed";

export interface SttRecoveryControl {
  readonly controller: SttCommandController;
  readonly state: () => SttRecoveryState;
  subscribe(listener: (state: SttRecoveryState) => void): () => void;
}

export const STT_RECOVERY_CONTROL = Symbol("tvic.stt.recovery-control");

interface RecoveryBrandedStream extends SttStream {
  readonly [STT_RECOVERY_CONTROL]?: SttRecoveryControl;
}

const STT_RECONNECT_BRAND = Symbol("tvic.stt.reconnect");

interface ReconnectBrand {
  readonly options: ResolvedSttReconnectOptions;
}

interface ReconnectBrandedProvider extends SpeechToTextProvider {
  readonly [STT_RECONNECT_BRAND]?: ReconnectBrand;
}

interface GenerationFailure {
  readonly kind: "failed";
  readonly error: unknown;
}

interface GenerationStable {
  readonly kind: "stable";
}

/**
 * Wraps one STT provider with bounded, best-effort reconnect and replay policy.
 * The wrapper is deliberately runtime-owned: adapters only need to expose honest
 * transport and timestamp semantics.
 */
export function withSttReconnect(
  provider: SpeechToTextProvider,
  options: SttReconnectOptions = {},
): SpeechToTextProvider {
  const resolved = resolveOptions(options);
  const branded = (provider as ReconnectBrandedProvider)[STT_RECONNECT_BRAND];
  if (branded) {
    if (!sameOptions(branded.options, resolved)) {
      throw validationError(
        "stt.reconnect.conflicting_policy",
        "The STT provider is already wrapped with a different reconnect policy",
      );
    }
    return provider;
  }

  const wrapped = new ResilientSttProvider(provider, resolved);
  Object.defineProperty(wrapped, STT_RECONNECT_BRAND, {
    configurable: false,
    enumerable: false,
    value: { options: resolved } satisfies ReconnectBrand,
    writable: false,
  });
  return wrapped;
}

export function getSttRecoveryControl(stream: SttStream): SttRecoveryControl | undefined {
  return (stream as RecoveryBrandedStream)[STT_RECOVERY_CONTROL];
}

class ResilientSttProvider implements SpeechToTextProvider {
  readonly name: string;
  readonly kind = "stt" as const;
  readonly version: string;
  readonly capabilities: SpeechToTextProvider["capabilities"];
  readonly region?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly #provider: SpeechToTextProvider;
  readonly #options: ResolvedSttReconnectOptions;

  constructor(provider: SpeechToTextProvider, options: ResolvedSttReconnectOptions) {
    this.#provider = provider;
    this.#options = options;
    this.name = provider.name;
    this.version = provider.version;
    this.capabilities = provider.capabilities;
    if (provider.region !== undefined) {
      this.region = provider.region;
    }
    if (provider.metadata !== undefined) {
      this.metadata = provider.metadata;
    }
  }

  async open(request: SttOpenRequest): Promise<SttStream> {
    const stream = await this.#provider.open(request);
    if (!stream.timestampOrigin) {
      await stream.close().catch(() => undefined);
      throw validationError(
        "stt.reconnect.timestamp_origin_unsupported",
        `${this.#provider.name} does not declare a reconnect-safe STT timestamp origin`,
        { provider: this.#provider.name },
      );
    }
    return new ResilientSttStream(this.#provider, request, stream, this.#options);
  }
}

class ResilientSttStream implements SttStream {
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
    this.#events = new AsyncQueue({ maxBuffered: options.maxBufferedCommands });
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
      return Promise.reject(closedError());
    }
    const bytes = chunk.audio.bytes.byteLength;
    this.#compactJournal(Date.now());
    if (
      this.#journal.length >= this.#options.maxBufferedCommands ||
      journalBytes(this.#journal) + bytes > this.#options.maxBufferedBytes
    ) {
      const error = bufferOverflowError();
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
      return Promise.reject(closedError());
    }
    this.#compactJournal(Date.now());
    if (this.#journal.length >= this.#options.maxBufferedCommands) {
      const error = bufferOverflowError();
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
    this.#closing = true;
    this.#signalWork();
    if (!this.#terminal) {
      await this.#waitForJournalDrain();
    }
    this.#closed = true;
    this.#setState("closed");
    this.#lifecycle.abort();
    this.#clearGenerationWait({ kind: "failed", error: closedError() });
    this.#rejectPending(closedError());
    await this.#waitForFailedStreamClose();
    await this.#closeActive();
    this.#events.close();
  }

  async #abort(error: unknown): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closing = true;
    this.#setState("closed");
    this.#lifecycle.abort();
    this.#clearGenerationWait({ kind: "failed", error: closedError() });
    this.#rejectPending(error);
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
      const stream = this.#active;
      if (!stream || (this.#state !== "healthy" && this.#state !== "probationary")) {
        await this.#waitForWork();
        continue;
      }

      try {
        if (entry.kind === "audio") {
          await stream.sendAudio(entry.chunk);
          entry.dispatchedAtMs = Date.now();
          this.#cursor += 1;
        } else if (this.commitMode === "none") {
          entry.settled = true;
          entry.resolve();
          this.#cursor += 1;
        } else {
          await withPreservedTimeout(
            stream.commit(),
            this.#options.commitTimeoutMs,
            timeoutError(
              "stt.commit_timeout",
              `STT commit was not accepted within ${this.#options.commitTimeoutMs}ms`,
            ),
            this.#lifecycle.signal,
          );
          entry.settled = true;
          entry.resolve();
          this.#cursor += 1;
        }
        this.#notifyProgress();
        this.#compactJournal(Date.now());
        this.#releaseHeldEndpoints();
      } catch (error) {
        this.#handleGenerationFailure(this.#generation, error);
      }
    }
  }

  async #consumeGeneration(generation: number, stream: SttStream): Promise<void> {
    try {
      for await (const event of stream.events) {
        if (this.#closed || generation !== this.#generation || stream !== this.#active) {
          continue;
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
          normalizeGenerationError(error, this.#provider.name),
        );
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
      this.#failTerminal(bufferOverflowError());
    }
  }

  #handleGenerationFailure(generation: number, source: unknown): void {
    if (this.#closed || this.#terminal || generation !== this.#generation) {
      return;
    }
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
    this.#failedStreamClosePromise = failedStream?.close().catch(() => undefined);
    if (this.#closing) {
      this.#terminal = true;
      this.#rejectPending(closedError());
      this.#notifyProgress();
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
    const opening = this.#provider.open({ ...this.#request, signal: attempt.signal });
    opening.catch(() => undefined);
    try {
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
      if (this.#closed || this.#terminal || this.#lifecycle.signal.aborted) {
        await stream.close().catch(() => undefined);
        throw closedError();
      }
      if (stream.timestampOrigin !== this.timestampOrigin) {
        await stream.close().catch(() => undefined);
        throw validationError(
          "stt.reconnect.timestamp_origin_changed",
          "A reconnect generation declared a different STT timestamp origin",
          { provider: this.#provider.name },
        );
      }
      return stream;
    } catch (error) {
      attempt.abort();
      void opening.then((lateStream) => lateStream.close()).catch(() => undefined);
      throw normalizeGenerationError(error, this.#provider.name);
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
      deadlineTimer.unref?.();
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
      stableTimer.unref?.();
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
      listener(state);
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
    for (const entry of this.#journal) {
      if (entry.kind === "commit" && !entry.settled) {
        entry.settled = true;
        entry.reject(error);
      }
    }
  }

  #failTerminal(error: unknown): void {
    if (this.#terminal || this.#closed) {
      return;
    }
    this.#terminal = true;
    this.#setState("failed");
    this.#clearGenerationWait({ kind: "failed", error });
    this.#lifecycle.abort();
    this.#rejectPending(error);
    this.#rejectFailure(error);
    this.#events.fail(error);
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
    this.#streamClosePromise = stream?.close().catch(() => undefined) ?? Promise.resolve();
    await this.#streamClosePromise;
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
    if (milliseconds <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        clearTimeout(timer);
        finish();
      };
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.#lifecycle.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (this.#lifecycle.signal.aborted) {
        resolve();
        return;
      }
      this.#lifecycle.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(finish, milliseconds);
      timer.unref?.();
    });
  }
}

function isRecoveryExhausted(error: NormalizedError): boolean {
  return error.code === STT_ERROR_CODES.recoveryExhausted;
}
