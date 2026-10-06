import {
  DEFAULT_DURABLE_RUNTIME_POLICY,
  isTerminalSession,
  type Agent,
  type AgentId,
  type DurableRuntimePolicy,
  type DurableRuntimeStore,
  type Runtime,
  type SessionAttachment,
  type SessionId,
} from "@tvic/core";

const RECOVERY_STOP_DRAIN_TIMEOUT_MS = 5_000;

export interface SessionActivator {
  activate(input: {
    readonly sessionId: SessionId;
    readonly agent: Agent;
    readonly attachment: SessionAttachment;
  }): Promise<void>;
  /** Idempotently undoes partial host registration after failed activation. */
  deactivate?(input: {
    readonly sessionId: SessionId;
    readonly agent: Agent;
    readonly attachment: SessionAttachment;
  }): Promise<void>;
}

export interface SessionRecoveryCoordinatorOptions {
  readonly runtime: Runtime;
  readonly durableStore: DurableRuntimeStore;
  readonly resolveAgent: (agentId: AgentId) => Promise<Agent | null>;
  readonly hasReconnectableTransport: (sessionId: SessionId) => Promise<boolean>;
  readonly activator: SessionActivator;
  /** Logical worker label; the Runtime adds its own incarnation ID to the lease holder. */
  readonly holderId: string;
  readonly policy?: Partial<DurableRuntimePolicy>;
  readonly pageSize?: number;
  readonly nowMs?: () => number;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number }) => void;
  readonly onError?: (error: unknown) => void;
}

export interface RecoveryPollResult {
  readonly candidates: number;
  readonly attached: number;
  readonly failed: number;
}

export class SessionRecoveryCoordinator {
  readonly #options: SessionRecoveryCoordinatorOptions;
  readonly #policy: DurableRuntimePolicy;
  readonly #now: () => number;
  #cursor: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #pollInFlight: Promise<RecoveryPollResult> | undefined;
  #timerObservedPoll: Promise<RecoveryPollResult> | undefined;
  #stopped = false;

