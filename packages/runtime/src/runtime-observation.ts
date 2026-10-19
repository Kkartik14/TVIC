import type {
  ActiveSession,
  Clock,
  RuntimeObservation,
  RuntimeObservationInput,
  RuntimeObservationName,
  RuntimePipelineObservationInput,
  RuntimeObservationSink,
  RuntimeObservationStats,
  RuntimeObservationValue,
  SessionId,
  TerminalTurn,
  TerminalSession,
} from "@tvic/core";
import {
  InvalidArgumentError,
  RUNTIME_OBSERVATION_NAMES,
  RUNTIME_OBSERVATION_SCHEMA_VERSION,
} from "@tvic/core";

const DEFAULT_QUEUE_CAPACITY = 256;
const MAX_QUEUE_CAPACITY = 4_096;
const MAX_ATTRIBUTE_STRING_LENGTH = 128;
const MAX_ATTRIBUTE_NUMBER = 1_000_000_000_000;
const MAX_PENDING_DROP_SESSIONS = 1_024;
const MAX_DETACHED_SESSIONS = 1_024;
const DRAIN_BATCH_SIZE = 32;
const DRAIN_TASK_BUDGET_MS = 25; // Yield before repeated sub-200ms sink calls exceed the latency budget.
const SINK_BUDGET_MS = 200;
const SINK_COOLDOWN_MS = 1_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ERROR_CATEGORIES = new Set([
  "validation",
  "auth",
  "provider",
  "network",
  "timeout",
  "rate_limit",
  "cancelled",
  "interrupted",
  "tool",
  "media",
  "internal",
]);
const TERMINAL_SOURCES = new Set([
  "operator_stop",
  "caller_abort",
  "run_timeout",
  "remote_transport",
  "provider_runtime",
  "normal_completion",
  "runtime_recovery",
  "runtime_shutdown",
  "legacy_unknown",
]);
const CANCEL_REASONS = new Set([
  "caller_hangup",
  "transport_lost",
  "recovery_expired",
  "operator_requested",
  "shutdown",
  "barge_in",
  "dtmf",
  "explicit",
  "timeout",
  "not_heard",
  "lease_lost",
  "runtime_restarted",
]);
const INTERRUPTION_CAUSES = new Set(["barge_in", "dtmf", "explicit", "timeout"]);
const CHANNELS = new Set(["phone", "web_audio", "simulated"]);
const DROP_REASONS = new Set(["queue_overflow", "pending_session_limit"]);

const ALLOWED_ATTRIBUTES: Readonly<Record<RuntimeObservationName, ReadonlySet<string>>> = {
  [RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED]: new Set([
    "drop_reason",
    "dropped_count",
    "queue_capacity",
  ]),
  [RUNTIME_OBSERVATION_NAMES.SESSION_END]: new Set([
    "cancel_reason",
    "error_category",
    "error_code",
    "error_retriable",
    "at_ms_estimated",
    "sequence_discontinuity",
    "terminal_source",
    "status",
  ]),
  [RUNTIME_OBSERVATION_NAMES.SESSION_RESUME]: new Set([
    "recovery_gap_ms",
    "sequence_discontinuity",
    "session_elapsed_ms",
  ]),
  [RUNTIME_OBSERVATION_NAMES.SESSION_START]: new Set(["agent_id", "channel"]),
  [RUNTIME_OBSERVATION_NAMES.TURN_END]: new Set([
    "audio_delivered",
    "audio_error_code",
    "at_ms_estimated",
    "cancel_reason",
    "endpoint_ms",
    "error_category",
    "error_code",
    "error_retriable",
    "first_audio_ms",
    "first_token_ms",
    "interruption_tail_ms",
    "listened_ms",
    "recovery_gap_ms",
    "turn_sequence",
    "status",
    "terminal_persisted",
    "text_delivered",
    "tool_ms",
    "total_ms",
  ]),
  [RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION]: new Set(["cause"]),
  [RUNTIME_OBSERVATION_NAMES.TURN_START]: new Set(["endpoint_ms", "listened_ms", "turn_sequence"]),
};

interface PendingDrop {
  atMs: number;
  count: number;
  order: number;
  reason: "queue_overflow" | "pending_session_limit";
  sequence: number;
}

interface QueueEntry {
  observation: RuntimeObservation;
  order: number;
}

