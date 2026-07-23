import type { MediaEventId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { NormalizedError } from "./errors.js";
import type { Timestamp } from "./timestamp.js";

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
}

export interface TurnLatency {
  readonly listenedMs?: number;
  readonly firstTokenMs?: number;
  readonly firstAudioMs?: number;
  readonly toolMs?: number;
  readonly totalMs?: number;
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
  readonly reason: string;
}

export interface FailedTurn extends TurnBase {
  readonly status: "failed";
  readonly endedAt: Timestamp;
  readonly error: NormalizedError;
}

export type TerminalTurn = CompletedTurn | CancelledTurn | FailedTurn;

export type Turn = ActiveTurn | TerminalTurn;
