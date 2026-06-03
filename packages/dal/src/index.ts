import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type {
  AudioArtifactChunk,
  CallArtifactManifest,
  CallArtifactPayload,
  CallArtifactSink,
  CallId,
  Memory,
  MemoryEntry,
  MemoryEntryId,
  MemoryPutOptions,
  MemoryQuery,
  MemoryRef,
  MemorySearchResult,
  ProviderCapabilities,
  SessionId,
  SessionStore,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  Timestamp,
  ToolCallId,
  ToolCallStore,
  TraceEvent,
  TraceQuery,
  TraceRedactor,
  TraceId,
  TraceStore,
  TurnId,
  TurnStore,
} from "@tvic/core";
import type { TraceExporter } from "@tvic/core";
import { parseCallArtifactManifest } from "@tvic/core";

function isWithinTraceQuery(event: TraceEvent, query: TraceQuery): boolean {
  if (query.sessionId && event.sessionId !== query.sessionId) {
    return false;
  }

  if (query.traceId && event.traceId !== query.traceId) {
    return false;
  }

  if (query.types && !query.types.includes(event.type)) {
    return false;
  }

  if (query.spanId && event.spanId !== query.spanId) {
    return false;
  }

  if (query.correlationId && event.correlationId !== query.correlationId) {
    return false;
  }

  if (query.since && event.timestamp < query.since) {
    return false;
  }

  if (query.until && event.timestamp > query.until) {
    return false;
  }

  if (
    typeof query.monotonicSinceMs === "number" &&
    event.monotonicOffsetMs < query.monotonicSinceMs
  ) {
    return false;
  }

  if (
    typeof query.monotonicUntilMs === "number" &&
    event.monotonicOffsetMs > query.monotonicUntilMs
  ) {
    return false;
  }

  return true;
}

export interface InMemoryTraceStoreOptions {
  readonly redactor?: TraceRedactor;
}

export class InMemoryTraceStore implements TraceStore {
  readonly #events: TraceEvent[] = [];
  readonly #redactor: TraceRedactor | undefined;
  #closed = false;

  constructor(initialEvents: readonly TraceEvent[] = [], options: InMemoryTraceStoreOptions = {}) {
    this.#events.push(...initialEvents);
    this.#redactor = options.redactor;
  }

  async append(event: TraceEvent): Promise<void> {
    this.#assertOpen();
    const redacted = this.#redactor ? this.#redactor(event) : event;
    if (redacted) {
      this.#events.push(redacted);
    }
  }

  async query(query: TraceQuery): Promise<readonly TraceEvent[]> {
    this.#assertOpen();
    const events = this.#events.filter((event) => isWithinTraceQuery(event, query));
    return typeof query.limit === "number" ? events.slice(0, query.limit) : events;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("TraceStore is closed");
    }
  }
}

export function createInMemoryTraceStore(
  initialEvents: readonly TraceEvent[] = [],
  options: InMemoryTraceStoreOptions = {},
): InMemoryTraceStore {
  return new InMemoryTraceStore(initialEvents, options);
}

export class InMemorySessionStore implements SessionStore {
  readonly #records = new Map<SessionId, StoredSessionRecord>();
  #closed = false;

  async get(id: SessionId): Promise<StoredSessionRecord | null> {
    this.#assertOpen();
    return this.#records.get(id) ?? null;
  }

  async list(): Promise<readonly StoredSessionRecord[]> {
    this.#assertOpen();
    return [...this.#records.values()];
  }

  async put(record: StoredSessionRecord): Promise<void> {
    this.#assertOpen();
    this.#records.set(record.session.id, record);
  }

  async update(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    this.#assertOpen();
    const current = this.#records.get(id);
    if (!current) {
      throw new Error(`Session not found: ${id}`);
    }
    const next = updater(current);
    this.#records.set(id, next);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SessionStore is closed");
    }
  }
}

export function createInMemorySessionStore(): InMemorySessionStore {
  return new InMemorySessionStore();
}

export class InMemoryTurnStore implements TurnStore {
  readonly #records = new Map<SessionId, StoredTurnRecord[]>();
  #closed = false;

  async get(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null> {
    this.#assertOpen();
    return this.#records.get(sessionId)?.find((record) => record.turn.id === id) ?? null;
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    this.#assertOpen();
    return this.#records.get(sessionId) ?? [];
  }

  async put(record: StoredTurnRecord): Promise<void> {
    this.#assertOpen();
    const records = this.#records.get(record.turn.sessionId) ?? [];
    this.#records.set(record.turn.sessionId, [...records, record]);
  }

  async update(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    this.#assertOpen();
    const records = this.#records.get(sessionId) ?? [];
    const index = records.findIndex((record) => record.turn.id === id);
    const current = index >= 0 ? records[index] : undefined;
    if (!current) {
      throw new Error(`Turn not found: ${id}`);
    }

    const next = updater(current);
    const updated = [...records];
    updated[index] = next;
    this.#records.set(sessionId, updated);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("TurnStore is closed");
    }
  }
}

