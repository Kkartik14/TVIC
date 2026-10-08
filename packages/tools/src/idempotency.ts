import { createHash } from "node:crypto";

import type { ToolDefinition, ToolTenant } from "@tvic/core";
import type { ExecuteToolInput } from "./index.js";
import { stableStringifyForPersistence } from "./serialization.js";

const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_CLAIM_SAFETY_MS = 1_000;

export function idempotencyRetentionTtlMs<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): number {
  const ttlMs = tool.idempotency.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  return Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_IDEMPOTENCY_TTL_MS;
}

export function idempotencyClaimTtlMs<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  retentionTtlMs: number,
): number {
  const attempts = tool.retry.maxAttempts;
  const timeoutMs = tool.timeout.timeoutMs;
  const maxDelayMs = tool.retry.maxDelayMs;
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxDelayMs) ||
    maxDelayMs < 0
  ) {
    return Math.max(retentionTtlMs, DEFAULT_IDEMPOTENCY_TTL_MS);
  }
  const executionBudgetMs = timeoutMs * attempts + maxDelayMs * (attempts - 1);
  if (!Number.isSafeInteger(executionBudgetMs)) {
    return Math.max(retentionTtlMs, DEFAULT_IDEMPOTENCY_TTL_MS);
  }
  return Math.max(retentionTtlMs, executionBudgetMs + IDEMPOTENCY_CLAIM_SAFETY_MS);
}

interface LegacyIdempotencyIdentity {
  readonly key: string;
  readonly requestHash: string;
}

export interface ToolIdempotencyIdentity {
  readonly key: string;
  readonly requestHash: string;
}

interface InternalToolIdempotencyIdentity extends ToolIdempotencyIdentity {
  readonly legacy: LegacyIdempotencyIdentity | null;
}

/** @internal Shared by execution and crash recovery to serialize the request once. */
export function idempotencyIdentityFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): ToolIdempotencyIdentity | null {
  const identity = idempotencyIdentityWithLegacyFor(input);
  if (!identity) return null;
  return { key: identity.key, requestHash: identity.requestHash };
}

/** @internal Raw legacy identity is confined to the compatibility lookup path. */
export function idempotencyIdentityWithLegacyFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): InternalToolIdempotencyIdentity | null {
  if (!input.tool.idempotency.enabled) return null;
  const serializedInput = stableStringifyForPersistence(input.input);
  const tenant = tenantRequestIdentity(input.tenant);
  const serializedTenant = stableStringifyForPersistence(tenant);
  const inputDigest = digest(serializedInput);
  const logicalKey = idempotencyLogicalKey(input, serializedInput, inputDigest);
  const requestMaterial =
    `{"input":${serializedInput},"sessionId":${JSON.stringify(String(input.sessionId))},` +
    `"tenant":${serializedTenant},"toolId":${JSON.stringify(String(input.tool.id))},` +
    `"toolVersion":${JSON.stringify(input.tool.version)}}`;
  const requestHash = digest(requestMaterial);
  const legacy =
    input.tool.idempotency.legacyKeyCompatibility === false
      ? null
      : legacyIdempotencyIdentity(input, serializedInput);
  const keyMaterial = stableStringifyForPersistence({
    toolId: String(input.tool.id),
    sessionId: String(input.sessionId),
    logicalKey,
  });
  return {
    key: `tvic:v3:${digest(keyMaterial)}`,
    requestHash,
    legacy,
  };
}

/** @internal Used only to replay durable claims created before session scoping. */
export function legacyIdempotencyForRecovery<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): LegacyIdempotencyIdentity | null {
  if (!input.tool.idempotency.enabled) return null;
  const serializedInput = stableStringifyForPersistence(input.input);
  return legacyIdempotencyIdentity(input, serializedInput);
}

function legacyIdempotencyIdentity<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
  serializedInput: string,
): LegacyIdempotencyIdentity {
  const prefix = `${String(input.tool.id)}@${input.tool.version}:`;
  const logicalKey = idempotencyLogicalKey(input, serializedInput);
  return {
    key: `${prefix}${logicalKey}`,
    requestHash:
      `{"input":${serializedInput},"toolId":${JSON.stringify(String(input.tool.id))},` +
      `"toolVersion":${JSON.stringify(input.tool.version)}}`,
  };
}

function idempotencyLogicalKey<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
  serializedInput: string,
  inputFragment = serializedInput,
): string {
  const policy = input.tool.idempotency;
  return policy.keyTemplate
    ? policy.keyTemplate
        .replaceAll("{sessionId}", String(input.sessionId))
        .replaceAll("{turnId}", String(input.turnId))
        .replaceAll("{toolId}", String(input.tool.id))
        .replaceAll("{toolVersion}", input.tool.version)
        .replaceAll("{input}", inputFragment)
    : inputFragment;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function tenantRequestIdentity(
  tenant: ToolTenant | undefined,
): Readonly<Record<string, unknown>> | null {
  if (!tenant) return null;
  const identity = {
    ...(tenant.userId !== undefined ? { userId: tenant.userId } : {}),
    ...(tenant.organizationId !== undefined ? { organizationId: tenant.organizationId } : {}),
    ...(tenant.workflowId !== undefined ? { workflowId: tenant.workflowId } : {}),
    ...(tenant.scopes !== undefined ? { scopes: [...tenant.scopes].sort() } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : null;
}

export function idempotencyKeyFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): string | null {
  return idempotencyIdentityFor(input)?.key ?? null;
}

/**
 * The request hash paired with idempotencyKeyFor. Keep this beside the key
 * builder so execution and crash recovery cannot silently hash different
 * request shapes.
 */
export function idempotencyRequestHashFor<TInput, TOutput>(
  input: ExecuteToolInput<TInput, TOutput>,
): string {
  return idempotencyIdentityFor(input)?.requestHash ?? "";
}
