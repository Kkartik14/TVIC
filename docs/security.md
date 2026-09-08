# Security and production boundaries

TVIC runs inside your server. It does not automatically create an authenticated
public endpoint, and it does not move provider credentials into browser code.

## Keep secrets server-side

Provider API keys, transport signing secrets, database URLs, and Redis credentials
belong in your server-side configuration or secret manager. The browser should
receive only a short-lived, scoped session credential issued by your application.

TVIC reads provider environment variables when a managed agent is configured. It
does not load `.env` files, so choose and configure your own environment loader.

## Authenticate before opening media

Your HTTP or WebSocket integration should authenticate the user and authorize the
requested session before creating or handing over a `CallHandle`.

For browser audio, restrict allowed origins, use short-lived single-use session
tokens, bound request bodies and session duration, and configure a connection cap.
The [browser example](../examples/voice-mode/README.md) includes a deliberately
small development token flow; its generated secrets and permissive local defaults
are not a production identity system.

For Twilio, verify the webhook signature, use short-lived signed media-stream
tokens, and reject unauthenticated production webhooks. See the [Twilio example](../examples/live-call/README.md)
for the current reference gateway.

## Treat prompts and callers as untrusted

Caller speech, transcripts, tool arguments, and external controller data are
untrusted input. A prompt cannot authorize a payment, booking, account change, or
workflow transition. Validate and authorize those operations in application-owned
tools or workflows, and require confirmation for irreversible actions.

## Data and logging

TVIC does not record calls or provide a dashboard. Decide what your application may
retain, redact sensitive fields before logging, and avoid logging raw audio,
provider keys, full transcripts, or authorization headers by default.

Memory and durable persistence are opt-in. Choose retention, tenant isolation,
deletion, and legal-hold behavior in the application and storage configuration.

## Operational limits

Set explicit limits for concurrent connections, session duration, input size,
provider timeouts, tool execution, output buffering, and reconnect attempts. A
provider that stalls or a client that stops reading must not be allowed to grow
process memory without bound.

Expose health checks and runtime metrics to your deployment system. At minimum,
watch active sessions, turn latency, provider failures, transport disconnects,
tool timeouts, persistence failures, and reconnect outcomes.
