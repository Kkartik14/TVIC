import type { RawData } from "ws";

import {
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
  type CallId,
  type WebClientAudioProvider,
  type WebClientAudioSocket,
} from "voice-runtime";

const MAX_STARTUP_BUFFERED_MESSAGES = 32;
const MAX_STARTUP_BUFFERED_BYTES = WEB_CLIENT_AUDIO_DEFAULTS.maxBinaryFrameBytes;

type MessageHandler = (data: RawData, isBinary: boolean) => void;
type CloseHandler = (code: number, reason: Buffer) => void;
type ErrorHandler = (error: Error) => void;

interface BufferedMessage {
  readonly data: RawData;
  readonly isBinary: boolean;
  readonly byteLength: number;
}

interface TerminalClose {
  readonly code: number;
  readonly reason: Buffer;
}

export class StartupBufferedWebClientSocket implements WebClientAudioSocket {
  readonly #socket: WebClientAudioSocket;
  readonly #onTerminal: () => void;
  readonly #messages: Array<BufferedMessage | undefined> = [];
  readonly #messageHandlers: MessageHandler[] = [];
  readonly #closeHandlers: CloseHandler[] = [];
  readonly #errorHandlers: ErrorHandler[] = [];
  #queuedBytes = 0;
  #readIndex = 0;
  #flushing = false;
  #rejected = false;
  #terminalNotified = false;
  #terminalClose: TerminalClose | undefined;
  #terminalError: Error | undefined;

  constructor(socket: WebClientAudioSocket, onTerminal: () => void) {
    this.#socket = socket;
    this.#onTerminal = onTerminal;
    socket.on("message", (data, isBinary) => this.#receiveMessage(data, isBinary));
    socket.on("close", (code, reason) => this.#receiveClose(code, reason));
    socket.on("error", (error) => this.#receiveError(error));
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount ?? 0;
  }

  send(data: string | Buffer): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  on(event: "message", handler: MessageHandler): this;
  on(event: "close", handler: CloseHandler): this;
  on(event: "error", handler: ErrorHandler): this;
  on(
    event: "message" | "close" | "error",
    handler: MessageHandler | CloseHandler | ErrorHandler,
  ): this {
    if (event === "message") {
      const messageHandler = handler as MessageHandler;
      this.#messageHandlers.push(messageHandler);
      this.#flushMessages();
    } else if (event === "close") {
      const closeHandler = handler as CloseHandler;
      this.#closeHandlers.push(closeHandler);
      if (this.#terminalClose) {
        const terminal = this.#terminalClose;
        queueMicrotask(() => closeHandler(terminal.code, terminal.reason));
      }
    } else {
      const errorHandler = handler as ErrorHandler;
      this.#errorHandlers.push(errorHandler);
      if (this.#terminalError) {
        const terminal = this.#terminalError;
        queueMicrotask(() => errorHandler(terminal));
      }
    }
    return this;
  }

  #receiveMessage(data: RawData, isBinary: boolean): void {
    if (this.#rejected || this.#terminalClose || this.#terminalError) return;
    if (
      this.#messageHandlers.length > 0 &&
      !this.#flushing &&
      this.#readIndex === this.#messages.length
    ) {
      this.#dispatchMessage(data, isBinary);
      return;
    }

    const byteLength = rawDataByteLength(data);
    const queuedMessages = this.#messages.length - this.#readIndex;
    if (
      byteLength > MAX_STARTUP_BUFFERED_BYTES - this.#queuedBytes ||
      queuedMessages >= MAX_STARTUP_BUFFERED_MESSAGES
    ) {
      this.#rejectStartupBuffer();
      return;
    }
    this.#messages.push({ data, isBinary, byteLength });
    this.#queuedBytes += byteLength;
  }

  #flushMessages(): void {
    if (this.#flushing || this.#messageHandlers.length === 0) return;
    this.#flushing = true;
    try {
      while (this.#readIndex < this.#messages.length) {
        const message = this.#messages[this.#readIndex];
        this.#messages[this.#readIndex] = undefined;
        this.#readIndex += 1;
        if (!message) continue;
        this.#queuedBytes -= message.byteLength;
        this.#dispatchMessage(message.data, message.isBinary);
      }
    } finally {
      this.#flushing = false;
      this.#messages.length = 0;
      this.#readIndex = 0;
      this.#queuedBytes = 0;
    }
  }

  #dispatchMessage(data: RawData, isBinary: boolean): void {
    for (let index = 0; index < this.#messageHandlers.length; index += 1) {
      this.#messageHandlers[index]?.(data, isBinary);
    }
  }

  #receiveClose(code: number, reason: Buffer): void {
    if (this.#terminalClose) return;
    this.#terminalClose = { code, reason: Buffer.from(reason) };
    this.#notifyTerminal();
    for (let index = 0; index < this.#closeHandlers.length; index += 1) {
      this.#closeHandlers[index]?.(code, this.#terminalClose.reason);
    }
  }

  #receiveError(error: Error): void {
    this.#terminalError ??= error;
    this.#notifyTerminal();
    for (let index = 0; index < this.#errorHandlers.length; index += 1) {
      this.#errorHandlers[index]?.(error);
    }
  }

  #rejectStartupBuffer(): void {
    if (this.#rejected) return;
    this.#rejected = true;
    this.#messages.length = 0;
    this.#readIndex = 0;
    this.#queuedBytes = 0;
    this.#notifyTerminal();
    this.#socket.close(WEB_CLIENT_AUDIO_CLOSE_CODES.resourceLimit, "startup input limit exceeded");
  }

  #notifyTerminal(): void {
    if (this.#terminalNotified) return;
    this.#terminalNotified = true;
    this.#onTerminal();
  }
}

export interface VoiceConnectionAttempt {
  readonly callId: CallId;
  readonly signal: AbortSignal;
  readonly socket: StartupBufferedWebClientSocket;
  readonly startupSettled: Promise<void>;
  settleStartup(): void;
}

interface RegisteredAttempt {
  readonly attempt: VoiceConnectionAttempt;
  readonly controller: AbortController;
}

export class VoiceConnectionRegistry {
  readonly #telephony: Pick<WebClientAudioProvider, "supersede" | "hangup">;
  readonly #attempts = new Map<string, RegisteredAttempt>();

