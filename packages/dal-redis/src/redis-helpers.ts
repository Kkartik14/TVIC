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
  if (
    typeof value.sessionId !== "string" ||
    typeof value.holder !== "string" ||
    !isPositiveInteger(value.fence) ||
    !isFiniteNumber(value.acquiredAtMs) ||
    !isFiniteNumber(value.renewedAtMs) ||
    !isFiniteNumber(value.expiresAtMs)
  ) {
    throw new CorruptRecordError(key, "invalid lease payload");
  }
  return {
    sessionId: value.sessionId as SessionId,
    holder: value.holder,
    fence: value.fence,
    acquiredAtMs: value.acquiredAtMs,
    renewedAtMs: value.renewedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 1;
}
