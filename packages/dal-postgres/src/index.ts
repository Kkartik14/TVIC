import {
  assertLeaseTtlMs,
  CorruptRecordError,
  InvalidArgumentError,
  RecordConflictError,
  RecordNotFoundError,
} from "@tvic/core";
import type {
  DurableOutboxEvent,
  DurableRuntimeStore,
  DurableSessionTransaction,
  SessionId,
  SessionLease,
  SessionStore,
  StoredSessionRecord,
  StoredToolCallRecord,
  StoredTurnRecord,
  ToolCallId,
  ToolCallStore,
  TurnId,
  TurnStore,
} from "@tvic/core";
import { decodeOutboxEnvelope } from "@tvic/dal-codec";
import { PostgresToolIdempotencyStore } from "./idempotency.js";
import {
  PostgresSessionLeaseStore,
  acquireLease,
  assertLease,
  assertNoActiveLease,
} from "./session-leases.js";
import { withBackendBoundary, withTransaction } from "./postgres-helpers.js";
import {
  decodeSessionRow,
  decodeToolRow,
  decodeTurnRow,
  normalizeSessionForStorage,
  normalizeToolCallForStorage,
  normalizeTurnForStorage,
  sameStoredRecord,
  safePersistedIntegerValue,
  sessionValues,
  toolCallValues,
  turnValues,
  type SessionRow,
  type ToolCallRow,
  type TurnRow,
} from "./postgres-records.js";

export { PostgresToolIdempotencyStore } from "./idempotency.js";
export { PostgresSessionLeaseStore };

export interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}

export interface SqlPool extends SqlClient {
  connect(): Promise<SqlClient & { readonly release: () => void }>;
  end?(): Promise<void>;
}

export interface PostgresSessionChildPage<RecordType> {
  readonly records: readonly RecordType[];
  readonly nextCursor: string | undefined;
}

const MAX_SESSION_CHILD_PAGE_SIZE = 1_000;

export interface PostgresDurableStoreOptions {
  readonly pool: SqlPool;
}

export class PostgresSessionStore implements SessionStore {
  constructor(readonly client: SqlClient) {}

  async get(id: SessionId): Promise<StoredSessionRecord | null> {
    return withBackendBoundary(async () => {
      const result = await this.client.query<SessionRow>(
        "SELECT id, payload, runtime, version FROM tvic_sessions WHERE id = $1",
        [id],
      );
      const row = result.rows[0];
      return row ? decodeSessionRow(row) : null;
    });
  }

  async list(): Promise<readonly StoredSessionRecord[]> {
    return withBackendBoundary(async () => {
      const result = await this.client.query<SessionRow>(
        "SELECT id, payload, runtime, version FROM tvic_sessions ORDER BY created_at, id",
      );
      return result.rows.map(decodeSessionRow);
    });
  }