  constructor(telephony: Pick<WebClientAudioProvider, "supersede" | "hangup">) {
    this.#telephony = telephony;
  }

  begin(sessionRef: string, callId: CallId, socket: WebClientAudioSocket): VoiceConnectionAttempt {
    if (this.#attempts.has(sessionRef)) {
      throw new Error("A voice connection is already active for this session");
    }
    const controller = new AbortController();
    let resolveStartup!: () => void;
    let isStartupSettled = false;
    const startupSettled = new Promise<void>((resolve) => {
      resolveStartup = resolve;
    });
    const attempt: VoiceConnectionAttempt = {
      callId,
      signal: controller.signal,
      socket: new StartupBufferedWebClientSocket(socket, () => controller.abort()),
      startupSettled,
      settleStartup() {
        if (isStartupSettled) return;
        isStartupSettled = true;
        resolveStartup();
      },
    };
    this.#attempts.set(sessionRef, { attempt, controller });
    return attempt;
  }

  finish(sessionRef: string, attempt: VoiceConnectionAttempt): void {
    attempt.settleStartup();
    if (this.#attempts.get(sessionRef)?.attempt === attempt) this.#attempts.delete(sessionRef);
  }

  async supersede(sessionRef: string): Promise<void> {
    const attempt = await this.#cancelStartup(
      sessionRef,
      WEB_CLIENT_AUDIO_CLOSE_CODES.superseded,
      "superseded by reconnect",
    );
    if (!attempt) return;
    await this.#telephony.supersede(attempt.callId);
  }

  async terminate(sessionRef: string): Promise<boolean> {
    const attempt = await this.#cancelStartup(
      sessionRef,
      WEB_CLIENT_AUDIO_CLOSE_CODES.operatorTerminated,
      "terminated",
    );
    if (!attempt) return false;
    await this.#telephony.hangup(attempt.callId);
    return true;
  }

  async #cancelStartup(
    sessionRef: string,
    code: number,
    reason: string,
  ): Promise<VoiceConnectionAttempt | undefined> {
    const registered = this.#attempts.get(sessionRef);
    if (!registered) return undefined;
    const { attempt, controller } = registered;
    if (!attempt.signal.aborted) {
      // Aborting the agent start prevents a late call-handle factory from
      // consuming this socket after replacement or operator termination.
      controller.abort();
    }
    attempt.socket.close(code, reason);
    await attempt.startupSettled;
    return attempt;
  }
}

function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    let byteLength = 0;
    for (const part of data) byteLength += part.byteLength;
    return byteLength;
  }
  return Number.POSITIVE_INFINITY;
}
