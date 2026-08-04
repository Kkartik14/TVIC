# TVIC voice-mode gateway

Reference composition for authenticated browser or native-client PCM audio. It runs
as a separate deployable from `examples/live-call` so public voice-mode traffic cannot
consume the phone gateway's capacity.

The client first mints a single-use session token with `POST /v1/voice/session`, then
opens `/voice/:sessionRef?token=...&exp=...` and sends `session.start`. Audio is PCM16
little-endian, 16 kHz mono in the version-1 binary framing documented in the private
runtime contracts. Control messages are JSON.

Required environment variables:

- `ALLOWED_ORIGINS`, `VOICE_AUTH_SECRET`, `VOICE_ADMIN_SECRET`;
- `STREAM_TOKEN_SECRET`, `SAFETY_IDENTIFIER_SECRET`;
- `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`;
- optionally both `CARTESIA_API_KEY` and `CARTESIA_VOICE_ID` for audio output.

Useful bounds are configurable with `STREAM_TOKEN_TTL_MS`,
`MAX_SESSION_DURATION_MS`, `CONCURRENT_SESSION_CAP`, and
`MINT_RATE_LIMIT_PER_MINUTE`. The concurrent-session default is one; reconnect by
minting with `supersedes` set to the prior session reference. Clients ping every five
seconds; the server closes after ten seconds with neither a ping nor audio. The hard
session-duration default is 45 minutes.

Run with `pnpm --filter @tvic/example-voice-mode start` after setting the environment.
