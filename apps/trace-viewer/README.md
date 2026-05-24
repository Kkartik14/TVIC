# @tvic/trace-viewer

The T-vic trace viewer — "Datadog for voice." It reads the per-call artifacts
written by the live-call gateway and renders, per call:

- **Turn waterfall** — every stage (STT, LLM, tool, TTS, playout) as a span on a
  real ms axis, positioned from `monotonicOffsetMs`.
- **Latency decomposition** — response latency, LLM TTFT, TTS TTFB, tool time,
  total — per turn (response > 1s highlighted).
- **Interruption markers** — barge-ins drawn on the turn timeline.
- **Transcript** — caller + agent text per turn.
- **Audio replay** — caller/agent tracks served as WAV; "play from here" seeks to
  a turn's start so you can hear any moment.

It's built on the shared `deriveCallTimeline` analysis in `@tvic/tracing`, the
same function the latency CLI uses.

## Run

```
# point it at a directory of call artifacts (defaults to ../../examples/live-call/calls)
CALLS_DIR=/path/to/calls pnpm --filter @tvic/trace-viewer dev
# open http://localhost:4321
```

Generate artifacts by running the live-call gateway with `RECORD_CALLS=true`
(and `PERSIST_AUDIO=true` for the audio replay).

## Notes

- Audio is reconstructed from normalized 16k mono PCM, wrapped in a WAV header by
  the `/api/calls/:callId/audio/:track` route. "Play from here" seeks on a shared
  call clock, so alignment is turn-accurate (per-word alignment is future work).
- Read-only and local: no auth/tenancy yet — it's a developer surface.
