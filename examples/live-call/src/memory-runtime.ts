import { Pool, type PoolClient } from "pg";

import type { Memory } from "@tvic/core";
import {
  createPostgresMemory,
  runPostgresMemoryMigrations,
  type SqlClient,
  type SqlPool,
} from "@tvic/dal-postgres-memory";

type SqlResult<Row> = { rows: readonly Row[]; rowCount: number };

export interface ConfiguredMemory {
  readonly memory: Memory;
  readonly stopExternalServices: () => Promise<void>;
}

export async function createConfiguredMemory(seed: Memory): Promise<ConfiguredMemory> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.warn(
      "[live-call] user-scoped memory is process-local in this example; configure a durable Memory backend before advertising cross-call recall.",
    );
    return { memory: seed, stopExternalServices: async () => undefined };
  }

  const pg = new Pool({ connectionString: databaseUrl });
  try {
    const pool = adaptPool(pg);
    await runPostgresMemoryMigrations(pool);
    const memory = createPostgresMemory({ pool });
    return {
      memory,
      stopExternalServices: async () => {
        await pg.end().catch(() => undefined);
      },
    };
  } catch (error) {
    await pg.end().catch(() => undefined);
    throw error;
  }
}

function adaptPool(pool: Pool): SqlPool {
  return {
    query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      adaptQuery<Row>(pool, text, values),
    connect: async () => adaptConnection(await pool.connect()),
  };
}

function adaptConnection(connection: PoolClient): SqlClient & { readonly release: () => void } {
  return {
    query: <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
      adaptQuery<Row>(connection, text, values),
    release: () => connection.release(),
  };
}

async function adaptQuery<Row extends Record<string, unknown>>(
  client: Pool | PoolClient,
  text: string,
  values?: readonly unknown[],
): Promise<SqlResult<Row>> {
  const result = await client.query(text, values ? [...values] : undefined);
  return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? 0 };
}
