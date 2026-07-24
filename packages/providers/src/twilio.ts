import type WebSocket from "ws";

import {
  base64ToBytes,
  bytesToBase64,
  durationMsForPcm16le,
  frameCountForPcm16le,
  mulawToPcm16le,
  pcm16leToMulaw,
  resamplePcm16le,
  assertPcm16leFormat,
} from "@tvic/media";

import {
  PCM16_16K_MONO,
  PROVIDER_ERROR_CODES,
  PROVIDER_NAMES,
  RUNTIME_SAMPLE_RATE_HZ,
  TELEPHONY_SAMPLE_RATE_HZ,
  isDtmfDigit,
  sameAudioFormat,
} from "@tvic/core";
import type {
  AudioFormat,
  CallHandle,
  CallId,
  InboundMediaEvent,
  InputMediaEvent,
  MediaEventId,
  OutputMediaEvent,
  ProviderCapabilities,
  SessionId,
  StreamEndReason,
  TelephonyProvider,
} from "@tvic/core";

import { AsyncQueue } from "./async-queue.js";
import {
  SystemProviderClock,
  parseJsonObject,
  providerError,
  safeClose,
  safeSend,
  unknownErrorMessage,
  type ProviderClock,
} from "./common.js";

const TWILIO_CAPABILITIES = {
  streaming: { input: true, output: true, native: true },
  cancellation: { request: true, output: true, buffer: true, truncation: false },
  transports: ["websocket"],
  audio: { input: [PCM16_16K_MONO], output: [PCM16_16K_MONO] },
  playout: { clearBuffer: true, acknowledgement: true, position: false },
} satisfies ProviderCapabilities;

export interface TwilioMediaStreamSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: WebSocket.RawData) => void): this;
  on(event: "close", handler: () => void): this;
  on(event: "error", handler: (error: Error) => void): this;
}

export interface TwilioMediaStreamCallHandleOptions {
  readonly socket: TwilioMediaStreamSocket;
  readonly callId: CallId;
  readonly sessionId: SessionId;
  readonly inputFormat?: AudioFormat;
  readonly outputFormat?: AudioFormat;
  readonly clock?: ProviderClock;
}

type TwilioInboundMessage =
  | { readonly event: "connected"; readonly protocol?: string; readonly version?: string }
  | {
      readonly event: "start";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly start?: {
        readonly streamSid?: string;
        readonly accountSid?: string;
        readonly callSid?: string;
        readonly customParameters?: Readonly<Record<string, string>>;
      };
    }
  | {
      readonly event: "media";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly media?: {
        readonly track?: "inbound" | "outbound";
        readonly chunk?: string;
        readonly timestamp?: string;
        readonly payload?: string;
      };
    }
  | {
      readonly event: "dtmf";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly dtmf?: { readonly digit?: string };
    }
  | {
      readonly event: "mark";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly mark?: { readonly name?: string };
    }
  | {
      readonly event: "stop";
      readonly sequenceNumber?: string;
      readonly streamSid: string;
      readonly stop?: { readonly callSid?: string };
    };

export class TwilioMediaStreamCallHandle implements CallHandle {
  readonly events: AsyncIterable<InboundMediaEvent>;
  readonly #socket: TwilioMediaStreamSocket;
  readonly #events = new AsyncQueue<InboundMediaEvent>();
  readonly #inputFormat: AudioFormat;
  readonly #clock: ProviderClock;
  // Twilio echoes a "mark" once playout reaches it — the proof the caller heard it.
  readonly #ackedMarks = new Set<string>();
  readonly #markWaiters = new Map<string, Set<(acked: boolean) => void>>();
  #streamSid: string | null = null;
  #closed = false;

