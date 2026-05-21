import { createMediaEventBuffer, type MediaEventBuffer } from "@tvic/media";
import {
  createInMemorySessionStore,
  createInMemoryToolCallStore,
  createInMemoryTraceStore,
  createInMemoryTurnStore,
} from "@tvic/dal";
import {
  emitTraceEvent,
  mediaEventTrace,
  sessionCreatedTrace,
  sessionEndTrace,
  sessionStartedTrace,
  turnEndTrace,
  turnStartedTrace,
} from "@tvic/tracing";

import {
  createDefaultIdGenerator,
  createSystemClock,
  isTerminalSession,
  isTerminalTurn,
  monotonicOffsetMs,
  terminalSessionFromRequest,
  terminalTurnFromRequest,
} from "@tvic/core";
import type {
  ActiveSession,
  ActiveTurn,
  Agent,
  Clock,
  EndSessionRequest,
  EndTurnRequest,
  IdGenerator,
  InputMediaEvent,
  Runtime,
  RuntimeLogger,
  RuntimeOptions,
  Session,
  SessionId,
  SessionSnapshot,
  SessionUpdateHandler,
  StartSessionOptions,
  StartTurnRequest,
  StoredSessionRecord,
  Subscription,
  TerminalSession,
  TerminalTurn,
  TraceEvent,
  TraceEventHandler,
  TraceExporter,
  TraceRedactor,
  TurnId,
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
  readonly #sessionStore;
  readonly #turnStore;
  readonly #toolCallStore;
  readonly #traceExporters;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #logger: RuntimeLogger;
  readonly #traceRedactor: TraceRedactor | undefined;
  readonly #mediaEvents: MediaEventBuffer;
  readonly #traceHandlers = new Set<TraceEventHandler>();
  readonly #sessionHandlers = new Set<SessionUpdateHandler>();

  #running = false;

  constructor(options: RuntimeOptions = {}) {
    this.#traceStore = options.traceStore ?? createInMemoryTraceStore();
    this.#sessionStore = options.sessionStore ?? createInMemorySessionStore();
    this.#turnStore = options.turnStore ?? createInMemoryTurnStore();
    this.#toolCallStore = options.toolCallStore ?? createInMemoryToolCallStore();
    this.#traceExporters = options.traceExporters ?? [];
    this.#clock = options.clock ?? createSystemClock();
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#traceRedactor = options.traceRedactor;
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
    const sessionRecords = await this.#sessionStore.list();
    const exporters = new Set<TraceExporter>(this.#traceExporters);
    for (const record of sessionRecords) {
      for (const exporter of record.runtime.traceExporters) {
        exporters.add(exporter);
      }
    }
    await Promise.all([...exporters].map((exporter) => exporter.close()));
    await Promise.all([
      this.#sessionStore.close(),
      this.#turnStore.close(),
      this.#toolCallStore.close(),
    ]);
  }

  async startSession(agent: Agent, options: StartSessionOptions): Promise<ActiveSession> {
    this.#assertRunning();

    const startMonotonicMs = this.#clock.monotonicMs();
    const now = this.#clock.now();
    const traceId = options.traceId ?? this.#ids.trace();
    const sessionId = this.#ids.session();
    const sessionSpanId = this.#ids.span();
    const sessionCorrelationId = this.#ids.correlation();
    const session: ActiveSession = {
      id: sessionId,
      agentId: agent.id,
      status: "active",
      channel: options.channel,
      ...(options.call ? { callId: options.call.id } : {}),
      traceId,
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

    await this.#sessionStore.put({
      session,
      runtime: {
        monotonicStartedAtMs: startMonotonicMs,
        spanId: sessionSpanId,
        correlationId: sessionCorrelationId,
        traceExporters: agent.providers.traceExporters ?? [],
      },
    });

    await this.#emit(
      sessionCreatedTrace(
        {
          id: this.#ids.traceEvent(),
          traceId: session.traceId,
          sessionId: session.id,
          timestamp: now,
          monotonicOffsetMs: 0,
          spanId: this.#ids.span(),
          correlationId: sessionCorrelationId,
        },
        agent.id,
      ),
    );
    await this.#emit(
      sessionStartedTrace({
        id: this.#ids.traceEvent(),
        traceId: session.traceId,
        sessionId: session.id,
        timestamp: now,
        monotonicOffsetMs: 0,
        spanId: sessionSpanId,
        correlationId: sessionCorrelationId,
      }),
    );

    this.#notifySession(session);
    return session;
  }

  async getSession(id: SessionId): Promise<Session | null> {
    return (await this.#sessionStore.get(id))?.session ?? null;
  }

  async endSession(id: SessionId, request: EndSessionRequest): Promise<TerminalSession> {
    const record = await this.#sessionStore.get(id);
    if (!record) {
      throw new Error(`Session not found: ${id}`);
    }
    const session = record.session;

    if (isTerminalSession(session)) {
      return session;
    }

    const now = this.#clock.now();
    const startedAt = "startedAt" in session ? session.startedAt : now;
    const durationMs = this.#sessionOffsetMs(record);
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
    await this.#sessionStore.put({ ...record, session: terminal });

    await this.#emit(
      sessionEndTrace(
        this.#ids.traceEvent(),
        terminal,
        request,
        durationMs,
        record.runtime.spanId,
        record.runtime.correlationId,
      ),
    );
    this.#notifySession(terminal);
    return terminal;
  }

  async startTurn(request: StartTurnRequest): Promise<ActiveTurn> {
    this.#assertRunning();

    const sessionRecord = await this.#sessionStore.get(request.sessionId);
    if (!sessionRecord) {
      throw new Error(`Session not found: ${request.sessionId}`);
    }
    const session = sessionRecord.session;
    if (session.status !== "active") {
      throw new Error(`Cannot start turn for ${session.status} session: ${request.sessionId}`);
    }

    const now = this.#clock.now();
    const turnId = this.#ids.turn();
    const spanId = this.#ids.span();
    const correlationId = this.#ids.correlation();
    const sequence = session.state.turnSequence + 1;
    const turn: ActiveTurn = {
      id: turnId,
      sessionId: session.id,
      sequence,
      status: "started",
      input: request.input ?? { mediaEventIds: [] },
      output: { mediaEventIds: [] },
      toolCallIds: [],
      interruptionRefs: [],
      startedAt: now,
      latency: {},
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    await this.#turnStore.put({
      turn,
      runtime: {
        monotonicStartedAtMs: this.#clock.monotonicMs(),
        spanId,
        correlationId,
      },
    });

    const updatedSession: ActiveSession = {
      ...session,
      state: {
        ...session.state,
        turnSequence: sequence,
      },
    };
    await this.#sessionStore.put({ ...sessionRecord, session: updatedSession });

    await this.#emit(
      turnStartedTrace(
        {
          id: this.#ids.traceEvent(),
          traceId: session.traceId,
          sessionId: session.id,
          timestamp: now,
          monotonicOffsetMs: this.#sessionOffsetMs(sessionRecord),
          spanId,
          parentSpanId: sessionRecord.runtime.spanId,
          correlationId,
        },
        turn.id,
        sequence,
      ),
    );
    this.#notifySession(updatedSession);
    return turn;
  }

  async endTurn(
    sessionId: SessionId,
    turnId: TurnId,
    request: EndTurnRequest,
  ): Promise<TerminalTurn> {
    this.#assertRunning();

    const sessionRecord = await this.#sessionStore.get(sessionId);
    if (!sessionRecord) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const session = sessionRecord.session;

    const turnRecord = await this.#turnStore.get(sessionId, turnId);
    if (!turnRecord) {
      throw new Error(`Turn not found: ${turnId}`);
    }
    const turn = turnRecord.turn;
    if (isTerminalTurn(turn)) {
      return turn;
    }

    const now = this.#clock.now();
    const durationMs = this.#durationSince(turnRecord.runtime.monotonicStartedAtMs);
    const terminal = terminalTurnFromRequest(turn, request, now, durationMs);
    await this.#turnStore.update(sessionId, turnId, (current) => ({ ...current, turn: terminal }));

    await this.#emit(
      turnEndTrace(
        {
          id: this.#ids.traceEvent(),
          traceId: session.traceId,
          sessionId,
          timestamp: terminal.endedAt,
          monotonicOffsetMs: this.#sessionOffsetMs(sessionRecord),
          spanId: turnRecord.runtime.spanId,
          parentSpanId: sessionRecord.runtime.spanId,
          correlationId: turnRecord.runtime.correlationId,
        },
        terminal,
        request,
        durationMs,
      ),
    );
    return terminal;
  }

  async injectMediaEvent(event: InputMediaEvent): Promise<void> {
    this.#assertRunning();

    const sessionRecord = await this.#sessionStore.get(event.sessionId);
    if (!sessionRecord) {
      throw new Error(`Session not found for media event: ${event.sessionId}`);
    }

    const stampedEvent = this.#stampMediaEvent(event, sessionRecord);
    this.#mediaEvents.append(stampedEvent);
    const trace = mediaEventTrace(
      this.#ids,
      this.#ids.traceEvent(),
      sessionRecord.session.traceId,
      stampedEvent,
    );
    if (trace) {
      await this.#emit(trace);
    }
  }

  async emitTraceEvent(event: TraceEvent): Promise<void> {
    this.#assertRunning();
    await this.#emit(event);
  }

  async inspectSession(id: SessionId): Promise<SessionSnapshot> {
    const sessionRecord = await this.#sessionStore.get(id);
    if (!sessionRecord) {
      throw new Error(`Session not found: ${id}`);
    }

    return {
      session: sessionRecord.session,
      turns: (await this.#turnStore.listBySession(id)).map((record) => record.turn),
      toolCalls: (await this.#toolCallStore.listBySession(id)).map((record) => record.toolCall),
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
    await emitTraceEvent(event, {
      store: this.#traceStore,
      handlers: this.#traceHandlers,
      exportersFor: (redacted) => this.#exportersFor(redacted.sessionId),
      ...(this.#traceRedactor ? { redactor: this.#traceRedactor } : {}),
      stamp: (source) => this.#stampTraceEvent(source),
    });
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

  #sessionOffsetMs(record: StoredSessionRecord): number {
    return this.#durationSince(record.runtime.monotonicStartedAtMs);
  }

  #durationSince(monotonicStartedAtMs: number): number {
    return monotonicOffsetMs(this.#clock, monotonicStartedAtMs);
  }

  #stampMediaEvent(event: InputMediaEvent, sessionRecord: StoredSessionRecord): InputMediaEvent {
    const runtimeOffsetMs = this.#sessionOffsetMs(sessionRecord);
    if (event.monotonicOffsetMs === runtimeOffsetMs) {
      return event;
    }

    return {
      ...event,
      monotonicOffsetMs: runtimeOffsetMs,
      metadata: {
        ...event.metadata,
        providerMonotonicOffsetMs: event.monotonicOffsetMs,
      },
    };
  }

  async #stampTraceEvent(event: TraceEvent): Promise<TraceEvent> {
    if (event.type === "session.created" || event.type === "session.started") {
      return event;
    }

    const sessionRecord = await this.#sessionStore.get(event.sessionId);
    const runtimeOffsetMs = sessionRecord ? this.#sessionOffsetMs(sessionRecord) : 0;
    if (event.monotonicOffsetMs === runtimeOffsetMs) {
      return event;
    }

    return {
      ...event,
      monotonicOffsetMs: runtimeOffsetMs,
      metadata: {
        ...event.metadata,
        sourceMonotonicOffsetMs: event.monotonicOffsetMs,
      },
    };
  }

  async #exportersFor(sessionId: SessionId): Promise<readonly TraceExporter[]> {
    const exporters = new Set<TraceExporter>(this.#traceExporters);
    const sessionRecord = await this.#sessionStore.get(sessionId);
    for (const exporter of sessionRecord?.runtime.traceExporters ?? []) {
      exporters.add(exporter);
    }
    return [...exporters];
  }
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new InMemoryRuntime(options);
}
