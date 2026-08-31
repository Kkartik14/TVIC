/**
 * `VectorMemorySkeleton` decorates an exact-key `Memory` adapter with a
 * provider-owned semantic search function. Exact retrieval remains governed
 * by the Memory contract; semantic search is an explicit method and can never
 * accidentally reinterpret `MemoryQuery.key` as free-form text.
 */
import type {
  Memory,
  MemoryCapabilities,
  MemoryEntry,
  MemoryKind,
  MemoryQuery,
  MemoryRef,
} from "@tvic/core";

export interface VectorSearchFn {
  /**
   * Embed the query, search the vector store, return the top-K
   * `MemoryEntry` values. The skeleton treats the result as the
   * authoritative list — no client-side filtering.
   */
  (
    query: string,
    options: { readonly ref: MemoryRef; readonly limit?: number; readonly kind?: MemoryKind },
  ): Promise<readonly MemoryEntry[]>;
}

export class VectorMemorySkeleton implements Memory {
  readonly name: string;
  readonly version: string;
  readonly capabilities: MemoryCapabilities;

  constructor(
    private readonly inner: Memory,
    private readonly vectorSearch: VectorSearchFn,
    options: {
      readonly name?: string;
      readonly version?: string;
    } = {},
  ) {
    this.name = options.name ?? "vector-memory-skeleton";
    this.version = options.version ?? "0.1.0";
    this.capabilities = {
      search: { ...inner.capabilities.search, vector: true },
      write: inner.capabilities.write,
      retention: inner.capabilities.retention,
      purge: inner.capabilities.purge,
      ...(inner.capabilities.maxEntryBytes !== undefined
        ? { maxEntryBytes: inner.capabilities.maxEntryBytes }
        : {}),
    };
  }

  get<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind = "raw",
  ): Promise<MemoryEntry<T> | null> {
    return this.inner.get<T>(ref, key, kind);
  }

  put<T = unknown>(
    ref: MemoryRef,
    key: string,
    kind: MemoryKind,
    value: T,
    options?: Parameters<Memory["put"]>[4],
  ): Promise<MemoryEntry<T>> {
    return this.inner.put<T>(ref, key, kind, value, options);
  }

  async list<T = unknown>(ref: MemoryRef, query?: MemoryQuery): Promise<readonly MemoryEntry<T>[]> {
    return this.inner.list<T>(ref, query);
  }

  /** Run provider-owned semantic search within one Memory scope. */
  async search<T = unknown>(
    ref: MemoryRef,
    query: string,
    options: { readonly limit?: number; readonly kind?: MemoryKind } = {},
  ): Promise<readonly MemoryEntry<T>[]> {
    return (await this.vectorSearch(query, {
      ref,
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    })) as readonly MemoryEntry<T>[];
  }

  delete(ref: MemoryRef, key: string, kind: MemoryKind = "raw"): Promise<boolean> {
    return this.inner.delete(ref, key, kind);
  }

  deleteAll(ref: MemoryRef): Promise<number> {
    return this.inner.deleteAll(ref);
  }

  deleteForUser(userId: Parameters<Memory["deleteForUser"]>[0]): Promise<number> {
    return this.inner.deleteForUser(userId);
  }
}
