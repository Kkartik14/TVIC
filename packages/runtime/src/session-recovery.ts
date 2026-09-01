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

export interface SessionActivator {
  activate(input: {
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
  readonly holderId: string;
  readonly policy?: Partial<DurableRuntimePolicy>;
  readonly pageSize?: number;
  readonly nowMs?: () => number;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number }) => void;
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

  constructor(options: SessionRecoveryCoordinatorOptions) {
    this.#options = options;
    this.#policy = { ...DEFAULT_DURABLE_RUNTIME_POLICY, ...options.policy };
    this.#now = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.#policy.recoveryPollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  pollOnce(): Promise<RecoveryPollResult> {
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
      ...(this.#cursor ? { cursor: this.#cursor } : {}),
    });
    this.#cursor = page.nextCursor;
    if (page.sessionIds.length === 0) this.#cursor = undefined;
    this.#emitMetric("session.recovery.candidates", page.sessionIds.length);

    let attached = 0;
    let failed = 0;
    for (const sessionId of page.sessionIds) {
      try {
        const stored = await this.#options.durableStore.sessions.get(sessionId);
        if (!stored || isTerminalSession(stored.session)) continue;
        if (!(await this.#options.hasReconnectableTransport(sessionId))) {
          this.#emitMetric("session.recovery.no_transport", 1);
          continue;
        }
        const agent = await this.#options.resolveAgent(stored.session.agentId);
        if (!agent) continue;
        const startedAtMs = this.#now();
        const attachment = await this.#options.runtime.attachSession(agent, sessionId, {
          holderId: this.#options.holderId,
        });
        try {
          await this.#options.activator.activate({ sessionId, agent, attachment });
          attached += 1;
          this.#emitMetric("session.recovery.attached", 1);
          this.#emitMetric("session.recovery.latency_ms", Math.max(0, this.#now() - startedAtMs));
        } catch (error) {
          await attachment.detach().catch(() => undefined);
          throw error;
        }
      } catch {
        failed += 1;
        this.#emitMetric("session.recovery.failed", 1);
      }
    }
    return { candidates: page.sessionIds.length, attached, failed };
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
  readonly holderId: string;
  readonly hasReconnectableTransport: (sessionId: SessionId) => Promise<boolean>;
  readonly policy?: Partial<DurableRuntimePolicy>;
  readonly pageSize?: number;
  readonly nowMs?: () => number;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number }) => void;
}

export class SessionReaper {
  readonly #options: SessionReaperOptions;
  readonly #policy: DurableRuntimePolicy;
  readonly #now: () => number;
  #cursor: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #reapInFlight: Promise<number> | undefined;

  constructor(options: SessionReaperOptions) {
    this.#options = options;
    this.#policy = { ...DEFAULT_DURABLE_RUNTIME_POLICY, ...options.policy };
    this.#now = options.nowMs ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.reapOnce().catch(() => undefined);
    }, this.#policy.recoveryPollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  reapOnce(): Promise<number> {
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
      ...(this.#cursor ? { cursor: this.#cursor } : {}),
    });
    this.#cursor = page.nextCursor;
    if (page.sessionIds.length === 0) this.#cursor = undefined;
    this.#emitMetric("session.reaper.candidates", page.sessionIds.length);
    let reaped = 0;
    for (const sessionId of page.sessionIds) {
      const stored = await this.#options.durableStore.sessions.get(sessionId);
      if (!stored || isTerminalSession(stored.session)) continue;
      if (await this.#options.hasReconnectableTransport(sessionId)) continue;
      const lastActivity =
        stored.runtime.lastActivityWallAtMs ?? Date.parse(stored.session.createdAt);
      if (
        Number.isFinite(lastActivity) &&
        this.#now() - lastActivity < this.#policy.recoveryGraceMs
      ) {
        continue;
      }
      const agent = await this.#options.resolveAgent(stored.session.agentId);
      if (!agent) continue;
      let attachment: SessionAttachment | null = null;
      try {
        attachment = await this.#options.runtime.attachSession(agent, sessionId, {
          holderId: this.#options.holderId,
        });
        await this.#options.runtime.endSession(sessionId, {
          reason: "cancelled",
          cancelReason: "recovery_expired",
        });
        reaped += 1;
        this.#emitMetric("session.reaper.terminalized", 1);
      } catch {
        await attachment?.detach().catch(() => undefined);
        this.#emitMetric("session.reaper.failed", 1);
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
