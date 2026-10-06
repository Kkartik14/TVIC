import { Pool, type PoolConfig } from "pg";

// Finite example defaults; tune pool size and timeouts to the deployment's
// request, database, and shutdown budgets.
const VOICE_MODE_POSTGRES_POOL_LIMITS = {
  max: 5,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,
  lock_timeout: 1_000,
} satisfies PoolConfig;

// Schema changes, including concurrent index builds, use a separate budget.
const VOICE_MODE_POSTGRES_MIGRATION_LIMITS = {
  max: 1,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 300_000,
  lock_timeout: 30_000,
} satisfies PoolConfig;

export function createVoiceModePostgresPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    ...VOICE_MODE_POSTGRES_POOL_LIMITS,
  });
}

export function createVoiceModePostgresMigrationPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    ...VOICE_MODE_POSTGRES_MIGRATION_LIMITS,
  });
}

export async function withVoiceModePostgresMigrationPool<Result>(
  connectionString: string,
  migrate: (pool: Pool) => Promise<Result>,
): Promise<Result> {
  const pool = createVoiceModePostgresMigrationPool(connectionString);
  let result: Result;
  try {
    result = await migrate(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  await pool.end();
  return result;
}
