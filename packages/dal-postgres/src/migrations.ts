import { BUNDLED_POSTGRES_MIGRATIONS } from "./bundled-migrations.js";
import type { SqlClient, SqlPool } from "./index.js";
import { withBackendBoundary } from "./postgres-helpers.js";

export interface PostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export async function runPostgresMigrations(
  pool: SqlPool,
  migrations?: readonly PostgresMigration[],
): Promise<readonly number[]> {
  return withBackendBoundary(() => runMigrations(pool, migrations));
}

async function runMigrations(
  pool: SqlPool,
  migrations?: readonly PostgresMigration[],
): Promise<readonly number[]> {
  const orderedMigrations = migrations ?? BUNDLED_POSTGRES_MIGRATIONS;
  const connection = await pool.connect();
  try {
    // A session advisory lock serializes runners even though the bundled SQL
    // files own their transaction boundaries. It also keeps every metadata
    // query on the same connection as the lock.
    await connection.query("SELECT pg_advisory_lock(hashtext('tvic:schema:migrations'))");
    try {
      await connection.query(
        `CREATE TABLE IF NOT EXISTS tvic_schema_migrations (
           version integer PRIMARY KEY,
           name text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT NOW()
         )`,
      );
      const appliedRows = await connection.query<
        { version: number | string } & Record<string, unknown>
      >("SELECT version FROM tvic_schema_migrations ORDER BY version");
      const applied = new Set(appliedRows.rows.map((row) => Number(row.version)));
      const appliedNow: number[] = [];
      for (const migration of [...orderedMigrations].sort((a, b) => a.version - b.version)) {
        if (applied.has(migration.version)) continue;
        await removeInvalidConcurrentIndex(connection, migration.sql);
        await connection.query(migration.sql);
        await connection.query(
          "INSERT INTO tvic_schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
          [migration.version, migration.name],
        );
        appliedNow.push(migration.version);
      }
      return appliedNow;
    } finally {
      await connection
        .query("SELECT pg_advisory_unlock(hashtext('tvic:schema:migrations'))")
        .catch(() => undefined);
    }
  } finally {
    connection.release();
  }
}

async function removeInvalidConcurrentIndex(connection: SqlClient, sql: string): Promise<void> {
  const match = sql.match(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:""|[^"])*)"|([a-z_][a-z0-9_$]*))/i,
  );
  const indexName = match?.[1]?.replaceAll('""', '"') ?? match?.[2];
  if (!indexName) return;

  const result = await connection.query<{ indisvalid: boolean } & Record<string, unknown>>(
    `SELECT index_state.indisvalid
     FROM pg_class AS index_relation
     JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
     JOIN pg_index AS index_state ON index_state.indexrelid = index_relation.oid
     WHERE index_namespace.nspname = current_schema()
       AND index_relation.relname = $1`,
    [indexName],
  );
  if (result.rows[0]?.indisvalid === false) {
    const quotedName = `"${indexName.replaceAll('"', '""')}"`;
    await connection.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quotedName}`);
  }
}
