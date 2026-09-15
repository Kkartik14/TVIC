# T-vic live call

This example runs a real inbound voice-agent call:

```text
Twilio Media Streams → Deepgram STT → Groq Chat Completions → Cartesia TTS → Twilio
```

It includes signed, single-use stream tokens, optional Twilio webhook signature
verification, normalized 16 kHz PCM audio, barge-in, tools, memory, provider stall
timeouts, and playout confirmation.

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
TWILIO_AUTH_TOKEN=...
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

- Set `TWILIO_AUTH_TOKEN` to validate webhook signatures.
- Media URLs use short-lived, signed, single-use tokens.
- The TwiML handler rejects duplicate `CallSid` webhooks within a bounded replay
  window before minting another media token, and the media handle correlates the
  Twilio `start` identity with the authenticated call.
- Production startup (`NODE_ENV=production` or `TVIC_ENV=production`) always
  requires both `TWILIO_AUTH_TOKEN` and `STREAM_TOKEN_SECRET`. Local development
  may omit them; the process warns and generates only a development-only token
  secret when needed.
- Request bodies and stream-token lifetimes are bounded.

Call recording and observability are intentionally not implemented here; Earshot
owns that product surface.
