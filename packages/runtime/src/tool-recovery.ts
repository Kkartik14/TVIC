import { internalError, InvalidArgumentError, LeaseUnavailableError } from "@tvic/core";
import type {
  Agent,
  OrganizationId,
  RunningToolCall,
  SessionId,
  StoredToolCallRecord,
  TerminalToolCall,
  Timestamp,
  ToolCall,
  ToolCallId,
  ToolIdempotencyLease,
  ToolIdempotencyRecord,
  ToolIdempotencyStore,
  ToolTenant,
  UserId,
  WorkflowId,
} from "@tvic/core";
import {
  idempotencyIdentityFor,
  quarantineRecoveredToolCall as quarantineIdempotencyClaim,
  stableStringify,
} from "@tvic/tools";
import { finishToolCall } from "./tool-lifecycle.js";
import type { ToolLifecycleContext } from "./tool-lifecycle.js";

export interface PreparedToolRecovery {
  readonly version?: number;
  readonly toolCall: RunningToolCall;
  readonly recoveredAt: Timestamp;
  readonly replayed: TerminalToolCall | null;
}

export interface ToolRecoverySnapshot {
  readonly records: readonly StoredToolCallRecord[];
  readonly prepared: ReadonlyMap<ToolCallId, PreparedToolRecovery>;
}

const MAX_CONCURRENT_TOOL_RECOVERIES = 16;

export function toolTenantForRuntimeIdentity(
  memoryUserId: string | undefined,
  organizationId: string | undefined,
  workflowId: string | undefined,
): ToolTenant | undefined {
  const tenant: ToolTenant = {
    ...(memoryUserId ? { userId: memoryUserId as UserId } : {}),
    ...(organizationId ? { organizationId: organizationId as OrganizationId } : {}),
    ...(workflowId ? { workflowId: workflowId as WorkflowId } : {}),
  };
  return Object.keys(tenant).length > 0 ? tenant : undefined;
}

export async function prepareToolRecovery(
  context: ToolLifecycleContext,
  sessionId: SessionId,
  agent: Agent,
  tenant?: ToolTenant,
  lease?: ToolIdempotencyLease,
): Promise<ToolRecoverySnapshot> {
  const records = await context.toolCallStore.listBySession(sessionId);
  const running = records.filter(
    (record): record is StoredToolCallRecord & { readonly toolCall: RunningToolCall } =>
      record.toolCall.status === "running",
  );
  const prepared: Array<readonly [ToolCallId, PreparedToolRecovery]> = [];
  for (let offset = 0; offset < running.length; offset += MAX_CONCURRENT_TOOL_RECOVERIES) {
    const batch = running.slice(offset, offset + MAX_CONCURRENT_TOOL_RECOVERIES);
    prepared.push(
      ...(await Promise.all(
        batch.map(async (record) => {
          const recoveredAt = context.clock.now();
          return [
            record.toolCall.toolCallId,
            {
              ...(record.version !== undefined ? { version: record.version } : {}),
              toolCall: record.toolCall,
              recoveredAt,
              replayed: await recoverToolCallIdempotency(
                record.toolCall,
                agent,
                context.toolIdempotencyStore,
                recoveredAt,
                tenant,
                lease,
              ),
            },
          ] as const;
        }),
      )),
    );
  }
  return { records, prepared: new Map(prepared) };
}

export function resolvePreparedToolRecovery(
  current: StoredToolCallRecord & { readonly toolCall: RunningToolCall },
  prepared: PreparedToolRecovery | undefined,
  fallbackEndedAt: Timestamp,
): TerminalToolCall {
  const matchingPersistedVersion =
    prepared?.version !== undefined &&
    current.version !== undefined &&
    prepared.version === current.version;
  const matchingUnversionedRecord =
    prepared !== undefined &&
    prepared.version === undefined &&
    current.version === undefined &&
    stableStringify(prepared.toolCall) === stableStringify(current.toolCall);
  if (prepared && (matchingPersistedVersion || matchingUnversionedRecord)) {
    return prepared.replayed ?? ambiguousRecoveredToolCall(current.toolCall, prepared.recoveredAt);
  }
  return ambiguousRecoveredToolCall(current.toolCall, fallbackEndedAt);
}

