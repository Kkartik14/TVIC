import assert from "node:assert/strict";
import { requireLocalDurableIntegrationTargets } from "./local-durable-integration-targets.mjs";

const localTargets = {
  TVIC_RUN_INTEGRATION: "1",
  DATABASE_URL: "postgres://tvic:secret@127.0.0.1:5432/tvic",
  REDIS_URL: "redis://127.0.0.1:6379/2",
};

assert.deepEqual(requireLocalDurableIntegrationTargets(localTargets), {
  databaseUrl: localTargets.DATABASE_URL,
  memoryDatabaseUrl: localTargets.DATABASE_URL,
  redisUrl: localTargets.REDIS_URL,
});
assert.throws(
  () => requireLocalDurableIntegrationTargets({ ...localTargets, TVIC_RUN_INTEGRATION: "" }),
  /TVIC_RUN_INTEGRATION=1/,
);
assert.throws(
  () =>
    requireLocalDurableIntegrationTargets({
      ...localTargets,
      DATABASE_URL: "postgres://tvic:secret@database.example:5432/tvic",
    }),
  /loopback host/,
);
assert.throws(
  () =>
    requireLocalDurableIntegrationTargets({
      ...localTargets,
      REDIS_URL: "redis://cache.example:6379",
    }),
  /loopback host/,
);
assert.throws(
  () =>
    requireLocalDurableIntegrationTargets({
      ...localTargets,
      REDIS_URL: "rediss://127.0.0.1:6379",
    }),
  /supported local service protocol/,
);

process.stdout.write("Local durable integration target checks passed\n");
