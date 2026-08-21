# TVIC browser voice mode

This example is an executable browser client and authenticated gateway. It runs as a
separate deployable from `examples/live-call` so browser traffic cannot consume the
phone gateway's capacity.

## Local demo (no provider accounts)

From the repository root:

```bash
cp examples/voice-mode/.env.example .env
pnpm install --frozen-lockfile
pnpm --filter @tvic/example-voice-mode start
```

Open <http://localhost:8090>, generate a local application token in another terminal,
and paste it into the client:

```bash
pnpm --silent --filter @tvic/example-voice-mode run mint-token -- demo-user
```

Allow microphone access, choose push-to-talk or continuous mode, and press Connect.
The mock STT, LLM, and TTS providers make the complete gateway → runtime → browser
loop executable without credentials. Push-to-talk mock turns settle on each explicit
turn boundary; continuous mode uses deterministic 500 ms audio windows instead of
real VAD. This mode is for local validation only.

The client first mints a single-use session token with `POST /v1/voice/session`, then
opens `/voice/:sessionRef?token=...&exp=...` and sends `session.start`. The complete
wire protocol is public below; browser clients must not receive any gateway signing
secret.

## Wire protocol

All audio is PCM16 little-endian, 16 kHz mono. Client binary frames contain a 12-byte
little-endian header followed by an even number of payload bytes:

| Bytes | Meaning                                           |
| ----- | ------------------------------------------------- |
| 0     | protocol version, currently `1`                   |
| 1     | flags, currently `0`                              |
| 2–5   | contiguous client audio sequence, starting at `1` |
| 6–9   | monotonic input offset in milliseconds            |
| 10–11 | reserved, must be `0`                             |
| 12+   | PCM16 payload                                     |

The first client control message is:

```json
{
  "type": "session.start",
  "protocolVersion": 1,
  "mode": "push_to_talk",
  "clientPlatform": "your-app",
  "audioFormat": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1 }
}
```

The server replies with `session.ready`, including `heartbeatIntervalMs` and
`maxSessionDurationMs`. Send `client.ping` regularly and expect `server.pong`.
`turn.end` commits a push-to-talk turn; `client.interrupt` requests an explicit
interruption; `session.end` closes the session.

Server binary frames use the same header shape, with the sequence referring to output
audio. Server JSON includes `assistant.text`, `output.clear`, `output.commit`,
`session.error`, and `session.ended`. After all output frames in an `output.commit`
`sequenceRange` have actually played, the client must send:

```json
{ "type": "output.playout_ack", "commitId": "..." }
```

Do not acknowledge on socket receipt; the runtime uses this signal as transport
playout evidence.

## Live provider mode

Set `VOICE_PROVIDER_MODE=live` and configure. OpenAI is the default LLM provider;
for a live smoke test with Groq's OpenAI-compatible Responses endpoint, set
`VOICE_LLM_PROVIDER=groq`, `GROQ_API_KEY`, and optionally
`LLM_MODEL=llama-3.1-8b-instant`.

- `ALLOWED_ORIGINS`, `VOICE_AUTH_SECRET`, `VOICE_ADMIN_SECRET`;
- `STREAM_TOKEN_SECRET`, `SAFETY_IDENTIFIER_SECRET`;
- `DEEPGRAM_API_KEY`, plus `OPENAI_API_KEY` or `GROQ_API_KEY` according to
  `VOICE_LLM_PROVIDER`;
- optionally both `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID` for audio output.

Useful bounds are configurable with `STREAM_TOKEN_TTL_MS`,
`MAX_SESSION_DURATION_MS`, `CONCURRENT_SESSION_CAP`, and
`MINT_RATE_LIMIT_PER_MINUTE`. The concurrent-session default is one; reconnect by
minting with `supersedes` set to the prior session reference. Clients ping every five
seconds; the server closes after ten seconds with neither a ping nor audio. The hard
session-duration default is 45 minutes.

Run with `pnpm --filter @tvic/example-voice-mode start`. In production, use HTTPS,
strong random secrets, an application-owned bearer-token verifier, and a shared session
store if more than one gateway instance is deployed. The example's HMAC app token is
only a local development helper.
