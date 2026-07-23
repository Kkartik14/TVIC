import type { Agent } from "./agent.js";
import type { Call } from "./call.js";
import type { Clock } from "./clock.js";
import type { ChannelKind } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { SessionId, ToolCallId, TurnId } from "./ids.js";
import type { SessionStore, ToolCallStore, TurnStore } from "./dal.js";
import type { ActiveSession, Session, TerminalSession } from "./session.js";
import type { ToolCall } from "./tool.js";
import type { TerminalTurn, Turn, TurnInput, TurnLatency, TurnOutput } from "./turn.js";

export interface RuntimeOptions {
  readonly sessionStore?: SessionStore;
  readonly turnStore?: TurnStore;
  readonly toolCallStore?: ToolCallStore;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

export interface StartSessionOptions {
  readonly channel: ChannelKind;
  readonly call?: Call;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EndSessionReason = "completed" | "cancelled" | "failed" | "timeout";

export type EndSessionRequest =
  | { readonly reason: "completed" }
  | { readonly reason: "cancelled"; readonly cancelReason: string }
  | { readonly reason: "failed"; readonly error: NormalizedError }
  | { readonly reason: "timeout"; readonly error: NormalizedError };

export interface StartTurnRequest {
  readonly sessionId: SessionId;
  readonly input?: TurnInput;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EndTurnRequest =
  | {
      readonly reason: "completed";
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
    }
  | {
      readonly reason: "cancelled";
      readonly cancelReason: string;
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
    }
  | {
      readonly reason: "failed";
      readonly error: NormalizedError;
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
    };

export interface SessionSnapshot {
  readonly session: Session;
  readonly turns: readonly Turn[];
  readonly toolCalls: readonly ToolCall[];
}

export interface RuntimeServiceLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

export interface Runtime extends RuntimeServiceLifecycle {
  startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession>;
  getSession(id: SessionId): Promise<Session | null>;
  endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession>;
  startTurn(request: StartTurnRequest): Promise<Turn>;
  endTurn(sessionId: SessionId, turnId: TurnId, request: EndTurnRequest): Promise<TerminalTurn>;
  /** Session-relative monotonic offset used for turn and media timing. */
  sessionClockMs(id: SessionId): number;
  /** Persists a completed tool call as part of runtime session state. */
  recordToolCall(toolCall: ToolCall): Promise<void>;
  inspectSession(id: SessionId): Promise<SessionSnapshot>;
}
