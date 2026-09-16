# Persistence and memory

TVIC has two related persistence concerns:

1. Durable runtime state for sessions, turns, tool calls, leases, and tool
   idempotency.
2. Application memory for facts, summaries, open items, and other context that
   can be loaded into a later call.

The runtime owns the lifecycle contract. Your application chooses the adapter,
database, retention policy, access controls, and backup strategy.

## Start with in-memory state

The default runtime uses in-memory stores. This is useful for local development
and deterministic tests:

```ts
import { createInMemoryDurableRuntimeStore, createInMemoryMemory } from "voice-runtime";
import { createRuntime } from "voice-runtime";

const memory = createInMemoryMemory();
const durableStore = createInMemoryDurableRuntimeStore();
const runtime = createRuntime({ durableStore, memory });
```

In-memory state disappears when the process exits. It is not suitable for a
multi-instance deployment or cross-process reconnect.

## PostgreSQL runtime state

Install a PostgreSQL driver in your application:

```bash
npm install pg
```

Create a pool, run the migrations during deployment, and inject the store:

```ts
import { Pool } from "pg";
import {
  createPostgresDurableRuntimeStore,
  createRuntime,
  runPostgresMigrations,
} from "voice-runtime";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await runPostgresMigrations(pool);

const durableStore = createPostgresDurableRuntimeStore({ pool });
const runtime = createRuntime({
  durableStore,
  durableStoreOwnership: "caller",
});
```

`durableStoreOwnership: "caller"` means the runtime will not close the pool
when it stops. Use the default runtime ownership when the pool belongs only to
the runtime and should close with it.

## Redis runtime state

Install a Redis client and adapt it to the exported Redis client shape:

```bash
npm install redis
```

```ts
import { createClient } from "redis";
import { createRedisDurableRuntimeStore, createRuntime } from "voice-runtime";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const durableStore = createRedisDurableRuntimeStore(redis);
const runtime = createRuntime({
  durableStore,
  durableStoreOwnership: "caller",
});
```

The runtime uses Redis server time and atomic operations for its Redis-backed
state and idempotency behavior. Keep Redis durable enough for the failure model
your application needs.

## Composite PostgreSQL and Redis state

The composite adapter uses PostgreSQL as the authoritative store and Redis as a
cache and projection layer:

```ts
import { Pool } from "pg";
import { createClient } from "redis";
import {
  createPostgresRedisDurableRuntimeStore,
  createRuntime,
  runPostgresMigrations,
} from "voice-runtime";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
await runPostgresMigrations(pool);

const durableStore = createPostgresRedisDurableRuntimeStore({
  pool,
  redis,
});
const runtime = createRuntime({
  durableStore,
  durableStoreOwnership: "caller",
});
```

Use one shared composite store instance per runtime process. Start its outbox
worker when the application needs cross-process cache projection. The composite
adapter supplies the projection behavior; the application configures the worker
schedule and lifecycle.

## PostgreSQL memory

Memory is a separate adapter. Install `pg`, run its migrations, and pass the
memory implementation into the runtime:

```ts
import { Pool } from "pg";
import { createPostgresMemory, createRuntime, runPostgresMemoryMigrations } from "voice-runtime";

const memoryPool = new Pool({ connectionString: process.env.DATABASE_URL });
await runPostgresMemoryMigrations(memoryPool);

const memory = createPostgresMemory({ pool: memoryPool });
const runtime = createRuntime({ memory });
```

The runtime can use one PostgreSQL database for runtime state and memory if both
migration functions are run. Keep migration ownership and connection-pool
shutdown in one application lifecycle.

## Local PostgreSQL and Redis with Docker

The repository includes an integration stack:

```bash
pnpm infra:up
```

It starts:

| Service       | Local address                                     |
| ------------- | ------------------------------------------------- |
| PostgreSQL 16 | `postgres://tvic:tvic_local@127.0.0.1:55432/tvic` |
| Redis 7       | `redis://127.0.0.1:56379`                         |

Use `pnpm infra:logs` to inspect service output and `pnpm infra:down` to stop
the containers. The compose file uses named volumes so data remains after a
normal stop. Delete those volumes only when you intentionally want a clean
local database.

## Memory scopes

| Scope          | Lifetime                           | Example                                       |
| -------------- | ---------------------------------- | --------------------------------------------- |
| `session`      | One call unless retained by policy | Temporary facts from the current conversation |
| `user`         | Across calls for one user          | Preferred name or language                    |
| `organization` | Shared by an organization          | Tenant-wide business context                  |
| `workflow`     | Shared by a workflow               | Intake process configuration                  |

Enable only the scopes the agent needs:

```ts
const agent = createVoiceAgent({
  prompt: "Remember stable caller preferences only.",
  memoryPolicy: {
    enabled: true,
    scopes: ["session", "user"],
    preCallLoad: "all",
    deleteSessionScopeOnEnd: true,
    canLlmWrite: true,
  },
  providers,
});
```

Session scope is purged by default at session end. User, organization, and
workflow scope are not deleted by that purge. `deleteForUser()` is a privileged
erasure primitive, not an authorization system.

## Pre-call context

The default resolver loads memory for the IDs supplied at session startup. A
custom `preCallContextResolver` can add non-memory context such as CRM data,
feature flags, or tenant configuration. That data is rendered separately from
the memory block in the model context.

Keep pre-call context bounded with:

- `maxPreCallBytes`
- `maxPreCallEntries`
- `maxHistoryBytes`
- `maxHistoryMessages`

Do not put a full customer record into the prompt. Select the fields the agent
needs and redact secrets.

## Retention and deletion

Decide and document:

- Which scopes may contain personal data
- How long each scope survives
- Which user action deletes data
- Whether session data is purged at call end
- Whether provider requests or application logs retain copies
- How backups and replicas are erased
- Which tenants may read shared organization or workflow data

TVIC validates JSON-compatible memory values. It does not classify personal
data or enforce your tenant authorization policy.

## Cross-process reconnect

Use a durable runtime store for reconnect. The application owns the reconnect
token format, token verification, user binding, expiration, and transport
lookup. TVIC provides the session attachment seam. See the
[reconnect example](../examples/reconnect/README.md).

## Production checklist

- Run migrations as a deployment step, not on every request.
- Use a connection pool with explicit maximum size and timeouts.
- Grant the database user only the required schema permissions.
- Encrypt connections and secrets in transit.
- Monitor database, Redis, lease, and outbox health.
- Set an explicit retention policy for every memory scope.
- Test restart and reconnect behavior with the same durable store.
- Test a database outage and a Redis outage separately.
- Decide whether the runtime or the application owns closing injected clients.
