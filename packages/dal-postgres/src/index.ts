import {
  InvalidArgumentError,
  LeaseLostError,
  RecordConflictError,
  RecordNotFoundError,
} from "@tvic/core";
import type {
  DurableOutboxEvent,
  DurableRuntimeStore,
  DurableSessionTransaction,
  SessionId,
  SessionLease,
  SessionLeaseStore,
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
import { databaseNowMs, withBackendBoundary, withTransaction } from "./postgres-helpers.js";
import {
  decodeSessionRow,
  decodeToolRow,
  decodeTurnRow,
  leaseFromRow,
  sameStoredRecord,
  sessionValues,
  toolCallValues,
  turnValues,
  type LeaseRow,
  type SessionRow,
  type ToolCallRow,
  type TurnRow,
} from "./postgres-records.js";

export { PostgresToolIdempotencyStore } from "./idempotency.js";

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
  /** If provided, the durable store owns this pool and calls it once on close. */
  end?(): Promise<void>;
}

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

export class PostgresSessionLeaseStore implements SessionLeaseStore {
  constructor(readonly client: SqlPool) {}

  async acquire(sessionId: SessionId, holder: string, ttlMs: number): Promise<SessionLease | null> {
    return withTransaction(this.client, (tx) => acquireLease(tx, sessionId, holder, ttlMs));
  }

  async renew(
    sessionId: SessionId,
    holder: string,
    fence: number,
    ttlMs: number,
  ): Promise<SessionLease | null> {
    return withTransaction(this.client, async (tx) => {
      const now = await databaseNowMs(tx);
      const result = await tx.query<LeaseRow>(
        `UPDATE tvic_session_leases
         SET renewed_at_ms = $4, expires_at_ms = $5, updated_at = NOW()
         WHERE session_id = $1 AND holder = $2 AND fence = $3 AND expires_at_ms > $4
         RETURNING session_id, holder, fence, acquired_at_ms, renewed_at_ms, expires_at_ms`,
        [sessionId, holder, fence, now, now + ttlMs],
      );
      return result.rows[0] ? leaseFromRow(result.rows[0]) : null;
    });
  }

  async release(sessionId: SessionId, holder: string, fence: number): Promise<void> {
    await withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      await this.client.query(
        "UPDATE tvic_session_leases SET expires_at_ms = $4, renewed_at_ms = $4, updated_at = NOW() WHERE session_id = $1 AND holder = $2 AND fence = $3",
        [sessionId, holder, fence, now],
      );
    });
  }

  async get(sessionId: SessionId): Promise<SessionLease | null> {
    return withBackendBoundary(async () => {
      const now = await databaseNowMs(this.client);
      const result = await this.client.query<LeaseRow>(
        "SELECT session_id, holder, fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1",
        [sessionId],
      );
      const row = result.rows[0];
      return row && Number(row.expires_at_ms) > now ? leaseFromRow(row) : null;
    });
  }

  async listRecoveryCandidates(options: {
    readonly nowMs: number;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly sessionIds: readonly SessionId[]; readonly nextCursor?: string }> {
    return withBackendBoundary(async () => {
      const nowMs = await databaseNowMs(this.client);
      const result = await this.client.query<{ session_id: string } & Record<string, unknown>>(
        `SELECT session_id FROM tvic_session_leases
         WHERE expires_at_ms <= $1 AND ($2::text IS NULL OR session_id > $2)
         ORDER BY session_id LIMIT $3`,
        [nowMs, options.cursor ?? null, options.limit],
      );
      const ids = result.rows.map((row) => row.session_id as SessionId);
      return {
        sessionIds: ids,
        ...(ids.length === options.limit ? { nextCursor: String(ids.at(-1)) } : {}),
      };
    });
  }

  async close(): Promise<void> {
    await this.client.end?.();
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
    return withTransaction(this.pool, async (client) => {
      await putSession(client, record);
      const lease = await acquireLease(client, record.session.id, holder, ttlMs);
      if (lease && initialEvent) await appendOutbox(client, initialEvent(lease));
      return lease;
    });
  }

  async runSessionTransaction<T>(
    sessionId: SessionId,
    lease: Pick<SessionLease, "holder" | "fence">,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await assertLease(client, sessionId, lease);
      const result = await operation(new PostgresTransaction(client, sessionId, lease.fence));
      await assertLease(client, sessionId, lease);
      return result;
    });
  }

  async runUnfencedSessionTransaction<T>(
    sessionId: SessionId,
    operation: (tx: DurableSessionTransaction) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      // The transaction is also the creation boundary for callers that have
      // not attached a live session yet. Do not preflight with a required row:
      // Runtime.startSession() deliberately calls this method before the
      // session exists, then puts it through the transaction callback.
      return operation(new PostgresTransaction(client, sessionId, 0));
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
  type PostgresRetentionJobOptions,
  type RetentionRunResult,
} from "./maintenance.js";
export { runPostgresMigrations, type PostgresMigration } from "./migrations.js";

class PostgresTransaction implements DurableSessionTransaction {
  constructor(
    readonly client: SqlClient,
    readonly sessionId: SessionId,
    readonly fence: number,
  ) {}

  getSession(id: SessionId): Promise<StoredSessionRecord | null> {
    this.assertSession(id);
    return getSession(this.client, id, true);
  }

  putSession(record: StoredSessionRecord): Promise<void> {
    this.assertSession(record.session.id);
    return this.putSessionWithFence(record);
  }

  private async putSessionWithFence(record: StoredSessionRecord): Promise<void> {
    await putSession(this.client, record);
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
    await appendOutbox(this.client, event);
  }

