import {
  isTerminalSession,
  normalizeUnknownError,
  validationError,
  type Clock,
  type Memory,
  type MemoryEntry,
  type MemoryRef,
  type OrganizationId,
  type SessionEndEvent,
  type SessionEndMemorySnapshot,
  type SessionId,
  type SessionMemoryFinalization,
  type SessionMetricsRecorder,
  type SessionSnapshot,
  type SessionStore,
  type TerminalSession,
  type UserId,
  type WorkflowId,
} from "@tvic/core";

import { listAllMemoryEntries } from "./memory-loader.js";
import type { RuntimeAttachmentState } from "./runtime-support.js";
import { assertMemoryCapability } from "./memory-capabilities.js";

type MemoryFinalizationPhase = "drain" | "purge";

type Settlement<T> =
  | { readonly status: "settled"; readonly value: T }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed_out" };

export interface SessionEndCoordinatorOptions {
  readonly memory: Memory;
  readonly sessionStore: SessionStore;
  readonly clock: Clock;
  readonly sessionMemoryFinalizeTimeoutMs: number;
  readonly sessionEndHookTimeoutMs: number;
  readonly inspectSession: (id: SessionId) => Promise<SessionSnapshot>;
  readonly onSessionEnd?: (event: SessionEndEvent) => void | Promise<void>;
  readonly sessionMetricsRecorder?: SessionMetricsRecorder;
  readonly emitMetric: (
    name: string,
    value: number,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ) => void;
  readonly recordSessionMetric: (
    name: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

/**
 * Owns the per-session memory admission lane and terminal observation work.
 * Keeping this boundary separate means the runtime facade coordinates durable
 * state while this module coordinates memory ordering and bounded observers.
 */
export class SessionEndCoordinator {
  readonly #memory: Memory;
  readonly #sessionStore: SessionStore;
  readonly #clock: Clock;
  readonly #sessionMemoryFinalizeTimeoutMs: number;
  readonly #sessionEndHookTimeoutMs: number;
  readonly #inspectSession: (id: SessionId) => Promise<SessionSnapshot>;
  readonly #onSessionEnd: ((event: SessionEndEvent) => void | Promise<void>) | undefined;
  readonly #sessionMetricsRecorder: SessionMetricsRecorder | undefined;
  readonly #emitMetric: SessionEndCoordinatorOptions["emitMetric"];
  readonly #recordSessionMetric: SessionEndCoordinatorOptions["recordSessionMetric"];
  readonly #finalizations = new Map<SessionId, Promise<void>>();
  readonly #operationQueues = new Map<SessionId, Promise<unknown>>();
  readonly #admissionClosed = new Set<SessionId>();
  readonly #observations = new Set<SessionId>();
  readonly #memoryFinalizationsPending = new Set<SessionId>();

  constructor(options: SessionEndCoordinatorOptions) {
    this.#memory = options.memory;
    this.#sessionStore = options.sessionStore;
    this.#clock = options.clock;
    this.#sessionMemoryFinalizeTimeoutMs = options.sessionMemoryFinalizeTimeoutMs;
    this.#sessionEndHookTimeoutMs = options.sessionEndHookTimeoutMs;
    this.#inspectSession = options.inspectSession;
    this.#onSessionEnd = options.onSessionEnd;
    this.#sessionMetricsRecorder = options.sessionMetricsRecorder;
    this.#emitMetric = options.emitMetric;
    this.#recordSessionMetric = options.recordSessionMetric;
  }

  open(sessionId: SessionId): void {
    this.#admissionClosed.delete(sessionId);
  }

  closeAdmission(sessionId: SessionId): void {
    this.#admissionClosed.add(sessionId);
  }

  runMemoryOperation<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    if (this.#admissionClosed.has(sessionId)) {
      return Promise.reject(this.#sessionEndedError());
    }
    return this.#enqueue(sessionId, async () => {
      if (!this.#admissionClosed.has(sessionId)) {
        const record = await this.#sessionStore.get(sessionId);
        if (record && isTerminalSession(record.session)) {
          throw this.#sessionEndedError();
        }
      }
      return operation();
    });
  }

