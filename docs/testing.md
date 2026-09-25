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

For the ElevenLabs provider specifically, the live scripts load `.env` in a
non-production shell and keep credentials out of output:

```bash
pnpm elevenlabs:live-tts-surface-smoke
pnpm elevenlabs:live-model-smoke
```

The TTS surface smoke currently exercises all
catalogued TTS models across REST, HTTP streaming, timestamped output,
Text-to-Dialogue, and multi-context WebSockets.

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

### Exercise every ElevenLabs model

Use the dedicated matrix runner when changing the ElevenLabs adapters:

```bash
pnpm elevenlabs:live-model-smoke -- ./speech.wav
```

The HTTP and multiplexed WebSocket surfaces have a separate bounded smoke
runner:

```bash
pnpm elevenlabs:live-tts-surface-smoke
```

It exercises complete HTTP, chunked HTTP, timestamped output, explicit
Text-to-Dialogue, regular multi-context, and dialogue multi-context calls using
short text. It is intentionally separate from the model/STT matrix so a model
matrix failure cannot hide a transport failure. Both runners load the local
`.env`, never print credentials, and classify account quota/permission failures
as blocked.

The optional WAV must be mono 16-bit PCM; it is resampled to 16 kHz for Scribe
batch requests. If no path is supplied, the runner uses the first successful
ElevenLabs TTS response as a bounded STT fixture. It executes every catalogued
TTS model and all three Scribe models, using Text-to-Dialogue for v3 models,
regular TTS WebSocket for the other TTS models, HTTP multipart for `scribe_v2`
and `scribe_v2_medical`, and realtime WebSocket for `scribe_v2_realtime`.
Results contain counts and bounded timings, not transcripts, audio, or secrets.
The run may incur provider charges.

The batch checks exercise both `scribe_v2` and `scribe_v2_medical` through the
same multipart shape, including word timestamps, audio-event tagging, and the
shared no-verbatim control. The realtime contract suite also covers delayed
timestamp/language results, entity-result correlation, nullable live word
fields, previous-text first-frame semantics, and documented incompatible
options.

To make one credential-backed realtime run assert the entity event as well,
set `ELEVENLABS_SMOKE_ENTITY_DETECTION=pii` (or another provider-supported
category). Entity detection is an extra provider feature and may incur an
additional charge, so the default matrix leaves it off.

The hermetic ElevenLabs TTS suite also checks the documented control fields,
pronunciation dictionary bounds, deterministic seed bounds, v3 multi-speaker
registration/turn switching, dialogue keep-alive, alignment variants, model
character limits, malformed audio, terminal markers, unexpected EOF, and output
ceilings. It does not treat ElevenLabs' model-latency estimates as an SDK SLA.

### Exercise every Sarvam Bulbul v3 voice and language

Sarvam’s hermetic suites cover the WebSocket lifecycle, all option boundaries,
flush ordering, cancellation, malformed frames, close-code retry policy, queue
and output ceilings, and the shared TTS session contract:

```bash
pnpm --filter @tvic/providers test
```

For credential-backed checks, run all 37 documented voices at one language,
generate a smaller random sample, or exercise the complete 37 × 11 voice and
language matrix:

```bash
pnpm sarvam:live-voice-smoke
pnpm sarvam:random-samples

SARVAM_TTS_MATRIX_CONCURRENCY=2 \
SARVAM_TTS_MATRIX_START_INTERVAL_MS=1000 \
pnpm sarvam:live-matrix
```

The matrix writes a manifest and validated 16 kHz mono WAV outputs under
`local/sarvam-tts-matrix/`. The connection-start interval is intentional:
Sarvam throttles rapid WebSocket connection bursts even when the concurrent
connection count is within plan limits. A previous matrix can be resumed with
`SARVAM_TTS_MATRIX_RESUME_DIR=/absolute/path/to/matrix`.

Run live negative-path checks for invalid authentication, cancellation, and an
aborted connection:

```bash
pnpm sarvam:live-negative
```

These live checks may incur provider charges. Rate-limit mapping is tested
hermetically; exhausting an account quota is not a safe test strategy.

### Exercise Sarvam REST and HTTP streaming TTS

The hermetic HTTP suite covers request bodies, authentication headers, base64 WAV
decoding, incremental WAV parsing across arbitrary network chunk boundaries,
2,500/3,500-character limits, cancellation, malformed output, and HTTP retry
classification:

```bash
pnpm exec vitest run packages/providers/test/sarvam-tts-http.test.ts
```

With `SARVAM_API_KEY` available, exercise both real one-shot transports and write
validated PCM WAV outputs under `local/sarvam-tts-http-smoke/`:

```bash
pnpm sarvam:live-http-smoke
```

The script uses Bulbul v3, `en-IN`, and `shubh` by default. Override
`SARVAM_TTS_LANGUAGE`, `SARVAM_TTS_VOICE_ID`, and `SARVAM_TTS_TEXT` for a
different documented voice/language pair. The normal WebSocket adapter remains
the correct choice for multi-turn incremental text; HTTP stream is one request
per complete text.

Exercise every documented voice-language pair through both HTTP transports with
the resumable live matrix:

```bash
SARVAM_TTS_HTTP_MATRIX_CONCURRENCY=1 \
SARVAM_TTS_HTTP_MATRIX_START_INTERVAL_MS=2500 \
pnpm sarvam:live-http-matrix
```

The default run covers 37 voices × 11 languages × REST and HTTP streaming (814
real API calls), writes validated WAV outputs and a manifest under
`local/sarvam-tts-http-matrix/`, and can be resumed with
`SARVAM_TTS_HTTP_MATRIX_RESUME_DIR=/absolute/path/to/matrix`. Narrow a run with
`SARVAM_TTS_MATRIX_VOICES`, `SARVAM_TTS_MATRIX_LANGUAGES`, or
`SARVAM_TTS_HTTP_MATRIX_TRANSPORTS` while debugging. These calls consume
provider quota; use the interval and concurrency settings deliberately.
Sarvam documents a model-specific Starter limit of 30 `bulbul:v3` REST requests
per minute; the 2,500 ms default leaves a small refill margin. The matrix also
backs off rate-limit responses before retrying. See Sarvam’s
[rate-limit documentation](https://docs.sarvam.ai/api/getting-started/ratelimits).

Exercise sustained, bounded traffic and collect per-transport p50/p95/p99,
success, failure, and error-code metrics:

```bash
SARVAM_TTS_HTTP_SOAK_SAMPLES=100 \
SARVAM_TTS_HTTP_SOAK_CONCURRENCY=2 \
SARVAM_TTS_HTTP_SOAK_START_INTERVAL_MS=1000 \
pnpm sarvam:live-http-soak
```

The soak run defaults to 30 samples per transport, uses `shubh`/`en-IN`, does
not retry by default, and fails on any unexpected call failure. It writes only
the manifest under `local/sarvam-tts-http-soak/`; set
`SARVAM_TTS_HTTP_SOAK_RETRIES` explicitly when measuring recovery separately.

The hermetic HTTP suite also injects transport failures, response-body resets,
caller cancellation while headers are pending, truncated WAV data, missing
bodies, and response-size overflow. It is the deterministic network-chaos
coverage; the live matrix and soak are credential-backed provider coverage.

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
