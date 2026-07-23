# T-vic live call

This example runs a real inbound voice-agent call:

```text
Twilio Media Streams → Deepgram STT → OpenAI Responses → Cartesia TTS → Twilio
```

It includes signed, single-use stream tokens, optional Twilio webhook signature
verification, normalized 16 kHz PCM audio, barge-in, tools, memory, provider stall
timeouts, and playout confirmation.

## Configure

```bash
PUBLIC_HOST=your-public-host.example
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...

# Optional
PORT=8080
MEDIA_PATH=/media/:callId
TWIML_PATH=/twiml
LLM_MODEL=gpt-4.1-mini
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
- Production startup rejects an unauthenticated webhook unless
  `ALLOW_UNAUTHENTICATED_TWIML=true` is explicitly set.
- Request bodies and stream-token lifetimes are bounded.

Call recording and observability are intentionally not implemented here; Earshot
owns that product surface.