  async put(record: StoredSessionRecord): Promise<void> {
    await withBackendBoundary(async () => {
      const inserted = await this.client.query(
        `INSERT INTO tvic_sessions
          (id, agent_id, status, created_at, started_at, ended_at, payload, runtime,
           version, last_fence, last_activity_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 0, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        sessionValues(record),
      );
      if ((inserted.rowCount ?? 0) > 0) return;
      const existing = await this.get(record.session.id);
      if (!existing || !sameStoredRecord(existing, record)) {
        throw new RecordConflictError(`session:${record.session.id}`);
      }
    });
  }

  async update(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    return withTransaction(this.client, async (tx) => updateSession(tx, id, updater));
  }

  async close(): Promise<void> {
    return;
  }
}

export class PostgresTurnStore implements TurnStore {
  constructor(readonly client: SqlClient) {}

  async get(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null> {
    return withBackendBoundary(async () => {
      const result = await this.client.query<TurnRow>(
        "SELECT id, session_id, payload, runtime, version FROM tvic_turns WHERE session_id = $1 AND id = $2",
        [sessionId, id],
      );
      const row = result.rows[0];
      return row ? decodeTurnRow(row) : null;
    });
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    return withBackendBoundary(async () => {
      const result = await this.client.query<TurnRow>(
        "SELECT id, session_id, payload, runtime, version FROM tvic_turns WHERE session_id = $1 ORDER BY turn_sequence, id",
        [sessionId],
      );
      return result.rows.map(decodeTurnRow);
    });
  }

  async listBySessionPage(
    sessionId: SessionId,
    afterId?: string,
    pageSize = 100,
  ): Promise<PostgresSessionChildPage<StoredTurnRecord>> {
    return listSessionChildrenPage(
      this.client,
      "tvic_turns",
      sessionId,
      afterId,
      pageSize,
      decodeTurnRow,
    );
  }

  async put(record: StoredTurnRecord): Promise<void> {
    await withBackendBoundary(async () => {
      const inserted = await this.client.query(
        `INSERT INTO tvic_turns
          (session_id, id, turn_sequence, status, started_at, ended_at, payload, runtime,
           version, last_fence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 0, NOW(), NOW())
         ON CONFLICT (session_id, id) DO NOTHING`,
        turnValues(record),
      );
      if ((inserted.rowCount ?? 0) > 0) return;
      const existing = await this.get(record.turn.sessionId, record.turn.id);
      if (!existing || !sameStoredRecord(existing, record)) {
        throw new RecordConflictError(`turn:${record.turn.sessionId}:${record.turn.id}`);
      }
    });
  }

  async update(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    return withTransaction(this.client, async (tx) => updateTurn(tx, sessionId, id, updater));
  }

  async close(): Promise<void> {
    return;
  }
}

export class PostgresToolCallStore implements ToolCallStore {
  constructor(readonly client: SqlClient) {}

  async get(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null> {
    return withBackendBoundary(async () => {
      const result = await this.client.query<ToolCallRow>(
        "SELECT id, session_id, payload, runtime, version FROM tvic_tool_calls WHERE session_id = $1 AND id = $2",
        [sessionId, id],
      );
      const row = result.rows[0];
      return row ? decodeToolRow(row) : null;
    });
  }

  async listBySession(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    return withBackendBoundary(async () => {
      const result = await this.client.query<ToolCallRow>(
        "SELECT id, session_id, payload, runtime, version FROM tvic_tool_calls WHERE session_id = $1 ORDER BY queued_at, id",
        [sessionId],
      );
      return result.rows.map(decodeToolRow);
    });
  }

  async listBySessionPage(
    sessionId: SessionId,
    afterId?: string,
    pageSize = 100,
  ): Promise<PostgresSessionChildPage<StoredToolCallRecord>> {
    return listSessionChildrenPage(
      this.client,
      "tvic_tool_calls",
      sessionId,
      afterId,
      pageSize,
      decodeToolRow,
    );
  }

  async put(record: StoredToolCallRecord): Promise<void> {
    await withBackendBoundary(async () => {
      const inserted = await this.client.query(
        `INSERT INTO tvic_tool_calls
          (session_id, id, turn_id, status, queued_at, started_at, ended_at, payload, runtime,
           version, last_fence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, 0, NOW(), NOW())
         ON CONFLICT (session_id, id) DO NOTHING`,
        toolCallValues(record),
      );
      if ((inserted.rowCount ?? 0) > 0) return;
      const existing = await this.get(record.toolCall.sessionId, record.toolCall.toolCallId);
      if (!existing || !sameStoredRecord(existing, record)) {
        throw new RecordConflictError(
          `tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
        );
      }
    });
  }

  async update(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    return withTransaction(this.client, async (tx) => updateToolCall(tx, sessionId, id, updater));
  }

  async close(): Promise<void> {
    return;
  }
}

export class PostgresDurableRuntimeStore implements DurableRuntimeStore {
  readonly sessions: PostgresSessionStore;
  readonly turns: PostgresTurnStore;
  readonly toolCalls: PostgresToolCallStore;
  readonly leases: PostgresSessionLeaseStore;
  readonly toolIdempotencyStore: PostgresToolIdempotencyStore;
  #closePromise: Promise<void> | undefined;

  constructor(readonly pool: SqlPool) {
    this.sessions = new PostgresSessionStore(pool);
    this.turns = new PostgresTurnStore(pool);
    this.toolCalls = new PostgresToolCallStore(pool);
    this.leases = new PostgresSessionLeaseStore(pool);
    this.toolIdempotencyStore = new PostgresToolIdempotencyStore(pool);
  }

