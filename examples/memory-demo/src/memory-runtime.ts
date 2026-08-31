/**
 * Memory runtime wiring for the memory-demo sub-demos. Three flavors:
 * - `createMemoryDemoMemory()`: in-memory only. Used by the CLI sub-demo
 *   and the unit tests; the user-scope is process-local.
 * - `createPostgresMemoryDemoMemory()`: real Postgres + pg via
 *   `DATABASE_URL`. Used by the voice-mode and live-call sub-demos.
 * - `stopMemoryServices()`: tear down any external services (Postgres
 *   pool, etc.). The CLI sub-demo no-ops.
 */
import { createInMemoryMemory } from "@tvic/dal";
import type { Call, Memory, MediaTransport, RingingCall, UserId } from "@tvic/core";
import {
  createPostgresMemory,
  runPostgresMemoryMigrations,
  type SqlClient,
  type SqlPool,
} from "@tvic/dal-postgres-memory";
import { PCM16_16K_MONO } from "@tvic/core";
import { Pool, type PoolClient } from "pg";

/**
 * Build a minimal synthetic `RingingCall` for demos and tests. The runtime
 * does not inspect `provider` or `mediaTransport` in this path; real gateways
 * provide those values from the live call.
 */
export function buildDemoCall(id: string, from: UserId): RingingCall {
  const transport: MediaTransport = {
    kind: "websocket",
    format: PCM16_16K_MONO,
  };
  return {
    id: id as Call["id"],
    provider: "demo",
    direction: "inbound",
    from,
    to: "agent",
    status: "ringing",
    mediaTransport: transport,
    createdAt: new Date().toISOString() as Call["createdAt"],
  };
}

export interface ConfiguredMemory {
  readonly memory: Memory;
  readonly stopExternalServices: () => Promise<void>;
}

export function createMemoryDemoMemory(): ConfiguredMemory {
  return {
    memory: createInMemoryMemory(),
    stopExternalServices: async () => undefined,
  };
}

export async function createPostgresMemoryDemoMemory(
  databaseUrl: string,
): Promise<ConfiguredMemory> {
  const pg = new Pool({ connectionString: databaseUrl });
  const pool = adaptPool(pg);
  try {
    await runPostgresMemoryMigrations(pool);
  } catch (error) {
    await pg.end().catch(() => undefined);
    throw error;
  }
  return {
    memory: createPostgresMemory({ pool }),
    stopExternalServices: async () => pg.end().catch(() => undefined),
  };
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
): Promise<{ rows: readonly Row[]; rowCount: number }> {
  const result = await client.query(text, values ? [...values] : undefined);
  return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? 0 };
}
