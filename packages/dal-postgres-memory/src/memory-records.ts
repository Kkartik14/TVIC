import { Buffer } from "node:buffer";

import {
  CorruptRecordError,
  InvalidArgumentError,
  MemoryEntryTooLargeError,
  type MemoryCapabilities,
  type MemoryEntry,
  type MemoryEntryId,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRef,
  type OrganizationId,
  type UserId,
  type WorkflowId,
} from "@tvic/core";
import type { SqlClient } from "./postgres-helpers.js";
import { serializeJsonValue, stableStringify } from "@tvic/dal-codec";

const SCOPE_KINDS = ["session", "user", "organization", "workflow"] as const;
type ScopeKind = (typeof SCOPE_KINDS)[number];
const MEMORY_KINDS = [
  "fact",
  "summary",
  "open_item",
  "entity_ref",
  "raw",
  "working_memory",
] as const satisfies readonly MemoryKind[];

export interface MemoryRow extends Record<string, unknown> {
  readonly scope_kind: string;
  readonly scope_id: string;
  readonly kind: string;
  readonly key: string;
  readonly value: unknown;
  readonly version: number | string;
  readonly created_at_ms: number | string;
  readonly updated_at_ms: number | string;
  readonly expires_at_ms: number | string | null;
  readonly memory_user_id: string | null;
  readonly entry_id: string;
  readonly tags: unknown;
  readonly metadata: unknown;
  readonly value_bytes?: number | string;
}

export const POSTGRES_MEMORY_CAPABILITIES: MemoryCapabilities = {
  search: { exact: true, vector: false, hybrid: false },
  write: { explicit: true, implicit: true, sessionQuota: true },
  retention: { ttl: true, policy: false },
  purge: { perEntry: true, perScope: true, tenant: true },
};

export function scopeKindOf(ref: MemoryRef): { kind: ScopeKind; id: string } {
  switch (ref.scope) {
    case "session":
      return { kind: "session", id: String(ref.sessionId) };
    case "user":
      return { kind: "user", id: String(ref.userId) };
    case "organization":
      return { kind: "organization", id: String(ref.organizationId) };
    case "workflow":
      return { kind: "workflow", id: String(ref.workflowId) };
  }
}

export function refKeyToWhereClause(
  ref: MemoryRef,
  kind?: MemoryKind,
): { sql: string; params: unknown[] } {
  const { kind: scopeKind, id: scopeId } = scopeKindOf(ref);
  const where: string[] = ["scope_kind = $1", "scope_id = $2"];
  const params: unknown[] = [scopeKind, scopeId];
  if (kind !== undefined) {
    where.push(`kind = $${params.length + 1}`);
    params.push(kind);
  }
  return { sql: where.join(" AND "), params };
}