export async function recoverToolCalls(
  context: ToolLifecycleContext,
  sessionId: SessionId,
): Promise<readonly ToolCall[]> {
  const attachment = context.attachments.get(sessionId);
  let lease = attachment?.lease ?? null;
  let ownsRecoveryLease = false;
  if (attachment && !lease) {
    throw new LeaseUnavailableError(`Session lease unavailable: ${sessionId}`);
  }
  if (!attachment) {
    if (!context.isRunning()) throw new Error("Runtime is not running");
    if (!(await context.sessionStore.get(sessionId))) return [];
    if (!context.isRunning()) throw new Error("Runtime is not running");
    lease =
      (await context.durableStore.leases.acquire(
        sessionId,
        context.leaseHolder(),
        context.leaseTtlMs,
      )) ?? null;
    if (!lease) throw new LeaseUnavailableError(`Session lease unavailable: ${sessionId}`);
    ownsRecoveryLease = true;
  }
  try {
    const records = await context.toolCallStore.listBySession(sessionId);
    if (context.attachments.get(sessionId) !== attachment) {
      throw new LeaseUnavailableError(`Session attachment changed: ${sessionId}`);
    }
    if (!attachment && !context.isRunning()) {
      throw new Error("Runtime is not running");
    }
    if (!attachment && records.some((record) => record.toolCall.status === "running")) {
      throw new InvalidArgumentError(
        `Attach the session with its agent before recovering running tool calls: ${sessionId}`,
      );
    }
    const recovered: ToolCall[] = [];
    const tenant = tenantFromAttachment(attachment);
    for (const record of records) {
      if (record.toolCall.status !== "running") {
        recovered.push(record.toolCall);
        continue;
      }
      const terminal =
        (await recoverToolCallIdempotency(
          record.toolCall,
          attachment?.agent,
          context.toolIdempotencyStore,
          context.clock.now(),
          tenant,
          lease ?? undefined,
        )) ?? ambiguousRecoveredToolCall(record.toolCall, context.clock.now());
      await finishToolCall(context, terminal, lease);
      recovered.push(terminal);
    }
    return recovered;
  } finally {
    if (ownsRecoveryLease && lease) {
      await context.durableStore.leases
        .release(sessionId, lease.holder, lease.fence, lease.generationId)
        .catch(() => undefined);
    }
  }
}

async function recoverToolCallIdempotency(
  toolCall: RunningToolCall,
  agent: Agent | undefined,
  idempotencyStore: ToolIdempotencyStore | undefined,
  endedAt: RunningToolCall["queuedAt"],
  tenant?: ToolTenant,
  lease?: ToolIdempotencyLease,
): Promise<TerminalToolCall | null> {
  const replayed = await replayRecoveredToolCall(
    toolCall,
    agent,
    idempotencyStore,
    endedAt,
    tenant,
    lease,
  );
  if (replayed || !agent || !idempotencyStore || !lease) return replayed;

  const tool = agent.tools.find((candidate) => candidate.id === toolCall.toolId);
  if (!tool) return null;
  const input = {
    tool,
    input: toolCall.input,
    sessionId: toolCall.sessionId,
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    idempotencyStore,
    ...(tenant ? { tenant } : {}),
  };
  let identity: ReturnType<typeof idempotencyIdentityFor>;
  try {
    identity = idempotencyIdentityFor(input);
  } catch {
    return null;
  }
  if (!identity) return null;

  const recoveredError = internalError(
    "tool.runtime_restarted",
    "Tool execution was interrupted by runtime ownership loss",
  );
  const claim = await quarantineIdempotencyClaim(input, lease, recoveredError);
  if (claim?.status !== "succeeded" && claim?.status !== "terminal") return null;
  return recoveredToolCallFromIdempotencyRecord(
    toolCall,
    identity.key,
    tool.version,
    identity.requestHash,
    claim.record,
    endedAt,
  );
}

