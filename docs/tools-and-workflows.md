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
check the caller identity and tenant scope inside the executor.

## Tool context

The executor receives:

- `sessionId`, `turnId`, and `toolCallId`
- The current attempt number
- An `AbortSignal`
- A structured logger
- Optional `tenant` values for user, organization, workflow, and application
  scopes

Use `context.signal` in database and HTTP calls. A caller interruption,
session cancellation, timeout, or shutdown can abort tool work.

The `tenant` value is context, not proof of authorization. Validate that the
session identity is allowed to act on the requested record before reading or
writing it.

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
      idempotencyKey: context.toolCallId,
      signal: context.signal,
    });
  },
});
```

The durable idempotency store is part of the runtime and can use PostgreSQL,
Redis, or the composite adapter. The external business service must still
honor the key if the side effect leaves TVIC.

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