export function createInMemoryTurnStore(): InMemoryTurnStore {
  return new InMemoryTurnStore();
}

export class InMemoryToolCallStore implements ToolCallStore {
  readonly #records = new Map<SessionId, StoredToolCallRecord[]>();
  #closed = false;

  async get(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null> {
    this.#assertOpen();
    return (
      this.#records.get(sessionId)?.find((record) => record.toolCall.toolCallId === id) ?? null
    );
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    this.#assertOpen();
    return this.#records.get(sessionId) ?? [];
  }

  async put(record: StoredToolCallRecord): Promise<void> {
    this.#assertOpen();
    const records = this.#records.get(record.toolCall.sessionId) ?? [];
    this.#records.set(record.toolCall.sessionId, [...records, record]);
  }

  async update(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    this.#assertOpen();
    const records = this.#records.get(sessionId) ?? [];
    const index = records.findIndex((record) => record.toolCall.toolCallId === id);
    const current = index >= 0 ? records[index] : undefined;
    if (!current) {
      throw new Error(`Tool call not found: ${id}`);
    }

    const next = updater(current);
    const updated = [...records];
    updated[index] = next;
    this.#records.set(sessionId, updated);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("ToolCallStore is closed");
    }
  }
}

export function createInMemoryToolCallStore(): InMemoryToolCallStore {
  return new InMemoryToolCallStore();
}

interface StoredMemoryEntry {
  readonly entry: MemoryEntry<unknown>;
  readonly expiresAtMs?: number;
}

export interface InMemoryMemoryOptions {
  readonly now?: () => Date;
  readonly idPrefix?: string;
}

export class InMemoryMemory implements Memory {
  readonly #entries = new Map<string, StoredMemoryEntry>();
  readonly #now: () => Date;
  readonly #idPrefix: string;
  #nextId = 1;

  constructor(options: InMemoryMemoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "mem";
  }

  async get<T = unknown>(ref: MemoryRef, key: string): Promise<MemoryEntry<T> | null> {
    const stored = this.#getStored(ref, key);
    return stored ? (stored.entry as MemoryEntry<T>) : null;
  }

  async put<T = unknown>(
    ref: MemoryRef,
    key: string,
    value: T,
    options: MemoryPutOptions = {},
  ): Promise<MemoryEntry<T>> {
    const now = this.#now();
    const existing = this.#getStored(ref, key);
    const entry: MemoryEntry<T> = {
      id: existing?.entry.id ?? this.#nextEntryId(),
      ref,
      key,
      value,
      createdAt: existing?.entry.createdAt ?? timestamp(now),
      updatedAt: timestamp(now),
      ...(options.tags ? { tags: options.tags } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };

    this.#entries.set(entryKey(ref, key), {
      entry: entry as MemoryEntry<unknown>,
      ...(typeof options.ttlMs === "number" ? { expiresAtMs: now.getTime() + options.ttlMs } : {}),
    });

    return entry;
  }

  async append<T = unknown>(
    ref: MemoryRef,
    key: string,
    value: T,
    options: MemoryPutOptions = {},
  ): Promise<MemoryEntry<readonly T[]>> {
    const existing = this.#getStored(ref, key);
    const existingValue = existing?.entry.value;
    const nextValue = Array.isArray(existingValue)
      ? ([...existingValue, value] as readonly T[])
      : ([value] as readonly T[]);

    return this.put(ref, key, nextValue, options);
  }

  async search<T = unknown>(ref: MemoryRef, query: MemoryQuery): Promise<MemorySearchResult<T>> {
    const prefix = `${refKey(ref)}:`;
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    const limit = query.limit ?? 100;
    const queryTags = query.tags ?? [];

    const entries = [...this.#entries.entries()]
      .filter(([key, stored]) => key.startsWith(prefix) && !this.#isExpired(stored))
      .map(([, stored]) => stored.entry)
      .filter((entry) => (query.key ? entry.key === query.key : true))
      .filter((entry) => (query.prefix ? entry.key.startsWith(query.prefix) : true))
      .filter((entry) => tagsMatch(entry.tags, queryTags));

    const page = entries.slice(offset, offset + limit) as readonly MemoryEntry<T>[];
    const nextOffset = offset + page.length;
    return {
      entries: page,
      ...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async delete(ref: MemoryRef, key: string): Promise<boolean> {
    return this.#entries.delete(entryKey(ref, key));
  }

  #getStored(ref: MemoryRef, key: string): StoredMemoryEntry | null {
    const keyValue = entryKey(ref, key);
    const stored = this.#entries.get(keyValue);
    if (!stored) {
      return null;
    }

    if (this.#isExpired(stored)) {
      this.#entries.delete(keyValue);
      return null;
    }

    return stored;
  }

  #isExpired(stored: StoredMemoryEntry): boolean {
    return typeof stored.expiresAtMs === "number" && stored.expiresAtMs <= this.#now().getTime();
  }

  #nextEntryId(): MemoryEntryId {
    const id = `${this.#idPrefix}_${this.#nextId}` as MemoryEntryId;
    this.#nextId += 1;
    return id;
  }
}

