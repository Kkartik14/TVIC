import {
  BackendUnavailableError,
  DurableError,
  LeaseLostError,
  RecordConflictError,
} from "@tvic/core";
import type { SqlClient, SqlPool } from "./index.js";

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
  if (typeof error === "object" && error !== null) {
    const postgresError = error as { readonly code?: unknown; readonly constraint?: unknown };
    if (
      postgresError.code === "23514" &&
      postgresError.constraint === "tvic_tool_idempotency_current_session_lease"
    ) {
      return new LeaseLostError("unknown");
    }
    if (
      postgresError.code === "23514" &&
      postgresError.constraint === "tvic_tool_idempotency_session_identity"
    ) {
      return new RecordConflictError("tool_idempotency");
    }
  }
  return new BackendUnavailableError(
    `PostgreSQL operation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
