const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function requireLocalDurableIntegrationTargets(env = process.env) {
  if (env.TVIC_RUN_INTEGRATION !== "1") {
    throw new Error("Set TVIC_RUN_INTEGRATION=1 to run durable integration checks");
  }

  const databaseUrl = env.DATABASE_URL;
  const memoryDatabaseUrl = env.MEMORY_INTEGRATION_URL ?? databaseUrl;
  const redisUrl = env.REDIS_URL;
  if (!databaseUrl || !memoryDatabaseUrl || !redisUrl) {
    throw new Error(
      "DATABASE_URL, MEMORY_INTEGRATION_URL (or DATABASE_URL), and REDIS_URL are required",
    );
  }

  assertLoopbackUrl(databaseUrl, "DATABASE_URL", ["postgres:", "postgresql:"]);
  assertLoopbackUrl(memoryDatabaseUrl, "MEMORY_INTEGRATION_URL", ["postgres:", "postgresql:"]);
  assertLoopbackUrl(redisUrl, "REDIS_URL", ["redis:"]);

  return { databaseUrl, memoryDatabaseUrl, redisUrl };
}

function assertLoopbackUrl(value, name, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid local service URL`);
  }
  if (!protocols.includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${name} must use a loopback host and a supported local service protocol`);
  }
}