  constructor(options: SessionRecoveryCoordinatorOptions) {
    this.#options = options;
    this.#policy = { ...DEFAULT_DURABLE_RUNTIME_POLICY, ...options.policy };
    this.#now = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      this.#timerObservedPoll = observePromiseFailureOnce(
        this.pollOnce(),
        this.#timerObservedPoll,
        (error) => {
          this.#emitMetric("session.recovery.poll_failed", 1);
          reportError(this.#options.onError, error);
        },
      );
    }, this.#policy.recoveryPollMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<boolean> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const inFlight = this.#pollInFlight;
    if (!inFlight) return true;
    return settleWithin(inFlight, RECOVERY_STOP_DRAIN_TIMEOUT_MS);
  }

  pollOnce(): Promise<RecoveryPollResult> {
    if (this.#stopped) {
      return Promise.resolve({ candidates: 0, attached: 0, failed: 0 });
    }
    if (this.#pollInFlight) return this.#pollInFlight;
    const run = this.#pollOnce();
    let tracked: Promise<RecoveryPollResult>;
    tracked = run.finally(() => {
      if (this.#pollInFlight === tracked) this.#pollInFlight = undefined;
    });
    this.#pollInFlight = tracked;
    return tracked;
  }

  async #pollOnce(): Promise<RecoveryPollResult> {
    const page = await this.#options.durableStore.leases.listRecoveryCandidates({
      nowMs: this.#now(),
      limit: this.#options.pageSize ?? 100,
      ...(this.#cursor !== undefined ? { cursor: this.#cursor } : {}),
    });
    if (this.#stopped) return { candidates: 0, attached: 0, failed: 0 };
    this.#cursor = page.nextCursor;
    if (page.candidates.length === 0 && page.nextCursor === undefined) this.#cursor = undefined;
    this.#emitMetric("session.recovery.candidates", page.candidates.length);

    let attached = 0;
    let failed = 0;
    for (const candidate of page.candidates) {
      const { sessionId } = candidate;
      if (this.#stopped) break;
      let attachment: SessionAttachment | undefined;
      try {
        const stored = await this.#options.durableStore.sessions.get(sessionId);
        if (this.#stopped) break;
        if (!stored || isTerminalSession(stored.session)) {
          await this.#options.durableStore.leases.acknowledgeRecoveryCandidate(candidate);
          continue;
        }
        const hasTransport = await this.#options.hasReconnectableTransport(sessionId);
        if (this.#stopped) break;
        if (!hasTransport) {
          this.#emitMetric("session.recovery.no_transport", 1);
          continue;
        }
        const agent = await this.#options.resolveAgent(stored.session.agentId);
        if (this.#stopped) break;
        if (!agent) {
          this.#emitMetric("session.recovery.no_agent", 1);
          continue;
        }
        const startedAtMs = this.#now();
        const activeAttachment = await this.#options.runtime.attachSession(agent, sessionId, {
          holderId: this.#options.holderId,
        });
        attachment = activeAttachment;
        if (this.#stopped) {
          await activeAttachment.detach().catch(() => undefined);
          attachment = undefined;
          break;
        }
        try {
          await this.#options.activator.activate({
            sessionId,
            agent,
            attachment: activeAttachment,
          });
          if (this.#stopped) {
            await this.#deactivate(sessionId, agent, activeAttachment);
            await activeAttachment.detach().catch(() => undefined);
            attachment = undefined;
            break;
          }
          attached += 1;
          this.#emitMetric("session.recovery.attached", 1);
          this.#emitMetric("session.recovery.latency_ms", Math.max(0, this.#now() - startedAtMs));
        } catch (error) {
          await this.#deactivate(sessionId, agent, activeAttachment);
          await activeAttachment.detach().catch(() => undefined);
          attachment = undefined;
          throw error;
        }
      } catch (error) {
        await attachment?.detach().catch(() => undefined);
        failed += 1;
        this.#emitMetric("session.recovery.failed", 1);
        reportError(this.#options.onError, error);
      }
    }
    return { candidates: page.candidates.length, attached, failed };
  }

  async #deactivate(
    sessionId: SessionId,
    agent: Agent,
    attachment: SessionAttachment,
  ): Promise<void> {
    try {
      await this.#options.activator.deactivate?.({ sessionId, agent, attachment });
    } catch (error) {
      reportError(this.#options.onError, error);
    }
  }

  #emitMetric(name: string, value: number): void {
    try {
      this.#options.onMetric?.({ name, value });
    } catch {
      // Metrics are observation only.
    }
  }
}

export interface SessionReaperOptions {
  readonly runtime: Runtime;
  readonly durableStore: DurableRuntimeStore;
  readonly resolveAgent: (agentId: AgentId) => Promise<Agent | null>;
  /** Logical worker label; the Runtime adds its own incarnation ID to the lease holder. */
  readonly holderId: string;
  readonly hasReconnectableTransport: (sessionId: SessionId) => Promise<boolean>;
  readonly policy?: Partial<DurableRuntimePolicy>;
  readonly pageSize?: number;
  readonly nowMs?: () => number;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number }) => void;
  readonly onError?: (error: unknown) => void;
}

export class SessionReaper {
  readonly #options: SessionReaperOptions;
  readonly #policy: DurableRuntimePolicy;
  readonly #now: () => number;
  #cursor: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reapInFlight: Promise<number> | undefined;
  #timerObservedPoll: Promise<number> | undefined;
  #stopped = false;

