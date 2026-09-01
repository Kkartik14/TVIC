import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { withBackendBoundary } from "./postgres-helpers.js";
import type { SqlPool } from "./postgres-helpers.js";

export interface PostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export async function runPostgresMemoryMigrations(
  pool: SqlPool,
  migrations?: readonly PostgresMigration[],
): Promise<readonly number[]> {
  return withBackendBoundary(() => runMigrations(pool, migrations));
}

async function runMigrations(
  pool: SqlPool,
  migrations?: readonly PostgresMigration[],
): Promise<readonly number[]> {
  const orderedMigrations = migrations ?? (await loadBundledMigrations());
  const connection = await pool.connect();
  try {
    await connection.query("SELECT pg_advisory_lock(hashtext('tvic:memory:schema:migrations'))");
    try {
      await connection.query(
        `CREATE TABLE IF NOT EXISTS tvic_memory_schema_migrations (
           version integer PRIMARY KEY,
           name text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT NOW()
         )`,
      );
      const appliedRows = await connection.query<
        { version: number | string } & Record<string, unknown>
      >("SELECT version FROM tvic_memory_schema_migrations ORDER BY version");
      const applied = new Set(appliedRows.rows.map((row) => Number(row.version)));
      const appliedNow: number[] = [];
      for (const migration of [...orderedMigrations].sort((a, b) => a.version - b.version)) {
        if (applied.has(migration.version)) continue;
        await connection.query(migration.sql);
        await connection.query(
          "INSERT INTO tvic_memory_schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
          [migration.version, migration.name],
        );
        appliedNow.push(migration.version);
      }
      return appliedNow;
    } finally {
      await connection
        .query("SELECT pg_advisory_unlock(hashtext('tvic:memory:schema:migrations'))")
        .catch(() => undefined);
    }
  } finally {
    connection.release();
  }
}

async function loadBundledMigrations(): Promise<readonly PostgresMigration[]> {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = (await readdir(directory)).filter((file) => /^\d+_[^/]+\.sql$/.test(file)).sort();
  return Promise.all(
    files.map(async (name) => ({
      version: Number(name.slice(0, name.indexOf("_"))),
      name,
      sql: await readFile(`${directory}/${name}`, "utf8"),
    })),
  );
}
