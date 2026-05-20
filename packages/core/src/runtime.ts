import type { Agent } from "./agent.js";
import type { Call } from "./call.js";
import type { Clock } from "./clock.js";
import type { ChannelKind } from "./direction.js";
import type { NormalizedError } from "./errors.js";
import type { IdGenerator } from "./id-generator.js";
import type { SessionId, TraceId } from "./ids.js";
import type { RuntimeLogger } from "./logger.js";
import type { InputMediaEvent } from "./media.js";
import type { Memory } from "./memory.js";
import type { TraceExporter } from "./providers/trace-exporter.js";
import type { ActiveSession, Session, TerminalSession } from "./session.js";
import type { ToolCall } from "./tool.js";
import type { TraceEvent, TraceStore } from "./trace.js";
import type { Turn } from "./turn.js";

export interface RuntimeOptions {
  readonly traceStore?: TraceStore;
  readonly traceExporters?: readonly TraceExporter[];
  readonly memory?: Memory;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly logger?: RuntimeLogger;
}

export interface StartSessionOptions {
  readonly channel: ChannelKind;
  readonly call?: Call;
  readonly traceId?: TraceId;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EndSessionReason = "completed" | "cancelled" | "failed" | "timeout";

export type EndSessionRequest =
  | { readonly reason: "completed" }
  | { readonly reason: "cancelled"; readonly cancelReason: string }
  | { readonly reason: "failed"; readonly error: NormalizedError }
  | { readonly reason: "timeout"; readonly error: NormalizedError };

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
  injectMediaEvent(event: InputMediaEvent): Promise<void>;
  inspectSession(id: SessionId): Promise<SessionSnapshot>;
  onTraceEvent(handler: TraceEventHandler): Subscription;
  onSessionUpdate(handler: SessionUpdateHandler): Subscription;
}
