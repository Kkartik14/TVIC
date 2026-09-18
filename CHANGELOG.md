# Changelog

This file records user-facing changes to `voice-runtime`. Release evidence and
publishing instructions remain in [docs/releasing.md](./docs/releasing.md).

## Unreleased

No unreleased changes.

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
