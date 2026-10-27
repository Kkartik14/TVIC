import type { NormalizedError, SpeechToTextProvider, SttStream } from "@tvic/core";
import { STT_ERROR_CODES, TvicThrowableError } from "@tvic/core";
import {
  coalescePendingSttAgentContext,
  createSttAgentContextWaiter,
  missingSttAgentContextUpdateError,
  normalizeSttAgentContextUpdateError,
  sttAgentContextCancelledError,
  sttAgentContextTimeoutError,
  updateSttAgentContext,
  validateSttAgentContext,
} from "./stt-agent-context.js";
import { closedError, bufferOverflowError } from "./resilient-stt-policy.js";
import type { ResolvedSttReconnectOptions } from "./resilient-stt-policy.js";
import type { LatestAgentContextValue, SttJournalEntry } from "./resilient-stt-journal.js";

type AgentContextEntry = Extract<SttJournalEntry, { readonly kind: "agent_context" }>;

class AmbiguousAgentContextHandoff extends Error {
  constructor(readonly failure: NormalizedError) {
    super(failure.message);
    this.name = "AmbiguousAgentContextHandoff";
  }
}

export interface ResilientSttAgentContextCoordinatorHost {
  readonly provider: SpeechToTextProvider;
  readonly options: Pick<ResolvedSttReconnectOptions, "contextUpdateTimeoutMs">;
  readonly journal: SttJournalEntry[];
  readonly lifecycleSignal: AbortSignal;
  readonly isAcceptingUpdates: () => boolean;
  readonly getActiveStream: () => SttStream | undefined;
  readonly getCursor: () => number;
  readonly getGeneration: () => number;
  readonly isClosing: () => boolean;
  readonly isClosedOrTerminal: () => boolean;
  readonly isRecovering: () => boolean;
  readonly isCurrentOrOpeningGeneration: (generation: number, stream: SttStream) => boolean;
  readonly compactJournal: (nowMs: number) => void;
  readonly hasCommandCapacity: () => boolean;
  readonly signalWork: () => void;
  readonly notifyProgress: () => void;
  readonly failTerminal: (error: unknown) => void;
  readonly handleGenerationFailure: (generation: number, stream: SttStream, error: unknown) => void;
}

/** Owns versioned STT context updates and their replay/rollback lifecycle. */
export class ResilientSttAgentContextCoordinator {
  readonly #host: ResilientSttAgentContextCoordinatorHost;
  readonly #contextWriteTails = new WeakMap<SttStream, Promise<void>>();
  readonly #pendingEntries = new Set<AgentContextEntry>();
  readonly #pendingWrites = new Map<number, number>();
  readonly #errorListeners = new Set<(error: NormalizedError) => void>();
  #inFlightWrites = 0;
  #latest: LatestAgentContextValue | undefined;
  #version = 0;
  #appliedGeneration = 0;
  #appliedVersion = 0;
  #dispatchedGeneration = 0;
  #dispatchedVersion = 0;
  #recoverySuppressedGeneration = -1;
  #ambiguousWrite:
    | { readonly generation: number; readonly stream: SttStream; readonly failure: NormalizedError }
    | undefined;

  constructor(host: ResilientSttAgentContextCoordinatorHost) {
    this.#host = host;
  }

