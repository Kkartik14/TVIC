import type {
  InputAudioChunk,
  NormalizedError,
  SttAudioWriteUsageOperation,
  SttStream,
} from "@tvic/core";
import {
  isNormalizedError,
  isTvicError,
  countUnicodeCodePoints,
  normalizeUnknownError,
  providerError,
  STT_ERROR_CODES,
  timeoutError,
  TvicThrowableError,
  validationError,
} from "@tvic/core";
import { cancelWithTimeout, withTimeout } from "./async-control.js";
import { CANCELLATION_TIMEOUT_MS } from "./pipeline-constants.js";
import { audioWriteTimeoutError } from "./resilient-stt-policy.js";
import { trackSttAudioWriteOutcome } from "./stt-audio-write-usage.js";
import { createSttAgentContextWaiter, type SttAgentContextWaiter } from "./stt-agent-context.js";

export const DEFAULT_STT_COMMAND_LIMITS = {
  maxBufferedBytes: 320_000,
  maxBufferedCommands: 512,
  sendTimeoutMs: 5_000,
  commitTimeoutMs: 5_000,
  audioWriteTimeoutMs: 5_000,
} as const;

export interface SttCommandControllerOptions {
  readonly stream: SttStream;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedCommands?: number;
  readonly sendTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
  readonly audioWriteTimeoutMs?: number;
  readonly contextUpdateTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onAudioWrite?: (chunk: InputAudioChunk) => SttAudioWriteUsageOperation | undefined;
}

export interface SttCommandController {
  readonly failure: Promise<never>;
  admitAudio(chunk: InputAudioChunk): Promise<void>;
  admitAgentContext(context: string): Promise<void>;
  admitCommit(): Promise<void>;
  drain(): Promise<void>;
  abort(error?: unknown): Promise<void>;
}

type Command =
  | {
      readonly kind: "audio";
      readonly chunk: InputAudioChunk;
    }
  | {
      readonly kind: "agent_context";
      context: string;
      readonly waiter: SttAgentContextWaiter;
    }
  | {
      readonly kind: "commit";
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    };

export class SerialSttCommandController implements SttCommandController {
  readonly #stream: SttStream;
  readonly #maxBufferedBytes: number;
  readonly #maxBufferedCommands: number;
  readonly #commitTimeoutMs: number;
  readonly #audioWriteTimeoutMs: number;
  readonly #contextUpdateTimeoutMs: number;
  readonly #audioWriteErrorCode: string;
  readonly #closeTimeoutMs: number;
  readonly #onAudioWrite: SttCommandControllerOptions["onAudioWrite"];
  readonly #abortController = new AbortController();
  readonly #commands: Command[] = [];
  readonly #pendingAgentContextCommands = new Set<
    Extract<Command, { readonly kind: "agent_context" }>
  >();
  readonly #failure: Promise<never>;
  #rejectFailure!: (error: unknown) => void;
  readonly #worker: Promise<void>;
  #bufferedBytes = 0;
  #accepting = true;
  #terminal = false;
  #drainRequested = false;
  #closePromise: Promise<void> | undefined;
  #streamClosePromise: Promise<void> | undefined;
  #wake: Promise<void> | undefined;
  #resolveWake: (() => void) | undefined;
  #activeCommitReject: ((error: unknown) => void) | undefined;

