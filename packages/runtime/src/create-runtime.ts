import { createMediaEventBuffer, type MediaEventBuffer } from "@tvic/media";
import { createInMemoryTraceStore } from "@tvic/tracing";

import type {
  ActiveSession,
  Agent,
  Clock,
  EndSessionRequest,
  IdGenerator,
  InputMediaEvent,
  NormalizedError,
  Runtime,
  RuntimeLogger,
  RuntimeOptions,
  Session,
  SessionId,
  SessionSnapshot,
  SessionUpdateHandler,
  StartSessionOptions,
  Subscription,
  TerminalSession,
  Timestamp,
  ToolCall,
  TraceEvent,
  TraceEventHandler,
  TraceEventId,
  TraceId,
  Turn,
  CallId,
} from "@tvic/core";

const NOOP_LOGGER: RuntimeLogger = {
  debug() {
    return;
  },
  info() {
    return;
  },
  warn() {
    return;
  },
  error() {
    return;
  },
};

class SystemClock implements Clock {
  readonly #startedAt = performance.now();

  now(): Timestamp {
    return new Date().toISOString() as Timestamp;
  }

  monotonicMs(): number {
    return performance.now() - this.#startedAt;
  }
}

class PrefixIdGenerator implements IdGenerator {
  #next = 1;

  agent() {
    return this.#id("agent") as ReturnType<IdGenerator["agent"]>;
  }

  session() {
    return this.#id("session") as ReturnType<IdGenerator["session"]>;
  }

  call() {
    return this.#id("call") as ReturnType<IdGenerator["call"]>;
  }

  turn() {
    return this.#id("turn") as ReturnType<IdGenerator["turn"]>;
  }

  tool() {
    return this.#id("tool") as ReturnType<IdGenerator["tool"]>;
  }

  toolCall() {
    return this.#id("tool_call") as ReturnType<IdGenerator["toolCall"]>;
  }

  trace() {
    return this.#id("trace") as ReturnType<IdGenerator["trace"]>;
  }

  traceEvent() {
    return this.#id("trace_event") as ReturnType<IdGenerator["traceEvent"]>;
  }

  mediaEvent() {
    return this.#id("media_event") as ReturnType<IdGenerator["mediaEvent"]>;
  }

  memoryEntry() {
    return this.#id("memory_entry") as ReturnType<IdGenerator["memoryEntry"]>;
  }

  payloadRef() {
    return this.#id("payload") as ReturnType<IdGenerator["payloadRef"]>;
  }

  #id(prefix: string): string {
    const id = `${prefix}_${this.#next}`;
    this.#next += 1;
    return id;
  }
}

class RuntimeSubscription implements Subscription {
  readonly #onClose: () => void;

  constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  close(): void {
    this.#onClose();
  }
}

export class InMemoryRuntime implements Runtime {
  readonly #traceStore;
  readonly #traceExporters;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: RuntimeLogger;
  readonly #sessions = new Map<SessionId, Session>();
  readonly #turns = new Map<SessionId, Turn[]>();
  readonly #toolCalls = new Map<SessionId, ToolCall[]>();
  readonly #mediaEvents: MediaEventBuffer;
  readonly #traceHandlers = new Set<TraceEventHandler>();
  readonly #sessionHandlers = new Set<SessionUpdateHandler>();

  #running = false;

  constructor(options: RuntimeOptions = {}) {
    this.#traceStore = options.traceStore ?? createInMemoryTraceStore();
    this.#traceExporters = options.traceExporters ?? [];
    this.#clock = options.clock ?? new SystemClock();
    this.#ids = options.idGenerator ?? new PrefixIdGenerator();
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#mediaEvents = createMediaEventBuffer();
  }

  get isRunning(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    this.#running = true;
  }

