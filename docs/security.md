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

## 1.1.0 threat model

The table records the boundary TVIC enforces and the responsibility that remains
with the host application. A green test proves the listed behavior only; it does
not turn a host-owned responsibility into an SDK guarantee.

| Asset or boundary                                | Attacker or failure                                       | Entry point and impact                                 | TVIC mitigation                                                                                                        | Executable check                                                          | Owner and residual risk                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Provider keys and database credentials           | Malicious browser code, logs, or a compromised dependency | Client configuration or diagnostics expose credentials | Credentials are server-side configuration and are not included in public event or error shapes                         | `pnpm check:security`                                                     | Host secret manager; a compromised host still has access                                                           |
| Browser session token                            | Token theft or tampering                                  | WebSocket upgrade impersonates a session               | HMAC format, expiry, constant-time comparison, and host-controlled single-use storage                                  | `pnpm --filter @tvic/providers test`                                      | Host origin policy and rate limits remain required                                                                 |
| Twilio webhook                                   | Forged request or altered URL/body                        | `/twiml` issues a media token for an attacker          | Full URL and repeated form values are signature checked; production requires `TWILIO_AUTH_TOKEN`                       | `pnpm --filter @tvic/example-live-call test`                              | Twilio account and public host configuration remain host-owned                                                     |
| TwiML replay state                               | Retry or concurrent duplicate delivery                    | A retry creates a second token or call side effect     | AccountSid plus CallSid key, request hash, atomic reservation, stored response replay, conflict rejection              | `pnpm --filter @tvic/example-live-call test -- test/replay-redis.test.ts` | Production must use shared Redis; retention after the configured TTL is a documented boundary                      |
| Call and session correlation                     | Client supplies another call or session identifier        | Media is attached to the wrong caller                  | The signed token is bound to the server-issued call ID and identity                                                    | `pnpm --filter @tvic/example-live-call test`                              | The host must keep call IDs unguessable, use TLS, and provide sticky routing or shared token state across replicas |
| Prompt, speech, transcript, and controller data  | Prompt injection or malicious caller                      | Tool arguments or workflow state are manipulated       | Prompts do not authorize side effects; tools must validate and authorize independently                                 | `docs/security.md` review plus tool contract tests                        | Host application owns business authorization and confirmation                                                      |
| Tool side effects                                | Replay, timeout, or unauthorized invocation               | Booking, payment, or account action happens twice      | Schema validation, aborts, timeout policy, and idempotency contracts                                                   | `pnpm test`                                                               | Tool implementation and durable idempotency configuration remain host-owned                                        |
| Audio, transcript, token, and authorization logs | Accidental sensitive-data retention                       | Privacy or credential disclosure                       | No raw media or full transcript is required by the runtime evidence path; diagnostics should be redacted               | `pnpm check:security`                                                     | Host logging and retention policy can still leak data                                                              |
| Input and queue capacity                         | Oversized body, slow client, or stalled provider          | Memory exhaustion or stuck sessions                    | Body caps, bounded queues, provider deadlines, cancellation, and connection policies                                   | `pnpm test` and live-call ingress tests                                   | Deployment-level connection and process limits remain required                                                     |
| Dependencies and npm publisher                   | Compromised workflow or unauthorized maintainer           | Malicious package reaches users                        | Read-only workflow permissions, protected environments, OIDC trusted publishing, provenance, and exact artifact digest | `pnpm check:release-workflow`                                             | GitHub branch protection, environment reviewers, and npm configuration are operational controls                    |
| Release tag and source commit                    | Tag points outside protected `main`                       | Unreviewed code is published                           | Release checks compare tag SHA, approved SHA, and fetched protected-main tip, then require `Verify`                    | `.github/workflows/release.yml`                                           | Maintainer must set `RELEASE_APPROVED_SHA` for the intended release                                                |
| Tested versus published bytes                    | Rebuild changes the artifact after verification           | Different code is published from the code tested       | One tarball is hashed, tested, uploaded, downloaded, and published without rebuilding                                  | `scripts/check-public-package.mjs`                                        | Artifact retention and npm immutability remain external controls                                                   |
| Error and diagnostic serialization               | Untrusted object contains secrets or cyclic data          | Logs or persisted records disclose data or crash       | Normalized error boundaries and redaction rules limit the public shape                                                 | `pnpm test` and error evidence checks                                     | Host log sinks must still treat messages as sensitive                                                              |

The release gate is intentionally fail-closed for missing protected credentials,
missing shared replay storage in production, a missing approval variable, a
missing live reference fixture, and provider rate limits. Those conditions are
operational failures, not successful skips.
