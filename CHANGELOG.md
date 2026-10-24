# Changelog

This file records user-facing changes to `voice-runtime`. Release evidence and
publishing instructions remain in [docs/releasing.md](./docs/releasing.md).

## Unreleased

### Added

- Added safe structured TTS text operations, and per-call text normalization and
  provider-managed pronunciation dictionary references. Caller and generated
  text remains literal by default; unsupported explicit controls fail preflight.
  Cartesia cannot detect mixed Devanagari and romanized Hindi text, which its
  documentation lists as an unsupported script mixture.
- Added fixed-call STT turn-taking profiles with an explicit AssemblyAI
  Universal-3.6 Pro mapping. Unsupported provider/model combinations fail before
  session creation.
- Added immutable provider account catalog snapshots and explicit Cartesia and
  ElevenLabs setup loaders. Cartesia `is_pro` and locale facts and requested
  ElevenLabs model and voice facts drive managed preflight; catalog requests
  remain outside calls. Sarvam custom voices remain limited to shipped Bulbul
  personas.
- Added provider-aware per-call TTS model, voice, output-language, and speed
  selection, plus fixed, automatic, and hinted STT language policies and
  opt-in vocabulary. Managed calls validate declared provider support before
  creating a durable session.
- Added opt-in AssemblyAI Universal-3 Pro conversation-context updates from
  submitted TTS text, with bounded context, interruption alignment, and
  reconnect carryover. Context updates do not block caller audio.

### Fixed

- Stream Hindi, Bengali, Urdu, and CJK sentences incrementally to TTS, and keep
  turn timing consistent across STT reconnect recovery.
- Apply provider-specific language, model, vocabulary, and speed settings or
  reject unsupported combinations before opening the provider stream.

## 2.1.0

### Added

- Added a transient per-session usage summary to managed `finalSession` values
  and the metadata-only session trace. It records runtime-measured STT audio,
  LLM request and token counts, TTS submitted text and received audio, and
  separately sourced provider metrics. Missing values are explicit, partial
  work is marked interrupted, and non-additive observations are bounded. Usage
  summaries cap entries, metric fields, and identifier lengths; `truncated` is
  set when a cap omits usage detail. Usage contains no prices or currency and
  is not persisted.
- Added an opt-in bounded audio tap for copied caller and agent PCM frames,
  output-clear and playout markers, and transient drop/error counters. Added a
  mock-provider stereo WAV recording example.
- Kept audio-tap observation out of the interruption path. A clear uses the
  normal 250 ms deadline and never waits for an in-flight send or issues a
  follow-up clear. Clear markers retain the tapped audio boundary from when the
  clear was requested and report which turns had sends pending then. Pending
  turn metadata and clear observers are bounded; the example clips late frames
  across turns covered by the transport-wide clear and refuses ambiguous WAVs.
- Released copied PCM after a send timeout while continuing to observe the
  underlying transport operation for later clear markers. The late-send
  callback cannot keep call state alive.
- Preserved the audio-tap object as the callback receiver, including for class
  instances and their empty-session drain notification.
- Kept interrupted agent audio up to a successful clear marker in the recording
  example, then trimmed the queued tail at the marker timestamp. Preserved
  transport-accepted audio by default when playout confirmation is unavailable.
- Made audio-tap summaries optional in public result types for compatible
  wrappers and mocks. Kept tap finalization hooks out of the public `Runtime`
  interface and discard them after terminal writes fail.

### Fixed

- Preserved valid OpenAI Responses usage on terminal events and classified
  `response.incomplete` as a non-retriable, content-free LLM failure.
- Read Groq stream usage from either the top-level or `x_groq.usage` fields and
  surfaced field-level conflicts as invalid instead of silently selecting a
  value.
- Serialized concurrent `endSession()` calls for a session so a duplicate
  request cannot discard the winning call's tap finalizer or session clock.
- Released session clocks when terminal writes fail; clocks remain available
  only while a timed-out write is still pending or terminal finalization runs.

