# Changelog

This file records user-facing changes to `voice-runtime`. Release evidence and
publishing instructions remain in [docs/releasing.md](./docs/releasing.md).

## Unreleased

### Added

- Added managed per-session `complete()`, `stop()`, and persisted `finalSession`
  outcomes, with bounded inbound half-close and remote-hangup reporting.
- Added a generic asynchronous WebSocket pre-upgrade authorization hook with a
  configurable deadline and pending-check limit.
- Added an opt-in metadata-only `RuntimeSessionTrace` projection with terminal,
  turn, tool-call, latency, and delivery status.

### Changed

- Preserve `completed`, `failed`, and `cancelled` as distinct terminal outcomes.
  Host aborts retain the schema-v2 `caller_hangup` cancellation reason and use
  `terminalSource: "caller_abort"` to record the more precise source.

## 1.2.0

Released 2026-09-28. See the [published release notes](https://github.com/Kkartik14/TVIC/releases/tag/voice-runtime-v1.2.0).

### Added

- Added provider capability metadata and batch speech-to-text contracts, then
  integrated capability checks into managed-agent execution.
- Expanded ElevenLabs speech support with HTTP, streaming, batch transcription,
  multi-context sessions, broader model coverage, and stricter option checks.
- Added Sarvam Bulbul v3 text-to-speech support across WebSocket, REST, and HTTP
  streaming, with WAV/base64 handling and voice/language validation.
- Added AssemblyAI pre-recorded HTTP, synchronous, sync-live, and expanded
  realtime transcription paths with bounded parsing and model validation.
- Added composable TTS failover and deterministic local provider fixtures.

### Changed

- Improved provider error normalization, adapter boundary checks, managed-agent
  run handling, and runtime state boundaries.
- Expanded provider examples, documentation, smoke tooling, and release
  evidence.

## 1.2.0

Released 2026-09-28.

### Added

- Added Cartesia Ink realtime and batch STT, expanded AssemblyAI realtime and
  HTTP transcription, and added more ElevenLabs Scribe batch support.
- Added Sarvam Bulbul v3 WebSocket, REST, and HTTP-stream TTS, plus expanded
  ElevenLabs HTTP and multi-context TTS surfaces.
- Added an explicit TTS failover adapter that stops fallback after primary audio
  has been emitted, along with a credential-free failover example.
- Added provider capability requirements and compatibility checks for configured
  models, audio formats, streaming, tool calls, and transport behavior.
- Added provider smoke and model-matrix scripts for the expanded STT and TTS
  surfaces.

### Changed

- Hardened provider protocol parsing, request and response bounds, cancellation,
  error classification, and stream lifecycle handling across adapters.
- Updated provider catalogs, maturity metadata, public exports, and guides for
  the expanded provider surface.
- Removed the repository-local live reference stack and its configuration; the
  maintained examples and provider smoke tools are the supported validation paths.

## 1.1.0

Released 2026-09-18.

### Added

- Added bounded async-control and lifecycle contracts for pipeline deadlines,
  queue limits, cancellation, event ordering, shutdown, and failure
  normalization, with deterministic tests and operational documentation.
- Added opt-in resilient STT recovery with bounded command replay and explicit
  at-least-once delivery limitations.
- Added incremental TTS input, playout-aware playback, and structured turn and
  tool-output paths.
- Added Docker-backed local PostgreSQL and Redis integration harnesses plus
  provider-stack smoke tooling for the documented cascaded path.
- Added provider maturity metadata and an evidence ladder. Web Client Audio and
  inbound Twilio Media Streams are the stable transport paths in this release;
  paid provider adapters remain experimental.

### Changed

- Normalized provider and runtime failures to canonical error codes and added
  migration evidence for the public error contract.
- Expanded and verified the public `voice-runtime` surface across ESM,
  CommonJS, TypeScript, and clean consumer installations.
- Hardened CI and release gates around exact artifacts, durable integrations,
  Node.js 22/24/26 support, and non-mutating publication workflows.
- Documented the cascaded-only executable topology and the support boundaries
  for providers, transports, and live evidence.

### Fixed

- Corrected cancellation, late-event cleanup, queue shutdown, and playout
  bookkeeping paths so unacknowledged audio cannot be recorded as heard.
- Improved bounded failure handling for provider closure, write failures,
  malformed input, timeouts, and interrupted turns.

### Security

- Added and exercised fail-closed authentication, replay, ingress, secret
  boundary, and configuration checks in the release verification path.

### Documentation

- Added beginner, developer, AI coding-agent, provider, transport, tools,
  persistence, testing, deployment, troubleshooting, and API guides.
- Added documentation references and missing example READMEs.

## 1.0.1

Released 2026-09-08.

### Added

- Published the `voice-runtime` Node.js package with ESM and CommonJS entry
  points.
- Exposed the managed voice-agent facade and the composable runtime surface from
  one package root.
- Added browser Web Client Audio and inbound Twilio Media Streams transport paths.
- Added Deepgram, Sarvam, ElevenLabs Scribe, AssemblyAI, and Soniox STT adapters.
- Added Groq Chat Completions, OpenAI Responses, Cartesia, and ElevenLabs TTS
  adapters.
- Added in-memory, PostgreSQL, Redis, and composite durable-state adapters.
- Added tools, memory, interruption, playout, recovery, normalized errors, and
  public-package verification paths.

### Security

- Added authenticated browser token flow and Twilio webhook verification.
- Added replay protection, bounded requests, single-use media tokens, and
  server-only provider credential handling.

## 1.0.0

Released 2026-09-08.

The first public release of the `voice-runtime` package and the TVIC cascaded
runtime contract. See the GitHub release notes for the exact artifact and
acceptance evidence.
