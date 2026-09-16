# Testing

Voice systems need more than one kind of test. A mock test can prove runtime
ordering and failure handling. It cannot prove that a provider account, model,
voice, network route, or vendor protocol is available.

Use separate test layers and report which layer actually ran.

## Test layers

| Layer                | Network                              | Credentials      | Purpose                                                                                    |
| -------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------ |
| Unit and contract    | No                                   | No               | Runtime state, event ordering, provider protocol fixtures, validation, and error semantics |
| Example tests        | No by default                        | No by default    | Gateway authentication, browser protocol, tool and memory behavior                         |
| Local integration    | Docker only                          | No provider keys | PostgreSQL, Redis, migrations, leases, idempotency, memory, and public artifacts           |
| Provider smoke       | Provider network                     | Yes              | One provider adapter at a time with a short fixture                                        |
| Provider stack smoke | Provider network and local WebSocket | Yes              | Deepgram -> Groq -> Cartesia plus cancellation and browser transport                       |
| Manual call          | Provider and transport network       | Yes              | Speak through a browser or phone and inspect the user experience                           |

## Run the normal repository gates

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm check:public-package
```

These gates are designed to be repeatable and do not contact paid providers.

Run one package or example while iterating:

```bash
pnpm --filter voice-runtime test
pnpm --filter @tvic/example-voice-mode test
pnpm --filter @tvic/example-live-call test
pnpm --filter @tvic/example-memory-demo test
```

The repository also includes focused stress and contract checks:

```bash
pnpm dual-protocol:stress
pnpm check:exports
pnpm check:node-support
pnpm check:security
pnpm check:persisted-errors
```

## Run PostgreSQL and Redis integration tests

The integration runner starts the repository Docker stack, creates the memory
database, builds the packages, runs the database adapter tests, and checks public
integration artifacts:

```bash
pnpm test:integration
```

The services use these local URLs by default:

```text
DATABASE_URL=postgres://tvic:tvic_local@127.0.0.1:55432/tvic
MEMORY_INTEGRATION_URL=postgres://tvic:tvic_local@127.0.0.1:55432/tvic_memory
REDIS_URL=redis://127.0.0.1:56379
```

For manual inspection:

```bash
pnpm infra:up
pnpm infra:logs
pnpm infra:down
```

The integration runner leaves services running after a failure so logs and
database state can be inspected.

## Test a real STT provider

Use a short mono PCM16 WAV file. Build first:

```bash
pnpm build
```

Test one or more providers:

```bash
STT_SMOKE_PROVIDERS=deepgram \
  DEEPGRAM_API_KEY="$DEEPGRAM_API_KEY" \
  pnpm stt:smoke -- ./speech.wav

STT_SMOKE_PROVIDERS=deepgram,assemblyai,sarvam,elevenlabs,soniox \
  pnpm stt:smoke -- ./speech.wav
