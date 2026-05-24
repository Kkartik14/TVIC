import type { Agent } from "./agent.js";
import type { Call } from "./call.js";
import type { Clock } from "./clock.js";
import type { ChannelKind } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { SessionId, ToolCallId, TraceEventId, TraceId, TurnId } from "./ids.js";
import type { RuntimeLogger } from "./logger.js";
import type { InputMediaEvent } from "./media.js";
import type { Memory } from "./memory.js";
import type { SessionStore, ToolCallStore, TurnStore } from "./dal.js";
import type { TraceExporter } from "./providers/trace-exporter.js";
import type { ActiveSession, Session, TerminalSession } from "./session.js";
import type { ToolCall } from "./tool.js";
import type { TraceEvent, TraceRedactor, TraceStore } from "./trace.js";
import type { TerminalTurn, Turn, TurnInput, TurnLatency, TurnOutput } from "./turn.js";

export interface RuntimeOptions {
  readonly sessionStore?: SessionStore;
  readonly turnStore?: TurnStore;
  readonly toolCallStore?: ToolCallStore;
  readonly traceStore?: TraceStore;
  readonly traceExporters?: readonly TraceExporter[];
  readonly traceRedactor?: TraceRedactor;
  readonly memory?: Memory;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly logger?: RuntimeLogger;
  /**
   * Max pending writes queued per trace sink (the store, and each exporter) before
   * new events are dropped to bound memory (default 10000). Each sink drains its own
   * queue in FIFO order, so a slow sink only ever drops its own newest events.
   */
  readonly traceMaxSinkDepth?: number;
  /** Max ms a flush waits before releasing the caller (default 5000). */
  readonly traceFlushTimeoutMs?: number;
}

export interface StartSessionOptions {
  readonly channel: ChannelKind;
  readonly call?: Call;
  readonly traceId?: TraceId;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Per-session trace exporters wired up before the session's own `session.created`
   * trace is emitted, so a call recorder attached here captures the session start.
   */
  readonly traceExporters?: readonly TraceExporter[];
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
      readonly interruptionRefs?: readonly TraceEventId[];
    }
  | {
      readonly reason: "cancelled";
      readonly cancelReason: string;
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
      readonly interruptionRefs?: readonly TraceEventId[];
    }
  | {
      readonly reason: "failed";
      readonly error: NormalizedError;
      readonly output?: TurnOutput;
      readonly latency?: TurnLatency;
      readonly toolCallIds?: readonly ToolCallId[];
      readonly interruptionRefs?: readonly TraceEventId[];
    };

export interface Subscription {
  close(): void;
}

export type TraceEventHandler = (event: TraceEvent) => void;
export type SessionUpdateHandler = (session: Session) => void;

export interface SessionSnapshot {
  readonly session: Session;
  readonly turns: readonly Turn[];
  readonly toolCalls: readonly ToolCall[];
  readonly traceEvents: readonly TraceEvent[];
}

export interface RuntimeServiceLifecycle {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  readonly isRunning: boolean;
}

export interface Runtime extends RuntimeServiceLifecycle {
  startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession>;
  getSession(id: SessionId): Promise<Session | null>;
  endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession>;
  startTurn(request: StartTurnRequest): Promise<Turn>;
  endTurn(sessionId: SessionId, turnId: TurnId, request: EndTurnRequest): Promise<TerminalTurn>;
  emitTraceEvent(event: TraceEvent): Promise<void>;
  /** Session-relative monotonic offset (ms) — the one clock all artifacts share. */
  sessionClockMs(id: SessionId): number;
  /** Persists a completed tool call (input/output/error) so it is replayable. */
  recordToolCall(toolCall: ToolCall): Promise<void>;
  injectMediaEvent(event: InputMediaEvent): Promise<void>;
  inspectSession(id: SessionId): Promise<SessionSnapshot>;
  onTraceEvent(handler: TraceEventHandler): Subscription;
  onSessionUpdate(handler: SessionUpdateHandler): Subscription;
}