  async createSessionWithLease(
    record: StoredSessionRecord,
    holder: string,
    ttlMs: number,
    initialEvent?: (lease: SessionLease) => DurableOutboxEvent,
  ): Promise<SessionLease | null> {
    assertLeaseTtlMs(ttlMs);
    return withTransaction(this.pool, async (client) => {
      const persistedSession = await putSession(client, record);
      const lease = await acquireLease(client, record.session.id, holder, ttlMs);
      if (lease && initialEvent) {
        await client.query(
          "UPDATE tvic_sessions SET last_fence = GREATEST(last_fence, $2) WHERE id = $1",
          [record.session.id, lease.fence],
        );
        await appendOutbox(client, initialEvent(lease), persistedSession.incarnation);
      }
      return lease;
    });
  }

  async runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence" | "generationId">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      const sessionIncarnation = await assertLease(client, sessionId, lease);
      const result = await operation(
        new PostgresTransaction(client, sessionId, lease.fence, sessionIncarnation),
      );
      await assertLease(client, sessionId, lease);
      return result;
    });
  }

  async runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      const ordering = await assertNoActiveLease(client, sessionId);
      const result = await operation(
        new PostgresTransaction(client, sessionId, ordering.fence, ordering.sessionIncarnation),
      );
      await assertNoActiveLease(client, sessionId);
      return result;
    });
  }

  async close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.leases.close();
    }
    await this.#closePromise;
  }
}

export function createPostgresDurableRuntimeStore(
  options: PostgresDurableStoreOptions,
): PostgresDurableRuntimeStore {
  return new PostgresDurableRuntimeStore(options.pool);
}

export {
  PostgresOutboxWorker,
  type OutboxRunResult,
  type PostgresOutboxWorkerOptions,
} from "./outbox.js";
export {
  PostgresRetentionJob,
  type PostgresRetentionSessionIdentity,
  type PostgresRetentionJobOptions,
  type RetentionRunResult,
} from "./maintenance.js";
export { runPostgresMigrations, type PostgresMigration } from "./migrations.js";

class PostgresTransaction implements DurableSessionTransaction {
  #sessionIncarnation: number | undefined;

  constructor(
    readonly client: SqlClient,
    readonly sessionId: SessionId,
    readonly fence: number,
    sessionIncarnation?: number,
  ) {
    this.#sessionIncarnation = sessionIncarnation;
  }

  getSession(id: SessionId): Promise<StoredSessionRecord | null> {
    this.assertSession(id);
    return getSession(this.client, id, true);
  }

  putSession(record: StoredSessionRecord): Promise<void> {
    this.assertSession(record.session.id);
    return this.putSessionWithFence(record);
  }

  private async putSessionWithFence(record: StoredSessionRecord): Promise<void> {
    this.#sessionIncarnation = (await putSession(this.client, record)).incarnation;
    await this.client.query(
      "UPDATE tvic_sessions SET last_fence = GREATEST(last_fence, $2) WHERE id = $1",
      [record.session.id, this.fence],
    );
  }

  updateSession(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    this.assertSession(id);
    return this.updateSessionWithFence(id, updater);
  }

  private async updateSessionWithFence(
    id: SessionId,
    updater: (record: StoredSessionRecord) => StoredSessionRecord,
  ): Promise<StoredSessionRecord> {
    const next = await updateSession(this.client, id, updater);
    await this.client.query(
      "UPDATE tvic_sessions SET last_fence = GREATEST(last_fence, $2) WHERE id = $1",
      [id, this.fence],
    );
    return next;
  }

  getTurn(sessionId: SessionId, id: TurnId): Promise<StoredTurnRecord | null> {
    this.assertSession(sessionId);
    return getTurn(this.client, sessionId, id, true);
  }

  listTurns(sessionId: SessionId): Promise<readonly StoredTurnRecord[]> {
    this.assertSession(sessionId);
    return listTurns(this.client, sessionId);
  }

  putTurn(record: StoredTurnRecord): Promise<void> {
    this.assertSession(record.turn.sessionId);
    return this.putTurnWithFence(record);
  }

  private async putTurnWithFence(record: StoredTurnRecord): Promise<void> {
    await putTurn(this.client, record);
    await this.client.query(
      "UPDATE tvic_turns SET last_fence = GREATEST(last_fence, $3) WHERE session_id = $1 AND id = $2",
      [record.turn.sessionId, record.turn.id, this.fence],
    );
  }

  updateTurn(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    this.assertSession(sessionId);
    return this.updateTurnWithFence(sessionId, id, updater);
  }

