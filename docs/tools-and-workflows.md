# Tools and workflows

A prompt tells the model how to speak and reason. Tools let it ask your
application to perform an action. The application remains the authority for
identity, permissions, business rules, and data.

TVIC provides the tool contract, validation, lifecycle, timeout, retry, abort,
and idempotency building blocks. It does not provide your CRM, payment system,
RBAC policy, or business workflow engine.

## Define a tool

```ts
import { defineTool } from "voice-runtime";

const lookupOrder = defineTool<
  { orderId: string },
  { orderId: string; status: "processing" | "shipped" | "delivered" }
>({
  id: "lookup_order",
  name: "lookup_order",
  description: "Looks up the status of an order for the authenticated caller.",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  outputSchema: {
    type: "object",
    properties: {
      orderId: { type: "string" },
      status: { type: "string", enum: ["processing", "shipped", "delivered"] },
    },
    required: ["orderId", "status"],
  },
  timeout: { timeoutMs: 5_000, onTimeout: "fail" },
  retry: {
    maxAttempts: 2,
    initialDelayMs: 100,
    maxDelayMs: 500,
    backoff: "fixed",
    jitter: false,
  },
  async execute(input, context) {
    const userId = context.tenant?.userId;
    if (!userId) throw new Error("Missing authenticated user");

    const order = await orders.findForUser(input.orderId, userId, {
      signal: context.signal,
    });
    if (!order) throw new Error("Order not found");

    return {
      orderId: order.id,
      status: order.status,
    };
  },
});
```

Pass tools to the managed agent:

```ts
const agent = createVoiceAgent({
  prompt:
    "You are a support assistant. Use lookup_order after collecting the order ID. " +
    "Never reveal another customer's order.",
  tools: [lookupOrder],
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram" },
    llm: { provider: "groq" },
    tts: { provider: "cartesia", voiceId: process.env.CARTESIA_VOICE_ID },
  },
});
```

The model can request a tool, but it cannot grant itself permission. Always
check the caller identity and the application's authorization policy inside
the executor.

## Tool context

The executor receives:

- `sessionId`, `turnId`, and `toolCallId`
- The current attempt number
- An `AbortSignal`
- A structured logger
- Optional tenant user, organization, and workflow IDs from the session
  attachment
- Optional scopes when a direct `executeTool()` caller supplies them

Use `context.signal` in database and HTTP calls. A caller interruption,
session cancellation, timeout, or shutdown can abort tool work.

The session runtime does not populate tenant scopes or derive them from a
tool's deprecated `authScope` field. Neither the identity IDs nor direct-call
scopes prove authorization. Validate access in the application before reading
or writing a protected record.

## Schemas and validation

TVIC validates tool input and output against the JSON Schema subset used by the
runtime. Keep schemas specific:

- List required properties.
- Use the correct primitive type.
- Restrict known string values with `enum` when possible.
- Return a small, stable result instead of an entire database record.
- Never return secrets, access tokens, or internal error details to the model.

TypeScript generics help the application code, but runtime schema validation is
still required because model output and JavaScript values are untrusted.

## Timeouts and retries

Set a timeout for every external operation. Retry only an operation that can be
repeated safely.

Safe retry candidates may include a read-only lookup or a request with a
provider-supported idempotency key. Unsafe retry candidates include charging a
card, sending a message, creating a booking, or deleting data unless your
application supplies a durable idempotency key.

When a tool times out, the runtime reports a terminal tool status. The prompt
should tell the agent how to explain a failed action without claiming success.
If the executor ran, a failure can leave the external outcome unknown. For an
idempotent tool, TVIC stores failed, timed-out, and cancelled outcomes through
the result TTL. Repeating the same key returns that terminal outcome without
running the executor again. Reconcile the provider operation before creating a
new business operation key; do not rotate a key just to retry an ambiguous
action.

## Idempotency

Enable idempotency for side effects that might be retried after a process crash
or network failure:

```ts
const createBooking = defineTool({
  id: "create_booking",
  name: "create_booking",
  description: "Creates an appointment after the caller confirms the details.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  idempotency: { enabled: true },
  async execute(input, context) {
    return bookingService.create({
      input,
      userId: context.tenant?.userId,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
    });
  },
});
```

The executor receives TVIC's stable, session-scoped key as
`context.idempotencyKey`. Its value is the same across repeats of the same
tool request in that session, so pass it to the external service when that
service supports idempotency. The durable store can use PostgreSQL, Redis, or
the composite adapter. The external service must honor the key if the side
effect leaves TVIC.

TVIC scopes idempotency records to the session that created them, including
when `keyTemplate` is set. The request fingerprint includes the tenant values
provided to that execution. The session runtime provides identity IDs but no
scopes; direct `executeTool()` callers can supply scopes. A changed tenant
context within a session key returns an idempotency conflict. Use a separate
provider-supported key at the business-service boundary when the external
operation needs deduplication across sessions.

The default key is stable across `tool.version` changes within the same session;
the request fingerprint includes the tool version. Repeating an existing key
after a version change therefore fails closed with an idempotency conflict
instead of executing the side effect again or replaying a result from an older
tool contract. If a version change represents a distinct business operation,
include that operation's stable identifier in `keyTemplate`. Including
`{toolVersion}` explicitly opts into a version-specific namespace and can allow
the same input to execute again after a tool upgrade; use it only when that is
the intended operation identity.