export function rowToEntry(row: MemoryRow): MemoryEntry {
  const key = `memory:${row.scope_kind}:${row.scope_id}:${row.kind}:${row.key}`;
  if (!SCOPE_KINDS.includes(row.scope_kind as ScopeKind) || !nonEmptyString(row.scope_id)) {
    throw new CorruptRecordError(key, "invalid memory scope");
  }
  if (!MEMORY_KINDS.includes(row.kind as MemoryKind) || typeof row.key !== "string") {
    throw new CorruptRecordError(key, "invalid memory kind or key");
  }
  if (!nonEmptyString(row.entry_id)) {
    throw new CorruptRecordError(key, "entry_id must be a non-empty string");
  }
  const version = positiveSafeInteger(row.version, "version", key);
  const createdAtMs = safeInteger(row.created_at_ms, "created_at_ms", key);
  const updatedAtMs = safeInteger(row.updated_at_ms, "updated_at_ms", key);
  const expiresAtMs =
    row.expires_at_ms === null || row.expires_at_ms === undefined
      ? undefined
      : safeInteger(row.expires_at_ms, "expires_at_ms", key);
  const tags = parseTags(row.tags, key);
  const metadata = parseMetadata(row.metadata, key);
  const entry: MemoryEntry = {
    id: row.entry_id as MemoryEntryId,
    ref: refFromRow(row),
    key: row.key,
    kind: row.kind as MemoryKind,
    value: row.value,
    version,
    createdAt: timestamp(createdAtMs, "created_at_ms", key),
    updatedAt: timestamp(updatedAtMs, "updated_at_ms", key),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
  return entry;
}

function refFromRow(row: MemoryRow): MemoryRef {
  switch (row.scope_kind) {
    case "session":
      return {
        scope: "session",
        sessionId: row.scope_id as import("@tvic/core").SessionId,
      };
    case "user":
      return {
        scope: "user",
        userId: row.scope_id as UserId,
      };
    case "organization":
      return {
        scope: "organization",
        organizationId: row.scope_id as OrganizationId,
      };
    case "workflow":
      return {
        scope: "workflow",
        workflowId: row.scope_id as WorkflowId,
      };
    default: {
      throw new CorruptRecordError(
        `memory:${row.scope_kind}:${row.scope_id}:${row.kind}:${row.key}`,
        `unknown scope kind: ${String(row.scope_kind)}`,
      );
    }
  }
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

export async function memoryEntryExists(
  client: SqlClient,
  ref: MemoryRef,
  key: string,
  kind: MemoryKind,
  nowMs: number,
): Promise<MemoryRow | null> {
  const { kind: scopeKind, id: scopeId } = scopeKindOf(ref);
  const result = await client.query<MemoryRow>(
    `SELECT scope_kind, scope_id, kind, key, value, version, created_at_ms, updated_at_ms, expires_at_ms, memory_user_id, entry_id, tags, metadata, value_bytes
       FROM tvic_memory_entries
      WHERE scope_kind = $1 AND scope_id = $2 AND kind = $3 AND key = $4
        AND (expires_at_ms IS NULL OR expires_at_ms > $5)`,
    [scopeKind, scopeId, kind, key, nowMs],
  );
  return result.rows[0] ?? null;
}

export function serializeMemoryValue(value: unknown, key: string): string {
  try {
    return serializeJsonValue(value);
  } catch (error) {
    throw new InvalidArgumentError(
      `Memory value ${key} must be a finite, acyclic JSON-compatible value: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function serializeMemoryTags(value: unknown, key: string): string {
  const serialized = serializeMemoryValue(value, key);
  const parsed = JSON.parse(serialized) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new InvalidArgumentError(`Memory tags ${key} must be an array of strings`);
  }
  return serialized;
}

export function serializeMemoryMetadata(value: unknown, key: string): string {
  const serialized = serializeMemoryValue(value, key);
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidArgumentError(`Memory metadata ${key} must be an object`);
  }
  return serialized;
}

export function enforceSize(
  serializedValue: string,
  maxBytes: number | undefined,
  key: string,
): void {
  if (maxBytes === undefined) return;
  const size = Buffer.byteLength(serializedValue, "utf8");
  if (size > maxBytes) {
    throw new MemoryEntryTooLargeError(key, size, maxBytes);
  }
}

export function memoryKeyError(ref: MemoryRef, key: string): string {
  return `memory:${scopeKindOf(ref).kind}:${scopeKindOf(ref).id}:${key}`;
}

export function orgId(id: OrganizationId): string {
  return String(id);
}

export function userId(id: UserId): string {
  return String(id);
}

export function workflowId(id: WorkflowId): string {
  return String(id);
}

export function parseMemoryCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new InvalidArgumentError(
      `Memory cursor must be a non-negative decimal offset: ${cursor}`,
    );
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new InvalidArgumentError(`Memory cursor exceeds the safe integer range: ${cursor}`);
  }
  return offset;
}

export function validateMemoryQuery(query: MemoryQuery): number {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new InvalidArgumentError(`Memory limit must be a positive safe integer: ${limit}`);
  }
  parseMemoryCursor(query.cursor);
  return limit;
}

export function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeInteger(value: number | string, field: string, key: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new CorruptRecordError(key, `${field} must be a safe integer`);
  }
  return numberValue;
}

function positiveSafeInteger(value: number | string, field: string, key: string): number {
  const numberValue = safeInteger(value, field, key);
  if (numberValue < 1) {
    throw new CorruptRecordError(key, `${field} must be positive`);
  }
  return numberValue;
}

function timestamp(value: number, field: string, key: string): MemoryEntry["createdAt"] {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CorruptRecordError(key, `${field} is not a valid timestamp`);
  }
  return date.toISOString() as MemoryEntry["createdAt"];
}

function parseTags(value: unknown, key: string): readonly string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new CorruptRecordError(key, "tags must be an array of strings");
  }
  return value;
}

function parseMetadata(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CorruptRecordError(key, "metadata must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

export { SCOPE_KINDS, type ScopeKind };
