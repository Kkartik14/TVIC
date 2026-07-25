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

/**
 * Turn timing on the session's monotonic clock.
 *
 * Every stage measurement is anchored at the endpoint commit, the moment the runtime
 * decided the participant had finished speaking, rather than at internal turn setup.
 * That anchor is what a caller actually experiences as the start of waiting.
 *
 * `endpointMs` is measured before that anchor and is therefore additive: perceived
 * caller-to-audio delay is `endpointMs + firstAudioMs`. It is usually the largest
 * single contributor, so a report that omits it understates the wait.
 */
export interface TurnLatency {
  /** Participant speech start to endpoint commit. Requires a speech-start signal. */
  readonly listenedMs?: number;
  /** Last immutable final segment to endpoint commit, the endpoint wait itself. */
  readonly endpointMs?: number;
  /** Endpoint commit to the first model token. */
  readonly firstTokenMs?: number;
  /** Endpoint commit to the first audio frame accepted by the transport. */
  readonly firstAudioMs?: number;
  /** Total time spent in tool execution during the turn. */
  readonly toolMs?: number;
  /** Interruption decision to queued output being stopped. */
  readonly interruptionTailMs?: number;
  /** Endpoint commit to terminal turn state. */
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
