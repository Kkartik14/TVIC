import type { MemoryEntryId, OrganizationId, SessionId, UserId, WorkflowId } from "./ids.js";
import type { Timestamp } from "./timestamp.js";

export type MemoryScope = "session" | "user" | "organization" | "workflow";

export type MemoryRef =
  | { readonly scope: "session"; readonly sessionId: SessionId }
  | { readonly scope: "user"; readonly userId: UserId }
  | { readonly scope: "organization"; readonly organizationId: OrganizationId }
  | { readonly scope: "workflow"; readonly workflowId: WorkflowId };

export type MemoryKind = "fact" | "summary" | "open_item" | "entity_ref" | "raw" | "working_memory";

export interface MemoryEntry<T = unknown> {
  readonly id: MemoryEntryId;
  readonly ref: MemoryRef;
  readonly key: string;
  readonly kind: MemoryKind;
  readonly value: T;
  readonly version: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly expiresAtMs?: number;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Values in the provider-neutral memory contract must be finite, acyclic JSON
 * data. Adapters validate this at runtime because TypeScript cannot protect
 * JavaScript callers and JSONB-backed adapters cannot preserve richer objects.
 */
export type JsonValue =
  | null
  | string
  | boolean
  | number
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface MemoryPutOptions {
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ttlMs?: number;
  /**
   * Trusted runtime attribution for a session-scoped entry. Adapters persist
   * this separately from caller metadata so `deleteForUser` can erase a
   * user's session data without treating arbitrary metadata as ownership.
   * This is not an authorization mechanism; callers must already be trusted.
   */
  readonly sessionUserId?: UserId;
  /**
   * Runtime-only aggregate quota for a session-scoped write. Adapters that
   * advertise `write.sessionQuota` must enforce this atomically, including
   * entries written before the current process started. The byte count is the
   * adapter's canonical UTF-8 JSON representation; callers should not assume
   * identical byte counts across adapters with different storage encodings.
   */
  readonly maxSessionBytes?: number;
  /**
   * If true, the put is a no-op when an entry with the same (ref, key, kind)
   * already exists; the existing entry is returned unchanged. If false and the
   * entry exists with a different value, the call throws `RecordConflictError`.
   * Default: false.
   */
  readonly ifNotExists?: boolean;
}

export interface MemoryQuery {
  readonly key?: string;
  readonly prefix?: string;
  readonly kind?: MemoryKind;
  readonly tags?: readonly string[];
  readonly limit?: number;
  /**
   * v0.1 continuation token. Adapters must interpret this as a non-negative
   * decimal offset; opaque provider-specific cursors are not portable yet.
   */
  readonly cursor?: string;
}

export interface MemoryCapabilities {
  readonly search: {
    readonly exact: boolean;
    readonly vector: boolean;
    readonly hybrid: boolean;
  };
  readonly write: {
    readonly explicit: boolean;
    readonly implicit: boolean;
    /** Whether `put(..., { maxSessionBytes })` is atomically enforced. */
    readonly sessionQuota?: boolean;
  };
  readonly retention: {
    readonly ttl: boolean;
    readonly policy: boolean;
  };
  readonly purge: {
    readonly perEntry: boolean;
    readonly perScope: boolean;
    readonly tenant: boolean;
  };
  readonly maxEntryBytes?: number;
}

export interface Memory {
  /** Implementation name (e.g., "in-memory", "postgres", "mem0"). */
  readonly name: string;
  /** Adapter version (semver-style string). */
  readonly version: string;
  /** Capability declaration used by the runtime to fail fast on mismatch. */
  readonly capabilities: MemoryCapabilities;

  get<T = unknown>(ref: MemoryRef, key: string, kind?: MemoryKind): Promise<MemoryEntry<T> | null>;

  put<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind,
    value: T,
    options?: MemoryPutOptions,
  ): Promise<MemoryEntry<T>>;

  list<T = unknown>(ref: MemoryRef, query?: MemoryQuery): Promise<readonly MemoryEntry<T>[]>;

  delete(ref: MemoryRef, key: string, kind?: MemoryKind): Promise<boolean>;

  /** Delete every entry under the given `MemoryRef`. Returns the count deleted. */
  deleteAll(ref: MemoryRef): Promise<number>;

  /**
   * Delete user-owned data only: the user's `user` scope and session entries
   * explicitly attributed to that user by a trusted runtime write. Shared
   * organization/workflow scopes are never part of this cascade. This is a
   * destructive, privileged erasure primitive; the adapter does not authorize
   * the caller or prove that the supplied user id belongs to the requester.
   */
  deleteForUser(userId: UserId): Promise<number>;
}
