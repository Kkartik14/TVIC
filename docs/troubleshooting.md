# Troubleshooting

Start with the layer that failed. A browser connection problem, a provider
connection problem, and a tool authorization problem need different fixes.

## First checks

Run these before changing application code:

```bash
node --version
pnpm lint
pnpm test
pnpm build
pnpm check:public-package
```

For a live provider problem, run the smallest provider smoke test and record the
normalized error code:

```bash
LIVE_SMOKE_STT=deepgram \
LIVE_SMOKE_LLM=groq \
LIVE_SMOKE_TTS=cartesia \
pnpm providers:live-smoke -- ./speech.wav
```

Do not use a mock success to diagnose a live provider failure.

## Read an error safely

Event errors are JSON-safe `NormalizedError` values:

```ts
import { isNormalizedError, isTvicError, TvicThrowableError } from "voice-runtime";

for await (const event of session.run) {
  if (event.kind !== "error") continue;
  console.error({
    code: event.error.code,
    category: event.error.category,
    retriable: event.error.retriable,
    recoverable: event.recoverable,
  });
}

try {
  await session.run;
} catch (error) {
  if (isTvicError(error)) {
    console.error(error.error.code, error.error.message);
  } else if (isNormalizedError(error)) {
    console.error(error.code, error.message);
  } else {
    console.error("unknown failure", error);
  }
}
```

Do not serialize or log an unknown thrown object before normalizing it. Error
messages and metadata can contain user or provider data.

## Installation and import problems

### `npm install voice-runtime` fails on Node.js

Check `node --version`. The published package supports Node.js 22, 24, and 26.
Use a supported version and reinstall dependencies.

### ESM import fails

Use an `.mjs` file or set `"type": "module"`:

```js
import { createVoiceAgent } from "voice-runtime";
```

### CommonJS import fails

Use a `.cjs` file or a CommonJS project:

```js
const { createVoiceAgent } = require("voice-runtime");
```

The public package has one root export. There are no advanced package subpaths.

## Agent construction errors

### Missing credentials

The managed constructor requires credentials for live provider configurations.
Set the right environment variable or pass `apiKey` explicitly:

| Provider              | Variable             |
| --------------------- | -------------------- |
| Deepgram              | `DEEPGRAM_API_KEY`   |
| Sarvam                | `SARVAM_API_KEY`     |
| ElevenLabs STT or TTS | `ELEVENLABS_API_KEY` |
| AssemblyAI            | `ASSEMBLYAI_API_KEY` |
| Soniox                | `SONIOX_API_KEY`     |
| Groq                  | `GROQ_API_KEY`       |
| OpenAI                | `OPENAI_API_KEY`     |
| Cartesia              | `CARTESIA_API_KEY`   |

Cartesia also requires `CARTESIA_VOICE_ID`. ElevenLabs TTS also requires
`ELEVENLABS_VOICE_ID`.

### Unsupported model

TVIC validates a selected model against its dated catalog. Check
[Providers](./providers.md) for the current list. If the model belongs to a
deliberately configured custom endpoint, set `allowUnknownModel: true` and test
the endpoint separately.

This setting does not fix a provider protocol mismatch.

### Provider kind mismatch

The provider was placed in the wrong role. A speech provider cannot be used as
an LLM, and a transport provider cannot be used as TTS. Check the four fields:

```ts
providers: {
  telephony,
  stt,
  llm,
  tts,
}
```

### Agent provider incompatible

The selected providers do not jointly support the audio format, streaming mode,
tool calls, interruption behavior, or transport. Inspect provider capabilities
and choose compatible settings before opening a session.

## Session startup errors

### `callHandle` is invalid

A handle needs a non-empty `callId`, an async `events` iterable, and `send`,
`clear`, and `close` methods. Use the factory form when the transport needs the
runtime session ID.

### Call and handle IDs do not match

The `Call.id` must equal `callHandle.callId`. Use the same authoritative ID in
the gateway, call record, token binding, and transport handle.

### The handle factory never returns

