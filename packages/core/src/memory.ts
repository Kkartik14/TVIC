import type { MemoryEntryId, OrganizationId, SessionId, UserId, WorkflowId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

export type MemoryScope = "session" | "user" | "organization" | "workflow";

export type MemoryRef =
  | { readonly scope: "session"; readonly sessionId: SessionId }
  | { readonly scope: "user"; readonly userId: UserId }
  | { readonly scope: "organization"; readonly organizationId: OrganizationId }
  | { readonly scope: "workflow"; readonly workflowId: WorkflowId };

export interface MemoryEntry<T = unknown> {
  readonly id: MemoryEntryId;
  readonly ref: MemoryRef;
  readonly key: string;
  readonly value: T;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryPutOptions {
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ttlMs?: number;
}

export interface MemoryQuery {
  readonly key?: string;
  readonly prefix?: string;
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface MemorySearchResult<T = unknown> {
  readonly entries: readonly MemoryEntry<T>[];
  readonly nextCursor?: string;
}

export interface Memory {
  get<T = unknown>(ref: MemoryRef, key: string): Promise<MemoryEntry<T> | null>;
  put<T = unknown>(
    ref: MemoryRef,
    key: string,
    value: T,
    options?: MemoryPutOptions,
  ): Promise<MemoryEntry<T>>;
  append<T = unknown>(
    ref: MemoryRef,
    key: string,
    value: T,
    options?: MemoryPutOptions,
  ): Promise<MemoryEntry<readonly T[]>>;
  search<T = unknown>(ref: MemoryRef, query: MemoryQuery): Promise<MemorySearchResult<T>>;
  delete(ref: MemoryRef, key: string): Promise<boolean>;
}