export function createInMemoryMemory(options: InMemoryMemoryOptions = {}): InMemoryMemory {
  return new InMemoryMemory(options);
}

export interface LocalCallArtifactWriterOptions {
  readonly rootDir: string;
  readonly callId: CallId;
  /** Optional: learned from the first exported trace event when omitted. */
  readonly sessionId?: SessionId;
  /** Optional: learned from the first exported trace event when omitted. */
  readonly traceId?: TraceId;
  readonly createdAt: Timestamp;
  readonly privacy: CallArtifactManifest["privacy"];
  readonly redactor?: TraceRedactor;
  /** Reports a failed write. Artifact I/O is best-effort and never throws into the caller. */
  readonly onError?: (error: unknown) => void;
}

export type AppendAudioArtifactInput = AudioArtifactChunk;

export interface DeleteCallArtifactsInput {
  readonly rootDir: string;
  readonly callId: CallId;
}

export interface PruneExpiredCallArtifactsInput {
  readonly rootDir: string;
  readonly now?: Date;
}

const TRACE_EXPORTER_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  interruption: false,
};

export class LocalCallArtifactWriter implements TraceExporter, CallArtifactSink {
  readonly name = "local-call-artifact-writer";
  readonly kind = "trace_exporter";
  readonly version = "0.1.0";
  readonly capabilities = TRACE_EXPORTER_CAPABILITIES;