  constructor(readonly options: TwilioMediaStreamCallHandleOptions) {
    this.callId = options.callId;
    this.#socket = options.socket;
    this.#clock = options.clock ?? new SystemProviderClock();
    this.#inputFormat = options.inputFormat ?? PCM16_16K_MONO;
    assertTwilioBoundaryFormat(this.#inputFormat);
    if (options.outputFormat) {
      assertTwilioBoundaryFormat(options.outputFormat);
    }
    this.events = this.#events;

    this.#socket.on("message", (data) => this.#handleRawMessage(data));
    this.#socket.on("close", () => this.#closeEvents());
    this.#socket.on("error", (error) => {
      this.#events.push(this.#mediaError(error));
      this.#closeEvents();
    });
  }

  readonly callId: CallId;

  async send(event: OutputMediaEvent): Promise<boolean> {
    if (this.#closed) {
      return false;
    }

    if (event.type === "media.audio.chunk") {
      assertTwilioBoundaryFormat(event.audio.format);

      const pcm16k =
        event.audio.format.sampleRateHz === RUNTIME_SAMPLE_RATE_HZ
          ? event.audio.data.bytes
          : resamplePcm16le(
              event.audio.data.bytes,
              event.audio.format.sampleRateHz,
              RUNTIME_SAMPLE_RATE_HZ,
            );
      const pcm8k = resamplePcm16le(pcm16k, RUNTIME_SAMPLE_RATE_HZ, TELEPHONY_SAMPLE_RATE_HZ);
      const mulaw = pcm16leToMulaw(pcm8k);
      return this.#sendJson({
        event: "media",
        streamSid: this.#requiredStreamSid(),
        media: { payload: bytesToBase64(mulaw) },
      });
    }

    if (event.type === "media.audio.committed") {
      return this.#sendMark(String(event.id));
    }

    if (event.type === "media.stream.ended" || event.type === "media.error") {
      await this.close(event.type === "media.error" ? "error" : event.reason);
    }
    return true;
  }

  async clear(): Promise<void> {
    if (!this.#closed) {
      this.#sendJson({ event: "clear", streamSid: this.#requiredStreamSid() });
    }
  }

  async cancelOutput(_reason?: string): Promise<void> {
    await this.clear();
  }

  async close(_reason: StreamEndReason): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    safeClose(this.#socket);
    this.#closeEvents();
  }

  #handleRawMessage(data: WebSocket.RawData): void {
    const body = data.toString("utf8");
    const parsed = parseJsonObject(body);
    if (!parsed || typeof parsed.event !== "string") {
      this.#events.push(this.#mediaError(new Error("Invalid Twilio message")));
      return;
    }

    this.#handleMessage(parsed as TwilioInboundMessage);
  }

  #handleMessage(message: TwilioInboundMessage): void {
    switch (message.event) {
      case "connected":
        return;
      case "start":
        this.#streamSid = message.streamSid || message.start?.streamSid || null;
        this.#events.push({
          id: this.#mediaEventId("stream_started", message.sequenceNumber),
          type: "media.stream.started",
          sessionId: this.options.sessionId,
          callId: this.callId,
          sequence: numericSequence(message.sequenceNumber),
          direction: "input",
          timestamp: this.#clock.now(),
          monotonicOffsetMs: 0,
          provider: PROVIDER_NAMES.twilio,
          format: this.#inputFormat,
          metadata: {
            accountSid: message.start?.accountSid,
            twilioCallSid: message.start?.callSid,
            customParameters: message.start?.customParameters,
          },
        });
        return;
      case "media":
        this.#handleMediaMessage(message);
        return;
      case "dtmf":
        if (isDtmfDigit(message.dtmf?.digit)) {
          this.#events.push({
            id: this.#mediaEventId("dtmf", message.sequenceNumber),
            type: "dtmf.received",
            sessionId: this.options.sessionId,
            callId: this.callId,
            sequence: numericSequence(message.sequenceNumber),
            direction: "input",
            timestamp: this.#clock.now(),
            monotonicOffsetMs: 0,
            provider: PROVIDER_NAMES.twilio,
            digit: message.dtmf.digit,
          });
        }
        return;
      case "mark":
        if (message.mark?.name) {
          this.#resolveMark(message.mark.name);
        }
        return;
      case "stop":
        this.#events.push({
          id: this.#mediaEventId("stream_ended", message.sequenceNumber),
          type: "media.stream.ended",
          sessionId: this.options.sessionId,
          callId: this.callId,
          sequence: numericSequence(message.sequenceNumber),
          direction: "input",
          timestamp: this.#clock.now(),
          monotonicOffsetMs: 0,
          provider: PROVIDER_NAMES.twilio,
          reason: "remote_hangup",
          durationMs: 0,
        });
        this.#closeEvents();
        return;
    }
  }

  #handleMediaMessage(message: Extract<TwilioInboundMessage, { readonly event: "media" }>): void {
    if (message.media?.track !== "inbound" || !message.media.payload) {
      return;
    }

    const mulaw = base64ToBytes(message.media.payload);
    const pcm8k = mulawToPcm16le(mulaw);
    const normalized = resamplePcm16le(
      pcm8k,
      TELEPHONY_SAMPLE_RATE_HZ,
      this.#inputFormat.sampleRateHz,
    );
    const monotonicOffsetMs = numericSequence(message.media.timestamp);
    const event: InputMediaEvent = {
      id: this.#mediaEventId("audio", message.sequenceNumber),
      type: "media.audio.chunk",
      sessionId: this.options.sessionId,
      callId: this.callId,
      sequence: numericSequence(message.sequenceNumber),
      direction: "input",
      timestamp: this.#clock.now(),
      monotonicOffsetMs,
      provider: PROVIDER_NAMES.twilio,
      audio: {
        format: this.#inputFormat,
        durationMs: durationMsForPcm16le(normalized, this.#inputFormat.sampleRateHz),
        frameCount: frameCountForPcm16le(normalized),
        data: { kind: "inline", bytes: normalized },
      },
      metadata: {
        twilioChunk: message.media.chunk,
        twilioStreamSid: message.streamSid,
      },
    };
    this.#events.push(event);
  }

  #sendMark(name: string): boolean {
    return this.#sendJson({
      event: "mark",
      streamSid: this.#requiredStreamSid(),
      mark: { name },
    });
  }

  #sendJson(message: unknown): boolean {
    return safeSend(this.#socket, JSON.stringify(message));
  }

  #requiredStreamSid(): string {
    if (!this.#streamSid) {
      throw new Error("Twilio streamSid is not available yet");
    }
    return this.#streamSid;
  }

  #mediaError(error: unknown): InputMediaEvent {
    return {
      id: this.#mediaEventId("error"),
      type: "media.error",
      sessionId: this.options.sessionId,
      callId: this.callId,
      sequence: 0,
      direction: "input",
      timestamp: this.#clock.now(),
      monotonicOffsetMs: 0,
      provider: PROVIDER_NAMES.twilio,
      error: providerError(PROVIDER_ERROR_CODES.twilioMedia, unknownErrorMessage(error), {
        category: "media",
        cause: error,
      }),
    };
  }

  #mediaEventId(kind: string, sequence?: string): MediaEventId {
    return `twilio_${kind}_${sequence ?? Date.now()}` as MediaEventId;
  }

  async confirmPlayout(markId: string, timeoutMs: number): Promise<boolean> {
    if (this.#ackedMarks.has(markId)) {
      return true;
    }
    if (this.#closed) {
      return false; // the call dropped before this mark could play out
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (acked: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#markWaiters.get(markId)?.delete(finish);
        resolve(acked);
      };
      // No ack within the window: we have no proof the caller heard it, so report
      // false (unconfirmed). We never claim "heard" without a mark ack.
      const timer = setTimeout(() => finish(false), timeoutMs);
      const waiters = this.#markWaiters.get(markId) ?? new Set();
      waiters.add(finish);
      this.#markWaiters.set(markId, waiters);
    });
  }

  #resolveMark(name: string): void {
    this.#ackedMarks.add(name);
    const waiters = this.#markWaiters.get(name);
    if (waiters) {
      this.#markWaiters.delete(name);
      for (const waiter of waiters) {
        waiter(true);
      }
    }
  }

  #closeEvents(): void {
    this.#closed = true;
    this.#events.close();
    // The call dropped: any output awaiting playout confirmation was not heard.
    for (const waiters of this.#markWaiters.values()) {
      for (const waiter of waiters) {
        waiter(false);
      }
    }
    this.#markWaiters.clear();
  }
}