  private async updateTurnWithFence(
    sessionId: SessionId,
    id: TurnId,
    updater: (record: StoredTurnRecord) => StoredTurnRecord,
  ): Promise<StoredTurnRecord> {
    const next = await updateTurn(this.client, sessionId, id, updater);
    await this.client.query(
      "UPDATE tvic_turns SET last_fence = GREATEST(last_fence, $3) WHERE session_id = $1 AND id = $2",
      [sessionId, id, this.fence],
    );
    return next;
  }

  getToolCall(sessionId: SessionId, id: ToolCallId): Promise<StoredToolCallRecord | null> {
    this.assertSession(sessionId);
    return getToolCall(this.client, sessionId, id, true);
  }

  listToolCalls(sessionId: SessionId): Promise<readonly StoredToolCallRecord[]> {
    this.assertSession(sessionId);
    return listToolCalls(this.client, sessionId);
  }

  putToolCall(record: StoredToolCallRecord): Promise<void> {
    this.assertSession(record.toolCall.sessionId);
    return this.putToolCallWithFence(record);
  }

  private async putToolCallWithFence(record: StoredToolCallRecord): Promise<void> {
    await putToolCall(this.client, record);
    await this.client.query(
      "UPDATE tvic_tool_calls SET last_fence = GREATEST(last_fence, $3) WHERE session_id = $1 AND id = $2",
      [record.toolCall.sessionId, record.toolCall.toolCallId, this.fence],
    );
  }

  updateToolCall(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    this.assertSession(sessionId);
    return this.updateToolCallWithFence(sessionId, id, updater);
  }

  private async updateToolCallWithFence(
    sessionId: SessionId,
    id: ToolCallId,
    updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
  ): Promise<StoredToolCallRecord> {
    const next = await updateToolCall(this.client, sessionId, id, updater);
    await this.client.query(
      "UPDATE tvic_tool_calls SET last_fence = GREATEST(last_fence, $3) WHERE session_id = $1 AND id = $2",
      [sessionId, id, this.fence],
    );
    return next;
  }