  constructor(options: SessionReaperOptions) {
    this.#options = options;
    this.#policy = { ...DEFAULT_DURABLE_RUNTIME_POLICY, ...options.policy };
    this.#now = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      this.#timerObservedPoll = observePromiseFailureOnce(
        this.reapOnce(),
        this.#timerObservedPoll,
        (error) => {
          this.#emitMetric("session.reaper.poll_failed", 1);
          reportError(this.#options.onError, error);
        },
      );
    }, this.#policy.recoveryPollMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<boolean> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const inFlight = this.#reapInFlight;
    if (!inFlight) return true;
    return settleWithin(inFlight, RECOVERY_STOP_DRAIN_TIMEOUT_MS);
  }

  reapOnce(): Promise<number> {
    if (this.#stopped) return Promise.resolve(0);
    if (this.#reapInFlight) return this.#reapInFlight;
    const run = this.#reapOnce();
    let tracked: Promise<number>;
    tracked = run.finally(() => {
      if (this.#reapInFlight === tracked) this.#reapInFlight = undefined;
    });
    this.#reapInFlight = tracked;
    return tracked;
  }

  async #reapOnce(): Promise<number> {
    const page = await this.#options.durableStore.leases.listRecoveryCandidates({
      nowMs: this.#now(),
      limit: this.#options.pageSize ?? 100,
      ...(this.#cursor !== undefined ? { cursor: this.#cursor } : {}),
    });
    if (this.#stopped) return 0;
    this.#cursor = page.nextCursor;
    if (page.candidates.length === 0 && page.nextCursor === undefined) this.#cursor = undefined;
    this.#emitMetric("session.reaper.candidates", page.candidates.length);
    let reaped = 0;
    for (const candidate of page.candidates) {
      const { sessionId } = candidate;
      if (this.#stopped) break;
      let attachment: SessionAttachment | null = null;
      try {
        const stored = await this.#options.durableStore.sessions.get(sessionId);
        if (this.#stopped) break;
        if (!stored || isTerminalSession(stored.session)) {
          await this.#options.durableStore.leases.acknowledgeRecoveryCandidate(candidate);
          continue;
        }
        const hasTransport = await this.#options.hasReconnectableTransport(sessionId);
        if (this.#stopped) break;
        if (hasTransport) continue;
        const lastActivity =
          stored.runtime.lastActivityWallAtMs ?? Date.parse(stored.session.createdAt);
        if (
          Number.isFinite(lastActivity) &&
          this.#now() - lastActivity < this.#policy.recoveryGraceMs
        ) {
          continue;
        }
        const agent = await this.#options.resolveAgent(stored.session.agentId);
        if (this.#stopped) break;
        if (!agent) {
          this.#emitMetric("session.reaper.no_agent", 1);
          continue;
        }
        attachment = await this.#options.runtime.attachSession(agent, sessionId, {
          holderId: this.#options.holderId,
        });
        if (this.#stopped) {
          await attachment.detach().catch(() => undefined);
          attachment = null;
          break;
        }
        await this.#options.runtime.endSession(sessionId, {
          reason: "cancelled",
          cancelReason: "recovery_expired",
        });
        await this.#options.durableStore.leases.acknowledgeRecoveryCandidate({
          sessionId,
          fence: attachment.lease?.fence ?? candidate.fence,
          generationId: attachment.lease?.generationId ?? candidate.generationId,
        });
        reaped += 1;
        this.#emitMetric("session.reaper.terminalized", 1);
      } catch (error) {
        await attachment?.detach().catch(() => undefined);
        this.#emitMetric("session.reaper.failed", 1);
        reportError(this.#options.onError, error);
      }
    }
    return reaped;
  }

  #emitMetric(name: string, value: number): void {
    try {
      this.#options.onMetric?.({ name, value });
    } catch {
      // Metrics are observation only.
    }
  }
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // Error handlers are observation only.
  }
}

function observePromiseFailureOnce<T>(
  promise: Promise<T>,
  previouslyObserved: Promise<T> | undefined,
  onFailure: (error: unknown) => void,
): Promise<T> {
  if (promise !== previouslyObserved) void promise.catch(onFailure);
  return promise;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