  private assertSession(candidate: SessionId): void {
    if (candidate !== this.sessionId) {
      throw new InvalidArgumentError(
        `Session transaction ${this.sessionId} cannot access ${candidate}`,
      );
    }
  }
}

async function appendOutbox(client: SqlClient, event: DurableOutboxEvent): Promise<void> {
  const envelope = decodeOutboxEnvelope(
    event.aggregateType,
    event.envelope,
    `outbox:${event.id}`,
    event.version,
  );
  await client.query(
    `INSERT INTO tvic_outbox
      (id, aggregate_type, aggregate_id, session_id, version, fence, envelope, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.aggregateType,
      event.aggregateId,
      event.sessionId,
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

async function putSession(client: SqlClient, record: StoredSessionRecord): Promise<void> {
  await client.query(
    `INSERT INTO tvic_sessions
      (id, agent_id, status, created_at, started_at, ended_at, payload, runtime,
       version, last_fence, last_activity_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 0, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    sessionValues(record),
  );
  const existing = await getSession(client, record.session.id, true);
  if (!existing) throw new RecordNotFoundError(`session:${record.session.id}`);
  if (!sameStoredRecord(existing, record)) {
    throw new RecordConflictError(`session:${record.session.id}`);
  }
}

async function updateSession(
  client: SqlClient,
  id: SessionId,
  updater: (record: StoredSessionRecord) => StoredSessionRecord,
): Promise<StoredSessionRecord> {
  const current = await getSession(client, id, true);
  if (!current) throw new RecordNotFoundError(`session:${id}`);
  const next = updater(current);
  const startedAt = "startedAt" in next.session ? next.session.startedAt : null;
  const endedAt = "endedAt" in next.session ? next.session.endedAt : null;
  await client.query(
    "UPDATE tvic_sessions SET payload = $2::jsonb, runtime = $3::jsonb, status = $4, started_at = $5, ended_at = $6, version = version + 1, last_activity_at = NOW(), updated_at = NOW() WHERE id = $1",
    [
      id,
      JSON.stringify(next.session),
      JSON.stringify(next.runtime),
      next.session.status,
      startedAt,
      endedAt,
    ],
  );
  return { ...next, version: (current.version ?? 1) + 1 };
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
  const endedAt = "endedAt" in next.turn ? next.turn.endedAt : null;
  await client.query(
    "UPDATE tvic_turns SET payload = $3::jsonb, runtime = $4::jsonb, status = $5, started_at = $6, ended_at = $7, version = version + 1, updated_at = NOW() WHERE session_id = $1 AND id = $2",
    [
      sessionId,
      id,
      JSON.stringify(next.turn),
      JSON.stringify(next.runtime),
      next.turn.status,
      next.turn.startedAt,
      endedAt,
    ],
  );
  return { ...next, version: (current.version ?? 1) + 1 };
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
  const startedAt = "startedAt" in next.toolCall ? next.toolCall.startedAt : null;
  const endedAt = "endedAt" in next.toolCall ? next.toolCall.endedAt : null;
  await client.query(
    "UPDATE tvic_tool_calls SET payload = $3::jsonb, runtime = $4::jsonb, status = $5, started_at = $6, ended_at = $7, version = version + 1, updated_at = NOW() WHERE session_id = $1 AND id = $2",
    [
      sessionId,
      id,
      JSON.stringify(next.toolCall),
      JSON.stringify(next.runtime),
      next.toolCall.status,
      startedAt,
      endedAt,
    ],
  );
  return { ...next, version: (current.version ?? 1) + 1 };
}

async function assertLease(
  client: SqlClient,
  sessionId: SessionId,
  lease: Pick<SessionLease, "holder" | "fence">,
): Promise<void> {
  const now = await databaseNowMs(client);
  const result = await client.query<LeaseRow>(
    "SELECT session_id, holder, fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.holder !== lease.holder ||
    Number(row.fence) !== lease.fence ||
    Number(row.expires_at_ms) <= now
  ) {
    throw new LeaseLostError(sessionId);
  }
}

async function acquireLease(
  client: SqlClient,
  sessionId: SessionId,
  holder: string,
  ttlMs: number,
): Promise<SessionLease | null> {
  const session = await client.query<{ id: string } & Record<string, unknown>>(
    "SELECT id FROM tvic_sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  if (!session.rows[0]) throw new RecordNotFoundError(`session:${sessionId}`);
  const now = await databaseNowMs(client);
  const result = await client.query<LeaseRow>(
    "SELECT session_id, holder, fence, acquired_at_ms, renewed_at_ms, expires_at_ms FROM tvic_session_leases WHERE session_id = $1 FOR UPDATE",
    [sessionId],
  );
  const current = result.rows[0];
  if (current && Number(current.expires_at_ms) > now) {
    return current.holder === holder ? leaseFromRow(current) : null;
  }
  const fence = Number(current?.fence ?? 0) + 1;
  await client.query(
    `INSERT INTO tvic_session_leases
      (session_id, holder, fence, acquired_at_ms, renewed_at_ms, expires_at_ms, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, NOW())
     ON CONFLICT (session_id) DO UPDATE SET holder = EXCLUDED.holder,
       fence = EXCLUDED.fence, acquired_at_ms = EXCLUDED.acquired_at_ms,
       renewed_at_ms = EXCLUDED.renewed_at_ms, expires_at_ms = EXCLUDED.expires_at_ms,
       updated_at = NOW()`,
    [sessionId, holder, fence, now, now + ttlMs],
  );
  return {
    sessionId,
    holder,
    fence,
    acquiredAtMs: now,
    renewedAtMs: now,
    expiresAtMs: now + ttlMs,
  };
}
