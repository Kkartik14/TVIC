# Deploying a voice agent

TVIC runs inside your Node.js service. You deploy the service, its transport
gateway, provider configuration, and persistence dependencies together.

TVIC does not provide hosted phone numbers, a browser application, a load
balancer, a secret manager, or automatic provider failover. Choose those pieces
for your application.

## Deployment shape

```text
browser or phone provider
          |
          v
authenticated Node gateway
          |
          +--> voice-runtime session
          +--> STT, LLM, and TTS providers
          +--> durable-store adapter and backing services when enabled
```

Your application chooses the durable-store adapter and its backing services;
see [Persistence](./persistence.md) for the available options.

Keep the gateway and runtime in the same process when the transport accepts a
handle directly. If the gateway and runtime are separate services, define an
explicit authenticated handoff and durable session lookup.

## Environment configuration

The names below are used by the examples and provider integrations. The
`voice-runtime` package does not load `.env` files. Your application controls
local environment loading and should set only the variables its configuration
uses; pass secrets through the deployment secret manager at runtime.

```text
DEEPGRAM_API_KEY
GROQ_API_KEY
CARTESIA_API_KEY
CARTESIA_VOICE_ID

# Optional alternatives
OPENAI_API_KEY
ASSEMBLYAI_API_KEY
SARVAM_API_KEY
SARVAM_TTS_VOICE_ID
SONIOX_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID

# Durable state used by the application
DATABASE_URL
REDIS_URL

# Optional: DDL-capable credentials for the deployment migration job only
MIGRATION_DATABASE_URL
```

Never put provider credentials in browser bundles, container images, Git
history, logs, prompts, or client-visible metadata.

## Start the service

The basic application lifecycle is:

```ts
const agent = createAgent();
const plane = createNodeMediaPlane({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
  path: "/voice/:sessionRef",
  healthPath: "/healthz",
  healthCheck: (signal) => {
    signal.throwIfAborted();
    return agent.healthCheck();
  },
  authorizeUpgrade,
  onConnection,
});

await plane.start();
```

Set `host` explicitly for every deployment. Omitting it makes Node bind to an
unspecified interface. The examples use loopback by default. A proxy in a separate
container can use a private interface; configure network policy to prevent direct
public access to the media-plane port. Bind to `0.0.0.0` only when the deployment
requires it and the raw listener remains restricted to the private network.

The media plane exposes a health endpoint that returns HTTP 200 with
`{"ok":true}` when the check passes and HTTP 503 with `{"ok":false}` when it
fails. Provide a richer `healthCheck` that checks the runtime, database, Redis,
recovery coordinator, and any required external dependency. The endpoint does
not serialize check details or exception messages; send diagnostics to a
protected host-side log or monitoring sink.

Do not use liveness as readiness. A process can be alive while its database is
unavailable or while its runtime is still draining.

## Reverse proxy requirements

If a proxy or load balancer sits in front of the service:

- Forward WebSocket upgrades.
- Preserve the `Origin`, authorization, and relevant provider headers.
- Use an idle timeout longer than the heartbeat interval.
- Set a request body limit for webhook and token endpoints.
- Route a live WebSocket connection to one backend for its lifetime.
- Use sticky routing or shared state for reconnect and transport token lookup.
- Terminate TLS at a trusted boundary and use HTTPS and WSS publicly.

Test the proxy with a real browser connection and a real Twilio Media Stream.
A successful HTTP health request does not prove that WebSocket upgrades or
audio frames work through the proxy.

## Graceful shutdown

Stop accepting requests and close the media plane before stopping the agent:

```ts
let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`received ${signal}; draining voice sessions`);

  await plane.stop().catch((error) => {
    console.error("media plane stop failed", error);
  });
  await agent.stop().catch((error) => {
    console.error("voice agent stop failed", error);
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
```

Managed agent shutdown may wait on an unreferenced persistence-cleanup deadline
timer. If shutdown closes the last active event-loop handle, Node may exit
before `agent.stop()` settles or its error handler runs. Keep a host handle
active through the drain when the shutdown result needs to be observed.

For a load-balanced deployment, use a pre-stop hook or drain signal to remove
the instance from service before closing its WebSocket listeners. Set a
termination grace period longer than the configured `webSocketCloseTimeoutMs`
(5000 ms by default) plus the expected runtime and resource cleanup time.

`plane.stop()` closes HTTP admission, aborts in-flight HTTP and health callbacks,
closes their sockets, and sends a WebSocket close to connected clients. HTTP
callbacks should observe their signal before starting work; a callback that
ignores cancellation may continue after its socket closes. WebSocket clients
are closed before `agent.stop()` begins cancelling their active sessions. The
plane terminates a peer that does not complete the close handshake within
`webSocketCloseTimeoutMs`; configure a value from 1 to 60000 ms to fit the
deployment's drain window.

## Scaling

Each active session has live transport and provider state. When running more
than one replica:

- Use a shared durable store for sessions, turns, leases, and idempotency.
- Use a shared memory adapter if callers must be recognized by every replica.
- Use Redis for shared replay protection where the transport requires it.
- Route each WebSocket to one replica for its lifetime.
- Design reconnect as a new authenticated transport attachment.
- Set a maximum concurrent-session limit per replica and at the gateway.
- Measure provider limits separately from Node process limits.
- Do not assume TVIC provides exactly-once audio or transcript delivery.

The runtime's STT reconnect option is bounded and opt-in. It can replay a
bounded command journal, but audio near a failure may be lost or recognized
twice. It is not provider failover or exactly-once delivery.

## Container deployment

Build the application in a reproducible environment:

```bash
npm ci && npm run build && npm test
# or, for a pnpm application:
pnpm install --frozen-lockfile && pnpm build && pnpm test
```

Use the package manager and lockfile for your application. To build the TVIC
repository itself, use the pinned pnpm 9.12.0 toolchain and repository
instructions in [Contributing](../CONTRIBUTING.md).

The production image should contain the compiled application and production
dependencies only. Inject secrets at runtime. Run database migrations as a
controlled deployment step before sending traffic to a new replica.

Do not run a development mock provider in a production image. Make the provider
mode explicit and fail startup when a required live credential is missing.

## Readiness and release checks

Before routing production traffic, verify:

- The service imports the published package surface.
- The selected Node.js version is supported by the package.
- The configured models and voice IDs are valid.
- PostgreSQL migrations have completed.
- Redis is reachable when required by the deployment.
- The health endpoint reports the expected readiness state.
- Browser or Twilio WebSocket upgrades work through the proxy.
- Provider smoke tests passed for the exact commit and configuration.
- Shutdown closes sessions and releases external clients.
- Logs redact credentials, tokens, raw audio, and personal data.

## Operations boundary

TVIC exposes health and observation seams but does not ship a proprietary
observability product. Connect the application to your metrics, logs, traces,
alerting, and incident system. Earshot can be integrated outside the realtime
critical path when that product is used.

For security requirements, read [Security](./security.md). For provider checks,
read [Testing](./testing.md). For deployment failures, read
[Troubleshooting](./troubleshooting.md).