  async appendOutbox(event: DurableOutboxEvent): Promise<void> {
    this.assertSession(event.sessionId);
    this.#sessionIncarnation ??= await getSessionIncarnation(this.client, this.sessionId);
    await appendOutbox(this.client, event, this.#sessionIncarnation);
  }

  private assertSession(candidate: SessionId): void {
    if (candidate !== this.sessionId) {
      throw new InvalidArgumentError(
        `Session transaction ${this.sessionId} cannot access ${candidate}`,
      );
    }
  }
}

async function appendOutbox(
  client: SqlClient,
  event: DurableOutboxEvent,
  sessionIncarnation: number,
): Promise<void> {
  const envelope = decodeOutboxEnvelope(
    event.aggregateType,
    event.envelope,
    `outbox:${event.id}`,
    event.version,
  );
  await client.query(
    `INSERT INTO tvic_outbox
      (id, aggregate_type, aggregate_id, session_id, session_incarnation,
       version, fence, envelope, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.aggregateType,
      event.aggregateId,
      event.sessionId,
      sessionIncarnation,
      event.version,
      event.fence,
      JSON.stringify(envelope),
    ],
  );
}

async function getSession(
  client: SqlClient,
  id: SessionId,
  lock: boolean,
): Promise<StoredSessionRecord | null> {
  const result = await client.query<SessionRow>(
    `SELECT id, payload, runtime, version FROM tvic_sessions WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ? decodeSessionRow(result.rows[0]) : null;
}

async function putSession(
  client: SqlClient,
  record: StoredSessionRecord,
): Promise<{ readonly incarnation: number }> {
  await client.query(
    `INSERT INTO tvic_sessions
      (id, agent_id, status, created_at, started_at, ended_at, payload, runtime,
       version, last_fence, last_activity_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 0, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    sessionValues(record),
  );
  const result = await client.query<SessionRow>(
    `SELECT id, payload, runtime, version, incarnation
     FROM tvic_sessions WHERE id = $1 FOR UPDATE`,
    [record.session.id],
  );
  const row = result.rows[0];
  const existing = row ? decodeSessionRow(row) : null;
  if (!existing || !row) throw new RecordNotFoundError(`session:${record.session.id}`);
  if (!sameStoredRecord(existing, record)) {
    throw new RecordConflictError(`session:${record.session.id}`);
  }
  const incarnation = safePersistedIntegerValue(row.incarnation ?? "");
  if (incarnation === null) {
    throw new CorruptRecordError(
      `postgres:session:${record.session.id}`,
      "incarnation must be a safe non-negative integer",
    );
  }
  return { incarnation };
}

async function getSessionIncarnation(client: SqlClient, sessionId: SessionId): Promise<number> {
  const result = await client.query<{ incarnation: number | string } & Record<string, unknown>>(
    "SELECT incarnation FROM tvic_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) throw new RecordNotFoundError(`session:${sessionId}`);
  const incarnation = safePersistedIntegerValue(row.incarnation);
  if (incarnation === null) {
    throw new CorruptRecordError(
      `postgres:session:${sessionId}`,
      "incarnation must be a safe non-negative integer",
    );
  }
  return incarnation;
}

async function updateSession(
  client: SqlClient,
  id: SessionId,
  updater: (record: StoredSessionRecord) => StoredSessionRecord,
): Promise<StoredSessionRecord> {
  const current = await getSession(client, id, true);
  if (!current) throw new RecordNotFoundError(`session:${id}`);
  const next = updater(current);
  const normalized = normalizeSessionForStorage(next);
  const startedAt = "startedAt" in normalized.session ? normalized.session.startedAt : null;
  const endedAt = "endedAt" in normalized.session ? normalized.session.endedAt : null;
  await client.query(
    "UPDATE tvic_sessions SET payload = $2::jsonb, runtime = $3::jsonb, status = $4, started_at = $5, ended_at = $6, version = version + 1, last_activity_at = NOW(), updated_at = NOW() WHERE id = $1",
    [
      id,
      JSON.stringify(normalized.session),
      JSON.stringify(normalized.runtime),
      normalized.session.status,
      startedAt,
      endedAt,
    ],
  );
  return { ...normalized, version: (current.version ?? 1) + 1 };
}

async function getTurn(
  client: SqlClient,
  sessionId: SessionId,
  id: TurnId,
  lock: boolean,
): Promise<StoredTurnRecord | null> {
  const result = await client.query<TurnRow>(
    `SELECT id, session_id, payload, runtime, version FROM tvic_turns WHERE session_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [sessionId, id],
  );
  return result.rows[0] ? decodeTurnRow(result.rows[0]) : null;
}

async function listTurns(
  client: SqlClient,
  sessionId: SessionId,
): Promise<readonly StoredTurnRecord[]> {
  const result = await client.query<TurnRow>(
    "SELECT id, session_id, payload, runtime, version FROM tvic_turns WHERE session_id = $1 ORDER BY turn_sequence, id",
    [sessionId],
  );
  return result.rows.map(decodeTurnRow);
}

async function putTurn(client: SqlClient, record: StoredTurnRecord): Promise<void> {
  await client.query(
    `INSERT INTO tvic_turns
      (session_id, id, turn_sequence, status, started_at, ended_at, payload, runtime,
       version, last_fence, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 0, NOW(), NOW())
     ON CONFLICT (session_id, id) DO NOTHING`,
    turnValues(record),
  );
  const existing = await getTurn(client, record.turn.sessionId, record.turn.id, true);
  if (!existing) throw new RecordNotFoundError(`turn:${record.turn.sessionId}:${record.turn.id}`);
  if (!sameStoredRecord(existing, record)) {
    throw new RecordConflictError(`turn:${record.turn.sessionId}:${record.turn.id}`);
  }
}

async function updateTurn(
  client: SqlClient,
  sessionId: SessionId,
  id: TurnId,
  updater: (record: StoredTurnRecord) => StoredTurnRecord,
): Promise<StoredTurnRecord> {
  const current = await getTurn(client, sessionId, id, true);
  if (!current) throw new RecordNotFoundError(`turn:${sessionId}:${id}`);
  const next = updater(current);
  const normalized = normalizeTurnForStorage(next);
  const endedAt = "endedAt" in normalized.turn ? normalized.turn.endedAt : null;
  await client.query(
    "UPDATE tvic_turns SET payload = $3::jsonb, runtime = $4::jsonb, status = $5, started_at = $6, ended_at = $7, version = version + 1, updated_at = NOW() WHERE session_id = $1 AND id = $2",
    [
      sessionId,
      id,
      JSON.stringify(normalized.turn),
      JSON.stringify(normalized.runtime),
      normalized.turn.status,
      normalized.turn.startedAt,
      endedAt,
    ],
  );
  return { ...normalized, version: (current.version ?? 1) + 1 };
}

async function getToolCall(
  client: SqlClient,
  sessionId: SessionId,
  id: ToolCallId,
  lock: boolean,
): Promise<StoredToolCallRecord | null> {
  const result = await client.query<ToolCallRow>(
    `SELECT id, session_id, payload, runtime, version FROM tvic_tool_calls WHERE session_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [sessionId, id],
  );
  return result.rows[0] ? decodeToolRow(result.rows[0]) : null;
}

async function listToolCalls(
  client: SqlClient,
  sessionId: SessionId,
): Promise<readonly StoredToolCallRecord[]> {
  const result = await client.query<ToolCallRow>(
    "SELECT id, session_id, payload, runtime, version FROM tvic_tool_calls WHERE session_id = $1 ORDER BY queued_at, id",
    [sessionId],
  );
  return result.rows.map(decodeToolRow);
}

async function putToolCall(client: SqlClient, record: StoredToolCallRecord): Promise<void> {
  await client.query(
    `INSERT INTO tvic_tool_calls
      (session_id, id, turn_id, status, queued_at, started_at, ended_at, payload, runtime,
       version, last_fence, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, 0, NOW(), NOW())
     ON CONFLICT (session_id, id) DO NOTHING`,
    toolCallValues(record),
  );
  const existing = await getToolCall(
    client,
    record.toolCall.sessionId,
    record.toolCall.toolCallId,
    true,
  );
  if (!existing) {
    throw new RecordNotFoundError(
      `tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
    );
  }
  if (!sameStoredRecord(existing, record)) {
    throw new RecordConflictError(
      `tool_call:${record.toolCall.sessionId}:${record.toolCall.toolCallId}`,
    );
  }
}

async function updateToolCall(
  client: SqlClient,
  sessionId: SessionId,
  id: ToolCallId,
  updater: (record: StoredToolCallRecord) => StoredToolCallRecord,
): Promise<StoredToolCallRecord> {
  const current = await getToolCall(client, sessionId, id, true);
  if (!current) throw new RecordNotFoundError(`tool_call:${sessionId}:${id}`);
  const next = updater(current);
  const normalized = normalizeToolCallForStorage(next);
  const startedAt = "startedAt" in normalized.toolCall ? normalized.toolCall.startedAt : null;
  const endedAt = "endedAt" in normalized.toolCall ? normalized.toolCall.endedAt : null;
  await client.query(
    "UPDATE tvic_tool_calls SET payload = $3::jsonb, runtime = $4::jsonb, status = $5, started_at = $6, ended_at = $7, version = version + 1, updated_at = NOW() WHERE session_id = $1 AND id = $2",
    [
      sessionId,
      id,
      JSON.stringify(normalized.toolCall),
      JSON.stringify(normalized.runtime),
      normalized.toolCall.status,
      startedAt,
      endedAt,
    ],
  );
  return { ...normalized, version: (current.version ?? 1) + 1 };
}

async function listSessionChildrenPage<
  Row extends Record<string, unknown> & { readonly id: string },
  RecordType,
>(
  client: SqlClient,
  table: "tvic_turns" | "tvic_tool_calls",
  sessionId: SessionId,
  afterId: string | undefined,
  pageSize: number,
  decode: (row: Row) => RecordType,
): Promise<PostgresSessionChildPage<RecordType>> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_SESSION_CHILD_PAGE_SIZE) {
    throw new InvalidArgumentError(
      `PostgreSQL session child page size must be between 1 and ${MAX_SESSION_CHILD_PAGE_SIZE}`,
    );
  }
  return withBackendBoundary(async () => {
    const cursorClause = afterId === undefined ? "" : "AND id > $2";
    const limitParameter = afterId === undefined ? "$2" : "$3";
    const values =
      afterId === undefined ? [sessionId, pageSize + 1] : [sessionId, afterId, pageSize + 1];
    const result = await client.query<Row>(
      `SELECT id, session_id, payload, runtime, version FROM ${table}
       WHERE session_id = $1 ${cursorClause}
       ORDER BY id LIMIT ${limitParameter}`,
      values,
    );
    const hasMore = result.rows.length > pageSize;
    const selected = result.rows.slice(0, pageSize);
    return {
      records: selected.map(decode),
      nextCursor: hasMore ? selected.at(-1)?.id : undefined,
    };
  });
}
