import type WebSocket from "ws";
import type { TwilioMediaStreamSocket } from "voice-runtime";

export interface TwilioStartFrame {
  readonly callSid?: string;
  readonly accountSid?: string;
  readonly customParameters: Readonly<Record<string, string>>;
}

interface StartWaiter {
  readonly resolve: (frame: TwilioStartFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Buffers Twilio's initial `connected` and `start` frames while the host checks
 * the signed stream parameters. Once the media adapter subscribes, it receives
 * those original frames in order.
 */
export class BufferedTwilioSocket implements TwilioMediaStreamSocket {
  readonly #socket: WebSocket;
  readonly #messages: WebSocket.RawData[] = [];
  readonly #messageHandlers = new Set<(data: WebSocket.RawData) => void>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #errorHandlers = new Set<(error: Error) => void>();
  readonly #startWaiters = new Set<StartWaiter>();
  #activated = false;
  #closed = false;
  #error: Error | undefined;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      if (this.#activated) {
        for (const handler of this.#messageHandlers) handler(data);
      } else {
        this.#messages.push(data);
      }
      const frame = parseTwilioStartFrame(data);
      if (frame) this.#resolveStartWaiters(frame);
    });
    socket.on("close", () => {
      this.#closed = true;
      for (const handler of this.#closeHandlers) handler();
      this.#rejectStartWaiters(new Error("Twilio WebSocket closed before its start frame"));
    });
    socket.on("error", (error) => {
      this.#error = error;
      for (const handler of this.#errorHandlers) handler(error);
      this.#rejectStartWaiters(error);
    });
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }

  waitForStart(timeoutMs: number): Promise<TwilioStartFrame> {
    for (const message of this.#messages) {
      const frame = parseTwilioStartFrame(message);
      if (frame) return Promise.resolve(frame);
    }
    if (this.#closed) {
      return Promise.reject(new Error("Twilio WebSocket closed before its start frame"));
    }
    if (this.#error) return Promise.reject(this.#error);

    return new Promise((resolve, reject) => {
      let waiter: StartWaiter | undefined;
      const timer = setTimeout(() => {
        if (waiter) this.#startWaiters.delete(waiter);
        reject(new Error("Timed out waiting for Twilio's start frame"));
      }, timeoutMs);
      timer.unref?.();
      waiter = { resolve, reject, timer };
      this.#startWaiters.add(waiter);
    });
  }

  on(event: "message", handler: (data: WebSocket.RawData) => void): this;
  on(event: "close", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
  on(
    event: "message" | "close" | "error",
    handler: ((data: WebSocket.RawData) => void) | (() => void) | ((error: Error) => void),
  ): this {
    if (event === "message") {
      this.#messageHandlers.add(handler as (data: WebSocket.RawData) => void);
      if (!this.#activated) {
        this.#activated = true;
        const buffered = this.#messages.splice(0);
        for (const data of buffered) {
          for (const listener of this.#messageHandlers) listener(data);
        }
      }
    } else if (event === "close") {
      const listener = handler as () => void;
      this.#closeHandlers.add(listener);
      if (this.#closed) listener();
    } else {
      const listener = handler as (error: Error) => void;
      this.#errorHandlers.add(listener);
      if (this.#error) listener(this.#error);
    }
    return this;
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  #resolveStartWaiters(frame: TwilioStartFrame): void {
    for (const waiter of this.#startWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
    this.#startWaiters.clear();
  }

  #rejectStartWaiters(error: Error): void {
    for (const waiter of this.#startWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#startWaiters.clear();
  }
}

function parseTwilioStartFrame(data: WebSocket.RawData): TwilioStartFrame | null {
  let raw: string;
  try {
    const bytes = Array.isArray(data)
      ? Buffer.concat(data)
      : data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(data))
        : Buffer.from(data);
    raw = bytes.toString("utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.event !== "start") return null;
  const start = isRecord(value.start) ? value.start : {};
  const parameters = isRecord(start.customParameters) ? start.customParameters : {};
  const customParameters: Record<string, string> = {};
  for (const [name, parameter] of Object.entries(parameters)) {
    if (typeof parameter === "string") customParameters[name] = parameter;
  }
  return {
    ...(typeof start.callSid === "string" ? { callSid: start.callSid } : {}),
    ...(typeof start.accountSid === "string" ? { accountSid: start.accountSid } : {}),
    customParameters,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
