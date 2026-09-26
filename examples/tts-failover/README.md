# TTS failover voice agent

This is the application-owned composition for a voice agent that prefers Sarvam
and uses ElevenLabs when the Sarvam TTS request fails.

The important part is [`src/agent.ts`](./src/agent.ts): the function receives
the primary provider, fallback provider, model/voice mapping, and fallback
observer as parameters. TVIC remains provider-neutral; the Sarvam → ElevenLabs
choice belongs to this application.

```text
web-client audio + Deepgram STT + Groq LLM
                         |
                   Sarvam TTS
                         |
             ElevenLabs on operational failure
```

## Inspect and typecheck

```bash
pnpm --filter @tvic/example-tts-failover typecheck
pnpm --filter @tvic/example-tts-failover test
```

## Construct it with real providers

Set these variables in the shell or repository `.env`:

```bash
SARVAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
DEEPGRAM_API_KEY=...
GROQ_API_KEY=...
```

Then run:

```bash
pnpm --filter @tvic/example-tts-failover start
```

This constructs and validates the managed agent. It does not open a browser
socket or place a call; attach the returned agent to your application's
`createWebClientAudioProvider().acceptWebSocket()` handler. For a credentialed
one-shot audio and forced-outage check, use the repository-level
`pnpm tts:failover-live` smoke command.