  readonly #options: LocalCallArtifactWriterOptions;
  readonly #callDir: string;
  readonly #onError: (error: unknown) => void;
  readonly #payloads: CallArtifactPayload[] = [];
  readonly #byteOffsets = new Map<"input" | "output", number>([
    ["input", 0],
    ["output", 0],
  ]);
  // All writes funnel through this chain so they are ordered and drainable.
  #chain: Promise<void> = Promise.resolve();
  // Learned from the first exported event when not supplied up front.
  #sessionId: SessionId | undefined;
  #traceId: TraceId | undefined;
  // Counts writes that failed, so the manifest can be marked degraded (never silently
  // "complete") even though a single failed write must not crash the call.
  #writeFailures = 0;
  #closed = false;
  #directoryReady = false;

  constructor(options: LocalCallArtifactWriterOptions) {
    this.#options = options;
    this.#callDir = callArtifactDirectory(options.rootDir, options.callId);
    this.#onError = options.onError ?? (() => undefined);
    this.#sessionId = options.sessionId;
    this.#traceId = options.traceId;
  }

  // Schedules an ordered write without blocking the caller. The realtime trace path
  // awaits export(); funnelling I/O through this chain keeps disk latency off it.
  // Failures are reported, never thrown, and the chain self-heals for later writes.
  #enqueue(task: () => Promise<void>): void {
    this.#chain = this.#chain.then(task).catch((error) => {
      this.#writeFailures += 1;
      this.#onError(error);
    });
  }

  async export(events: readonly TraceEvent[]): Promise<void> {
    if (this.#closed || events.length === 0) {
      return;
    }
    const redacted = events
      .map((event) => (this.#options.redactor ? this.#options.redactor(event) : event))
      .filter((event): event is TraceEvent => event !== null);
    const first = redacted[0];
    if (!first) {
      return;
    }
    this.#sessionId ??= first.sessionId;
    this.#traceId ??= first.traceId;

    this.#enqueue(async () => {
      await this.#ensureDirectory();
      await appendFile(
        join(this.#callDir, "call.jsonl"),
        `${redacted.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
    });
  }

  async appendAudio(input: AppendAudioArtifactInput): Promise<void> {
    if (this.#closed || !this.#options.privacy.persistAudio) {
      return;
    }

    this.#enqueue(async () => {
      await this.#ensureDirectory();
      const file = input.direction === "input" ? "input.pcm" : "output.pcm";
      const start = this.#byteOffsets.get(input.direction) ?? 0;
      const endExclusive = start + input.bytes.byteLength;

      await appendFile(join(this.#callDir, file), input.bytes);
      this.#byteOffsets.set(input.direction, endExclusive);
      this.#payloads.push({
        payloadRef: input.payloadRef,
        file,
        byteRange: { start, endExclusive },
        monotonicOffsetMs: input.monotonicOffsetMs,
        durationMs: input.durationMs,
        format: input.format,
        ...(input.mediaEventId ? { mediaEventId: input.mediaEventId } : {}),
      });
    });
  }

  async flush(): Promise<void> {
    await this.#chain;
    await this.#writeManifest();
  }

  async close(): Promise<void> {
    // Drain every queued write before finalizing, so nothing is lost or reordered.
    await this.#chain;
    await this.#writeManifest();
    this.#closed = true;
  }

  async #ensureDirectory(): Promise<void> {
    if (this.#directoryReady) {
      return;
    }
    await mkdir(this.#callDir, { recursive: true });
    this.#directoryReady = true;
  }

  async #writeManifest(): Promise<void> {
    if (this.#closed) {
      return;
    }

    await this.#ensureDirectory();
    const now = new Date().toISOString() as Timestamp;
    // Honest identity: write real ids when known, omit them otherwise — never a sentinel
    // "unknown" branded id. A manifest with no identity is marked integrity:"incomplete"
    // so the viewer surfaces it as degraded instead of trusting fake data.
    const identityComplete = this.#sessionId !== undefined && this.#traceId !== undefined;
    const manifest: CallArtifactManifest = {
      version: "0.1.0",
      callId: this.#options.callId,
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      ...(this.#traceId ? { traceId: this.#traceId } : {}),
      createdAt: this.#options.createdAt,
      updatedAt: now,
      files: {
        trace: "call.jsonl",
        manifest: "manifest.json",
        ...(this.#options.privacy.persistAudio
          ? { inputAudio: "input.pcm", outputAudio: "output.pcm" }
          : {}),
      },
      privacy: this.#options.privacy,
      payloads: this.#payloads,
      writeFailures: this.#writeFailures,
      integrity: identityComplete ? "complete" : "incomplete",
    };
    await writeFile(
      join(this.#callDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }
}

export async function deleteCallArtifacts(input: DeleteCallArtifactsInput): Promise<void> {
  await rm(callArtifactDirectory(input.rootDir, input.callId), { recursive: true, force: true });
}

export async function pruneExpiredCallArtifacts(
  input: PruneExpiredCallArtifactsInput,
): Promise<readonly CallId[]> {
  const nowMs = input.now?.getTime() ?? Date.now();
  const entries = await readdir(input.rootDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  });
  const deleted: CallId[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const callId = entry.name as CallId;
    const callDir = callArtifactDirectory(input.rootDir, callId);
    const manifest = await readManifest(join(callDir, "manifest.json"));
    if (!manifest) {
      continue;
    }
    const retentionMs = manifest.privacy.retentionMs;
    if (typeof retentionMs !== "number") {
      continue;
    }

    const expiresAtMs = Date.parse(manifest.createdAt) + retentionMs;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
      await rm(callDir, { recursive: true, force: true });
      deleted.push(callId);
    }
  }

  return deleted;
}

export function callArtifactDirectory(rootDir: string, callId: CallId): string {
  const segment = String(callId);
  if (!/^[A-Za-z0-9._:-]+$/.test(segment) || segment === "." || segment === "..") {
    throw new Error(`Unsafe call artifact id: ${segment}`);
  }

  const root = resolve(rootDir);
  const target = resolve(root, segment);
  if (target !== root && target.startsWith(`${root}${sep}`)) {
    return target;
  }

  throw new Error(`Call artifact path escapes root: ${segment}`);
}

function timestamp(date: Date): Timestamp {
  return date.toISOString() as Timestamp;
}

function refKey(ref: MemoryRef): string {
  switch (ref.scope) {
    case "session":
      return `session:${ref.sessionId}`;
    case "user":
      return `user:${ref.userId}`;
    case "organization":
      return `organization:${ref.organizationId}`;
    case "workflow":
      return `workflow:${ref.workflowId}`;
  }
  const unreachable: never = ref;
  throw new Error(`Unsupported memory ref: ${String(unreachable)}`);
}

function entryKey(ref: MemoryRef, key: string): string {
  return `${refKey(ref)}:${key}`;
}

function tagsMatch(
  entryTags: readonly string[] | undefined,
  queryTags: readonly string[],
): boolean {
  if (queryTags.length === 0) {
    return true;
  }

  const tags = new Set(entryTags ?? []);
  return queryTags.every((tag) => tags.has(tag));
}

async function readManifest(path: string): Promise<CallArtifactManifest | null> {
  const body = await readFile(path, "utf8").catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (!body) {
    return null;
  }
  // Disk data is untrusted: a corrupt manifest must not crash the whole prune pass, so
  // parse-and-validate rather than cast. An invalid manifest is treated as absent (the
  // call is simply skipped for retention).
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const result = parseCallArtifactManifest(parsed);
  return result.ok ? result.manifest : null;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