  async stop(reason = "runtime.stop"): Promise<void> {
    this.#logger.info("Stopping runtime", { reason });
    this.#running = false;
    await this.#traceStore.close();
    await Promise.all(this.#traceExporters.map((exporter) => exporter.close()));
  }

  async startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession> {
    this.#assertRunning();

    const now = this.#clock.now();
    const session: ActiveSession = {
      id: this.#ids.session(),
      agentId: agent.id,
      status: "active",
      channel: options.channel,
      ...(options.call ? { callId: options.call.id } : {}),
      traceId: options.traceId ?? this.#ids.trace(),
      memoryRefs: [],
      ...(options.metadata ? { metadata: options.metadata } : {}),
      createdAt: now,
      startedAt: now,
      state: {
        variables: options.variables ?? {},
        pendingToolCallIds: [],
        turnSequence: 0,
      },
    };

    this.#sessions.set(session.id, session);
    this.#turns.set(session.id, []);
    this.#toolCalls.set(session.id, []);

    await this.#emit({
      id: this.#ids.traceEvent(),
      traceId: session.traceId,
      sessionId: session.id,
      timestamp: now,
      type: "session.created",
      status: "succeeded",
      agentId: agent.id,
    });
    await this.#emit({
      id: this.#ids.traceEvent(),
      traceId: session.traceId,
      sessionId: session.id,
      timestamp: now,
      type: "session.started",
      status: "succeeded",
    });

    this.#notifySession(session);
    return session;
  }

  async getSession(id: SessionId): Promise<Session | null> {
    return this.#sessions.get(id) ?? null;
  }

  async endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession> {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    if (isTerminalSession(session)) {
      return session;
    }

    const now = this.#clock.now();
    const startedAt = "startedAt" in session ? session.startedAt : now;
    const durationMs = Math.max(0, Date.parse(now) - Date.parse(startedAt));
    const base = {
      id: session.id,
      agentId: session.agentId,
      channel: session.channel,
      ...(session.callId ? { callId: session.callId } : {}),
      traceId: session.traceId,
      memoryRefs: session.memoryRefs,
      ...(session.metadata ? { metadata: session.metadata } : {}),
      createdAt: session.createdAt,
      state: session.state,
      startedAt,
      endedAt: now,
    };

    const terminal = terminalSessionFromRequest(base, request);
    this.#sessions.set(id, terminal);

    await this.#emit(sessionEndTrace(this.#ids.traceEvent(), terminal, request, durationMs));
    this.#notifySession(terminal);
    return terminal;
  }

  async injectMediaEvent(event: InputMediaEvent): Promise<void> {
    this.#assertRunning();

    const session = this.#sessions.get(event.sessionId);
    if (!session) {
      throw new Error(`Session not found for media event: ${event.sessionId}`);
    }

    this.#mediaEvents.append(event);
    const trace = mediaEventTrace(this.#ids.traceEvent(), session.traceId, event);
    if (trace) {
      await this.#emit(trace);
    }
  }

  async inspectSession(id: SessionId): Promise<SessionSnapshot> {
    const session = this.#sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    return {
      session,
      turns: this.#turns.get(id) ?? [],
      toolCalls: this.#toolCalls.get(id) ?? [],
      traceEvents: await this.#traceStore.query({ sessionId: id }),
    };
  }

  onTraceEvent(handler: TraceEventHandler): Subscription {
    this.#traceHandlers.add(handler);
    return new RuntimeSubscription(() => this.#traceHandlers.delete(handler));
  }

  onSessionUpdate(handler: SessionUpdateHandler): Subscription {
    this.#sessionHandlers.add(handler);
    return new RuntimeSubscription(() => this.#sessionHandlers.delete(handler));
  }

  async #emit(event: TraceEvent): Promise<void> {
    await this.#traceStore.append(event);
    for (const handler of this.#traceHandlers) {
      handler(event);
    }
    await Promise.all(this.#traceExporters.map((exporter) => exporter.export([event])));
  }

  #notifySession(session: Session): void {
    for (const handler of this.#sessionHandlers) {
      handler(session);
    }
  }

  #assertRunning(): void {
    if (!this.#running) {
      throw new Error("Runtime is not running");
    }
  }
}