Startup has a bounded deadline. Check that the WebSocket has been authenticated,
that the transport accept call is awaited, and that the proxy is forwarding
upgrades. Increase `startupTimeoutMs` only after fixing the underlying wait.

### Startup is cancelled

An application `AbortSignal`, agent shutdown, or startup timeout can cancel the
operation. Treat cancellation as expected during deploys and caller disconnects.

## No transcript or no audio

Check the pipeline from the edge inward:

1. Is the WebSocket or phone stream connected?
2. Did the handle emit `media.stream.started`?
3. Are input frames the expected PCM format and sample rate?
4. Did STT emit `stt.partial` or `stt.final`?
5. Did an endpoint or explicit turn commit occur?
6. Did the LLM emit tokens or a tool call?
7. Did TTS emit audio chunks?
8. Did the handle accept output frames?
9. Did the transport confirm playout?

For browser audio, verify microphone permission, the audio worklet, the protocol
version, input sequence numbers, and `session.ready` before sending audio. For
Twilio, verify the `start` frame, stream SID, sequence numbers, and mu-law edge
format.

## Provider stalls and timeouts

Provider streams must make progress. A stall can produce errors such as
`llm.stalled`, `tts.stalled`, `stt.open_timeout`, or `stt.drain_timeout`.

Check:

- Provider status page and account limits
- API key permissions and billing
- Model and voice ID
- Outbound firewall and DNS
- Proxy idle timeout
- Runtime stream and operation timeout settings
- Whether the provider sent a terminal event

Do not retry an operation without checking whether it can repeat a side effect.

## Event stream already consumed

The run supports one public async iterator. This fails:

```ts
const first = session.run[Symbol.asyncIterator]();
const second = session.run[Symbol.asyncIterator]();
```

Create one observer and share its application results. Multiple `await
session.run` calls are safe.

## Tool failures

### Tool input or output validation failed

Inspect the JSON schema and the value returned by the executor. Keep schemas
small and return JSON-compatible data.

### Tool authorization failed

Check `context.tenant` and your application identity lookup. TVIC does not
enforce `authScope` as an RBAC layer.

### Tool timed out or was cancelled

Pass `context.signal` into the external operation. Check whether the caller
interrupted, the session ended, or the configured timeout was too short.

### Tool ran twice

Use a durable idempotency store and make the external side effect honor the key.
An application-level retry without an external idempotency key can duplicate a
booking, payment, or message.

## Browser authentication errors

| Symptom                       | Likely cause                                          |
| ----------------------------- | ----------------------------------------------------- |
| HTTP 401 on token mint        | Missing or invalid application bearer token           |
| HTTP 403 on token mint        | Origin or supersede check failed                      |
| HTTP 429 on token mint        | Mint rate limit reached                               |
| HTTP 401 on WebSocket upgrade | Missing, expired, or already-used media token         |
| HTTP 403 on WebSocket upgrade | Origin is not allowed                                 |
| Socket closes after waiting   | The gateway did not accept the pending socket in time |
| Output is marked unheard      | The browser did not send `output.playout_ack`         |

Use the example's development token only locally. In production, bind short-lived
tokens to an application user and session reference.

## Twilio authentication errors

Verify the public URL, Twilio signature, account and call identity, stream token,
and replay store. Keep `ALLOW_UNAUTHENTICATED_TWIML=false` outside a private
development tunnel. Use Redis or another shared store for replay protection when
there are multiple gateway replicas.

## Database and Redis errors

Check the connection URL, network policy, migrations, pool limits, and health
endpoint. Run the local stack and integration tests:

```bash
pnpm infra:up
pnpm test:integration
```

If the runtime owns an injected store, it may close it during `stop()`. Set
`durableStoreOwnership: "caller"` when the application owns the connection
client and closes it separately.

## Still blocked

Create a minimal reproduction containing:

- Package version and Node.js version
- Provider, model, and transport names
- Redacted configuration names
- Exact normalized error code and category
- Whether the failure is mock, local integration, provider smoke, or manual
- The smallest command that reproduces it

Do not attach API keys, tokens, raw recordings, or personal data. For a security
issue, follow [SECURITY.md](../SECURITY.md) instead of opening a public issue.