  subscribeErrors(listener: (error: NormalizedError) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  isApplied(entry: AgentContextEntry, generation: number): boolean {
    return this.#appliedGeneration === generation && entry.version <= this.#appliedVersion;
  }

  wasDispatched(entry: AgentContextEntry, generation: number): boolean {
    return this.#dispatchedGeneration === generation && entry.version <= this.#dispatchedVersion;
  }

  pendingWriteCount(generation: number): number {
    return this.#pendingWrites.get(generation) ?? 0;
  }

  shouldRecoverOnAmbiguous(generation: number): boolean {
    return this.#recoverySuppressedGeneration !== generation;
  }

  get inFlightWriteCount(): number {
    return this.#inFlightWrites;
  }

  detachedPendingEntryCount(): number {
    return [...this.#pendingEntries].filter(
      (entry) => !entry.settled && !this.#host.journal.includes(entry),
    ).length;
  }

  retainPending(entry: AgentContextEntry): void {
    this.#pendingEntries.add(entry);
  }

  update(context: string, signal?: AbortSignal): Promise<void> {
    if (!this.#host.isAcceptingUpdates()) {
      return Promise.reject(TvicThrowableError.from(closedError()));
    }
    if (signal?.aborted) {
      return Promise.reject(
        TvicThrowableError.from(
          sttAgentContextCancelledError(
            this.#host.provider.name,
            "STT agent context update was cancelled",
          ),
        ),
      );
    }
    const invalidContext = validateSttAgentContext(context, this.#host.provider.name);
    if (invalidContext) return Promise.reject(TvicThrowableError.from(invalidContext));
    const active = this.#host.getActiveStream();
    if (active && typeof active.updateAgentContext !== "function") {
      return Promise.reject(
        TvicThrowableError.from(missingSttAgentContextUpdateError(this.#host.provider.name)),
      );
    }

    this.#host.compactJournal(Date.now());
    const previousLatest = this.#latest;
    const version = ++this.#version;
    const latest: LatestAgentContextValue = {
      context,
      version,
      ...(previousLatest !== undefined ? { previous: previousLatest } : {}),
    };
    this.#latest = latest;
    const pending = coalescePendingSttAgentContext(
      this.#host.journal.slice(this.#host.getCursor()),
      context,
      (entry): entry is AgentContextEntry =>
        entry.kind === "agent_context" &&
        !entry.settled &&
        entry.signal === undefined &&
        signal === undefined &&
        !this.#pendingEntries.has(entry),
    );
    if (pending) {
      pending.version = version;
      latest.previous = pending.previousLatestContext;
      pending.latestContext = latest;
      pending.previousLatestContext = latest.previous;
      this.#fenceAmbiguousWrite();
      return pending.waiter.promise;
    }
    if (!this.#host.hasCommandCapacity()) {
      const error = TvicThrowableError.from(bufferOverflowError());
      this.#host.failTerminal(error);
      return Promise.reject(error);
    }
    const waiter = createSttAgentContextWaiter();
    const entry: AgentContextEntry = {
      kind: "agent_context",
      context,
      version,
      settled: false,
      ...(signal !== undefined ? { signal } : {}),
      ...(previousLatest !== undefined ? { previousLatestContext: previousLatest } : {}),
      latestContext: latest,
      admittedAtMs: Date.now(),
      waiter,
    };
    this.#host.journal.push(entry);
    if (signal) {
      const onAbort = (): void => {
        if (entry.settled || entry.providerAccepted) return;
        // A canceled provider write can have an ambiguous side effect. Recovery
        // therefore starts from the last live version rather than this update.
        this.#retire(latest, entry.previousLatestContext);
        this.settle(
          entry,
          sttAgentContextCancelledError(
            this.#host.provider.name,
            "STT agent context update was cancelled",
          ),
        );
        this.#rewindDispatch(version);
        this.#host.signalWork();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void waiter.promise.then(
        () => signal.removeEventListener("abort", onAbort),
        () => signal.removeEventListener("abort", onAbort),
      );
      if (signal.aborted) onAbort();
    }
    this.#fenceAmbiguousWrite();
    this.#host.signalWork();
    return waiter.promise;
  }

  dispatch(
    entry: AgentContextEntry,
    stream: SttStream,
    generation: number,
    recoverOnAmbiguous = true,
  ): Promise<void> {
    return this.#dispatchValue(
      entry.context,
      entry.version,
      stream,
      generation,
      entry,
      recoverOnAmbiguous,
    );
  }

  observe(write: Promise<void>): void {
    void write.catch(() => {
      // Definite context rejection is reported to its caller. Ambiguous writes
      // schedule recovery inside #dispatchValue.
    });
  }

  async replayLatest(stream: SttStream, generation: number): Promise<void> {
    while (true) {
      if (
        this.#host.isClosedOrTerminal() ||
        this.#host.isRecovering() ||
        !this.#host.isCurrentOrOpeningGeneration(generation, stream)
      ) {
        return;
      }
      const latest = this.#latest;
      if (latest === undefined) return;
      const dispatchedVersion =
        this.#dispatchedGeneration === generation ? this.#dispatchedVersion : 0;
      if (latest.version <= dispatchedVersion) return;
      const pending =
        this.#host.journal.find(
          (entry): entry is AgentContextEntry =>
            entry.kind === "agent_context" && !entry.settled && entry.version === latest.version,
        ) ??
        [...this.#pendingEntries].find(
          (entry) => !entry.settled && entry.version === latest.version,
        );
      const lastAcceptedContext =
        this.#appliedGeneration === generation ? undefined : this.#latestAccepted(latest);
      // A queued newer value supersedes the accepted value on this new stream.
      // Replaying both can let a timed-out older provider write land after it.
      if (
        lastAcceptedContext &&
        lastAcceptedContext.version < latest.version &&
        lastAcceptedContext.version > dispatchedVersion &&
        pending === undefined
      ) {
        try {
          await this.#dispatchValue(
            lastAcceptedContext.context,
            lastAcceptedContext.version,
            stream,
            generation,
            undefined,
          );
        } catch {
          if (!this.#host.isCurrentOrOpeningGeneration(generation, stream)) return;
        }
        continue;
      }
      for (const entry of new Set([
        ...this.#host.journal.filter(
          (candidate): candidate is AgentContextEntry =>
            candidate.kind === "agent_context" && !candidate.settled,
        ),
        ...this.#pendingEntries,
      ])) {
        if (entry.version <= latest.version) this.#pendingEntries.add(entry);
      }
      const recoverOnAmbiguous = pending?.signal !== undefined;
      try {
        await this.#dispatchValue(
          latest.context,
          latest.version,
          stream,
          generation,
          pending,
          recoverOnAmbiguous,
        );
      } catch (error) {
        if (!this.#host.isCurrentOrOpeningGeneration(generation, stream)) return;
        if (this.#latest !== latest) {
          if (
            error instanceof AmbiguousAgentContextHandoff &&
            (recoverOnAmbiguous || this.#version > latest.version)
          ) {
            if (!this.#host.isClosing()) {
              this.#host.handleGenerationFailure(generation, stream, error.failure);
            }
            return;
          }
          continue;
        }
        return;
      }
    }
  }

  settle(entry: AgentContextEntry, error?: unknown): void {
    this.#pendingEntries.delete(entry);
    if (entry.settled) return;
    entry.settled = true;
    if (error === undefined) {
      entry.waiter.resolve();
      return;
    }
    entry.waiter.reject(TvicThrowableError.from(error));
  }

  rejectPending(error: unknown): void {
    const throwable = TvicThrowableError.from(error);
    for (const entry of this.#host.journal) {
      if (entry.kind === "agent_context") this.settle(entry, throwable);
    }
    for (const entry of this.#pendingEntries) this.settle(entry, throwable);
  }

  completeStream(stream: SttStream): void {
    if (this.#ambiguousWrite?.stream === stream) this.#ambiguousWrite = undefined;
  }

  #dispatchValue(
    context: string,
    version: number,
    stream: SttStream,
    generation: number,
    entry?: AgentContextEntry,
    recoverOnAmbiguous = true,
  ): Promise<void> {
    this.#inFlightWrites += 1;
    if (recoverOnAmbiguous) {
      this.#pendingWrites.set(generation, (this.#pendingWrites.get(generation) ?? 0) + 1);
    }
    if (entry) this.#pendingEntries.add(entry);
    if (this.#dispatchedGeneration !== generation) {
      this.#dispatchedGeneration = generation;
      this.#dispatchedVersion = version;
    } else {
      this.#dispatchedVersion = Math.max(this.#dispatchedVersion, version);
    }
    const previousWrite = this.#contextWriteTails.get(stream) ?? Promise.resolve();
    const write = previousWrite.then(() => {
      if (entry?.settled) return;
      if (!this.#host.isCurrentOrOpeningGeneration(generation, stream)) {
        throw TvicThrowableError.from(closedError());
      }
      if (entry) entry.dispatchStarted = true;
      return this.#startUpdate(stream, context, entry?.signal, () => {
        if (
          this.#ambiguousWrite?.generation === generation &&
          this.#ambiguousWrite.stream === stream
        ) {
          this.#ambiguousWrite = undefined;
        }
        if (this.#recoverySuppressedGeneration === generation) {
          this.#recoverySuppressedGeneration = -1;
        }
        if (!entry) return;
        entry.providerAccepted = true;
        if (!this.#host.isCurrentOrOpeningGeneration(generation, stream)) return;
        entry.latestContext.cancelled = false;
        this.#appliedGeneration = generation;
        this.#appliedVersion = Math.max(this.#appliedVersion, version);
        if (!this.#latest || this.#latest.version < version) this.#latest = entry.latestContext;
      });
    });
    const result = write.then(
      () => {
        this.#finish(entry, stream, generation, version);
        this.#completeWrite(generation, recoverOnAmbiguous);
      },
      (error: unknown) => {
        const handoffError =
          entry?.signal?.aborted && !entry.providerAccepted
            ? new AmbiguousAgentContextHandoff(
                sttAgentContextCancelledError(
                  this.#host.provider.name,
                  "STT agent context update was cancelled",
                ),
              )
            : error;
        const recoverFromAmbiguousHandoff =
          recoverOnAmbiguous &&
          handoffError instanceof AmbiguousAgentContextHandoff &&
          !this.#host.isClosing();
        if (handoffError instanceof AmbiguousAgentContextHandoff && !this.#host.isClosing()) {
          if (recoverFromAmbiguousHandoff) {
            if (this.#ambiguousWrite?.stream === stream) this.#ambiguousWrite = undefined;
          } else if (
            recoverOnAmbiguous &&
            this.#host.isCurrentOrOpeningGeneration(generation, stream)
          ) {
            this.#ambiguousWrite = { generation, stream, failure: handoffError.failure };
          } else if (this.#host.isCurrentOrOpeningGeneration(generation, stream)) {
            this.#recoverySuppressedGeneration = generation;
          }
        }
        this.#finish(entry, stream, generation, version, handoffError);
        if (recoverFromAmbiguousHandoff) {
          this.#host.handleGenerationFailure(generation, stream, handoffError.failure);
        }
        this.#completeWrite(generation, recoverOnAmbiguous);
        throw handoffError;
      },
    );
    this.#contextWriteTails.set(
      stream,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    this.#host.signalWork();
    return result;
  }

  #completeWrite(generation: number, trackedForRecovery: boolean): void {
    this.#inFlightWrites = Math.max(0, this.#inFlightWrites - 1);
    if (trackedForRecovery) {
      const pending = this.#pendingWrites.get(generation) ?? 0;
      if (pending <= 1) this.#pendingWrites.delete(generation);
      else this.#pendingWrites.set(generation, pending - 1);
    }
    this.#host.notifyProgress();
  }

  #fenceAmbiguousWrite(): void {
    const ambiguous = this.#ambiguousWrite;
    if (!ambiguous) return;
    if (
      ambiguous.generation !== this.#host.getGeneration() ||
      ambiguous.stream !== this.#host.getActiveStream()
    ) {
      this.#ambiguousWrite = undefined;
      return;
    }
    this.#host.handleGenerationFailure(ambiguous.generation, ambiguous.stream, ambiguous.failure);
  }

  #finish(
    entry: AgentContextEntry | undefined,
    stream: SttStream,
    generation: number,
    version: number,
    error?: unknown,
  ): void {
    if (entry?.settled && !entry.dispatchStarted) return;
    if (entry?.signal?.aborted && !entry.providerAccepted) return;
    if (!this.#host.isCurrentOrOpeningGeneration(generation, stream)) return;
    if (error === undefined) {
      if (entry) {
        entry.latestContext.cancelled = false;
        entry.latestContext.previous = undefined;
      }
      this.#appliedGeneration = generation;
      this.#appliedVersion = Math.max(this.#appliedVersion, version);
      for (const pending of [...this.#pendingEntries]) {
        if (pending.version <= this.#appliedVersion) this.settle(pending);
      }
      return;
    }
    const contextError = TvicThrowableError.from(
      error instanceof AmbiguousAgentContextHandoff ? error.failure : error,
    );
    if (entry) {
      if (entry.version === version) {
        this.#retire(entry.latestContext, entry.previousLatestContext, true);
        this.#rewindDispatch(version);
      }
      for (const pending of [...this.#pendingEntries]) {
        if (pending.version <= version) this.settle(pending, contextError);
      }
      return;
    }
    for (const listener of this.#errorListeners) {
      try {
        const notification = listener(contextError.error);
        void Promise.resolve(notification).catch(() => undefined);
      } catch {
        // Error observers must not change STT recovery or audio delivery.
      }
    }
  }

  #retire(
    value: LatestAgentContextValue,
    fallback?: LatestAgentContextValue,
    acceptedContextOnly = false,
  ): void {
    value.cancelled = true;
    const previous = acceptedContextOnly
      ? this.#latestAccepted(value.previous ?? fallback)
      : (value.previous ?? fallback);
    if (this.#latest === value) {
      this.#latest = latestNonCancelledContext(previous);
    } else {
      let current = this.#latest;
      while (current?.previous) {
        if (current.previous === value) {
          current.previous = previous;
          break;
        }
        current = current.previous;
      }
    }
    value.previous = undefined;
  }

  #latestAccepted(value: LatestAgentContextValue | undefined): LatestAgentContextValue | undefined {
    let current = value;
    while (current) {
      if (!current.cancelled && current.version <= this.#appliedVersion) return current;
      current = current.previous;
    }
    return undefined;
  }

  #rewindDispatch(version: number): void {
    const generation = this.#dispatchedGeneration;
    if (generation === 0 || this.#dispatchedVersion < version) return;
    // A scheduled write is not an accepted context. Recovery must not skip the
    // last value this generation actually confirmed.
    this.#dispatchedVersion =
      this.#appliedGeneration === generation
        ? Math.min(this.#appliedVersion, this.#dispatchedVersion)
        : 0;
  }

  #startUpdate(
    stream: SttStream,
    context: string,
    signal?: AbortSignal,
    onProviderAccepted?: () => void,
  ): Promise<void> {
    const timeout = sttAgentContextTimeoutError(
      this.#host.options.contextUpdateTimeoutMs,
      this.#host.provider.name,
    );
    let providerAccepted = false;
    return updateSttAgentContext(stream, context, {
      timeoutMs: this.#host.options.contextUpdateTimeoutMs,
      timeoutError: timeout,
      provider: this.#host.provider.name,
      lifecycleSignal: this.#host.lifecycleSignal,
      lifecycleAbortReason: () => this.#host.lifecycleSignal.reason ?? closedError(),
      abortProviderOnFailure: false,
      ...(signal !== undefined ? { callerSignal: signal } : {}),
      callerAbortReason: () =>
        sttAgentContextCancelledError(
          this.#host.provider.name,
          "STT agent context update was cancelled",
        ),
      onProviderAccepted: () => {
        providerAccepted = true;
        onProviderAccepted?.();
      },
    }).catch((error: unknown) => {
      if (error === timeout) throw new AmbiguousAgentContextHandoff(timeout);
      if (signal?.aborted && !providerAccepted) {
        throw new AmbiguousAgentContextHandoff(
          sttAgentContextCancelledError(
            this.#host.provider.name,
            "STT agent context update was cancelled",
          ),
        );
      }
      if (this.#host.lifecycleSignal.aborted) {
        throw this.#host.lifecycleSignal.reason ?? TvicThrowableError.from(closedError());
      }
      const failure = normalizeSttAgentContextUpdateError(error, this.#host.provider.name);
      if (isAmbiguousAgentContextFailure(failure)) {
        throw new AmbiguousAgentContextHandoff(failure);
      }
      throw failure;
    });
  }
}

function latestNonCancelledContext(
  context: LatestAgentContextValue | undefined,
): LatestAgentContextValue | undefined {
  let current = context;
  while (current?.cancelled) current = current.previous;
  return current;
}

function isAmbiguousAgentContextFailure(error: NormalizedError): boolean {
  return (
    error.retriable &&
    (error.category === "network" ||
      error.category === "timeout" ||
      error.code === STT_ERROR_CODES.transportWriteFailed ||
      error.code === STT_ERROR_CODES.transportTimeout)
  );
}
