# Post-call summarization example

This example shows how to run application-owned work after a session ends. The
runtime calls `RuntimeOptions.onSessionEnd` after terminalization and its
best-effort memory finalization attempt.

The example uses a deterministic offline summarizer and in-memory memory. It
does not contact an LLM or provider.

## Run

```bash
pnpm install
pnpm --filter @tvic/example-post-call-summarization start -- --user-id ada
```

The process creates one simulated call, writes a caller fact, ends the session,
and starts a second call that can read the summary and fact.

## Replace the summarizer

The application chooses:

- Which LLM to call
- The summarization prompt
- The output schema
- The memory keys and scopes
- Whether a failed summary should be retried externally

The runtime owns the lifecycle but does not retry the hook. Use a durable queue
or external job system if losing a post-call task is unacceptable.

The hook should be short and bounded. Do not block realtime audio on work that
belongs after the call.

## Test

```bash
pnpm --filter @tvic/example-post-call-summarization test
pnpm --filter @tvic/example-post-call-summarization typecheck
```

The test covers terminal ordering, memory writes, schema validation, and the
cross-call result.

## Files

- `src/agent.ts`: deterministic demo agent and summarizer
- `src/main.ts`: runtime, hook, simulated calls, and memory reads
- `test/post-call-summarization.test.ts`: lifecycle assertions

Read [Tools and workflows](../../docs/tools-and-workflows.md) and
[Persistence](../../docs/persistence.md) before using this pattern with real
customer data.