/**
 * Owns the realtime observation seam. Producers only append to a bounded
 * queue; the sink is an enqueue-only callback run on a later task and must not
 * perform I/O or block. Drain work yields after a short task budget, and slow
 * sink calls open a circuit breaker. Overflow and sink failures remain inspectable counters.
 */
export class RuntimeObservationCoordinator {
  readonly #sink: RuntimeObservationSink | undefined;
  readonly #capacity: number;
  #epoch: string;
  readonly #queue: QueueEntry[] = [];
  readonly #activeSessions = new Set<SessionId>();
  readonly #nextSequence = new Map<SessionId, number>();
  readonly #lastAtMs = new Map<SessionId, number>();
  readonly #detachedSessions = new Set<SessionId>();
  readonly #evictableDetachedSessions = new Set<SessionId>();
  readonly #retiredSessions = new Set<SessionId>();
  readonly #pendingDrops = new Map<SessionId, PendingDrop>();
  readonly #queuedObservationCounts = new Map<SessionId, number>();
  readonly #sessionEpochs = new Map<SessionId, string>();
  readonly #sessionStarts = new Map<SessionId, number>();
  #nextOrder = 0;
  #drainScheduled = false;
  #draining = false;
  #closed = false;
  #sinkDisabledUntilMs = 0;
  #queueDrops = 0;
  #sinkFailures = 0;
  #sinkDisabledDrops = 0;
  #shutdownDrops = 0;
  #detachedSessionEvictions = 0;

