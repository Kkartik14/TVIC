# T-vic live call

This example runs a real inbound voice-agent call:

```text
Twilio Media Streams → Deepgram STT → Groq Chat Completions → Cartesia TTS → Twilio
```

It includes signed, single-use stream tokens, Twilio webhook signature
verification, authenticated webhook replay protection, normalized 16 kHz PCM
audio, barge-in, tools, memory, provider stall timeouts, and playout confirmation.

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
CARTESIA_MODEL=sonic-3
STREAM_TOKEN_SECRET=...
STREAM_TOKEN_TTL_MS=120000
TWIML_REPLAY_TTL_MS=300000
TWILIO_AUTH_TOKEN=...
ALLOW_UNAUTHENTICATED_TWIML=false
REDIS_URL=redis://127.0.0.1:56379
```

`PUBLIC_HOST` is the public hostname Twilio can reach, without a URL scheme.
Use a tunnel during local development.

## Run

```bash
pnpm --filter @tvic/example-live-call start
```

Configure the Twilio Voice webhook to:

```text
https://PUBLIC_HOST/twiml
```

The webhook returns TwiML that connects the call to the signed media WebSocket.
The process then starts a T-vic session and runs the pipeline until hangup or
failure.

## Security

- Set `TWILIO_AUTH_TOKEN` to validate webhook signatures. It is mandatory in
  production.
- Media URLs use short-lived, signed, single-use tokens.
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
