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
          +--> PostgreSQL and Redis when durable state is enabled
```

Keep the gateway and runtime in the same process when the transport accepts a
handle directly. If the gateway and runtime are separate services, define an
explicit authenticated handoff and durable session lookup.

## Environment configuration

Store credentials in the deployment secret manager and expose only the required
variables to the server process:

```text
DEEPGRAM_API_KEY
GROQ_API_KEY
CARTESIA_API_KEY
CARTESIA_VOICE_ID

# Optional alternatives
OPENAI_API_KEY
ASSEMBLYAI_API_KEY
SARVAM_API_KEY
SONIOX_API_KEY
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID

# Durable state
DATABASE_URL
REDIS_URL
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
  healthCheck: () => agent.healthCheck(),
  authorizeUpgrade,
  onConnection,
});

await plane.start();
```

The media plane exposes a health endpoint that returns HTTP 200 when the check
passes and HTTP 503 when it fails. Provide a richer `healthCheck` that checks
the runtime, database, Redis, recovery coordinator, and any required external
dependency.

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

Stop accepting traffic, drain active connections, then stop the agent:

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

For a load-balanced deployment, use a pre-stop hook or drain signal to remove
the instance from service before closing its WebSocket listeners. Set a
termination grace period longer than the expected cleanup timeout.

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
npm ci
pnpm build
pnpm test
```

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
