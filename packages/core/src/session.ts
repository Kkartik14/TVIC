import type { ChannelKind } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { AgentId, CallId, MemoryEntryId, SessionId, ToolCallId, TurnId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

export type SessionCancellationReason =
  | "caller_hangup"
  | "transport_lost"
  | "recovery_expired"
  | "operator_requested"
  | "shutdown";

export type SessionStatus =
  | "created"
  | "starting"
  | "active"
  | "interrupted"
  | "waiting_for_tool"
  | "ending"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionState {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly currentTurnId?: TurnId;
  readonly pendingToolCallIds: readonly ToolCallId[];
  readonly turnSequence: number;
}

interface SessionBase {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly channel: ChannelKind;
  readonly callId?: CallId;
  /**
   * Reserved for a future durable reference index. The runtime currently
   * leaves this empty; memory adapters and session-end snapshots are the
   * authoritative memory surfaces.
   */
  readonly memoryRefs: readonly MemoryEntryId[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: Timestamp;
  readonly state: SessionState;
}

export interface CreatedSession extends SessionBase {
  readonly status: "created";
}

export interface StartingSession extends SessionBase {
  readonly status: "starting";
}

export interface ActiveSession extends SessionBase {
  readonly status: "active" | "interrupted" | "waiting_for_tool" | "ending";
  readonly startedAt: Timestamp;
}

export type TerminalSessionStatus = "completed" | "failed" | "cancelled";

interface TerminalSessionBase extends SessionBase {
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
}

export interface CompletedSession extends TerminalSessionBase {
  readonly status: "completed";
}

export interface FailedSession extends TerminalSessionBase {
  readonly status: "failed";
  readonly error: NormalizedError;
}

export interface CancelledSession extends TerminalSessionBase {
  readonly status: "cancelled";
  readonly cancelReason: SessionCancellationReason;
}

export type TerminalSession = CompletedSession | FailedSession | CancelledSession;

export type Session = CreatedSession | StartingSession | ActiveSession | TerminalSession;