New store keys and request fingerprints are fixed-size SHA-256 digests. A
`{input}` key-template fragment is digested before it becomes part of a key.
These digests are not encryption and should not be treated as authorization;
low-entropy values may be guessable. This applies only to idempotency keys and
fingerprints: persisted tool-call records still contain tool inputs and
outputs, so protect those records with the store's access and retention policy.

The active claim lasts at least the larger of the configured result-retention
TTL (60 seconds by default) and the full timeout/retry budget plus a one-second
safety margin. After completion, the result uses the configured TTL (60
seconds by default). Set a longer `ttlMs` when the application needs a longer
deduplication window. Executors must honor `context.signal`; a timed-out
operation that ignores cancellation can keep performing an external side
effect after TVIC reports its terminal status.

During upgrades from the earlier key format, TVIC looks up old records using
their original raw key and request fingerprint before the current claim. A
custom store must preserve lookup compatibility for those original arguments
until the legacy rows expire. Legacy results are never replayed,
even when the current request omits tenant context, because the old row cannot
prove which tenant produced its output. A matching legacy row fails closed
until it expires. Legacy rows may contain raw serialized input in their key or
fingerprint until expiry; current package exports expose only the new digests.
Redis applies physical TTLs to current records. To remove expired rows written
by earlier versions, call `RedisToolIdempotencyStore.pruneExpiredIdempotencyPage`
with its returned cursor until it returns `"0"`.

Custom `ToolIdempotencyStore` adapters must implement `quarantine()` as one
atomic operation that validates the current session lease and either preserves
the existing outcome or prevents a recovered ambiguous call from being claimed
again. PostgreSQL performs the check in a transaction; Redis uses a Lua script;
the in-memory adapter uses a synchronous current-lease snapshot. This required
method is part of the checkout's source API and must be implemented before an
adapter can compile against the updated declarations.

The compatibility lookup is an extra store read for each idempotent execution
while old-format compatibility is enabled. It defaults to enabled for safe
upgrades. After all legacy records have expired and old workers are drained,
set `legacyKeyCompatibility: false` on the tool's idempotency policy to remove
that lookup. Drain old workers before starting new side-effecting workers: the
legacy lookup and current-key claim cannot arbitrate simultaneous old and new
writers. The current `context.idempotencyKey` format (`tvic:v3`) differs from
earlier downstream keys and from the version-scoped `tvic:v2` store keys used by
prior checkouts. Before switching to this format, drain old workers, reconcile
outstanding idempotency records and provider operations, and wait out both the
configured record TTL and provider deduplication-retention window. The provider
must honor the current stable key for duplicate protection. Respect the
provider's retention window when reconciling or retrying an operation.

`tool_result` events include a terminal `status`; ambiguous failures also
include `recoveryPolicy: "do_not_replay"`. Generic tool exceptions are reduced
to a safe `tool.execution_failed` message before they reach the model or durable
tool result. Explicit TVIC errors retain their code and message, but their
cause and metadata are removed at that boundary.

## Confirmation for irreversible actions

Use a two-step interaction for actions that a caller cannot easily undo:

1. Gather and restate the details.
2. Ask for explicit confirmation.
3. Call the side-effecting tool only after confirmation.
4. Report success only after the tool returns success.

Put this rule in the prompt and enforce it in the tool. Do not rely on the
prompt alone.

## Memory tools

If an agent's memory policy enables LLM writes, TVIC exposes its reserved
`remember_fact` capability. Do not register a tool with that name. Choose the
allowed memory scopes and retention policy deliberately:

```ts
const agent = createVoiceAgent({
  prompt: "Remember only stable caller preferences that the caller shares.",
  memoryPolicy: {
    enabled: true,
    scopes: ["session", "user"],
    canLlmWrite: true,
    deleteSessionScopeOnEnd: true,
    preCallLoad: "all",
  },
  providers: {
    telephony: { provider: "web-client-audio" },
    stt: { provider: "deepgram" },
    llm: { provider: "groq" },
    tts: { provider: "cartesia", voiceId: process.env.CARTESIA_VOICE_ID },
  },
});
```

Session memory is temporary by default. User, organization, and workflow memory
can survive across calls. Read [Persistence](./persistence.md) for adapter
selection and deletion behavior.

## Personas and context

The composable `defineAgent` API can resolve tenant-specific context at session
start and system-prompt context before a turn. This is useful for CRM records,
feature flags, and tenant-specific instructions.

The [persona example](../examples/persona/README.md) demonstrates one agent
serving multiple tenants. Keep the source of truth in the application. Do not
copy a full customer record into every prompt or expose fields the agent does
not need.

## Post-call work

Use `RuntimeOptions.onSessionEnd` for work such as:

- Post-call summarization
- CRM synchronization
- Callback scheduling
- Writing durable caller facts
- Delivering a transcript to an application system

The hook is best effort and is not retried by the runtime. If the operation must
not be lost, send it to a durable external queue from the hook. The
[post-call summarization example](../examples/post-call-summarization/README.md)
shows the lifecycle.

## Workflows and multiple agents

`organizationId` and `workflowId` label the session and can scope memory and
application context. They do not create a workflow engine.

For a complex application, keep each role explicit:

- One agent can collect information.
- A second agent can handle a specialized role.
- The host application decides when control changes and what context is passed.
- Each agent gets only the tools it needs.

If the application needs a custom handoff or a nonstandard pipeline, use the
composable runtime surface. Do not describe an unimplemented handoff feature as
part of the managed API.