```

The runner reports partial transcripts, final transcripts, endpoints, and
speech-start events. It fails when a provider emits no non-empty final text.

Optional bounds:

```bash
STT_SMOKE_WAIT_MS=10000
STT_SMOKE_MAX_AUDIO_MS=15000
STT_MODEL=nova-3
STT_LANGUAGE=en
```

The model and language variables apply to the selected STT smoke run. A live
run may incur charges.

## Test real LLM and TTS providers

The broad live smoke runner exercises every selected STT, LLM, and TTS adapter:

```bash
pnpm build
LIVE_SMOKE_STT=deepgram,assemblyai,sarvam,elevenlabs,soniox \
LIVE_SMOKE_LLM=openai,groq \
LIVE_SMOKE_TTS=cartesia,elevenlabs \
pnpm providers:live-smoke -- ./speech.wav
```

Required credentials are:

```text
DEEPGRAM_API_KEY
ASSEMBLYAI_API_KEY
SARVAM_API_KEY
ELEVENLABS_API_KEY
SONIOX_API_KEY
OPENAI_API_KEY
GROQ_API_KEY
CARTESIA_API_KEY
CARTESIA_VOICE_ID
ELEVENLABS_VOICE_ID
```

The runner reads a local `.env` file for development while preserving already
exported environment variables. It reports each case as `passed`, `blocked`, or
`failed`. A blocked case usually means a missing credential or provider access.
Do not turn a blocked provider into a passing release claim.

Bound the run when debugging:

```bash
LIVE_SMOKE_TIMEOUT_MS=45000
LIVE_SMOKE_WAIT_MS=30000
LIVE_SMOKE_MAX_AUDIO_MS=8000
LIVE_SMOKE_ALLOW_BLOCKED=1
```

Use `LIVE_SMOKE_ALLOW_BLOCKED=1` only when the blocked status is intentional and
recorded in the test report. A provider failure must still fail the command.

## Test the reference provider stack

The stack smoke test uses the public package surface for the browser transport
and the provider adapters for this path:

```text
Cartesia input fixture -> Deepgram -> Groq -> Cartesia output -> Web Client Audio
```

Run it with:

```bash
pnpm provider:smoke
```

It checks streamed STT, streamed LLM output, streamed TTS output, in-flight TTS
cancellation, the public package import path, browser transport input and output,
and clean shutdown. It requires `DEEPGRAM_API_KEY`, `GROQ_API_KEY`,
`CARTESIA_API_KEY`, and `CARTESIA_VOICE_ID`.

Optional configuration:

```bash
GROQ_MODEL=openai/gpt-oss-20b
STT_MODEL=nova-3
STT_LANGUAGE=en
CARTESIA_MODEL=sonic-3
GROQ_API_URL=https://api.groq.com/openai/v1/chat/completions
```

## Test the browser path manually

Start mock mode first:

```bash
cp examples/voice-mode/.env.example .env
pnpm --filter @tvic/example-voice-mode start
```

Then open <http://localhost:8090>, mint a token, connect, speak, interrupt a
reply, switch between push-to-talk and continuous mode, and end the session.

For live browser testing, set `VOICE_PROVIDER_MODE=live` and configure Deepgram,
Groq, Cartesia, and the required voice ID. Use HTTPS and application-owned
authentication outside local development.

Verify these behaviors:

- A missing or expired token is rejected.
- A disallowed origin is rejected.
- A second use of a single-use token is rejected.
- The browser receives `session.ready` before sending audio.
- Output is acknowledged only after playback, not socket receipt.
- An interruption clears queued output and cancels generation.
- A browser disconnect finalizes the session.
- The process stops without leaving an active WebSocket or runtime session.

## Test the Twilio path manually

Configure the variables in the [live-call example](../examples/live-call/README.md),
make the gateway reachable by Twilio, and configure the incoming Voice webhook.

Verify these behaviors:

- An invalid Twilio signature is rejected.
- Duplicate authenticated webhook delivery does not mint a second stream token.
- The Twilio `start` identity matches the authenticated call.
- Input mu-law audio becomes normalized PCM16 audio.
- Output marks are not treated as heard audio when they were cleared.
- A remote hangup ends the session.
- Redis replay protection works across two gateway processes.

## Test failure paths

Every production agent should have tests for:

- Missing credentials
- Unsupported provider model
- Provider connection rejection
- Malformed provider message
- Provider stream ending without a terminal event
- Provider stall or timeout
- Tool input validation failure
- Tool output validation failure
- Tool cancellation and retry
- Caller interruption during LLM generation
- Caller interruption during TTS output
- Transport send returning `false`
- Remote hangup
- Startup cancellation
- Agent shutdown during an active session
- Durable-store outage
- Duplicate tool execution after a retry

## Report live evidence

For every live run, record:

- Commit or package version
- Date and timezone
- Provider and adapter
- Model and voice ID
- Input fixture duration
- Result and normalized error code
- Whether the case was passed, blocked, or failed
- Approximate provider cost if known

Do not commit API keys, raw recordings, caller data, or unredacted provider
responses. A live smoke result is evidence for that provider, model, transport,
and commit. It is not a blanket reliability claim for every vendor model.
