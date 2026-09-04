import type { InputAudioChunk, NormalizedError, SttStream } from "@tvic/core";
import {
  isNormalizedError,
  isTvicError,
  normalizeUnknownError,
  providerError,
  STT_ERROR_CODES,
  timeoutError,
  TvicThrowableError,
} from "@tvic/core";

export const DEFAULT_STT_COMMAND_LIMITS = {
  maxBufferedBytes: 320_000,
  maxBufferedCommands: 512,
  commitTimeoutMs: 5_000,
} as const;

export interface SttCommandControllerOptions {
  readonly stream: SttStream;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedCommands?: number;
  readonly commitTimeoutMs?: number;
}

export interface SttCommandController {
  /** Resolves only when this controller reaches a terminal state. */
  readonly failure: Promise<never>;
  /** Admit audio without waiting for provider I/O. */
  admitAudio(chunk: InputAudioChunk): Promise<void>;
  /** Admit an ordered barrier and settle it after provider command acceptance. */
  admitCommit(): Promise<void>;
  /** Drain admitted commands in order and then close the stream. */
  drain(): Promise<void>;
  /** Abandon queued work and close the stream immediately. */
  abort(error?: unknown): Promise<void>;
}

type Command =
  | {
      readonly kind: "audio";
      readonly chunk: InputAudioChunk;
    }
  | {
      readonly kind: "commit";
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    };

/**
 * The one runtime ingress seam for direct STT streams. Admission is bounded and
 * synchronous from the caller's point of view; provider work is serialized in a
 * supervised worker so a slow commit cannot stop media consumption.
 */
export class SerialSttCommandController implements SttCommandController {
  readonly #stream: SttStream;
  readonly #maxBufferedBytes: number;
  readonly #maxBufferedCommands: number;
  readonly #commitTimeoutMs: number;
  readonly #abortController = new AbortController();
  readonly #commands: Command[] = [];
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
    this.#maxBufferedBytes = validateLimit(
      options.maxBufferedBytes ?? DEFAULT_STT_COMMAND_LIMITS.maxBufferedBytes,
      "maxBufferedBytes",
    );
    this.#maxBufferedCommands = validateLimit(
      options.maxBufferedCommands ?? DEFAULT_STT_COMMAND_LIMITS.maxBufferedCommands,
      "maxBufferedCommands",
    );
    this.#commitTimeoutMs = validatePositiveTimeout(
      options.commitTimeoutMs ?? DEFAULT_STT_COMMAND_LIMITS.commitTimeoutMs,
      "commitTimeoutMs",
    );
    this.#failure = new Promise<never>((_, reject) => {
      this.#rejectFailure = reject;
    });
    // The controller is supervised by its owner, but a terminal provider failure
    // must not become an unhandled rejection if the owner is already shutting down.
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

  async drain(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#accepting = false;
    this.#drainRequested = true;
    this.#signalWork();
    this.#closePromise = this.#worker.then(() => this.#closeStream());
    return this.#closePromise;
  }

  async abort(error: unknown = sessionClosedError()): Promise<void> {
    const throwable = TvicThrowableError.from(error);
    this.#accepting = false;
    this.#terminal = true;
    this.#abortController.abort(throwable);
    this.#activeCommitReject?.(throwable);
    this.#activeCommitReject = undefined;
    this.#rejectQueued(throwable);
    this.#signalWork();
    await this.#closeStream();
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
        try {
          await this.#stream.sendAudio(command.chunk);
        } catch (error) {
          this.#fail(error);
        }
        continue;
      }

      this.#activeCommitReject = command.reject;
      try {
        await withAbortableTimeout(
          this.#stream.commit(),
          this.#commitTimeoutMs,
          this.#abortController.signal,
        );
        command.resolve();
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

  async #closeStream(): Promise<void> {
    if (!this.#streamClosePromise) {
      this.#streamClosePromise = this.#stream.close().catch(() => undefined);
    }
    await this.#streamClosePromise;
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
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(timeoutError("stt.commit_timeout", `STT commit timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
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
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