export class TwilioMediaStreamsProvider implements TelephonyProvider {
  readonly name = PROVIDER_NAMES.twilio;
  readonly kind = "telephony";
  readonly version = "0.1.0";
  readonly capabilities = TWILIO_CAPABILITIES;
  readonly #pendingSockets = new Map<
    CallId,
    { socket: TwilioMediaStreamSocket; sessionId: SessionId }
  >();

  async dial(): Promise<CallHandle> {
    throw new Error(
      "Twilio outbound dialing is owned by the control plane; attach Media Streams via acceptWebSocket",
    );
  }

  async accept(ctx: Parameters<TelephonyProvider["accept"]>[0]): Promise<CallHandle> {
    const pending = this.#pendingSockets.get(ctx.call.id);
    const sessionId = pending?.sessionId ?? ctx.call.sessionId;
    if (!pending || !sessionId) {
      throw new Error(`No attached Twilio Media Stream socket for call ${ctx.call.id}`);
    }

    this.#pendingSockets.delete(ctx.call.id);
    return new TwilioMediaStreamCallHandle({
      socket: pending.socket,
      callId: ctx.call.id,
      sessionId,
    });
  }

  attachWebSocket(socket: TwilioMediaStreamSocket, callId: CallId, sessionId: SessionId): void {
    this.#pendingSockets.set(callId, { socket, sessionId });
  }

  async acceptWebSocket(
    socket: TwilioMediaStreamSocket,
    callId: CallId,
    sessionId: SessionId,
  ): Promise<TwilioMediaStreamCallHandle> {
    return new TwilioMediaStreamCallHandle({ socket, callId, sessionId });
  }

  async hangup(_callId: CallId): Promise<void> {
    return;
  }
}

export function createTwilioMediaStreamsProvider(): TwilioMediaStreamsProvider {
  return new TwilioMediaStreamsProvider();
}

function numericSequence(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertTwilioBoundaryFormat(format: AudioFormat): void {
  assertPcm16leFormat(format);
  if (!sameAudioFormat(format, PCM16_16K_MONO)) {
    throw new Error(
      `Twilio adapter boundary requires 16kHz PCM mono, received ${format.sampleRateHz}Hz`,
    );
  }
}
