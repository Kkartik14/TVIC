import type { MediaEventId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { NormalizedError } from "./errors.js";
import type { Timestamp } from "./timestamp.js";

export type TurnCancellationReason =
  | "barge_in"
  | "dtmf"
  | "explicit"
  | "timeout"
  | "not_heard"
  | "transport_lost"
  | "lease_lost"
  | "runtime_restarted";

export type TurnStatus =
  | "started"
  | "listening"
  | "thinking"
  | "calling_tool"
  | "speaking"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed";

export interface TurnInput {
  readonly transcript?: string;
  readonly mediaEventIds: readonly MediaEventId[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TurnOutput {
  readonly text?: string;
  readonly mediaEventIds: readonly MediaEventId[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly delivery?: TurnOutputDelivery;
}

export type AudioOutputDeliveryStatus =
  | "not_attempted"
  | "not_accepted"
  | "partially_accepted"
  | "transport_accepted"
  | "playout_confirmed"
  | "playout_unconfirmed";

export type TextOutputDeliveryStatus = "not_attempted" | "not_accepted" | "transport_accepted";

export interface TurnOutputDelivery {
  readonly audio: AudioOutputDeliveryStatus;
  readonly text: TextOutputDeliveryStatus;
}

export interface TurnLatency {
  readonly listenedMs?: number;
  readonly endpointMs?: number;
  readonly firstTokenMs?: number;
  readonly firstAudioMs?: number;
  readonly toolMs?: number;
  readonly interruptionTailMs?: number;
  readonly totalMs?: number;
  readonly recoveryGapMs?: number;
}

interface TurnBase {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly input: TurnInput;
  readonly output: TurnOutput;
  readonly toolCallIds: readonly ToolCallId[];
  readonly startedAt: Timestamp;
  readonly latency: TurnLatency;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActiveTurn extends TurnBase {
  readonly status:
    | "started"
    | "listening"
    | "thinking"
    | "calling_tool"
    | "speaking"
    | "interrupted";
}

export interface CompletedTurn extends TurnBase {
  readonly status: "completed";
  readonly endedAt: Timestamp;
}

export interface CancelledTurn extends TurnBase {
  readonly status: "cancelled";
  readonly endedAt: Timestamp;
  readonly reason: TurnCancellationReason;
}

export interface FailedTurn extends TurnBase {
  readonly status: "failed";
  readonly endedAt: Timestamp;
  readonly error: NormalizedError;
}

export type TerminalTurn = CompletedTurn | CancelledTurn | FailedTurn;

export type Turn = ActiveTurn | TerminalTurn;
