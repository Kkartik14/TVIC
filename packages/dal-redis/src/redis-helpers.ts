import { CorruptRecordError } from "@tvic/dal-codec";
import { BackendUnavailableError, DurableError } from "@tvic/core";
import type { SessionId, SessionLease } from "@tvic/core";
import type { RedisClient, RedisStoreOptions } from "./index.js";

export async function readLease(client: RedisClient, key: string): Promise<SessionLease | null> {
  const raw = await client.get(key);
  if (raw === null) return null;
  return parseLease(raw, key);
}

export function parseLease(raw: string, key: string): SessionLease {
  const value = parseObject(raw, key);
  const generationId = value.generationId;
  const fence = parsePersistedInteger(value.fence, 1);
  const acquiredAtMs = parsePersistedInteger(value.acquiredAtMs, 0);
  const renewedAtMs = parsePersistedInteger(value.renewedAtMs, 0);
  const expiresAtMs = parsePersistedInteger(value.expiresAtMs, 0);
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.holder !== "string" ||
    fence === null ||
    (generationId !== undefined &&
      (typeof generationId !== "string" || generationId.length === 0)) ||
    acquiredAtMs === null ||
    renewedAtMs === null ||
    expiresAtMs === null
  ) {
    throw new CorruptRecordError(key, "invalid lease payload");
  }
  return {
    sessionId: value.sessionId as SessionId,
    holder: value.holder,
    fence,
    generationId:
      typeof generationId === "string"
        ? generationId
        : legacyLeaseGenerationId(fence, acquiredAtMs),
    acquiredAtMs,
    renewedAtMs,
    expiresAtMs,
  };
}

export function legacyLeaseGenerationId(fence: number, acquiredAtMs: number): string {
  return `legacy:${fence}:${acquiredAtMs}`;
}

export function parseObject(raw: string, key: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CorruptRecordError(
      key,
      `Corrupt Redis record ${key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CorruptRecordError(key, "expected object");
  }
  return value as Record<string, unknown>;
}

export async function readProjectedSessionIncarnation(
  client: RedisClient,
  key: string,
): Promise<number | null | undefined> {
  const raw = await client.get(key);
  if (raw === null) return undefined;
  const metadata = parseObject(raw, key);
  if (metadata.retired !== undefined && typeof metadata.retired !== "boolean") {
    throw new CorruptRecordError(key, "invalid projected session retirement state");
  }
  if (metadata.retired === true) return null;
  const incarnation = metadata.sessionIncarnation === undefined ? 0 : metadata.sessionIncarnation;
  if (typeof incarnation !== "number" || !Number.isSafeInteger(incarnation) || incarnation < 0) {
    throw new CorruptRecordError(key, "invalid projected session incarnation");
  }
  return incarnation;
}

export function maxRetries(options: RedisStoreOptions): number {
  return Math.max(1, options.maxTransactionRetries ?? 4);
}

export async function redisNowMs(client: RedisClient): Promise<number> {
  const [seconds, micros] = await client.time();
  return Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
}

export async function withRedisBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DurableError) throw error;
    throw new BackendUnavailableError(
      `Redis operation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parsePersistedInteger(value: unknown, minimum: number): number | null {
  if (typeof value === "string" && !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}
