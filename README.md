# TVIC

[![CI](https://github.com/Kkartik14/TVIC/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kkartik14/TVIC/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/voice-runtime.svg)](https://www.npmjs.com/package/voice-runtime)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./.nvmrc)

**A provider-neutral TypeScript runtime for realtime voice agents.**

Voice agents are easy to demo and hard to run. The hard part is not calling a model
API. It is streaming audio, deciding when a caller actually finished speaking,
cancelling a response the moment they interrupt, knowing whether your audio was
heard or merely sent, and keeping all of that correct while providers fail in
different ways.

TVIC owns exactly that layer. You define an agent, attach tools, choose your
telephony, speech, model, and synthesis providers, and the runtime executes the
live conversation.

```text
telephony/media -> STT -> conversation policy -> LLM/tools -> TTS -> telephony/media
```

## Why this exists

Most voice stacks collapse distinctions that matter once real calls are running.
TVIC keeps them separate, because each one is a different failure:

| Commonly conflated              | TVIC treats as distinct                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| A transcript is final           | The text is immutable **vs.** the caller finished their turn         |
| Output was cancelled            | Generation stopped **vs.** queued audio was cleared                  |
| Audio was sent                  | The transport accepted it **vs.** the caller heard it                |
| The provider supports streaming | Incremental input **vs.** incremental output **vs.** native protocol |

A turn whose audio reached the socket but was never acknowledged is reported as
cancelled, not completed, and never enters memory as a heard exchange. That single
rule is the difference between a runtime you can debug and one that quietly lies.

## What is built

- Typed contracts for agents, sessions, turns, calls, tools, memory, and providers,
  modelled as discriminated unions so a completed turn structurally cannot be
  missing its end state.
- A cascaded voice loop: media, streaming STT, conversation policy, LLM and tools,
  streaming TTS, media out.
- Turn boundaries that separate transcript finality from endpointing, with a
  debounced silence window, an absolute utterance cap, and a commit on hangup.
- Barge-in driven by the earliest speech signal available, gated by a minimum
  speech duration, with output clearing and playout confirmation.
- Incremental TTS: sentences stream into a prosody-preserving synthesis session
  while the model is still generating, so audio starts before the reply is finished.
- Provider capability negotiation that fails agent construction with an exact error
  rather than degrading silently at runtime.
- Tool execution with schema validation on input **and** output, timeouts, abort
  propagation, retries, and idempotency.
- A Node HTTP and WebSocket media plane, plus a complete inbound phone-call example
  with signature verification and single-use media tokens.
- An executable browser voice-mode gateway and reference client with local mock
  providers, push-to-talk, continuous mode, interruption, and playout-aware audio.

## Providers

| Role      | Adapter                 | Notes                                                               |
| --------- | ----------------------- | ------------------------------------------------------------------- |
| Telephony | Twilio Media Streams    | mu-law edge conversion, buffer clear, mark acknowledgement          |
| Telephony | Browser WebSocket audio | PCM16 framing, push-to-talk, text delivery, playout acknowledgement |
| STT       | Deepgram                | partial and final segments, speech start, explicit endpoint         |
| STT       | Sarvam                  | partial and final segments, VAD signals, manual flush               |
| STT       | ElevenLabs Scribe       | realtime partial/final transcripts, manual commit                   |
| STT       | AssemblyAI              | realtime turns, natural end-of-turn endpoint                        |
| STT       | Soniox                  | token finality, endpoint markers, manual finalization               |
| LLM       | OpenAI Responses        | SSE token stream, function calling                                  |
| TTS       | Cartesia                | incremental contexts, provider-acknowledged flush, word alignment   |
| TTS       | ElevenLabs              | incremental PCM, character alignment, transport-level flush         |

Adapters declare what the configured deployment actually does, not what the vendor
markets. Where a role has more than one adapter, both run against a shared contract
test suite.

STT model IDs are checked against TVIC's dated provider catalogs before a socket is
opened. For a deliberately configured custom or self-hosted endpoint, pass
`allowUnknownModel: true` in the STT open/session request (or
`sttAllowUnknownModel: true` in `PipelineVoiceLoop`); this explicitly opts out of
the catalog check and does not make the model part of TVIC's capability claim.

## Repository map

| Path                     | Responsibility                                                  |
| ------------------------ | --------------------------------------------------------------- |
| `packages/core`          | Contracts, provider requirements, errors, IDs, constants        |
| `packages/runtime`       | Session lifecycle, voice loop, conversation policy, media plane |
| `packages/providers`     | Twilio, Deepgram, OpenAI, Cartesia, and ElevenLabs adapters     |
| `packages/media`         | PCM and mu-law conversion, resampling, framing, format guards   |
| `packages/tools`         | Tool validation, timeouts, retries, abort, idempotency          |
| `packages/dal`           | In-memory session, turn, tool-call, and memory stores           |
| `packages/memory`        | Memory helpers                                                  |
| `packages/voice-runtime` | Public npm identity (early preview)                             |
| `examples/live-call`     | Real inbound phone-call gateway                                 |
| `examples/voice-mode`    | Browser/native audio gateway and reference client               |

## Quick start

Requirements: Node.js 20 or newer, and pnpm 9.12.0.

### Run a local browser voice agent

This is the fastest way to validate the complete browser path without vendor
accounts. The example starts with deterministic mock STT, LLM, and TTS providers;
switch to `VOICE_PROVIDER_MODE=live` only after adding live credentials.

```bash
cp examples/voice-mode/.env.example .env
pnpm install --frozen-lockfile
pnpm --filter @tvic/example-voice-mode start
```

Open <http://localhost:8090>, then generate and paste a local app token:

```bash
pnpm --silent --filter @tvic/example-voice-mode run mint-token -- demo-user
```

The browser client and public protocol are documented in
[`examples/voice-mode/README.md`](./examples/voice-mode/README.md). For production,
host the client from your application and have your authenticated backend mint the
short-lived session token; never expose gateway signing secrets in browser code.

### Verify the repository

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

No provider credentials are needed for the repository gates. To run a real inbound
phone call, set the variables described in
[`examples/live-call/README.md`](./examples/live-call/README.md) and start the
gateway:

```bash
pnpm --filter @tvic/example-live-call start
```

## Observability belongs to Earshot

TVIC does not persist recordings, emit a proprietary trace model, analyze incidents,
or render dashboards. Those are owned by **Earshot**, a separate product for voice
observability.

This is a deliberate boundary rather than a missing feature. Evidence collection is
not on the realtime critical path, so it must never be able to stall audio, and no
Earshot dependency is required to execute a call. Earshot integrates at the
application boundary.

## Status

TVIC is pre-1.0 and under active development. The workspace runtime and browser
voice-mode reference gateway are executable; the published `voice-runtime` package
remains a name-reservation preview and is not the public SDK yet.

The only executable topology today is cascaded. Native realtime and half-cascade
remain product scope, and their public contracts will return only alongside working
executors and contract tests, not before. The runtime deliberately ships no public
seam for a topology it cannot run.

The same rule applies to the call lifecycle: the `Call` union models the states
TVIC can actually reach today. Outbound dialing (`CreatedCall`/`RingingCall`) is
contract-reserved — the types exist so the state machine is complete, but no
executor produces them until outbound calling ships.

The `voice-runtime` npm package is currently an early name reservation. It does not
yet export the executable runtime. Use the browser voice-mode example for the
working end-to-end composition today.

## Contributing

Every change is expected to keep the gates green:

```bash
pnpm lint && pnpm test && pnpm build
```

`pnpm lint` runs Prettier, TypeScript across production and test code, and
`scripts/check-architecture.mjs`, which enforces package import boundaries, single
ownership of the normalized audio format, source line budgets, validation of parsed
JSON, and public-package imports instead of deep source imports.

When changing a public contract: identify the executable consumer, add a behavior
test through the public seam, update the affected provider capability declarations,
and avoid claiming delivery or cancellation semantics stronger than the underlying
provider proves.

## License

[Apache-2.0](./LICENSE)
