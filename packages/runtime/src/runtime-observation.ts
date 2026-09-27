import type {
  ActiveSession,
  Clock,
  RuntimeObservation,
  RuntimeObservationInput,
  RuntimeObservationName,
  RuntimeObservationSink,
  RuntimeObservationStats,
  RuntimeObservationValue,
  SessionId,
  TerminalTurn,
  TerminalSession,
} from "@tvic/core";
import { RUNTIME_OBSERVATION_NAMES, RUNTIME_OBSERVATION_SCHEMA_VERSION } from "@tvic/core";

const DEFAULT_QUEUE_CAPACITY = 256;
const MAX_ATTRIBUTE_STRING_LENGTH = 128;
const MAX_ATTRIBUTE_NUMBER = 1_000_000_000_000;
const MAX_PENDING_DROP_SESSIONS = 1_024;
const MAX_DETACHED_SESSIONS = 1_024;
const DRAIN_BATCH_SIZE = 32;
const SINK_BUDGET_MS = 200;
const GLOBAL_DROP_SESSION_ID = "runtime-observation" as SessionId;
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
 * perform I/O or block. Overflow and sink failures remain inspectable counters.
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
  readonly #retiredSessions = new Set<SessionId>();
  readonly #pendingDrops = new Map<SessionId, PendingDrop>();
  readonly #sessionStarts = new Map<SessionId, number>();
  #nextOrder = 0;
  #drainScheduled = false;
  #draining = false;
  #closed = false;
  #sinkDisabled = false;
  #globalDrop: PendingDrop | undefined;
  #globalDropSequence = 0;
  #globalLastAtMs = 0;
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
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("observation queue capacity must be a positive safe integer");
    }
    this.#sink = sink;
    this.#capacity = capacity;
    this.#epoch = epoch;
  }

  record(input: RuntimeObservationInput): void {
    if (!this.#sink || this.#closed) return;
    if (!this.#activeSessions.has(input.sessionId)) return;
    if (this.#sinkDisabled) {
      this.#sinkDisabledDrops += 1;
      return;
    }
    const order = ++this.#nextOrder;
    const observation = this.#envelope(input);
    if (this.#queue.length >= this.#capacity) {
      this.#queueDrops += 1;
      const pending = this.#pendingDrops.get(input.sessionId);
      if (pending) {
        pending.count += 1;
      } else if (this.#pendingDrops.size < MAX_PENDING_DROP_SESSIONS) {
        this.#pendingDrops.set(input.sessionId, {
          atMs: observation.atMs,
          count: 1,
          order,
          reason: "queue_overflow",
          sequence: observation.sequence,
        });
      } else {
        const atMs = Math.max(this.#globalLastAtMs, observation.atMs);
        this.#globalLastAtMs = atMs;
        this.#globalDrop = this.#globalDrop
          ? { ...this.#globalDrop, atMs, count: this.#globalDrop.count + 1 }
          : {
              atMs,
              count: 1,
              order,
              reason: "pending_session_limit",
              sequence: ++this.#globalDropSequence,
            };
      }
    } else {
      this.#queue.push({ observation, order });
    }
    this.#scheduleDrain();
  }

  start(session: Pick<ActiveSession, "id" | "agentId" | "channel">, startedAtMs: number): void {
    if (!this.#sink || this.#closed) return;
    this.#activeSessions.add(session.id);
    this.#detachedSessions.delete(session.id);
    this.#retiredSessions.delete(session.id);
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
    this.#retiredSessions.delete(sessionId);
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
    const attributes: Record<string, RuntimeObservationValue> = {
      status: turn.status,
      turn_sequence: turn.sequence,
      terminal_persisted: true,
      recovery_gap_ms: recoveryGapMs,
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

  end(session: TerminalSession, clock: Clock): void {
    const startedAtMs = this.#sessionStarts.get(session.id);
    if (!this.#sink) return;
    this.#activeSessions.add(session.id);
    this.#detachedSessions.delete(session.id);
    const attributes: Record<string, RuntimeObservationValue> = { status: session.status };
    if (startedAtMs === undefined) attributes.sequence_discontinuity = true;
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
      atMs: startedAtMs === undefined ? 0 : Math.max(0, clock.monotonicMs() - startedAtMs),
      attributes,
    });
    this.#sessionStarts.delete(session.id);
    this.#activeSessions.delete(session.id);
    this.#detachedSessions.delete(session.id);
    this.#retiredSessions.add(session.id);
    this.#cleanupSequence(session.id);
  }

  forget(sessionId: SessionId): void {
    this.#activeSessions.delete(sessionId);
    this.#detachedSessions.add(sessionId);
    this.#retiredSessions.delete(sessionId);
    this.#evictDetachedSessions();
  }

  diagnostics(): RuntimeObservationStats {
    return {
      queueDrops: this.#queueDrops,
      sinkFailures: this.#sinkFailures,
      sinkDisabled: this.#sinkDisabled,
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
        [...this.#pendingDrops.values()].reduce((total, drop) => total + drop.count, 0) +
        (this.#globalDrop?.count ?? 0);
      this.#queue.length = 0;
      this.#pendingDrops.clear();
      this.#globalDrop = undefined;
    }
    this.#activeSessions.clear();
    this.#detachedSessions.clear();
    this.#nextSequence.clear();
    this.#lastAtMs.clear();
    this.#retiredSessions.clear();
    this.#sessionStarts.clear();
    return drained;
  }

  #envelope(input: RuntimeObservationInput): RuntimeObservation {
    const sequence = (this.#nextSequence.get(input.sessionId) ?? 0) + 1;
    this.#nextSequence.set(input.sessionId, sequence);
    const atMs = Math.max(this.#lastAtMs.get(input.sessionId) ?? 0, normalizeAtMs(input.atMs));
    this.#lastAtMs.set(input.sessionId, atMs);
    return {
      schemaVersion: RUNTIME_OBSERVATION_SCHEMA_VERSION,
      epoch: this.#epoch,
      sequence,
      factId: factIdFor(input, sequence, this.#epoch),
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
      if (this.#sinkDisabled) {
        this.#sinkDisabledDrops += this.#queue.length + this.#pendingDropCount();
        this.#queue.length = 0;
        this.#pendingDrops.clear();
        this.#globalDrop = undefined;
        return;
      }
      let delivered = 0;
      while (delivered < DRAIN_BATCH_SIZE) {
        const next = this.#takeNext();
        if (!next) break;
        this.#deliver(next.observation);
        delivered += 1;
        this.#cleanupSequence(next.observation.sessionId);
        if (this.#sinkDisabled) {
          this.#sinkDisabledDrops += this.#queue.length + this.#pendingDropCount();
          this.#queue.length = 0;
          this.#pendingDrops.clear();
          this.#globalDrop = undefined;
          break;
        }
      }
    } finally {
      this.#draining = false;
      this.#evictDetachedSessions();
      if (this.#queue.length > 0 || this.#pendingDrops.size > 0 || this.#globalDrop) {
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
      return;
    }
    if (performance.now() - startedAt >= SINK_BUDGET_MS) this.#sinkDisabled = true;
  }

  async #waitForDrain(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + Math.max(0, timeoutMs);
    while (
      this.#drainScheduled ||
      this.#draining ||
      this.#queue.length > 0 ||
      this.#pendingDrops.size > 0 ||
      this.#globalDrop !== undefined
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
    return this.#pendingDrops.size === 0;
  }

  #takeNext(): QueueEntry | undefined {
    const queued = this.#queue[0];
    const pending = this.#nextPendingDrop();
    if (!queued && !pending) return undefined;
    if (!pending || (queued && queued.order <= pending[1].order)) {
      return this.#queue.shift();
    }
    if (pending[0] === GLOBAL_DROP_SESSION_ID) this.#globalDrop = undefined;
    else this.#pendingDrops.delete(pending[0]);
    return {
      order: pending[1].order,
      observation: {
        schemaVersion: RUNTIME_OBSERVATION_SCHEMA_VERSION,
        epoch: this.#epoch,
        sequence: pending[1].sequence,
        factId: factIdFor(
          {
            name: RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED,
            sessionId: pending[0],
            atMs: pending[1].atMs,
          },
          pending[1].sequence,
          this.#epoch,
        ),
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
    let first: [SessionId, PendingDrop] | undefined = this.#globalDrop
      ? [GLOBAL_DROP_SESSION_ID, this.#globalDrop]
      : undefined;
    for (const entry of this.#pendingDrops.entries()) {
      if (!first || entry[1].order < first[1].order) first = entry;
    }
    return first;
  }

  #cleanupSequence(sessionId: SessionId): void {
    if (this.#detachedSessions.has(sessionId) || !this.#retiredSessions.has(sessionId)) return;
    if (
      this.#pendingDrops.has(sessionId) ||
      this.#queue.some((entry) => entry.observation.sessionId === sessionId)
    ) {
      return;
    }
    this.#retiredSessions.delete(sessionId);
    this.#nextSequence.delete(sessionId);
    this.#lastAtMs.delete(sessionId);
  }

  #evictDetachedSessions(): void {
    while (this.#detachedSessions.size > MAX_DETACHED_SESSIONS) {
      const candidate = [...this.#detachedSessions].find(
        (sessionId) =>
          !this.#pendingDrops.has(sessionId) &&
          !this.#queue.some((entry) => entry.observation.sessionId === sessionId),
      );
      if (!candidate) return;
      this.#detachedSessions.delete(candidate);
      this.#sessionStarts.delete(candidate);
      this.#nextSequence.delete(candidate);
      this.#lastAtMs.delete(candidate);
      this.#epoch = `${this.#epoch}:reset-${this.#detachedSessionEvictions + 1}`;
      this.#detachedSessionEvictions += 1;
    }
  }

  #pendingDropCount(): number {
    return (
      [...this.#pendingDrops.values()].reduce((total, drop) => total + drop.count, 0) +
      (this.#globalDrop?.count ?? 0)
    );
  }
}

function sanitizeAttributes(
  name: RuntimeObservationName,
  attributes: Readonly<Record<string, RuntimeObservationValue>>,
): Readonly<Record<string, RuntimeObservationValue>> {
  const allowed = ALLOWED_ATTRIBUTES[name];
  const sanitized: Record<string, RuntimeObservationValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowed?.has(key)) continue;
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

function factIdFor(input: RuntimeObservationInput, sequence: number, epoch: string): string {
  const subject = input.turnId ? `turn:${input.turnId}` : "session";
  const occurrence =
    input.name === RUNTIME_OBSERVATION_NAMES.SESSION_RESUME ||
    input.name === RUNTIME_OBSERVATION_NAMES.TURN_INTERRUPTION
      ? `:${epoch}:${normalizeAtMs(input.atMs)}:${sequence}`
      : input.name === RUNTIME_OBSERVATION_NAMES.OBSERVATION_DROPPED
        ? `:${epoch}:${sequence}`
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
