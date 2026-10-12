# T-vic live Twilio call

This example runs a real voice-agent call through Twilio Media Streams:

```text
Twilio Media Streams → Deepgram STT → Groq Chat Completions → Cartesia TTS → Twilio
```

The gateway includes Twilio webhook and WebSocket signature verification,
single-use stream tokens passed with TwiML `<Parameter>` values, authenticated
webhook replay protection, normalized 16 kHz PCM audio, barge-in, tools, memory,
provider stall timeouts, and playout confirmation. Outbound calls start through
`TelephonyProvider.dial()` and join the SDK-created agent session. The guarded
runner requests a real call from the authenticated local gateway and then
checks its Twilio status. Twilio has no automated unit or E2E test suite; the
runner is a manual, opt-in real-call procedure and may incur charges.

## Configure

```bash
PUBLIC_HOST=your-public-host.example
DEEPGRAM_API_KEY=...
GROQ_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...

# Optional
PORT=8080
MEDIA_PATH=/media/:callId
TWIML_PATH=/twiml
GROQ_MODEL=openai/gpt-oss-20b
GROQ_API_URL=https://api.groq.com/openai/v1/chat/completions
STT_LANGUAGE=en
CARTESIA_MODEL=sonic-3.6
STREAM_TOKEN_SECRET=...
STREAM_TOKEN_TTL_MS=120000
TWIML_REPLAY_TTL_MS=300000
TWILIO_AUTH_TOKEN=...
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=...
TWILIO_FROM_NUMBER=+1...
TWILIO_TO_NUMBER=+1...
TWILIO_STATUS_PATH=/twilio/status
TVIC_OUTBOUND_CALL_TOKEN=... # random secret, at least 32 characters
TVIC_ALLOW_LIVE_TWILIO_CALL=0
ALLOW_UNAUTHENTICATED_TWIML=false
REDIS_URL=redis://127.0.0.1:56379
```

`PUBLIC_HOST` is the public hostname Twilio can reach, without a URL scheme.
Use a tunnel during local development. `TWILIO_FROM_NUMBER` is your Twilio
Voice number; `TWILIO_TO_NUMBER` is the handset that will receive the outbound
call. `TWILIO_AUTH_TOKEN` verifies signed callbacks and WebSocket handshakes. A
Standard API key pair is used for Calls API access when supplied; otherwise the
provider uses the Account SID and Auth Token. The provider passes `/twiml` in
its Calls API request, so outbound calls do not depend on the number's Console
inbound webhook setting. The example's `/calls/outbound` route requires the
separate `TVIC_OUTBOUND_CALL_TOKEN` bearer secret.

## Place a live outbound call

This gateway requires Twilio Media Streams. Twilio's current trial restrictions
block the `<Stream>` verb, so upgrade a trial account before a live call. Trial
accounts also restrict calls to verified recipients in the account's sign-up
country; see [Twilio trial restrictions](https://www.twilio.com/docs/usage/trials).

1. Copy `examples/live-call/.env.example` to the repository root as `.env` if
   you do not already have one; otherwise merge the listed variables into your
   existing `.env`. Fill in the AI provider keys, Twilio Auth Token, Account
   SID, Twilio caller ID, destination number, and a random
   `TVIC_OUTBOUND_CALL_TOKEN` of at least 32 characters. Create a Standard API
   key pair for Calls API access, or leave both API-key fields blank to use the
   Account SID and Auth Token pair.
2. Start a public HTTPS tunnel to local port 8080. For example, with ngrok run
   `ngrok http 8080`. Put only its hostname (no scheme or path) in `PUBLIC_HOST`.
3. Start the gateway:

```bash
pnpm --filter @tvic/example-live-call start
```

4. In another terminal, explicitly opt in to a real outbound call:

```bash
TVIC_ALLOW_LIVE_TWILIO_CALL=1 pnpm --filter @tvic/example-live-call twilio:outbound:live -- --place-live-call
```

After the interactive confirmation containing the exact `TWILIO_TO_NUMBER`,
the runner checks the public gateway and sends an authenticated request to
`/calls/outbound`. The gateway starts an SDK session and the Twilio provider
creates the real call through the Calls API. The runner waits for a terminal
call status and prints the Call SID. Answer the
destination phone, speak to the agent, listen for its response, then hang up.
The runner cannot judge audio quality; check the gateway logs for the accepted
TwiML call, authenticated media stream, connected session, and call completion.
If the Calls API response is lost before any authenticated callback arrives, the
SDK reports a non-retriable error with an unknown creation outcome. Check the
Twilio Console call records before retrying.

**This command places a real, potentially billable phone call.** Run it only
when ready to place that call. Twilio Test Credentials cannot place a live call:
they do not place a call, fetch the `Url`, or execute TwiML. See [Twilio Test
Credentials](https://www.twilio.com/docs/iam/test-credentials).

## Inbound calls

Inbound calls can be tested later by setting the Twilio number's **A call comes
in** webhook to `https://PUBLIC_HOST/twiml` with HTTP POST. The handler returns
TwiML that connects the call to the signed media WebSocket.

## Security

- Set `TWILIO_AUTH_TOKEN` to validate HTTP webhooks and WSS handshakes. It is
  mandatory for production and live calls.
- The `<Stream>` URL has no query string. Twilio sends the short-lived,
  single-use stream token in `start.customParameters`, as required by Twilio's
  [Stream reference](https://www.twilio.com/docs/voice/twiml/stream).
- The WebSocket handshake validates `X-Twilio-Signature`; Twilio requires
  signature validation for Media Streams. The verifier also retries with a
  trailing slash to match Twilio's documented WSS signature caveat.
- Duplicate authenticated TwiML deliveries return the original response and do
  not mint a replacement stream token. The replay key is based on
  `AccountSid`, `CallSid`, the endpoint, and the initial-call event. Production
  uses Redis for an atomic cross-process reservation when `REDIS_URL` is set.
- After the returned single-use stream token connects, a later retry for that
  initial request returns `409` instead of returning a stale TwiML response.
- Local development without `TWILIO_AUTH_TOKEN` is rejected by default. To use a
  private development tunnel, explicitly set `ALLOW_UNAUTHENTICATED_TWIML=true`.
  That setting is rejected in production and the process must have
  `TWILIO_AUTH_TOKEN`.
- Production also requires `REDIS_URL` so TwiML replay protection is shared by
  gateway instances.
- The example's stream-token map is process-local. Redis does not share issued
  stream tokens, so a multi-replica deployment needs sticky WebSocket routing
  or a shared stream-token store before using this gateway horizontally.
- The TwiML handler rejects duplicate `CallSid` webhooks through the bounded
  replay store before minting another media token, and the media handle
  correlates the Twilio `start` identity with the authenticated call.
- Production startup (`NODE_ENV=production` or `TVIC_ENV=production`) always
  requires both `TWILIO_AUTH_TOKEN` and `STREAM_TOKEN_SECRET`. Local development
  may omit them; the process warns and generates only a development-only token
  secret when needed.
- Request bodies and stream-token lifetimes are bounded.

Call recording and observability are intentionally not implemented here; Earshot
owns that product surface.