interface TerminalBase {
  readonly id: SessionId;
  readonly agentId: ActiveSession["agentId"];
  readonly channel: ActiveSession["channel"];
  readonly callId?: CallId;
  readonly traceId: TraceId;
  readonly memoryRefs: ActiveSession["memoryRefs"];
  readonly metadata?: NonNullable<ActiveSession["metadata"]>;
  readonly createdAt: Timestamp;
  readonly state: ActiveSession["state"];
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp;
}

function terminalSessionFromRequest(
  base: TerminalBase,
  request: EndSessionRequest,
): TerminalSession {
  switch (request.reason) {
    case "completed":
      return { ...base, status: "completed" };
    case "cancelled":
      return { ...base, status: "cancelled", cancelReason: request.cancelReason };
    case "failed":
      return { ...base, status: "failed", error: request.error };
    case "timeout":
      return { ...base, status: "failed", error: request.error };
  }
}

function sessionEndTrace(
  id: TraceEventId,
  session: TerminalSession,
  request: EndSessionRequest,
  durationMs: number,
): TraceEvent {
  if (session.status === "completed") {
    return {
      id,
      traceId: session.traceId,
      sessionId: session.id,
      timestamp: session.endedAt,
      type: "session.completed",
      status: "succeeded",
      durationMs,
    };
  }

  if (session.status === "cancelled") {
    return {
      id,
      traceId: session.traceId,
      sessionId: session.id,
      timestamp: session.endedAt,
      type: "session.cancelled",
      status: "cancelled",
      durationMs,
      cancelReason: request.reason === "cancelled" ? request.cancelReason : "cancelled",
    };
  }

  return {
    id,
    traceId: session.traceId,
    sessionId: session.id,
    timestamp: session.endedAt,
    type: "session.failed",
    status: "failed",
    durationMs,
    error: session.error,
  };
}

function mediaEventTrace(
  id: TraceEventId,
  traceId: TraceId,
  event: InputMediaEvent,
): TraceEvent | null {
  switch (event.type) {
    case "media.stream.started":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        timestamp: event.timestamp,
        type: "media.stream.started",
        status: "succeeded",
        direction: "input",
      };
    case "media.stream.ended":
      return event.reason === "error"
        ? {
            id,
            traceId,
            sessionId: event.sessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            timestamp: event.timestamp,
            type: "media.stream.ended",
            status: "failed",
            direction: "input",
            durationMs: event.durationMs,
            error: mediaError("media.stream.error"),
          }
        : {
            id,
            traceId,
            sessionId: event.sessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            timestamp: event.timestamp,
            type: "media.stream.ended",
            status: "succeeded",
            direction: "input",
            durationMs: event.durationMs,
          };
    case "media.audio.chunk":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.timestamp,
        type: "audio.input.chunk",
        status: "in_progress",
        mediaEventId: event.id,
        frameCount: event.audio.frameCount,
        durationMs: event.audio.durationMs,
      };
    case "speech.started":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.timestamp,
        type: "speech.started",
        status: "started",
      };
    case "speech.ended":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.timestamp,
        type: "speech.ended",
        status: "succeeded",
        durationMs: event.durationMs,
      };
    case "barge_in.detected":
      return event.turnId
        ? {
            id,
            traceId,
            sessionId: event.sessionId,
            ...(event.callId ? { callId: event.callId } : {}),
            turnId: event.turnId,
            timestamp: event.timestamp,
            type: "barge_in.detected",
            status: "succeeded",
            confidence: event.confidence,
          }
        : null;
    case "media.error":
      return {
        id,
        traceId,
        sessionId: event.sessionId,
        ...(event.callId ? { callId: event.callId } : {}),
        timestamp: event.timestamp,
        type: "media.stream.ended",
        status: "failed",
        direction: "input",
        durationMs: 0,
        error: event.error,
      };
    case "dtmf.received":
    case "silence.started":
    case "silence.ended":
      return null;
  }
}

function mediaError(code: string): NormalizedError {
  return {
    code,
    category: "media",
    message: code,
    retriable: false,
  };
}

function isTerminalSession(session: Session): session is TerminalSession {
  return (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "cancelled"
  );
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new InMemoryRuntime(options);
}