export async function replayRecoveredToolCall(
  toolCall: RunningToolCall,
  agent: Agent | undefined,
  idempotencyStore: ToolIdempotencyStore | undefined,
  endedAt: RunningToolCall["queuedAt"],
  tenant?: ToolTenant,
  lease?: ToolIdempotencyLease,
): Promise<TerminalToolCall | null> {
  if (!agent || !idempotencyStore) return null;
  const tool = agent.tools.find((candidate) => candidate.id === toolCall.toolId);
  if (!tool) return null;
  const input = {
    tool,
    input: toolCall.input,
    sessionId: toolCall.sessionId,
    turnId: toolCall.turnId,
    toolCallId: toolCall.toolCallId,
    ...(tenant ? { tenant } : {}),
  };
  let identity: ReturnType<typeof idempotencyIdentityFor>;
  try {
    identity = idempotencyIdentityFor(input);
  } catch {
    return null;
  }
  if (!identity) return null;
  const currentKey = identity.key;
  const requestHash = identity.requestHash;
  const lookup = await idempotencyStore.lookup(currentKey, requestHash, toolCall.sessionId, lease);
  if (lookup.status === "found") {
    return recoveredToolCallFromIdempotencyRecord(
      toolCall,
      currentKey,
      tool.version,
      requestHash,
      lookup.record,
      endedAt,
    );
  }
  return null;
}

function recoveredToolCallFromIdempotencyRecord(
  toolCall: RunningToolCall,
  key: string,
  toolVersion: string,
  requestHash: string,
  record: ToolIdempotencyRecord,
  endedAt: RunningToolCall["queuedAt"],
): TerminalToolCall | null {
  if (
    record.sessionId !== toolCall.sessionId ||
    record.toolId !== toolCall.toolId ||
    record.toolVersion !== toolVersion ||
    record.requestHash !== requestHash
  ) {
    return null;
  }
  const metadata = {
    ...(toolCall.metadata ?? {}),
    recovery: "idempotent_replay",
    idempotentHit: true,
  };
  const base = {
    ...toolCall,
    ...(toolCall.idempotencyKey !== undefined ? { idempotencyKey: key } : {}),
    endedAt,
    metadata,
  };
  if (record.status === "succeeded") {
    return { ...base, status: "succeeded", output: record.output };
  }
  if (record.status === "claimed") return null;
  return {
    ...base,
    status: record.status,
    error: {
      ...(record.error ??
        internalError(
          "tool.idempotency_terminal",
          "Tool execution has a persisted terminal idempotency outcome",
        )),
      retriable: false,
    },
  };
}

function tenantFromAttachment(
  attachment:
    | {
        readonly memoryUserId?: UserId;
        readonly organizationId?: OrganizationId;
        readonly workflowId?: WorkflowId;
      }
    | undefined,
): ToolTenant | undefined {
  if (!attachment) return undefined;
  const tenant: ToolTenant = {
    ...(attachment.memoryUserId ? { userId: attachment.memoryUserId } : {}),
    ...(attachment.organizationId ? { organizationId: attachment.organizationId } : {}),
    ...(attachment.workflowId ? { workflowId: attachment.workflowId } : {}),
  };
  return Object.keys(tenant).length > 0 ? tenant : undefined;
}

function ambiguousRecoveredToolCall(
  toolCall: RunningToolCall,
  endedAt: RunningToolCall["queuedAt"],
): TerminalToolCall {
  const { idempotencyKey: _possiblyLegacyKey, ...safeToolCall } = toolCall;
  return {
    ...safeToolCall,
    status: "failed",
    endedAt,
    error: internalError(
      "tool.runtime_restarted",
      "Tool execution was interrupted by runtime ownership loss",
    ),
    metadata: { ...(toolCall.metadata ?? {}), recovery: "ambiguous" },
  };
}
