# T-vic standalone STT

This example reads a local mono 16-bit PCM WAV file and streams it to a selected
STT provider through TVIC's standalone `SttSession` API:

```text
WAV file -> caller-owned chunking -> SttSession -> normalized transcript events
```

TVIC owns provider lifecycle, input validation, ordering, commit/close behavior,
audio normalization to the provider target, and transcript normalization. The
example owns the audio source and feeds it in 20 ms chunks. The standalone
example uses this session; the current browser voice-mode pipeline keeps its
upstream direct `SttStream` lifecycle.

## Run

```bash
STT_PROVIDER=deepgram DEEPGRAM_API_KEY=... \
  pnpm --filter @tvic/example-stt-only start ./speech.wav

STT_PROVIDER=sarvam SARVAM_API_KEY=... \
  pnpm --filter @tvic/example-stt-only start ./speech.wav

STT_PROVIDER=elevenlabs ELEVENLABS_API_KEY=... \
  pnpm --filter @tvic/example-stt-only start ./speech.wav

STT_PROVIDER=assemblyai ASSEMBLYAI_API_KEY=... \
  pnpm --filter @tvic/example-stt-only start ./speech.wav

STT_PROVIDER=soniox SONIOX_API_KEY=... \
  pnpm --filter @tvic/example-stt-only start ./speech.wav
```

Optional settings:

```bash
STT_PROVIDER=deepgram STT_MODEL=nova-3 STT_LANGUAGE=en DEEPGRAM_API_KEY=... \
  pnpm --filter @tvic/example-stt-only start ./speech.wav
```

`STT_PROVIDER` defaults to `deepgram`. The provider-specific models can be
selected with `STT_MODEL`; Sarvam accepts `saaras:v3`/`saaras:v4`, ElevenLabs
accepts `scribe_v2_realtime`, AssemblyAI accepts `u3-rt-pro`, and Soniox accepts
`stt-rt-v5`.

Model validation is strict by default. If a provider URL points to a deliberately
configured custom or self-hosted deployment, the application can pass
`allowUnknownModel: true` in its `SttOpenRequest`/`SttSessionOptions`; the pipeline
equivalent is `sttAllowUnknownModel: true`. This opt-out is explicit because the
catalog lists dated models TVIC has verified, not every vendor or deployment model.

The WAV must contain mono, 16-bit little-endian PCM at one of TVIC's supported
sample rates. TVIC opens the provider at canonical 16 kHz PCM16LE and converts
the WAV's declared source rate automatically; 16 kHz is the example's target,
not a universal provider input. Press `Ctrl-C` to close the stream cleanly.

## Credentialed smoke test

The normal test suite never contacts providers. For an explicit real-provider
check, build first and select the providers you want to exercise:

```bash
pnpm build
STT_SMOKE_PROVIDERS=deepgram,assemblyai \
  pnpm stt:smoke -- ./speech.wav
```

The smoke runner loads the repository `.env` for local development, preserves
already-exported environment variables, and reports normalized partial/final/
endpoint events. It requires at least one selected provider and may incur
provider charges. Use `STT_SMOKE_WAIT_MS` and `STT_SMOKE_MAX_AUDIO_MS` to bound
the wait and fixture duration.
