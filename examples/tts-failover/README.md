# TTS failover voice agent

This is a runnable, one-turn voice-agent application that prefers Sarvam and
uses ElevenLabs when the Sarvam TTS request fails.

The important part is [`src/agent.ts`](./src/agent.ts): the function receives
the primary provider, fallback provider, model/voice mapping, and fallback
observer as parameters. TVIC remains provider-neutral; the Sarvam → ElevenLabs
choice belongs to this application.

```text
scripted call + local STT + local LLM
                         |
                   Sarvam TTS
                         |
             ElevenLabs on operational failure
```

The STT, LLM, and call transport are deterministic local providers so the
example can exercise the complete managed-agent loop without unrelated
credentials. Only the TTS providers switch between mock and live mode.

## Inspect and typecheck

```bash
pnpm --filter @tvic/example-tts-failover typecheck
pnpm --filter @tvic/example-tts-failover test
```

## Run the local example

No credentials are required in the default mode:

```bash
pnpm --filter @tvic/example-tts-failover start
```

The primary TTS intentionally fails, the fallback produces audio, and the
scripted call completes through `createVoiceAgent().start(...)`. You should see
`fallback ... phase=synthesize` and `turns=1` in the output.

## Run with the real TTS APIs

Set these three variables in the shell or repository `.env`; STT and LLM
remain local:

```bash
SARVAM_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

Then run:

```bash
VOICE_PROVIDER_MODE=live \
  pnpm --filter @tvic/example-tts-failover start
```

To force Sarvam to fail without sending a malformed request to Sarvam:

```bash
VOICE_PROVIDER_MODE=live FAILOVER_FORCE_PRIMARY_FAILURE=1 \
  pnpm --filter @tvic/example-tts-failover start
```

The example then uses the real ElevenLabs API for the fallback turn. For a
provider-only smoke matrix, use the repository-level `pnpm tts:failover-live`
command.
