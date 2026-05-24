# @tvic/example-live-call

A live **inbound** phone-call gateway: Twilio Media Streams → T-vic runtime →
Deepgram (STT) + OpenAI (LLM) + Cartesia (TTS), with per-call traces and audio
artifacts written to disk.

This is the integration that turns the runtime into a real phone call. You point
a Twilio number at it and call.

## What it does

1. Twilio calls the **Voice webhook** (`/twiml`) → we return TwiML that opens a
   `<Connect><Stream>` back to our `wss://…/media/:callId`.
2. Twilio streams μ-law 8k audio over that WebSocket.
3. The runtime runs the full pipeline loop: STT → conversation policy → LLM →
   tools → TTS → audio back to the caller, with barge-in, latency metrics, trace
   spans, and memory.
4. When `RECORD_CALLS=true`, each call writes
   `calls/<callId>/{call.jsonl, manifest.json, input.pcm, output.pcm}` (audio only
   if `PERSIST_AUDIO=true`). With recording off (the default), nothing is persisted.

## Prerequisites

- A **Twilio** account + a phone number with Voice capability.
- API keys: **Deepgram**, **OpenAI**, **Cartesia** (+ a Cartesia voice id).
- A **public URL** to your machine. For local dev use a tunnel:
  - `ngrok http 8080` (or `cloudflared tunnel --url http://localhost:8080`)
  - take the host it gives you (e.g. `abc123.ngrok.io`).

## Configure

Set env vars (e.g. in your shell or a `.env` you export):

```
PORT=8080
PUBLIC_HOST=abc123.ngrok.io          # no scheme; the host Twilio reaches
DEEPGRAM_API_KEY=...
OPENAI_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
# optional:
LLM_MODEL=gpt-4.1-mini
CARTESIA_MODEL=sonic-3
STT_LANGUAGE=en
ARTIFACTS_DIR=./calls
# privacy — OFF by default. Nothing is persisted unless you opt in:
RECORD_CALLS=false                   # set true to persist traces + transcript
PERSIST_AUDIO=false                  # set true (with RECORD_CALLS) to also persist PCM
# ingress security:
TWILIO_AUTH_TOKEN=...                # when set, /twiml requires a valid X-Twilio-Signature
STREAM_TOKEN_SECRET=...              # stable secret for signing media tokens (else ephemeral per-process)
STREAM_TOKEN_TTL_MS=120000
```

> **Set `TWILIO_AUTH_TOKEN` for any public deployment.** Without it, `/twiml` is
> unauthenticated and will mint a stream token for anyone who hits the webhook
> (fine only for a throwaway local tunnel). With it set, only requests carrying a
> valid Twilio signature can obtain a token.

## Run

```
pnpm --filter @tvic/example-live-call start
```

You'll see:

```
T-vic live-call gateway listening on :8080
  Twilio Voice webhook  ->  https://abc123.ngrok.io/twiml
  Media Streams (wss)   ->  wss://abc123.ngrok.io/media/:callId
```

In the Twilio console, set your number's **A call comes in** webhook to
`https://abc123.ngrok.io/twiml` (HTTP POST). Then **call the number**.

> Artifacts are only written when `RECORD_CALLS=true`. They contain caller audio
> and transcripts — `calls/` is gitignored; treat it as sensitive.

## Inspect a call

```
pnpm --filter @tvic/example-live-call latency calls/<callId>
```

Prints the per-turn latency decomposition (end-of-utterance marker, LLM TTFT, TTS
TTFB, tool time, end-of-utterance → first audio) and p50/p95 response latency.
The same `call.jsonl` + `manifest.json` feed the trace viewer.

## How barge-in works here

Twilio Media Streams is raw audio with no VAD, so barge-in is driven by
**Deepgram interim transcripts**: when the caller speaks while the agent is
talking, the first interim transcript interrupts the turn (cancels LLM/TTS,
clears Twilio output). Echo/min-speech thresholds still need real-world tuning —
use the latency CLI / viewer to tune them.

## Security / current edges

- `/twiml` validates the **Twilio request signature** when `TWILIO_AUTH_TOKEN` is
  set — only Twilio can mint a stream token. (Unset = unauthenticated; dev only.)
- The media WebSocket then requires that **single-use, TTL-bounded HMAC token** —
  random WS connections are rejected.
- Remaining hardening: bind the issued token to the Twilio `start.callSid` /
  `accountSid` and verify it on the media `start` message (defense-in-depth).
- Outbound dialing is not wired here — this gateway is inbound only.
- Audio artifacts are normalized 16k PCM (what flows through the runtime), not
  the raw μ-law on the wire.
