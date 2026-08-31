# Cross-call memory demos

Three runnable demos of the TVIC cross-call memory contract. Each
demo simulates a "Monday: agent learns your name; Wednesday: agent
greets you by name" flow.

## What the demo proves

- **Cross-call memory is portable.** The pre-call memory block is the
  same shape regardless of channel (CLI / WebSocket / Twilio) or
  transport. The runtime's `PreCallMemoryContext` is the contract.
- **The runtime owns the session; the user owns the data.** The agent
  reads from a `Memory` adapter that the user provides. `InMemoryMemory`
  is the dev default. `PostgresMemory` (via `dal-postgres-memory`) is
  the production default. Community adapters (Mem0, Supermemory,
  pgvector) are drop-in.
- **`deleteSessionScopeOnEnd: true` purges `session` scope, leaves
  `user` scope.** This is the Vapi Zero Data Retention posture. Verified by
  the test `deleteSessionScopeOnEnd: true purges session scope but leaves
user scope intact`.

## Run the CLI sub-demo

```bash
pnpm install
pnpm --filter @tvic/example-memory-demo start:cli -- --user-id ada
```

Output:

```
=== Call 1: agent learns the caller's name ===
=== Call 2 (next day): agent greets by name ===
Pre-call memory block injected into the system prompt:
<memory>
  fact:preferred_name = Ada Lovelace
  fact:account_id = ACC-8821
  fact:favorite_color = blue
</memory>
=== Cleanup ===
OK: cross-call memory demo finished cleanly.
```

The demo simulates the LLM's `remember_fact` call by writing directly to
the memory adapter. In a real voice flow the LLM calls the
`remember_fact` tool that the runtime wires in (see
`packages/runtime/src/remember-fact-tool.ts`).

## Run the voice-mode sub-demo

```bash
pnpm --filter @tvic/example-memory-demo start:voice-mode -- --user-id ada
```

Same flow over the browser WebSocket channel. The script does not
spin up a real voice gateway; it exercises the runtime's pre-call
memory contract. For a runnable browser voice-mode, see
`examples/voice-mode` and reuse this example's `buildMemoryDemoAgent`
and `createPostgresMemoryDemoMemory`.

## Run the live-call sub-demo

```bash
pnpm --filter @tvic/example-memory-demo start:live-call -- --user-id ada
```

Same flow over the Twilio Media Streams channel. The script does not
spin up a real Twilio gateway; it exercises the runtime's pre-call
memory contract. For a runnable Twilio gateway, see `examples/live-call`
and reuse this example's `buildMemoryDemoAgent` and
`createPostgresMemoryDemoMemory`.

## Run with Postgres (cross-process / cross-restart)

```bash
export DATABASE_URL=postgres://postgres:tvic@127.0.0.1:5432/tvic_memory
pnpm --filter @tvic/dal-postgres-memory build
pnpm --filter @tvic/example-memory-demo start:cli -- --user-id ada --memory postgres --database-url $DATABASE_URL
```

The Postgres adapter persists memory across process restarts. Run the
demo, kill it, run it again with the same `--user-id`, and the second
run's pre-call memory block is populated from the first run's writes.

## Run the tests

```bash
pnpm --filter @tvic/example-memory-demo test
```

The tests cover three invariants:

1. The pre-call loader injects prior memory into the system prompt.
2. The runtime's `#updateMemory` does not overwrite `user`-scope facts
   across calls.
3. The `deleteSessionScopeOnEnd: true` default purges `session` scope
   but leaves `user` scope intact across sessions.

The integration test against Postgres is gated by `TVIC_RUN_INTEGRATION=1`
and `MEMORY_INTEGRATION_URL`. It runs in CI.

## What's NOT in this demo

By design:

- **Vector search / RAG.** The cross-call greeting is key-based, not
  relevance-based. Add a `Mem0` / `pgvector` adapter to enable recall
  by relevance.
- **LLM-driven summarization / `Observer`.** The demo's "agent learns
  your name" step is simulated. In a real voice flow the LLM calls
  `remember_fact` during the call; a `summarizeCall` step at call end
  extracts durable facts. See `examples/post-call-summarization/`
  (the example is included in this repository).
- **A live `Call` object.** This demo uses a synthetic `RingingCall`.
  Real voice gateways supply a `Call` with a real
  `mediaTransport` and `createdAt`.
- **Auth, RBAC, OAuth.** Tenant concern. The runtime's
  `ToolExecutionContext` carries a `tenant` field the user reads inside
  `execute`.

## File map

- `src/agent.ts` — the shared agent definition; uses non-calling demo providers so
  the demo can run without API keys.
- `src/memory-runtime.ts` — `createMemoryDemoMemory()` and
  `createPostgresMemoryDemoMemory()` factories.
- `src/cli/main.ts` — text-only sub-demo.
- `src/voice-mode/main.ts` — browser voice-mode shape (no real
  gateway).
- `src/live-call/main.ts` — Twilio Media Streams shape (no real
  gateway).
- `test/memory-demo.test.ts` — the three invariants above, always-on
  for `InMemoryMemory` and gated for `PostgresMemory`.