  async emit(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    const existing = this.#finalizations.get(session.id);
    if (existing) {
      await existing;
      return;
    }
    const finalization = this.#observe(session, attachment);
    this.#finalizations.set(session.id, finalization);
    try {
      await finalization;
    } finally {
      if (this.#finalizations.get(session.id) === finalization) {
        this.#finalizations.delete(session.id);
      }
    }
  }

  async #observe(
    session: TerminalSession,
    attachment: RuntimeAttachmentState | undefined,
  ): Promise<void> {
    this.#observations.add(session.id);
    try {
      const memoryFinalization = await this.#finalizeMemory(session);
      const finalMemorySnapshot =
        memoryFinalization.status === "timed_out"
          ? {}
          : await this.#captureMemorySnapshot(
              attachment,
              session.metadata,
              this.#sessionMemoryFinalizeTimeoutMs,
            );
      const snapshotResult = await settleWithin(
        Promise.resolve().then(() => this.#inspectSession(session.id)),
        this.#sessionMemoryFinalizeTimeoutMs,
      );
      const snapshot =
        snapshotResult.status === "settled"
          ? snapshotResult.value
          : { session, turns: [], toolCalls: [] };
      const event: SessionEndEvent = {
        session,
        snapshot,
        finalMemorySnapshot,
        memoryFinalization,
        wallClockMs: Date.parse(this.#clock.now()),
      };
      this.#recordSessionMetric("session.end", {
        session_id: session.id,
        status: session.status,
      });
      if (this.#onSessionEnd) {
        const hookResult = await settleWithin(
          Promise.resolve().then(() => this.#onSessionEnd?.(event)),
          this.#sessionEndHookTimeoutMs,
        );
        if (hookResult.status === "timed_out") {
          this.#emitMetric("session.end_hook_timeout", 1, {
            session_id: session.id,
            timeout_ms: this.#sessionEndHookTimeoutMs,
          });
        } else if (hookResult.status === "rejected") {
          this.#emitMetric("session.end_hook_failed", 1, { session_id: session.id });
        }
      }
      try {
        this.#sessionMetricsRecorder?.onSessionEnd?.(event);
      } catch {
        // Metrics are observation only.
      }
    } finally {
      this.#observations.delete(session.id);
      this.#releaseAdmissionIfReady(session.id);
    }
  }

  async #finalizeMemory(session: TerminalSession): Promise<SessionMemoryFinalization> {
    let phase: MemoryFinalizationPhase = "drain";
    this.#memoryFinalizationsPending.add(session.id);
    const operation = this.#enqueue(session.id, async () => {
      if (!shouldDeleteSessionMemory(session.metadata)) {
        return { status: "skipped" } as const;
      }
      phase = "purge";
      assertMemoryCapability(
        this.#memory,
        "purge.perScope",
        "session-scope deletion at session end",
      );
      const deletedEntries = await this.#memory.deleteAll({
        scope: "session",
        sessionId: session.id,
      });
      return { status: "completed", deletedEntries } as const;
    });
    void operation.then(
      () => {
        this.#memoryFinalizationsPending.delete(session.id);
        this.#releaseAdmissionIfReady(session.id);
      },
      () => {
        this.#memoryFinalizationsPending.delete(session.id);
        this.#releaseAdmissionIfReady(session.id);
      },
    );
    const result = await settleWithin(operation, this.#sessionMemoryFinalizeTimeoutMs);
    if (result.status === "timed_out") {
      const outcome: SessionMemoryFinalization = {
        status: "timed_out",
        phase,
        timeoutMs: this.#sessionMemoryFinalizeTimeoutMs,
      };
      this.#reportFinalizationFailure(session.id, outcome);
      return outcome;
    }
    if (result.status === "rejected") {
      const error = normalizeUnknownError(result.error, {
        code: "memory.session_purge_failed",
        category: "provider",
        provider: this.#memory.name,
        retriable: true,
      });
      const outcome: SessionMemoryFinalization = { status: "failed", error };
      this.#reportFinalizationFailure(session.id, outcome);
      return outcome;
    }
    return result.value;
  }

  #reportFinalizationFailure(
    sessionId: SessionId,
    outcome: Extract<SessionMemoryFinalization, { status: "failed" | "timed_out" }>,
  ): void {
    const attributes: Record<string, string | number | boolean> = {
      session_id: sessionId,
      memory_adapter: this.#memory.name,
      failure_reason: outcome.status === "timed_out" ? "timeout" : "error",
      phase: outcome.status === "timed_out" ? outcome.phase : "purge",
    };
    if (outcome.status === "timed_out") attributes.timeout_ms = outcome.timeoutMs;
    this.#emitMetric("memory.session_purge_failed", 1, attributes);
    this.#recordSessionMetric("memory.session_purge_failed", attributes);
  }

  async #captureMemorySnapshot(
    attachment: RuntimeAttachmentState | undefined,
    metadata: Readonly<Record<string, unknown>> | undefined,
    timeoutMs: number,
  ): Promise<SessionEndMemorySnapshot> {
    const memoryUserId =
      attachment?.memoryUserId ?? (metadataString(metadata, "memoryUserId") as UserId | undefined);
    const organizationId =
      attachment?.organizationId ??
      (metadataString(metadata, "organizationId") as OrganizationId | undefined);
    const workflowId =
      attachment?.workflowId ?? (metadataString(metadata, "workflowId") as WorkflowId | undefined);
    const read = async <T>(ref: MemoryRef): Promise<readonly MemoryEntry<T>[]> => {
      const result = await settleWithin(
        listAllMemoryEntries<T>(this.#memory, ref, undefined, 1_000),
        timeoutMs,
      );
      return result.status === "settled" ? result.value : [];
    };
    const [user, organization, workflow] = await Promise.all([
      memoryUserId ? read({ scope: "user", userId: memoryUserId }) : Promise.resolve([]),
      organizationId ? read({ scope: "organization", organizationId }) : Promise.resolve([]),
      workflowId ? read({ scope: "workflow", workflowId }) : Promise.resolve([]),
    ]);
    return {
      ...(memoryUserId
        ? { user: new Map(user.map((entry) => [`${entry.kind}:${entry.key}`, entry])) }
        : {}),
      ...(organizationId
        ? {
            organization: new Map(
              organization.map((entry) => [`${entry.kind}:${entry.key}`, entry]),
            ),
          }
        : {}),
      ...(workflowId
        ? { workflow: new Map(workflow.map((entry) => [`${entry.kind}:${entry.key}`, entry])) }
        : {}),
    };
  }

  #enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#operationQueues.set(sessionId, current);
    void current.then(
      () => this.#clearQueue(sessionId, current),
      () => this.#clearQueue(sessionId, current),
    );
    return current;
  }

  #clearQueue(sessionId: SessionId, operation: Promise<unknown>): void {
    if (this.#operationQueues.get(sessionId) === operation) {
      this.#operationQueues.delete(sessionId);
    }
  }

  #releaseAdmissionIfReady(sessionId: SessionId): void {
    if (this.#observations.has(sessionId) || this.#memoryFinalizationsPending.has(sessionId)) {
      return;
    }
    this.#admissionClosed.delete(sessionId);
  }

  #sessionEndedError() {
    return validationError(
      "memory.session_ended",
      "Memory writes are closed because the session has ended",
    );
  }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Settlement<T>> {
  return new Promise<Settlement<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timed_out" });
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "settled", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "rejected", error });
      },
    );
  });
}

function metadataString(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function shouldDeleteSessionMemory(
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const policy = metadata?.memoryPolicy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return true;
  const values = policy as Record<string, unknown>;
  if (values.enabled === false) return false;
  if (Array.isArray(values.scopes) && !values.scopes.includes("session")) return false;
  return values.deleteSessionScopeOnEnd !== false;
}
