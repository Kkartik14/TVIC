import { createMediaEventBuffer, toTraceSafeMediaEvent, type MediaEventBuffer } from "@tvic/media";
import {
  createInMemorySessionStore,
  createInMemoryToolCallStore,
  createInMemoryTraceStore,
  createInMemoryTurnStore,
} from "@tvic/dal";
import {
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
  ToolCall,
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

// A single trace sink's ordered write queue. `chain` is the tail promise events are
// appended to (each write runs only after the previous settles → strict FIFO);
// `depth` counts writes still pending so the queue can be bounded and flushed.
interface SinkChain {
  chain: Promise<void>;
  depth: number;
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
  // Synchronous mirror of each session's monotonic origin, so the session clock
  // can be read (and traces stamped) without an async store hit on the realtime path.
  readonly #sessionStartMs = new Map<SessionId, number>();
  // Synchronous mirror of per-session trace exporters, so the drain resolves them
  // without an async store read.
  readonly #sessionExporters = new Map<SessionId, readonly TraceExporter[]>();
  // One ordered write chain per sink: the store, and each exporter. Within a sink,
  // writes are strictly FIFO (replay-grade ordering — event 2 never commits before
  // event 1). Across sinks the chains are independent, so a slow/stalled store can't
  // block exporters (and vice versa). Each chain is bounded; a flush awaits them.
  readonly #storeChain: SinkChain = { chain: Promise.resolve(), depth: 0 };
  readonly #exporterChains = new Map<TraceExporter, SinkChain>();
  readonly #maxSinkDepth: number;
  readonly #flushTimeoutMs: number;
  #droppedTraces = 0;

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
    this.#maxSinkDepth = options.traceMaxSinkDepth ?? TRACE_MAX_SINK_DEPTH;
    this.#flushTimeoutMs = options.traceFlushTimeoutMs ?? FLUSH_TIMEOUT_MS;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /**
   * Test/diagnostic introspection (not part of the Runtime interface). Used by
   * leak/chaos suites to assert per-call state is released and queues stay bounded.
   */
  debugStats(): {
    readonly activeSessionClocks: number;
    readonly sessionExporters: number;
    readonly exporterChains: number;
    readonly queuedTraces: number;
    readonly droppedTraces: number;
    readonly bufferedMediaEvents: number;
  } {
    const pendingExporterWrites = [...this.#exporterChains.values()].reduce(
      (total, sink) => total + sink.depth,
      0,
    );
    return {
      activeSessionClocks: this.#sessionStartMs.size,
      sessionExporters: this.#sessionExporters.size,
      exporterChains: this.#exporterChains.size,
      queuedTraces: this.#storeChain.depth + pendingExporterWrites,
      droppedTraces: this.#droppedTraces,
      bufferedMediaEvents: this.#mediaEvents.size(),
    };
  }

  async start(): Promise<void> {
    this.#running = true;
  }

  async stop(reason = "runtime.stop"): Promise<void> {
    this.#logger.info("Stopping runtime", { reason });
    this.#running = false;
    // Drain any queued traces before tearing the store down so nothing is lost.
    await this.#flushTraces();
    await this.#traceStore.close();
    const sessionRecords = await this.#sessionStore.list();
    const exporters = new Set<TraceExporter>(this.#traceExporters);
    for (const record of sessionRecords) {
      for (const exporter of record.runtime.traceExporters) {
        exporters.add(exporter);
      }
    }
    // Honor the exporter contract: flush its internal buffer, then close. Each is
    // isolated (one broken exporter can't abort the others) and bounded (a hung
    // flush/close can't wedge shutdown).
    await Promise.all(
      [...exporters].map((exporter) =>
        raceTimeout(
          (async () => {
            try {
              await exporter.flush();
              await exporter.close();
            } catch (error) {
              this.#logger.warn("trace exporter flush/close failed", {
                exporter: exporter.name,
                error,
              });
            }
          })(),
          this.#flushTimeoutMs,
        ).then((timedOut) => {
          if (timedOut) {
            this.#logger.warn("trace exporter flush/close timed out", { exporter: exporter.name });
          }
        }),
      ),
    );
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

    const sessionExporters = [
      ...(agent.providers.traceExporters ?? []),
      ...(options.traceExporters ?? []),
    ];
    this.#sessionStartMs.set(sessionId, startMonotonicMs);
    // Registered before session.created is emitted (sync, so the drain resolves them
    // without a store read), so a per-session exporter here captures session start.
    this.#sessionExporters.set(sessionId, sessionExporters);
    await this.#sessionStore.put({
      session,
      runtime: {
        monotonicStartedAtMs: startMonotonicMs,
        spanId: sessionSpanId,
        correlationId: sessionCorrelationId,
        traceExporters: sessionExporters,
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

    // This session's own per-session exporter chains — the only exporter work endSession
    // must wait on. Runtime-level exporters live on across sessions (drained by stop, not
    // here), and OTHER sessions' chains are none of this teardown's concern. Scoping the
    // flush this way keeps one ended session's hung exporter from taxing the next.
    const sessionExporters = this.#sessionExporters.get(id) ?? [];
    const runtimeLevel = new Set(this.#traceExporters);
    const releasable = sessionExporters.filter((exporter) => !runtimeLevel.has(exporter));
    const sessionChains = releasable
      .map((exporter) => this.#exporterChains.get(exporter))
      .filter((sink): sink is SinkChain => sink !== undefined);

    // Drain this session's queued traces BEFORE dropping its clock/exporters, so the
    // terminal trace is stored and reaches the per-session exporter.
    await this.#flushTraces(sessionChains);
    this.#sessionStartMs.delete(id);
    // Release this session's per-session exporters and their write chains. A per-session
    // chain is removed only once it has actually drained: if the bounded flush returned
    // with writes still pending (a slow/hanging exporter), the chain stays in accounting
    // — visible to debugStats — and self-removes when depth hits zero. No further events
    // route to it (its session is terminal), so the current tail settling means drained.
    for (const exporter of releasable) {
      const sink = this.#exporterChains.get(exporter);
      if (!sink || sink.depth === 0) {
        this.#exporterChains.delete(exporter);
      } else {
        void sink.chain.finally(() => {
          if (sink.depth === 0 && this.#exporterChains.get(exporter) === sink) {
            this.#exporterChains.delete(exporter);
          }
        });
      }
    }
    this.#sessionExporters.delete(id);
    this.#mediaEvents.clearSession(id);
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
    // Never retain raw caller PCM in process memory — keep trace-safe metadata only.
    // Audio is persisted (under consent) by the artifact writer, not here.
    this.#mediaEvents.append(toTraceSafeMediaEvent(stampedEvent));
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

  sessionClockMs(id: SessionId): number {
    const start = this.#sessionStartMs.get(id);
    if (start === undefined) {
      // A silent 0 would corrupt any artifact stamped against it. The session clock
      // is only valid between startSession and endSession.
      throw new Error(`sessionClockMs: no active clock for session ${id} (not started or ended)`);
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
    // The snapshot is built from the stores; exporters are write-only side channels that
    // never feed a read. So drain only the store chain — never block a read on a slow or
    // hung exporter from this or any other session.
    await this.#flushTraces([]);
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

  // Stamps + redacts synchronously, fans out to live handlers, then appends to each
  // sink's own ordered queue. No store/exporter write is awaited here, so trace emission
  // never adds latency to the realtime audio path. (async only so existing
  // `await this.#emit(...)` call sites stay valid — it resolves immediately.)
  async #emit(event: TraceEvent): Promise<void> {
    const stamped = this.#stampTraceEvent(event);
    const prepared = this.#traceRedactor ? this.#traceRedactor(stamped) : stamped;
    if (!prepared) {
      return; // redactor dropped the event entirely
    }

    // Synchronous observers (live subscribers) run first and are isolated.
    for (const handler of this.#traceHandlers) {
      try {
        handler(prepared);
      } catch (error) {
        this.#logger.error("trace handler failed", { error });
      }
    }

    // Each sink (the store, every exporter) gets the event appended to its own FIFO
    // queue. The queues are independent failure domains — a stalled store can't block
    // an exporter — but each is strictly ordered, so a sink never commits event N+1
    // before event N. The per-call artifact writer thus records a replay-grade trace.
    this.#appendToSink(this.#storeChain, "trace store", () => this.#traceStore.append(prepared));
    for (const exporter of this.#exportersFor(prepared.sessionId)) {
      this.#appendToSink(this.#exporterChain(exporter), `exporter ${exporter.name}`, () =>
        exporter.export([prepared]),
      );
    }
  }

  // Appends one write to a sink's ordered chain: it runs only after the prior write
  // for that sink settles (FIFO, no reordering). A failing/slow write is isolated to
  // its own chain; once the chain is saturated, new events are dropped (counted) to
  // bound memory rather than block or grow unbounded.
  #appendToSink(sink: SinkChain, label: string, write: () => Promise<void>): void {
    if (sink.depth >= this.#maxSinkDepth) {
      this.#droppedTraces += 1;
      this.#logger.warn("trace sink saturated; dropped event", {
        sink: label,
        dropped: this.#droppedTraces,
      });
      return;
    }
    sink.depth += 1;
    sink.chain = sink.chain
      .then(write)
      .catch((error) => {
        this.#droppedTraces += 1;
        this.#logger.warn("trace sink write failed", {
          sink: label,
          error,
          dropped: this.#droppedTraces,
        });
      })
      .finally(() => {
        sink.depth -= 1;
      });
  }

  #exporterChain(exporter: TraceExporter): SinkChain {
    let sink = this.#exporterChains.get(exporter);
    if (!sink) {
      sink = { chain: Promise.resolve(), depth: 0 };
      this.#exporterChains.set(exporter, sink);
    }
    return sink;
  }

  // Awaits the store's ordered queue plus a SCOPED set of exporter queues, so a
  // read/teardown reflects the events it cares about — bounded by the flush budget, so a
  // hanging store/exporter can never wedge inspectSession/endSession/stop. On the
  // deadline the caller is released; the stalled sink's chain keeps draining in the
  // background but can't mutate a closed sink.
  //
  // Scope matters: a read needs only the store; endSession needs only the session it is
  // releasing; stop needs everything. Waiting on UNRELATED chains is the bug to avoid —
  // one ended session's hung exporter must not tax every later flush with the full
  // timeout. `exporterChains` defaults to all (teardown); scoped callers pass their own.
  async #flushTraces(exporterChains?: readonly SinkChain[]): Promise<void> {
    const exporters = exporterChains ?? [...this.#exporterChains.values()];
    const deadline = this.#clock.monotonicMs() + this.#flushTimeoutMs;
    while (this.#clock.monotonicMs() < deadline) {
      const sinks = [this.#storeChain, ...exporters];
      if (sinks.every((sink) => sink.depth === 0)) {
        return; // every in-scope queue drained
      }
      const remaining = deadline - this.#clock.monotonicMs();
      if (
        (await raceTimeout(Promise.allSettled(sinks.map((sink) => sink.chain)), remaining)) === true
      ) {
        this.#logger.warn("trace flush timed out awaiting sinks", {
          pending: sinks.reduce((total, sink) => total + sink.depth, 0),
        });
        return;
      }
    }
  }

  #notifySession(session: Session): void {
    for (const handler of this.#sessionHandlers) {
      try {
        handler(session);
      } catch (error) {
        // A broken session-update observer must not break session lifecycle.
        this.#logger.error("session update handler failed", { error });
      }
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
    // Already stamped to the session clock at the edge (the recorder preserves the
    // provider offset in metadata). Reuse that single stamp so the traced event and
    // the persisted audio share one timestamp.
    if (event.metadata?.providerMonotonicOffsetMs !== undefined) {
      return event;
    }

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

  // Synchronous: stamps from the in-memory session-clock map, never a store read.
  #stampTraceEvent(event: TraceEvent): TraceEvent {
    if (event.type === "session.created" || event.type === "session.started") {
      return event;
    }

    const start = this.#sessionStartMs.get(event.sessionId);
    if (start === undefined) {
      return event; // session ended/unknown — keep the source offset as-is
    }
    const runtimeOffsetMs = monotonicOffsetMs(this.#clock, start);
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

  #exportersFor(sessionId: SessionId): readonly TraceExporter[] {
    const sessionExporters = this.#sessionExporters.get(sessionId);
    if (!sessionExporters || sessionExporters.length === 0) {
      return this.#traceExporters;
    }
    return [...this.#traceExporters, ...sessionExporters];
  }
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new InMemoryRuntime(options);
}

// Per-sink queue ceiling: once a sink's chain has this many writes pending (a stalled
// or slow sink), new events for that sink are dropped — bounding memory without
// reordering or blocking other sinks.
const TRACE_MAX_SINK_DEPTH = 10_000;
// Overall ceiling for a flush before the caller (query/teardown) is released.
const FLUSH_TIMEOUT_MS = 5_000;

/** Resolves false when `promise` settles first, true if `ms` elapses first. */
function raceTimeout(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
