# T-vic

T-vic is a TypeScript runtime for realtime voice agents. Its job is to execute a
voice session reliably: accept media, transcribe speech, run a model and tools,
synthesize a response, stream audio back, and handle interruptions and failures.

The runtime deliberately does not own call observability, recordings, incident
analysis, dashboards, or a trace viewer. Those belong to Earshot. Keeping that
boundary makes T-vic smaller and keeps non-critical work out of the audio path.

## What is built

- A typed runtime model for agents, sessions, turns, media, calls, tools, memory,
  providers, timeouts, retries, and interruption policy.
- A pipeline voice loop: media → streaming STT → LLM/tools → streaming TTS → media.
- Barge-in and cancellation handling, including output clearing and playout
  confirmation.
- Per-session monotonic clocks and turn latency measurements used by execution.
- In-memory stores for sessions, turns, tool calls, and memory.
- Provider adapters for Twilio Media Streams, Deepgram, OpenAI Responses, and
  Cartesia.
- A Node HTTP/WebSocket media plane and a complete inbound-call example.
- Behavioral, provider-contract, state-machine, ingress-security, and chaos tests.

## Repository map

| Path                 | Responsibility                                                   |
| -------------------- | ---------------------------------------------------------------- |
| `packages/core`      | Stable domain contracts and provider interfaces.                 |
| `packages/runtime`   | Session lifecycle, pipeline orchestration, and media plane.      |
| `packages/providers` | Twilio, Deepgram, OpenAI, and Cartesia adapters.                 |
| `packages/media`     | PCM/mulaw conversion, resampling, framing, and media guards.     |
| `packages/tools`     | Tool definition, validation, retries, timeouts, and idempotency. |
| `packages/dal`       | In-memory runtime-state and memory stores.                       |
| `packages/memory`    | Memory policy helpers.                                           |
| `examples/live-call` | Real inbound phone-call gateway.                                 |

Internal working notes under `docs/` are intentionally local-only and ignored by
Git.

## Runtime flow

```text
Twilio media
    ↓
normalized PCM input
    ↓
Deepgram streaming STT
    ↓
conversation policy
    ↓
OpenAI model ↔ tools
    ↓
Cartesia streaming TTS
    ↓
Twilio output + playout confirmation
```

The loop supervises the input stream and STT together, aborts provider work when
the call disappears, bounds provider stalls, and only completes a turn after its
response is delivered.

## Local setup

Requirements: Node.js 20+ and pnpm 9.12.0.

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Run the inbound-call example after setting its provider credentials:

```bash
pnpm --filter @tvic/example-live-call start
```

See `examples/live-call/README.md` for its environment variables and Twilio setup.

## Product boundary

T-vic owns decisions needed to execute the live call:

- session and turn lifecycle;
- provider orchestration;
- media conversion and transport;
- tools and memory;
- interruption, timeout, retry, and delivery semantics.

T-vic does not persist recordings, emit a proprietary trace model, generate call
artifacts, analyze incidents, or render dashboards. Earshot can integrate at the
application boundary without becoming a dependency of this runtime.