  constructor(
    sink: RuntimeObservationSink | undefined,
    capacity = DEFAULT_QUEUE_CAPACITY,
    epoch = `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > MAX_QUEUE_CAPACITY) {
      throw new InvalidArgumentError(
        `observation queue capacity must be between 1 and ${MAX_QUEUE_CAPACITY}`,
      );
    }
    this.#sink = sink;
    this.#capacity = capacity;
    this.#epoch = epoch;
  }

  record(input: RuntimeObservationInput): void {
    if (!this.#sink) return;
    if (this.#closed) {
      this.#shutdownDrops += 1;
      return;
    }
    if (!this.#activeSessions.has(input.sessionId)) return;
    const order = ++this.#nextOrder;
    const observation = this.#envelope(input, order);
    if (this.#isSinkDisabled()) {
      this.#sinkDisabledDrops += 1;
      return;
    }
    if (this.#queue.length >= this.#capacity) {
      this.#queueDrops += 1;
      const pending = this.#pendingDrops.get(input.sessionId);
      if (pending) {
        // Anchor the aggregate at its latest loss so it cannot overtake an
        // admitted fact that arrived between two drops.
        pending.count += 1;
        pending.atMs = observation.atMs;
        pending.order = order;
        pending.sequence = observation.sequence;
      } else if (this.#pendingDrops.size < MAX_PENDING_DROP_SESSIONS) {
        this.#pendingDrops.set(input.sessionId, {
          atMs: observation.atMs,
          count: 1,
          order,
          reason: "queue_overflow",
          sequence: observation.sequence,
        });
      }
    } else {
      this.#queue.push({ observation, order });
      this.#incrementQueuedObservationCount(input.sessionId);
    }
    this.#scheduleDrain();
  }

  recordPipeline(input: RuntimePipelineObservationInput): void {
    validatePipelineObservation(input);
    this.record(input);
  }

  start(session: Pick<ActiveSession, "id" | "agentId" | "channel">, startedAtMs: number): void {
    if (!this.#sink || this.#closed) return;
    this.#activeSessions.add(session.id);
    this.#detachedSessions.delete(session.id);
    this.#evictableDetachedSessions.delete(session.id);
    this.#retiredSessions.delete(session.id);
    this.#sessionEpochs.set(session.id, this.#epoch);
    this.#sessionStarts.set(session.id, startedAtMs);
    this.record({
      name: RUNTIME_OBSERVATION_NAMES.SESSION_START,
      sessionId: session.id,
      atMs: 0,
      attributes: { agent_id: session.agentId, channel: session.channel },
    });
  }

  resume(sessionId: SessionId, startedAtMs: number, atMs: number, recoveryGapMs: number): void {
    if (!this.#sink || this.#closed) return;
    const sequenceDiscontinuity = !this.#nextSequence.has(sessionId);
    this.#activeSessions.add(sessionId);
    this.#detachedSessions.delete(sessionId);
    this.#evictableDetachedSessions.delete(sessionId);
    this.#retiredSessions.delete(sessionId);
    if (sequenceDiscontinuity || !this.#sessionEpochs.has(sessionId)) {
      this.#sessionEpochs.set(sessionId, this.#resumedSessionEpoch(sessionId));
    }
    this.#sessionStarts.set(sessionId, startedAtMs);
    this.record({
      name: RUNTIME_OBSERVATION_NAMES.SESSION_RESUME,
      sessionId,
      atMs,
      attributes: {
        recovery_gap_ms: recoveryGapMs,
        session_elapsed_ms: atMs,
        ...(sequenceDiscontinuity ? { sequence_discontinuity: true } : {}),
      },
    });
  }

  /** Records a committed recovery transition; attachment readiness is a separate boundary. */
  recordRecovery(
    sessionId: SessionId,
    startedAtMs: number,
    atMs: number,
    recoveryGapMs: number,
    recoveredTurns: readonly TerminalTurn[],
  ): void {
    this.resume(sessionId, startedAtMs, atMs, recoveryGapMs);
    for (const turn of recoveredTurns) {
      this.recordRecoveredTurn(sessionId, turn, atMs, recoveryGapMs);
    }
  }

  recordRecoveredTurn(
    sessionId: SessionId,
    turn: TerminalTurn,
    atMs: number,
    recoveryGapMs: number,
  ): void {
    this.#recordTerminalTurn(sessionId, turn, atMs, { recovery_gap_ms: recoveryGapMs });
  }

  #recordTerminalTurn(
    sessionId: SessionId,
    turn: TerminalTurn,
    atMs: number,
    extraAttributes: Readonly<Record<string, RuntimeObservationValue>> = {},
  ): void {
    const attributes: Record<string, RuntimeObservationValue> = {
      status: turn.status,
      turn_sequence: turn.sequence,
      terminal_persisted: true,
      ...extraAttributes,
    };
    if (turn.latency.listenedMs !== undefined) attributes.listened_ms = turn.latency.listenedMs;
    if (turn.latency.endpointMs !== undefined) attributes.endpoint_ms = turn.latency.endpointMs;
    if (turn.latency.totalMs !== undefined) attributes.total_ms = turn.latency.totalMs;
    if (turn.status === "cancelled") attributes.cancel_reason = turn.reason;
    if (turn.status === "failed") {
      attributes.error_code = turn.error.code;
      attributes.error_category = turn.error.category;
      attributes.error_retriable = turn.error.retriable;
    }
    this.record({
      name: RUNTIME_OBSERVATION_NAMES.TURN_END,
      sessionId,
      turnId: turn.id,
      atMs,
      attributes,
    });
  }

  end(session: TerminalSession, clock: Clock, terminalTurns: readonly TerminalTurn[] = []): void {
    const startedAtMs = this.#sessionStarts.get(session.id);
    if (!this.#sink) return;
    this.#activeSessions.add(session.id);
    this.#detachedSessions.delete(session.id);
    this.#evictableDetachedSessions.delete(session.id);
    const estimatedAtMs = startedAtMs === undefined ? estimateElapsedMs(session) : undefined;
    const atMs =
      startedAtMs === undefined
        ? (estimatedAtMs ?? 0)
        : Math.max(0, clock.monotonicMs() - startedAtMs);
    for (const turn of terminalTurns) {
      this.#recordTerminalTurn(
        session.id,
        turn,
        atMs,
        startedAtMs === undefined ? { at_ms_estimated: true } : {},
      );
    }
    const attributes: Record<string, RuntimeObservationValue> = { status: session.status };
    if (startedAtMs === undefined) {
      attributes.sequence_discontinuity = true;
      attributes.at_ms_estimated = true;
    }
    if (session.status === "cancelled") attributes.cancel_reason = session.cancelReason;
    if (session.status === "failed") {
      attributes.error_code = session.error.code;
      attributes.error_category = session.error.category;
      attributes.error_retriable = session.error.retriable;
    }
    attributes.terminal_source = session.terminalSource ?? "legacy_unknown";
    this.record({
      name: RUNTIME_OBSERVATION_NAMES.SESSION_END,
      sessionId: session.id,
      atMs,
      attributes,
    });
    this.#sessionStarts.delete(session.id);
    this.#activeSessions.delete(session.id);
    this.#detachedSessions.delete(session.id);
    this.#evictableDetachedSessions.delete(session.id);
    this.#retiredSessions.add(session.id);
    this.#cleanupSequence(session.id);
  }

  forget(sessionId: SessionId): void {
    this.#activeSessions.delete(sessionId);
    if (this.#retiredSessions.has(sessionId)) return;
    this.#detachedSessions.add(sessionId);
    this.#retiredSessions.delete(sessionId);
    this.#markDetachedSessionEvictable(sessionId);
    this.#evictDetachedSessions();
  }

  diagnostics(): RuntimeObservationStats {
    return {
      queueDrops: this.#queueDrops,
      sinkFailures: this.#sinkFailures,
      sinkDisabled: this.#isSinkDisabled(),
      sinkDisabledDrops: this.#sinkDisabledDrops,
      shutdownDrops: this.#shutdownDrops,
      detachedSessionEvictions: this.#detachedSessionEvictions,
    };
  }

  flush(timeoutMs = 1_000): Promise<boolean> {
    if (!this.#sink) return Promise.resolve(true);
    this.#scheduleDrain();
    return this.#waitForDrain(timeoutMs);
  }

  async shutdown(timeoutMs = 1_000): Promise<boolean> {
    this.#closed = true;
    if (!this.#sink) return true;
    this.#scheduleDrain();
    const drained = await this.#waitForDrain(timeoutMs);
    if (!drained) {
      this.#shutdownDrops +=
        this.#queue.length +
        [...this.#pendingDrops.values()].reduce((total, drop) => total + drop.count, 0);
      this.#clearQueuedObservations();
      this.#clearPendingDrops();
    }
    this.#activeSessions.clear();
    this.#detachedSessions.clear();
    this.#evictableDetachedSessions.clear();
    this.#nextSequence.clear();
    this.#lastAtMs.clear();
    this.#queuedObservationCounts.clear();
    this.#sessionEpochs.clear();
    this.#retiredSessions.clear();
    this.#sessionStarts.clear();
    return drained;
  }

  #envelope(input: RuntimeObservationInput, order: number): RuntimeObservation {
    const sequence = (this.#nextSequence.get(input.sessionId) ?? 0) + 1;
    this.#nextSequence.set(input.sessionId, sequence);
    const atMs = Math.max(this.#lastAtMs.get(input.sessionId) ?? 0, normalizeAtMs(input.atMs));
    this.#lastAtMs.set(input.sessionId, atMs);
    const epoch = this.#sessionEpochs.get(input.sessionId) ?? this.#epoch;
    return {
      schemaVersion: RUNTIME_OBSERVATION_SCHEMA_VERSION,
      epoch,
      sequence,
      factId: factIdFor(input, epoch, order),
      name: input.name,
      sessionId: input.sessionId,
      atMs,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.attributes ? { attributes: sanitizeAttributes(input.name, input.attributes) } : {}),
    };
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#draining) return;
    this.#drainScheduled = true;
    setTimeout(() => {
      this.#drainScheduled = false;
      this.#drain();
    }, 0);
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      if (this.#isSinkDisabled()) {
        this.#sinkDisabledDrops += this.#queue.length + this.#pendingDropCount();
        this.#clearQueuedObservations();
        this.#clearPendingDrops();
        return;
      }
      let delivered = 0;
      const taskStartedAt = performance.now();
      while (
        delivered < DRAIN_BATCH_SIZE &&
        performance.now() - taskStartedAt < DRAIN_TASK_BUDGET_MS
      ) {
        const next = this.#takeNext();
        if (!next) break;
        this.#deliver(next.observation);
        this.#decrementQueuedObservationCount(next.observation.sessionId);
        delivered += 1;
        this.#cleanupSequence(next.observation.sessionId);
        if (this.#isSinkDisabled()) {
          this.#sinkDisabledDrops += this.#queue.length + this.#pendingDropCount();
          this.#clearQueuedObservations();
          this.#clearPendingDrops();
          break;
        }
      }
    } finally {
      this.#draining = false;
      this.#evictDetachedSessions();
      if (this.#queue.length > 0 || this.#pendingDrops.size > 0) {
        this.#scheduleDrain();
      }
    }
  }

  #deliver(observation: RuntimeObservation): void {
    const startedAt = performance.now();
    try {
      this.#sink?.enqueue(observation);
    } catch {
      this.#sinkFailures += 1;
    } finally {
      const elapsedMs = performance.now() - startedAt;
      this.#sinkDisabledUntilMs =
        elapsedMs >= SINK_BUDGET_MS ? performance.now() + SINK_COOLDOWN_MS : 0;
    }
  }

  #isSinkDisabled(): boolean {
    return performance.now() < this.#sinkDisabledUntilMs;
  }

  async #waitForDrain(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + Math.max(0, timeoutMs);
    while (
      this.#drainScheduled ||
      this.#draining ||
      this.#queue.length > 0 ||
      this.#pendingDrops.size > 0
    ) {
      if (performance.now() >= deadline) return false;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(
          resolve,
          Math.min(10, Math.max(1, deadline - performance.now())),
        );
        timeout.unref?.();
      });
    }
    return true;
  }

  #takeNext(): QueueEntry | undefined {
    const queued = this.#queue[0];
    const pending = this.#nextPendingDrop();
    if (!queued && !pending) return undefined;
    if (!pending || (queued && queued.order <= pending[1].order)) {
      return this.#queue.shift();
    }
    this.#pendingDrops.delete(pending[0]);
    this.#incrementQueuedObservationCount(pending[0]);
    const epoch = this.#sessionEpochs.get(pending[0]) ?? this.#epoch;
    const input = {
      name: RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
      sessionId: pending[0],
      atMs: pending[1].atMs,
    } as const;
    return {
      order: pending[1].order,
      observation: {
        schemaVersion: RUNTIME_OBSERVATION_SCHEMA_VERSION,
        epoch,
        sequence: pending[1].sequence,
        factId: factIdFor(input, epoch, pending[1].order),
        name: RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
        sessionId: pending[0],
        atMs: pending[1].atMs,
        attributes: {
          drop_reason: pending[1].reason,
          dropped_count: pending[1].count,
          queue_capacity: this.#capacity,
        },
      },
    };
  }

  #nextPendingDrop(): [SessionId, PendingDrop] | undefined {
    let first: [SessionId, PendingDrop] | undefined;
    for (const entry of this.#pendingDrops.entries()) {
      if (!first || entry[1].order < first[1].order) first = entry;
    }
    return first;
  }

  #cleanupSequence(sessionId: SessionId): void {
    if (this.#detachedSessions.has(sessionId) || !this.#retiredSessions.has(sessionId)) return;
    if (this.#pendingDrops.has(sessionId) || this.#queuedObservationCounts.has(sessionId)) {
      return;
    }
    this.#retiredSessions.delete(sessionId);
    this.#nextSequence.delete(sessionId);
    this.#lastAtMs.delete(sessionId);
    this.#sessionEpochs.delete(sessionId);
  }

  #evictDetachedSessions(): void {
    while (this.#detachedSessions.size > MAX_DETACHED_SESSIONS) {
      const candidate = this.#evictableDetachedSessions.values().next().value;
      if (!candidate) return;
      this.#evictableDetachedSessions.delete(candidate);
      this.#detachedSessions.delete(candidate);
      this.#sessionStarts.delete(candidate);
      this.#nextSequence.delete(candidate);
      this.#lastAtMs.delete(candidate);
      this.#sessionEpochs.delete(candidate);
      this.#detachedSessionEvictions += 1;
    }
  }

  #incrementQueuedObservationCount(sessionId: SessionId): void {
    this.#queuedObservationCounts.set(
      sessionId,
      (this.#queuedObservationCounts.get(sessionId) ?? 0) + 1,
    );
  }

  #decrementQueuedObservationCount(sessionId: SessionId): void {
    const count = this.#queuedObservationCounts.get(sessionId);
    if (count === undefined) return;
    if (count > 1) {
      this.#queuedObservationCounts.set(sessionId, count - 1);
      return;
    }
    this.#queuedObservationCounts.delete(sessionId);
    this.#markDetachedSessionEvictable(sessionId);
  }

  #markDetachedSessionEvictable(sessionId: SessionId): void {
    if (
      !this.#detachedSessions.has(sessionId) ||
      this.#pendingDrops.has(sessionId) ||
      this.#queuedObservationCounts.has(sessionId)
    ) {
      return;
    }
    this.#evictableDetachedSessions.add(sessionId);
  }

  #clearQueuedObservations(): void {
    const sessionIds = [...this.#queuedObservationCounts.keys()];
    this.#queue.length = 0;
    this.#queuedObservationCounts.clear();
    for (const sessionId of sessionIds) {
      this.#markDetachedSessionEvictable(sessionId);
      this.#cleanupSequence(sessionId);
    }
  }

  #clearPendingDrops(): void {
    const sessionIds = [...this.#pendingDrops.keys()];
    this.#pendingDrops.clear();
    for (const sessionId of sessionIds) {
      this.#markDetachedSessionEvictable(sessionId);
      this.#cleanupSequence(sessionId);
    }
  }

  #resumedSessionEpoch(sessionId: SessionId): string {
    const material = `${this.#epoch}:${this.#detachedSessionEvictions}:${sessionId}`;
    return `${this.#epoch}:reset-${hashPart(material, 2_166_136_261)}-${hashPart(
      material,
      2_654_435_761,
    )}`;
  }

  #pendingDropCount(): number {
    return [...this.#pendingDrops.values()].reduce((total, drop) => total + drop.count, 0);
  }
}

function validatePipelineObservation(
  input: unknown,
): asserts input is RuntimePipelineObservationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidArgumentError("runtime observation input must be an object");
  }
  const value = input as Partial<RuntimePipelineObservationInput> & {
    readonly name?: unknown;
    readonly sessionId?: unknown;
    readonly turnId?: unknown;
    readonly atMs?: unknown;
    readonly attributes?: unknown;
  };
  const validName =
    value.name === RUNTIME_OBSERVATION_NAMES.TURN_START ||
    value.name === RUNTIME_OBSERVATION_NAMES.TURN_END ||
    value.name === RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION;
  if (!validName) {
    throw new InvalidArgumentError("runtime observation name is not pipeline-owned");
  }
  if (!isBoundedIdentifier(value.sessionId)) {
    throw new InvalidArgumentError("runtime observation sessionId must be a bounded identifier");
  }
  if (!isBoundedIdentifier(value.turnId)) {
    throw new InvalidArgumentError("runtime observation turnId must be a bounded identifier");
  }
  if (
    typeof value.atMs !== "number" ||
    !Number.isFinite(value.atMs) ||
    value.atMs < 0 ||
    value.atMs > MAX_ATTRIBUTE_NUMBER
  ) {
    throw new InvalidArgumentError("runtime observation atMs must be a bounded finite number");
  }
  if (
    value.attributes !== undefined &&
    (!value.attributes || typeof value.attributes !== "object" || Array.isArray(value.attributes))
  ) {
    throw new InvalidArgumentError("runtime observation attributes must be an object");
  }
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function estimateElapsedMs(session: TerminalSession): number | undefined {
  const startedAt = Date.parse(session.startedAt);
  const endedAt = Date.parse(session.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
  return Math.min(MAX_ATTRIBUTE_NUMBER, Math.max(0, endedAt - startedAt));
}

function sanitizeAttributes(
  name: RuntimeObservationName,
  attributes: Readonly<Record<string, RuntimeObservationValue>>,
): Readonly<Record<string, RuntimeObservationValue>> {
  const allowed = ALLOWED_ATTRIBUTES[name];
  const sanitized: Record<string, RuntimeObservationValue> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) continue;
    const value = descriptor.value;
    if (typeof value === "string") {
      if (value.length > MAX_ATTRIBUTE_STRING_LENGTH || !isSafeStringAttribute(key, value)) {
        continue;
      }
      sanitized[key] = value;
    } else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= MAX_ATTRIBUTE_NUMBER
    ) {
      sanitized[key] = value;
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function isSafeStringAttribute(key: string, value: string): boolean {
  if (key === "status") return SESSION_STATUSES.has(value);
  if (key === "error_category") return ERROR_CATEGORIES.has(value);
  if (key === "terminal_source") return TERMINAL_SOURCES.has(value);
  if (key === "cancel_reason") return CANCEL_REASONS.has(value);
  if (key === "cause") return INTERRUPTION_CAUSES.has(value);
  if (key === "drop_reason") return DROP_REASONS.has(value);
  if (key === "channel") return CHANNELS.has(value);
  return key === "agent_id" || key === "error_code" || key === "audio_error_code"
    ? SAFE_IDENTIFIER.test(value)
    : false;
}

function normalizeAtMs(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function factIdFor(input: RuntimeObservationInput, epoch: string, order: number): string {
  const subject = input.turnId ? `turn:${input.turnId}` : "session";
  const occurrence =
    input.name === RUNTIME_OBSERVATION_NAMES.SESSION_RESUME ||
    input.name === RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION ||
    input.name === RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED ||
    (input.name === RUNTIME_OBSERVATION_NAMES.TURN_END &&
      input.attributes?.terminal_persisted === false)
      ? `:${epoch}:${order}`
      : "";
  const value = `${input.sessionId}:${subject}:${input.name}${occurrence}`;
  return `tvic-${hashPart(value, 2_166_136_261)}-${hashPart(value, 2_654_435_761)}`;
}

function hashPart(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
