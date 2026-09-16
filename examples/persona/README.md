# Persona example

This example shows one agent serving multiple tenants with tenant-specific
context. The runtime asks the application's persona resolver for an instruction
override and string variables at session start.

The example uses a mocked CRM and simulated providers. It does not contact a
provider or open a real browser or phone connection.

## Run

From the repository root:

```bash
pnpm install
pnpm --filter @tvic/example-persona start -- --user-id ada --tenant acme
pnpm --filter @tvic/example-persona start -- --user-id bob --tenant globex
```

The output shows the same base agent receiving different tenant context.

## What it demonstrates

- One agent definition can serve many organizations.
- The application remains the source of truth for CRM and tenant data.
- The persona resolver can change instructions for a session.
- Variables can carry small values such as a customer name or account ID.
- Organization identity can be carried into the runtime and memory policy.

## Important boundary

The resolver is not an authorization system. Check the authenticated user's
organization before returning context. Return only the fields the model needs.
Do not put secrets or an entire customer record into the prompt.

## Test

```bash
pnpm --filter @tvic/example-persona test
pnpm --filter @tvic/example-persona typecheck
```

## Files

- `src/main.ts`: agent, persona resolver, and simulated sessions
- `src/mock-crm.ts`: application-owned CRM fixture
- `test/persona.test.ts`: tenant context and prompt behavior tests

For a real voice connection, start with the [browser voice example](../voice-mode/README.md)
or the [Twilio example](../live-call/README.md), then add the persona resolver
to the agent definition.
