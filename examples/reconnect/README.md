# Reconnect example

This example shows how an application can reattach a durable TVIC session after
a network or process boundary change.

TVIC provides the session attachment seam. The application owns the reconnect
token format, signing, storage, expiry, user binding, and identity provider.
The example uses an in-memory HMAC token store only to make the flow executable.

## Run

```bash
pnpm install
pnpm --filter @tvic/example-reconnect start
```

The script:

1. Starts a runtime and creates a simulated session.
2. Mints an application-owned token bound to the user and session.
3. Simulates a network reconnect.
4. Verifies the token and looks up the session.
5. Calls `runtime.attachSession()`.
6. Detaches and shuts down cleanly.

## Production changes

Replace the demo token store with a signed token or opaque reference backed by
your identity and storage systems. Add:

- Short token expiry
- Single-use or bounded-use rules
- User and tenant binding
- Revocation
- Replay protection
- Shared durable session state
- A fresh authenticated transport handle on reconnect
- Tests for expired, forged, cross-user, and replayed tokens

The token signature proves that the token was not changed. It does not by itself
prove that the token belongs to the current requester. The application store and
identity check must make that decision.

## Test

```bash
pnpm --filter @tvic/example-reconnect test
pnpm --filter @tvic/example-reconnect typecheck
```

## Files

- `src/main.ts`: token store, gateway shape, and attach flow
- `test/reconnect.test.ts`: reconnect and token cases

Read [Transports](../../docs/transports.md) and
[Persistence](../../docs/persistence.md) before using reconnect across
replicas.
