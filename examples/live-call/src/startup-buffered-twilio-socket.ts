import type { RawData } from "ws";

import type { TwilioMediaStreamSocket } from "voice-runtime";

const MAX_STARTUP_MESSAGES = 32;
const MAX_STARTUP_BYTES = 1_048_576;

type MessageHandler = (data: RawData) => void;
type CloseHandler = () => void;
type ErrorHandler = (error: Error) => void;

export class StartupBufferedTwilioSocket implements TwilioMediaStreamSocket {
  readonly #socket: TwilioMediaStreamSocket & { terminate?: () => void };
  readonly #messages: RawData[] = [];
  readonly #messageHandlers: MessageHandler[] = [];
  readonly #closeHandlers: CloseHandler[] = [];
  readonly #errorHandlers: ErrorHandler[] = [];
  #bufferedBytes = 0;
  #terminalClose = false;
  #terminalError: Error | undefined;
  #rejected = false;

  constructor(socket: TwilioMediaStreamSocket & { terminate?: () => void }) {
    this.#socket = socket;
    socket.on("message", (data) => this.#receiveMessage(data));
    socket.on("close", () => this.#receiveClose());
    socket.on("error", (error) => this.#receiveError(error));
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount ?? 0;
  }

  send(data: string): void {
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
      this.#messageHandlers.push(handler as MessageHandler);
      this.#flushMessages();
    } else if (event === "close") {
      const closeHandler = handler as CloseHandler;
      this.#closeHandlers.push(closeHandler);
      if (this.#terminalClose) queueMicrotask(closeHandler);
    } else {
      const errorHandler = handler as ErrorHandler;
      this.#errorHandlers.push(errorHandler);
      if (this.#terminalError) queueMicrotask(() => errorHandler(this.#terminalError!));
    }
    return this;
  }

  #receiveMessage(data: RawData): void {
    if (this.#rejected || this.#terminalClose || this.#terminalError) return;
    if (this.#messageHandlers.length > 0) {
      this.#dispatchMessage(data);
      return;
    }
    const byteLength = rawDataByteLength(data);
    if (
      byteLength > MAX_STARTUP_BYTES - this.#bufferedBytes ||
      this.#messages.length >= MAX_STARTUP_MESSAGES
    ) {
      this.#rejectStartupBuffer();
      return;
    }
    this.#messages.push(data);
    this.#bufferedBytes += byteLength;
  }

  #flushMessages(): void {
    if (this.#messageHandlers.length === 0 || this.#messages.length === 0) return;
    const messages = this.#messages.splice(0);
    this.#bufferedBytes = 0;
    for (const message of messages) this.#dispatchMessage(message);
  }

  #dispatchMessage(data: RawData): void {
    for (const handler of this.#messageHandlers) handler(data);
  }

  #receiveClose(): void {
    if (this.#terminalClose) return;
    this.#terminalClose = true;
    for (const handler of this.#closeHandlers) handler();
  }

  #receiveError(error: Error): void {
    this.#terminalError ??= error;
    for (const handler of this.#errorHandlers) handler(error);
  }

  #rejectStartupBuffer(): void {
    if (this.#rejected) return;
    this.#rejected = true;
    this.#messages.length = 0;
    this.#bufferedBytes = 0;
    const error = new Error("Twilio media stream startup buffer exceeded");
    this.#receiveError(error);
    try {
      this.#socket.close(1009, "startup buffer exceeded");
    } catch {
      this.#socket.terminate?.();
    }
  }
}

function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}