  constructor(options: SttCommandControllerOptions) {
    this.#stream = options.stream;
    this.#onAudioWrite = options.onAudioWrite;
    this.#maxBufferedBytes = validateLimit(
      options.maxBufferedBytes ?? DEFAULT_STT_COMMAND_LIMITS.maxBufferedBytes,
      "maxBufferedBytes",
    );
    this.#maxBufferedCommands = validateLimit(
      options.maxBufferedCommands ?? DEFAULT_STT_COMMAND_LIMITS.maxBufferedCommands,
      "maxBufferedCommands",
    );
    validatePositiveTimeout(
      options.sendTimeoutMs ?? DEFAULT_STT_COMMAND_LIMITS.sendTimeoutMs,
      "sendTimeoutMs",
    );
    this.#commitTimeoutMs = validatePositiveTimeout(
      options.commitTimeoutMs ?? DEFAULT_STT_COMMAND_LIMITS.commitTimeoutMs,
      "commitTimeoutMs",
    );
    this.#audioWriteTimeoutMs = validatePositiveTimeout(
      options.audioWriteTimeoutMs ??
        options.sendTimeoutMs ??
        DEFAULT_STT_COMMAND_LIMITS.audioWriteTimeoutMs,
      "audioWriteTimeoutMs",
    );
    this.#contextUpdateTimeoutMs = validatePositiveTimeout(
      options.contextUpdateTimeoutMs ?? 2_000,
      "contextUpdateTimeoutMs",
    );
    this.#audioWriteErrorCode =
      options.audioWriteTimeoutMs === undefined
        ? STT_ERROR_CODES.transportTimeout
        : STT_ERROR_CODES.audioWriteTimeout;
    this.#closeTimeoutMs = validatePositiveTimeout(
      options.closeTimeoutMs ?? CANCELLATION_TIMEOUT_MS,
      "closeTimeoutMs",
    );
    this.#failure = new Promise<never>((_, reject) => {
      this.#rejectFailure = reject;
    });
    this.#failure.catch(() => undefined);
    this.#worker = this.#run();
  }

  get failure(): Promise<never> {
    return this.#failure;
  }

  admitAudio(chunk: InputAudioChunk): Promise<void> {
    if (this.#terminal || !this.#accepting) {
      return Promise.reject(TvicThrowableError.from(sessionClosedError()));
    }
    const bytes = chunk.audio.bytes.byteLength;
    if (
      this.#commands.length >= this.#maxBufferedCommands ||
      this.#bufferedBytes + bytes > this.#maxBufferedBytes
    ) {
      const error = TvicThrowableError.from(overflowError());
      this.#fail(error);
      return Promise.reject(error);
    }
    this.#commands.push({
      kind: "audio",
      chunk: copyAudioChunk(chunk),
    });
    this.#bufferedBytes += bytes;
    this.#signalWork();
    return Promise.resolve();
  }

  admitCommit(): Promise<void> {
    if (this.#terminal || !this.#accepting) {
      return Promise.reject(TvicThrowableError.from(sessionClosedError()));
    }
    if (this.#commands.length >= this.#maxBufferedCommands) {
      const error = TvicThrowableError.from(overflowError());
      this.#fail(error);
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.#commands.push({ kind: "commit", resolve, reject });
      this.#signalWork();
    });
  }

  admitAgentContext(context: string): Promise<void> {
    if (this.#terminal || !this.#accepting) {
      return Promise.reject(TvicThrowableError.from(sessionClosedError()));
    }
    if (typeof context !== "string" || countUnicodeCodePoints(context) > 1_500) {
      return Promise.reject(
        TvicThrowableError.from(
          validationError(
            STT_ERROR_CODES.invalidRequest,
            "STT agent context must not exceed 1500 characters",
          ),
        ),
      );
    }
    if (typeof this.#stream.updateAgentContext !== "function") {
      return Promise.reject(
        TvicThrowableError.from(
          providerError(
            STT_ERROR_CODES.contextUpdateFailed,
            "The STT stream does not implement agent context updates",
            { retriable: false },
          ),
        ),
      );
    }

    const pending = this.#commands.find(
      (command): command is Extract<Command, { kind: "agent_context" }> =>
        command.kind === "agent_context",
    );
    if (pending) {
      pending.context = context;
      return pending.waiter.promise;
    }
    if (
      this.#commands.length + this.#pendingAgentContextCommands.size >=
      this.#maxBufferedCommands
    ) {
      const error = TvicThrowableError.from(overflowError());
      this.#fail(error);
      return Promise.reject(error);
    }
    const waiter = createSttAgentContextWaiter();
    this.#commands.push({ kind: "agent_context", context, waiter });
    this.#signalWork();
    return waiter.promise;
  }

  async drain(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#accepting = false;
    this.#drainRequested = true;
    this.#signalWork();
    this.#closePromise = (async () => {
      try {
        await withTimeout(
          this.#worker,
          this.#closeTimeoutMs,
          timeoutError(
            "stt.drain_timeout",
            `STT command drain timed out after ${this.#closeTimeoutMs}ms`,
          ),
        );
      } catch (error) {
        const throwable = TvicThrowableError.from(error);
        this.#rejectFailure(throwable);
        await this.#abort(throwable, false).catch(() => undefined);
        throw throwable;
      }
      await this.#closeStream();
    })();
    return this.#closePromise;
  }

  async abort(error: unknown = sessionClosedError()): Promise<void> {
    await this.#abort(error, true);
  }

  async #abort(error: unknown, waitForProvider: boolean): Promise<void> {
    const throwable = TvicThrowableError.from(error);
    this.#accepting = false;
    this.#terminal = true;
    this.#abortController.abort(throwable);
    this.#activeCommitReject?.(throwable);
    this.#activeCommitReject = undefined;
    this.#rejectQueued(throwable);
    this.#signalWork();
    await this.#closeStream(waitForProvider);
  }

  async #run(): Promise<void> {
    while (!this.#terminal) {
      const command = this.#commands.shift();
      if (!command) {
        if (this.#drainRequested) {
          return;
        }
        await this.#waitForWork();
        continue;
      }

      if (command.kind === "audio") {
        this.#bufferedBytes -= command.chunk.audio.bytes.byteLength;
        const usageWrite = this.#onAudioWrite?.(command.chunk);
        try {
          const send = trackSttAudioWriteOutcome(
            Promise.resolve().then(() => this.#stream.sendAudio(command.chunk)),
            usageWrite,
            (error) => this.#fail(error),
          );
          await withAbortableTimeout(
            send,
            this.#audioWriteTimeoutMs,
            this.#abortController.signal,
            audioWriteTimeoutError(
              this.#audioWriteErrorCode,
              `STT audio write timed out after ${this.#audioWriteTimeoutMs}ms`,
            ),
          );
        } catch (error) {
          this.#fail(error);
        }
        continue;
      }

      if (command.kind === "agent_context") {
        await this.#dispatchAgentContext(command);
        continue;
      }

      this.#activeCommitReject = command.reject;
      try {
        if ((this.#stream as SttStream).commitMode === "none") {
          command.resolve();
        } else {
          await withAbortableTimeout(
            Promise.resolve().then(() => this.#stream.commit()),
            this.#commitTimeoutMs,
            this.#abortController.signal,
          );
          command.resolve();
        }
      } catch (error) {
        const normalized = normalizedCommitError(error);
        const throwable = TvicThrowableError.from(normalized);
        command.reject(throwable);
        this.#fail(throwable);
      } finally {
        this.#activeCommitReject = undefined;
      }
    }
  }

  #fail(error: unknown): void {
    if (this.#terminal) {
      return;
    }
    const throwable = TvicThrowableError.from(error);
    this.#terminal = true;
    this.#accepting = false;
    this.#abortController.abort(throwable);
    this.#activeCommitReject?.(throwable);
    this.#activeCommitReject = undefined;
    this.#rejectQueued(throwable);
    this.#rejectFailure(throwable);
    void this.#closeStream();
  }

  #rejectQueued(error: unknown): void {
    this.#bufferedBytes = 0;
    for (const command of this.#commands.splice(0)) {
      if (command.kind === "commit") {
        command.reject(error);
      } else if (command.kind === "agent_context") {
        command.waiter.reject(error);
      }
    }
    this.#resolveWake?.();
    this.#resolveWake = undefined;
    this.#wake = undefined;
  }

  #signalWork(): void {
    this.#resolveWake?.();
    this.#resolveWake = undefined;
    this.#wake = undefined;
  }

  async #waitForWork(): Promise<void> {
    if (this.#commands.length > 0 || this.#terminal || this.#drainRequested) {
      return;
    }
    this.#wake = new Promise<void>((resolve) => {
      this.#resolveWake = resolve;
    });
    await this.#wake;
  }

  async #closeStream(waitForProvider = true): Promise<void> {
    if (!this.#streamClosePromise) {
      this.#streamClosePromise = cancelWithTimeout(
        () => this.#stream.close(),
        this.#closeTimeoutMs,
      ).catch(() => undefined);
    }
    if (waitForProvider) await this.#streamClosePromise;
  }

  async #dispatchAgentContext(
    command: Extract<Command, { readonly kind: "agent_context" }>,
  ): Promise<void> {
    this.#pendingAgentContextCommands.add(command);
    try {
      if (typeof this.#stream.updateAgentContext !== "function") {
        throw new Error("STT stream does not implement agent context updates");
      }
      const timeout = timeoutError(
        STT_ERROR_CODES.contextUpdateFailed,
        `STT agent context update timed out after ${this.#contextUpdateTimeoutMs}ms`,
        { retriable: false },
      );
      await withTimeout(
        Promise.resolve().then(() => this.#stream.updateAgentContext!(command.context)),
        this.#contextUpdateTimeoutMs,
        timeout,
        this.#abortController.signal,
      );
      this.#settleAgentContext(command);
    } catch (error) {
      const failure = this.#abortController.signal.aborted
        ? TvicThrowableError.from(this.#abortController.signal.reason ?? sessionClosedError())
        : isNormalizedError(error) && error.category === "timeout"
          ? error
          : providerError(STT_ERROR_CODES.contextUpdateFailed, "STT agent context update failed", {
              retriable: false,
            });
      this.#settleAgentContext(command, failure);
      this.#fail(failure);
    }
  }

  #settleAgentContext(
    command: Extract<Command, { readonly kind: "agent_context" }>,
    error?: unknown,
  ): void {
    if (!this.#pendingAgentContextCommands.delete(command)) return;
    if (error === undefined) {
      command.waiter.resolve();
      return;
    }
    command.waiter.reject(TvicThrowableError.from(error));
  }
}

function copyAudioChunk(chunk: InputAudioChunk): InputAudioChunk {
  return {
    ...chunk,
    audio: {
      ...chunk.audio,
      bytes: new Uint8Array(chunk.audio.bytes),
    },
  };
}

function validateLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validatePositiveTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function overflowError(): NormalizedError {
  return providerError(STT_ERROR_CODES.bufferOverflow, "The bounded STT command buffer is full", {
    retriable: false,
  });
}

function sessionClosedError(): NormalizedError {
  return providerError(STT_ERROR_CODES.closed, "The STT command controller is closed", {
    retriable: false,
  });
}

function normalizedCommitError(error: unknown): NormalizedError {
  if (isNormalizedError(error)) return error;
  if (isTvicError(error)) {
    const carried = (error as NormalizedError & { readonly error?: unknown }).error;
    if (isNormalizedError(carried)) return carried;
  }
  return normalizeUnknownError(error, {
    code: "stt.commit_failed",
    category: "provider",
    retriable: true,
  });
}

async function withAbortableTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutReason: unknown = timeoutError("stt.commit_timeout", `STT operation timed out`),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutReason), timeoutMs);
        timer.unref?.();
        onAbort = () => reject(signal.reason ?? new Error("STT command aborted"));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
