import type { AudioFormat } from "./audio.js";
import type { CallDirection } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { CallId, SessionId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

export type CallStatus =
  | "created"
  | "ringing"
  | "connected"
  | "active"
  | "held"
  | "ended"
  | "failed";

/** Transports TVIC 1.0 can execute. SIP/WebRTC return alongside native topologies. */
export type MediaTransportKind = "websocket";

export interface MediaTransport {
  readonly kind: MediaTransportKind;
  readonly format: AudioFormat;
  readonly remoteEndpoint?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface CallBase {
  readonly id: CallId;
  readonly provider: string;
  readonly direction: CallDirection;
  readonly from: string;
  readonly to: string;
  readonly sessionId?: SessionId;
  readonly mediaTransport: MediaTransport;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: Timestamp;
}

export interface CreatedCall extends CallBase {
  readonly status: "created";
}

export interface RingingCall extends CallBase {
  readonly status: "ringing";
}

export interface ConnectedCall extends CallBase {
  readonly status: "connected" | "active" | "held";
  readonly startedAt: Timestamp;
}

export interface EndedCall extends CallBase {
  readonly status: "ended";
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
}

export interface FailedCall extends CallBase {
  readonly status: "failed";
  readonly endedAt: Timestamp;
  readonly error: NormalizedError;
  readonly startedAt?: Timestamp;
}

export type Call = CreatedCall | RingingCall | ConnectedCall | EndedCall | FailedCall;
