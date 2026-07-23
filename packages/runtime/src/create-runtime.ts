import {
  createInMemorySessionStore,
  createInMemoryToolCallStore,
  createInMemoryTurnStore,
} from "@tvic/dal";
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
  Runtime,
  RuntimeOptions,
  Session,
  SessionId,
  SessionSnapshot,
  StartSessionOptions,
  StartTurnRequest,
  StoredSessionRecord,
  TerminalSession,
  TerminalTurn,
  ToolCall,
  TurnId,
} from "@tvic/core";

/**
 * The runtime owns execution state only: sessions, turns, tool calls, and the
 * monotonic clocks needed by the realtime loop. Observability is deliberately
 * outside this module so an external system can consume runtime activity without
 * becoming part of the call's critical path.
 */
export class InMemoryRuntime implements Runtime {
  readonly #sessionStore;
  readonly #turnStore;
  readonly #toolCallStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #sessionStartMs = new Map<SessionId, number>();
  #running = false;

  constructor(options: RuntimeOptions = {}) {
    this.#sessionStore = options.sessionStore ?? createInMemorySessionStore();
    this.#turnStore = options.turnStore ?? createInMemoryTurnStore();
    this.#toolCallStore = options.toolCallStore ?? createInMemoryToolCallStore();
    this.#clock = options.clock ?? createSystemClock();
    this.#ids = options.idGenerator ?? createDefaultIdGenerator();
  }

  get isRunning(): boolean {
    return this.#running;
  }

  debugStats(): { readonly activeSessionClocks: number } {
    return { activeSessionClocks: this.#sessionStartMs.size };
  }

  async start(): Promise<void> {
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#sessionStartMs.clear();
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
    const session: ActiveSession = {
      id: this.#ids.session(),
      agentId: agent.id,
      status: "active",
      channel: options.channel,
      ...(options.call ? { callId: options.call.id } : {}),
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

    this.#sessionStartMs.set(session.id, startMonotonicMs);
    await this.#sessionStore.put({
      session,
      runtime: { monotonicStartedAtMs: startMonotonicMs },
    });
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
    if (isTerminalSession(record.session)) {
      return record.session;
    }

    const now = this.#clock.now();
    const session = record.session;
    const terminal = terminalSessionFromRequest(
      {
        id: session.id,
        agentId: session.agentId,
        channel: session.channel,
        ...(session.callId ? { callId: session.callId } : {}),
        memoryRefs: session.memoryRefs,
        ...(session.metadata ? { metadata: session.metadata } : {}),
        createdAt: session.createdAt,
        state: session.state,
        startedAt: "startedAt" in session ? session.startedAt : now,
        endedAt: now,
      },
      request,
    );

    await this.#sessionStore.put({ ...record, session: terminal });
    this.#sessionStartMs.delete(id);
    return terminal;
  }

  async startTurn(request: StartTurnRequest): Promise<ActiveTurn> {
    this.#assertRunning();
    const sessionRecord = await this.#requireSession(request.sessionId);
    const session = sessionRecord.session;
    if (session.status !== "active") {
      throw new Error(`Cannot start turn for ${session.status} session: ${request.sessionId}`);
    }

    const sequence = session.state.turnSequence + 1;
    const turn: ActiveTurn = {
      id: this.#ids.turn(),
      sessionId: session.id,
      sequence,
      status: "started",
      input: request.input ?? { mediaEventIds: [] },
      output: { mediaEventIds: [] },
      toolCallIds: [],
      startedAt: this.#clock.now(),
      latency: {},
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };

    await this.#turnStore.put({
      turn,
      runtime: { monotonicStartedAtMs: this.#clock.monotonicMs() },
    });
    const updatedSession: ActiveSession = {
      ...session,
      state: { ...session.state, turnSequence: sequence },
    };
    await this.#sessionStore.put({ ...sessionRecord, session: updatedSession });
    return turn;
  }

  async endTurn(
    sessionId: SessionId,
    turnId: TurnId,
    request: EndTurnRequest,
  ): Promise<TerminalTurn> {
    this.#assertRunning();
    await this.#requireSession(sessionId);
    const turnRecord = await this.#turnStore.get(sessionId, turnId);
    if (!turnRecord) {
      throw new Error(`Turn not found: ${turnId}`);
    }
    if (isTerminalTurn(turnRecord.turn)) {
      return turnRecord.turn;
    }

    const terminal = terminalTurnFromRequest(
      turnRecord.turn,
      request,
      this.#clock.now(),
      this.#durationSince(turnRecord.runtime.monotonicStartedAtMs),
    );
    await this.#turnStore.update(sessionId, turnId, (current) => ({ ...current, turn: terminal }));
    return terminal;
  }

  sessionClockMs(id: SessionId): number {
    const start = this.#sessionStartMs.get(id);
    if (start === undefined) {
      throw new Error(`sessionClockMs: no active clock for session ${id}`);
    }
    return monotonicOffsetMs(this.#clock, start);
  }

  async recordToolCall(toolCall: ToolCall): Promise<void> {
    await this.#toolCallStore.put({
      toolCall,
      runtime: { monotonicQueuedAtMs: this.sessionClockMs(toolCall.sessionId) },
    });
  }

  async inspectSession(id: SessionId): Promise<SessionSnapshot> {
    const sessionRecord = await this.#requireSession(id);
    return {
      session: sessionRecord.session,
      turns: (await this.#turnStore.listBySession(id)).map((record) => record.turn),
      toolCalls: (await this.#toolCallStore.listBySession(id)).map((record) => record.toolCall),
    };
  }

  async #requireSession(id: SessionId): Promise<StoredSessionRecord> {
    const record = await this.#sessionStore.get(id);
    if (!record) {
      throw new Error(`Session not found: ${id}`);
    }
    return record;
  }

  #assertRunning(): void {
    if (!this.#running) {
      throw new Error("Runtime is not running");
    }
  }

  #durationSince(monotonicStartedAtMs: number): number {
    return monotonicOffsetMs(this.#clock, monotonicStartedAtMs);
  }
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new InMemoryRuntime(options);
}
