import {
  WEB_CLIENT_AUDIO_ACK_RETENTION_MS,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
  WebClientAudioCallHandle as RuntimeWebClientAudioCallHandle,
  WebClientAudioProvider as RuntimeWebClientAudioProvider,
} from "./web-client-audio-runtime.js";
import type {
  CallHandle,
  CallId,
  InboundMediaEvent,
  OutputMediaEvent,
  ProviderCapabilities,
  SessionId,
  StreamEndReason,
  TelephonyProvider,
  TurnId,
} from "@tvic/core";
import type { ProviderClock } from "./common.js";

export {
  WEB_CLIENT_AUDIO_ACK_RETENTION_MS,
  WEB_CLIENT_AUDIO_CLOSE_CODES,
  WEB_CLIENT_AUDIO_DEFAULTS,
};
export type { ProviderClock };

export interface WebClientAudioSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (data: import("ws").RawData, isBinary: boolean) => void): this;
  on(event: "close", handler: (code: number, reason: Buffer) => void): this;
  on(event: "error", handler: (error: Error) => void): this;
}

export type ConnectionObservabilityEvent =
  | { readonly type: "session_started"; readonly callId: CallId; readonly sessionId: SessionId }
  | {
      readonly type: "session_ended";
      readonly callId: CallId;
      readonly sessionId: SessionId;
      readonly closeCode: number;
      readonly reason: string;
    }
  | { readonly type: "auth_rejected"; readonly reason: string }
  | {
      readonly type: "reconnect_detected";
      readonly sessionRef: string;
      readonly supersedes: string;
    };

export type WebClientAudioConnectionEvent = ConnectionObservabilityEvent;

export interface WebClientAudioCallHandleOptions {
  readonly socket: WebClientAudioSocket;
  readonly callId: CallId;
  readonly sessionId: SessionId;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxSessionDurationMs?: number;
  readonly maxBinaryFrameBytes?: number;
  readonly maxInputBytesPerSecond?: number;
  readonly maxPendingEvents?: number;
  readonly maxInputFramesPerSecond?: number;
  readonly maxPendingAcks?: number;
  readonly expectedMode?: "push_to_talk" | "continuous";
  readonly clock?: ProviderClock;
  readonly nowMs?: () => number;
  readonly onConnectionEvent?: (event: ConnectionObservabilityEvent) => void;
  readonly onClosed?: () => void;
}

export interface WebClientAudioCallHandle extends CallHandle {
  readonly callId: CallId;
  readonly events: AsyncIterable<InboundMediaEvent>;
  send(event: OutputMediaEvent): Promise<boolean>;
  deliverText(turnId: TurnId, sequence: number, text: string): Promise<boolean>;
  clear(): Promise<void>;
  close(reason: StreamEndReason): Promise<void>;
  terminate(code: number, reason: string): void;
  confirmPlayout(markId: string, timeoutMs: number): Promise<boolean>;
}

export const WebClientAudioCallHandle: {
  new (options: WebClientAudioCallHandleOptions): WebClientAudioCallHandle;
} = RuntimeWebClientAudioCallHandle;

export interface WebClientAudioProviderOptions extends Omit<
  WebClientAudioCallHandleOptions,
  "socket" | "callId" | "sessionId" | "onClosed" | "expectedMode"
> {}

export interface WebClientAudioProvider extends TelephonyProvider {
  readonly name: "web-client-audio";
  readonly kind: "telephony";
  readonly version: "0.1.0";
  readonly capabilities: ProviderCapabilities;
  dial(): Promise<CallHandle>;
  accept(ctx: Parameters<TelephonyProvider["accept"]>[0]): Promise<CallHandle>;
  attachWebSocket(socket: WebClientAudioSocket, callId: CallId, sessionId: SessionId): void;
  acceptWebSocket(
    socket: WebClientAudioSocket,
    callId: CallId,
    sessionId: SessionId,
    connectionOptions?: { readonly expectedMode?: "push_to_talk" | "continuous" },
  ): Promise<WebClientAudioCallHandle>;
  hangup(callId: CallId): Promise<void>;
  supersede(callId: CallId): Promise<void>;
}

export const WebClientAudioProvider: {
  new (options?: WebClientAudioProviderOptions): WebClientAudioProvider;
} = RuntimeWebClientAudioProvider;

export function createWebClientAudioProvider(
  options: WebClientAudioProviderOptions = {},
): WebClientAudioProvider {
  return new WebClientAudioProvider(options);
}