## 2.0.0

### Migration notice

This is a major release. Custom `SessionLeaseStore` and
`ToolIdempotencyStore` adapters built against 1.2.0 need source changes for
lease generation fencing, acknowledged recovery, and explicit idempotency
lookup, claim release, and quarantine. PostgreSQL migrations 014 and 018
require draining incompatible writers before applying them. Tool exceptions
without an explicit retry classification are no longer retried by default.
See the [2.0.0 migration guide](./docs/migrations/2.0.0.md) for before-and-after
contracts and the rollout sequence.

### Added

- Added managed per-session `complete()`, `stop()`, and persisted `finalSession`
  outcomes, with bounded inbound half-close and remote-hangup reporting.
- Added a generic asynchronous WebSocket pre-upgrade authorization hook with a
  configurable deadline and pending-check limit.
- Added bounded Web Client Audio startup buffering, heartbeat handling, and
  reconnect-safe connection lifecycle controls.
- Added Twilio webhook replay protection with a shared Redis-backed store.
- Added an opt-in metadata-only `RuntimeSessionTrace` projection with terminal,
  turn, tool-call, latency, and delivery status.
- Added generation-fenced durable session leases, paginated recovery candidates,
  and application-managed recovery and reaper workers.
- Added durable tool idempotency with lease-scoped recovery, ambiguity
  quarantine, tenant-aware keys, and backend support for PostgreSQL and Redis.
- Added claim release when cancellation prevents a tool executor from starting,
  so that call can be safely attempted later.

### Changed

- Preserve `completed`, `failed`, and `cancelled` as distinct terminal outcomes.
  Host aborts retain the schema-v2 `caller_hangup` cancellation reason and use
  `terminalSource: "caller_abort"` to record the more precise source.
- Changed the public durable adapter contracts to require lease generation
  fencing, acknowledged recovery candidates, and explicit idempotency lookup
  and quarantine results. Custom adapters need migration before upgrading.
- Allow terminal tool writes during the bounded runtime shutdown drain, while
  rejecting writes after the hard-stop deadline.
- Keep runtime-owned stores open if tracked durable writes outlive the bounded
  shutdown drain, then close them after those writes settle.
- Scope tool idempotency records to their creating session, and pass a stable
  key to executors for provider-side duplicate protection. Failed, timed-out,
  cancelled, and quarantined attempts remain terminal for the configured TTL
  once execution begins; reconcile an ambiguous external operation before
  starting a new business operation.
- Treat unclassified tool executor exceptions as non-retriable by default.
  Throw an explicit TVIC error with `retriable: true` to opt into the configured
  retry policy. This avoids automatically repeating operations with an unknown
  outcome.
- Bound persisted error messages and metadata, preserve well-formed Unicode at
  truncation boundaries, and accept older persisted error rows by truncating
  oversized nested fields during read.
- Batch Redis session transaction writes into `MSET` commands of up to 500
  records each, and document that Redis Cluster is unsupported by the current
  multi-key Lua scripts.

### Fixed

- Ignore late Web Client Audio input events after the input queue closes, and
  ignore client turn controls after input is finished so host-ended calls
  finalize their session instead of failing with queue overflow.
- Keep raw upgrade sockets error-handled and tracked until close so a reset
  during an authorization rejection cannot crash the process or stall stop.
- Preserve replayed cancelled tool results in the model continuation unless
  the enclosing turn itself has been aborted.
- Preserve Redis idempotency output JSON as opaque text so Lua does not coerce
  large numbers or convert empty arrays into objects.
- Preserve the original terminal tool error on idempotency replay while marking
  the replay non-retriable.
- Keep class-based tool executors bound to their original instance, omit
  `undefined` schema properties during snapshots, and preserve legacy error
  metadata through bounded reads.
- Restore the PostgreSQL outbox incarnation default and legacy-writer trigger
  for databases that had already recorded migration 009, and map lease-trigger
  violations to lease loss.

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
