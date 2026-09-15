# Local live testing

This guide checks two different things:

1. PostgreSQL, Redis, and the composite durable store running in Docker.
2. The real provider adapters using the credentials in the local `.env` file.

The normal unit suite uses fakes and does not contact provider services. The
commands below are intentionally separate because live calls can cost money and
can be blocked by account limits.

## Start PostgreSQL and Redis

TVIC provides `docker-compose.integration.yml` with the official PostgreSQL 16
and Redis 7 images. The composite store is application code that uses both
services; it does not need a third container.

```bash
pnpm infra:up
```

The stack uses host ports `55432` for PostgreSQL and `56379` for Redis, so it can
run beside another local project. PostgreSQL creates two databases:

- `tvic` for durable sessions and the composite store;
- `tvic_memory` for the PostgreSQL memory adapter.

Run the complete local storage check:

```bash
pnpm test:integration
```

This starts the services if needed, builds the workspace, runs the regular suite,
runs the three durable suites directly with the integration flag, and checks the
public `voice-runtime` artifact against PostgreSQL and Redis. The services remain
running after the command so they can be inspected with:

```bash
pnpm infra:logs
pnpm infra:down
```

`infra:down` removes the containers and network but keeps the named data volumes.
The next `pnpm infra:up` can reuse them. Remove only this project's volumes when a
fresh database is required:

```bash
docker compose -f docker-compose.integration.yml -p tvic-integration down -v
```

## Configure live providers

Keep real credentials only in the ignored repository `.env` file or a secret
manager. The live smoke runner reads these names:

| Role | Provider          | Environment variables                                                        |
| ---- | ----------------- | ---------------------------------------------------------------------------- |
| STT  | Deepgram          | `DEEPGRAM_API_KEY`                                                           |
| STT  | AssemblyAI        | `ASSEMBLYAI_API_KEY`                                                         |
| STT  | Sarvam            | `SARVAM_API_KEY`, optional `SARVAM_LANGUAGE`                                 |
| STT  | ElevenLabs Scribe | `ELEVENLABS_API_KEY`                                                         |
| STT  | Soniox            | `SONIOX_API_KEY`                                                             |
| LLM  | OpenAI Responses  | `OPENAI_API_KEY`, optional `OPENAI_MODEL`, `OPENAI_RESPONSES_URL`            |
| LLM  | Groq Responses    | `GROQ_API_KEY`, optional `GROQ_MODEL`, `GROQ_RESPONSES_URL`                  |
| TTS  | Cartesia          | `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`, optional `CARTESIA_MODEL`           |
| TTS  | ElevenLabs        | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, optional `ELEVENLABS_TTS_MODEL` |

The checked-in example contains placeholders. The local `.env` used for this
repository has current values for the configured Cartesia and ElevenLabs voices,
and Groq's current model selected for the smoke check. It deliberately leaves
`OPENAI_API_KEY` empty until an OpenAI key is supplied.

## Create a short speech fixture

On macOS, the built-in speech synthesizer can create a repeatable local fixture:

```bash
say -o /tmp/tvic-live-fixture.aiff \
  'This is a short TVIC integration test. Please schedule an appointment for tomorrow at ten in the morning.'
afconvert /tmp/tvic-live-fixture.aiff -f WAVE -d LEI16@16000 -c 1 \
  /tmp/tvic-live-fixture.wav
```

The runner accepts a mono, 16-bit PCM WAV file. Do not add a credentialed audio
fixture to the repository.

## Run the provider matrix

Build first, then run the configured matrix:

```bash
pnpm build
pnpm providers:live-smoke -- /tmp/tvic-live-fixture.wav
```

The separator before the file is optional. The runner accepts it for compatibility
with pnpm versions that pass it through to scripts.

By default, the matrix uses these lists:

```text
STT: deepgram,assemblyai,sarvam,elevenlabs,soniox
LLM: the value of LIVE_SMOKE_LLM, or all if it is not set
TTS: cartesia,elevenlabs
```

Set `LIVE_SMOKE_STT`, `LIVE_SMOKE_LLM`, and `LIVE_SMOKE_TTS` to comma-separated
lists when testing only one provider. For example:

```bash
LIVE_SMOKE_STT=sarvam LIVE_SMOKE_LLM=groq LIVE_SMOKE_TTS=cartesia \
  pnpm providers:live-smoke -- /tmp/tvic-live-fixture.wav
```

Every result is reported as `passed`, `blocked`, or `failed`:

- `passed` means the adapter completed the useful contract check;
- `blocked` means the account, credential, quota, or service availability stopped
  the check;
- `failed` means the adapter or harness produced an unexpected result.

The command exits nonzero for a failed or blocked result. Set
`LIVE_SMOKE_ALLOW_BLOCKED=1` only when a report is needed despite a known account
block. A blocked result is still printed and is not a provider approval.

The checks require more than a successful connection. STT must emit a nonempty
final transcript, the LLM must emit visible text and a completed event, and TTS
must emit PCM audio plus one committed output event.

## Run the protected reference chain

The release workflow runs one fixed, credentialed chain through the exact
`voice-runtime` tarball that will be published. It uses Web Client Audio,
Deepgram `nova-3`, OpenAI Responses `gpt-4.1-mini`, and Cartesia `sonic-3`.
The chain also checks streamed output, an interruption boundary, and clean
shutdown.

To run the same check locally, build and pack the public package first:

```bash
pnpm build
PACKAGE_TARBALL="$(cd packages/voice-runtime && npm pack --pack-destination /tmp --ignore-scripts --json | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.parse(s)[0].filename))')"
PACKAGE_TARBALL="/tmp/$PACKAGE_TARBALL" \
DEEPGRAM_API_KEY=... \
OPENAI_API_KEY=... \
CARTESIA_API_KEY=... \
CARTESIA_VOICE_ID=... \
REFERENCE_WAV_PATH=/tmp/tvic-live-fixture.wav \
  pnpm reference:live
```

The fixture must be mono, 16-bit PCM WAV at 16 kHz. The command installs that
exact tarball in a clean temporary consumer before it starts the provider chain.
It requires paid provider credentials and is not part of ordinary pull-request
CI. Do not put the credentials or audio fixture in the repository.

## What this does not prove

These checks do not place a phone call or open a public browser gateway. Twilio
requires a public HTTPS endpoint, a configured webhook, and a Twilio account. The
browser path requires a running example and a browser that grants microphone
access. Test those transport boundaries separately after the provider matrix is
green.
