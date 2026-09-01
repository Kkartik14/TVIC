import {
  BackendUnavailableError,
  DurableError,
  type Memory,
  type MemoryEntryId,
  type Timestamp,
} from "@tvic/core";
import { stableStringify } from "@tvic/dal-codec";

/**
 * The minimum SQL surface a Postgres driver must provide for this package.
 * Drivers are injected — this package never imports `pg` directly. Matches
 * the contract used by `@tvic/dal-postgres` so a single shared `pg` pool can
 * be passed to both packages.
 */
export interface SqlClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly TRow[]; rowCount: number }>;
}

export interface SqlPool {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly TRow[]; rowCount: number }>;
  connect(): Promise<SqlClient & { readonly release: () => void }>;
  end?(): Promise<void>;
}

export async function databaseNowMs(client: SqlClient): Promise<number> {
  const result = await client.query<{ now_ms: number | string } & Record<string, unknown>>(
    "SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now_ms",
  );
  return Number(result.rows[0]?.now_ms ?? Date.now());
}

export async function withTransaction<T>(
  client: SqlClient,
  operation: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  const pool = client as SqlPool;
  if (typeof pool.connect !== "function") {
    return operation(client).catch((error) => {
      throw classifyPostgresError(error);
    });
  }
  let connection: (SqlClient & { readonly release: () => void }) | undefined;
  try {
    connection = await pool.connect();
    await connection.query("BEGIN");
    const result = await operation(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    if (connection) await connection.query("ROLLBACK").catch(() => undefined);
    throw classifyPostgresError(error);
  } finally {
    connection?.release();
  }
}

export async function withBackendBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw classifyPostgresError(error);
  }
}

function classifyPostgresError(error: unknown): Error {
  if (error instanceof DurableError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BackendUnavailableError(`PostgreSQL memory operation failed: ${message}`);
}

export { stableStringify };
export type { Memory, MemoryEntryId, Timestamp };
