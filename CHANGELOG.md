# Changelog

This file records user-facing changes to `voice-runtime`. Release evidence and
publishing instructions remain in [docs/releasing.md](./docs/releasing.md).

## 2.2.0 (Unreleased)

### Added

- Added `agent.start()` TTS model, voice, language, and speed overrides, plus
  per-call STT language-policy, vocabulary, and conversation-context controls.
  Agents can set default `ttsVoicesByLanguage` and `sttVocabulary` values.
  Managed calls preflight declared provider support before creating a durable
  session.
- Added optional provider hooks for combined TTS selection and model-specific
  TTS and STT language, vocabulary, voice, speed, and context support. Built-in
  adapters answer them from the same declared catalog data and speed ranges
  they publish in `capabilities`.
- Added public selection helpers and types: `resolveTtsCallSelection()`,
  `resolveSttCallSelection()`, `evaluateTtsSelectionCompatibility()`, their
  input/result/context types, `TtsFailoverRequestVariant`,
  `languageTagCandidates()`, and
  `MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES`. `voice-runtime` also re-exports
  `canonicalizeLanguageTag()`, `normalizeStrictLanguageTag()`, and
  `normalizeLanguageStringMap()`.
- Added call-scoped turn-taking profiles with an explicit AssemblyAI
  Universal-3.6 Pro mapping. Unsupported provider/model combinations fail
  preflight rather than selecting an approximate profile.
- Added bounded provider capability snapshots for model-, voice-, and
  account-scoped facts, plus explicit setup-time Cartesia and ElevenLabs
  loaders. Stale or missing facts reject dependent selections before a call is
  created. The Cartesia adapter also accepts a `capabilitySnapshot` option so
  its preflight hooks can check voice facts synchronously.
- Added typed TTS spelling and pause operations. Cartesia preserves provider
  markup in transcript text by default for 2.1 compatibility; hosts can opt into
  rejection with `transcriptMarkup: "reject"`.
  ElevenLabs text is passed through unchanged, and the provider may interpret
  tag-shaped text on supported routes.
- Added `fallbackRequestVariants` for TTS failover. Each variant matches the
  primary call's effective model, voice, language, or speed with `when` and
  declares the fallback settings. Without `mapFallbackRequest`, the matching
  variant maps the fallback request itself; with a mapper, variants declare the
  allowed mapped settings so both providers can be preflighted. Existing
  `mapFallbackRequest` configurations remain valid without variants; those
  mapped settings are validated when failover is dispatched.
- Added opt-in AssemblyAI Universal-3 Pro conversation-context updates from
  confirmed TTS playout, with bounded context, interruption alignment, and
  reconnect carryover. Definite context write failures are reported as
  `stt.context_update_failed` and do not end the call. An ambiguous timeout or
  cancellation on a live stream can trigger reconnect. Caller audio replay
  continues while TVIC attempts to restore the latest accepted context; replay
  is not held behind the context write. Both paths use an independent 2-second
  context update deadline by default;
  `withSttReconnect()` accepts `contextUpdateTimeoutMs` to override it. Repeated
  ambiguous writes on a healthy stream can each trigger a reconnect to fence
  writes that may complete late. `closeTimeoutMs` bounds the overall graceful
  drain and can expire before an in-flight context update's own deadline.
- Added the provider compatibility issue codes `tts.selection_unsupported`,
  `turn_profile.unsupported`, `tts_text_control.unsupported`, and
  `tts_speed.unsupported`, and the `tts.language_unsupported` and
  `stt.vocabulary_unsupported` error codes. Exhaustive consumers of
  `ProviderCompatibilityIssueCode` must handle the new issue codes.
- Added public consumer checks for the new selection, text-control,
  capability-snapshot, voice-requirement, and turn-profile types and exports.
- Exported the Cartesia and ElevenLabs capability snapshot loaders through the
  published `voice-runtime` package and added a managed-agent snapshot loader
  callback for refreshing bounded account facts before each call.
- Bound Cartesia and ElevenLabs capability snapshot setup to 30 seconds by
  default, with configurable timeouts and caller cancellation covering both
  fetches and response-body reads.
- Documented that STT vocabulary is sent to providers and may appear in URL
  logs for some adapters.

### Changed

- Keep capability snapshot enforcement opt-in for compatibility: when snapshots
  are supplied, stale, missing, or unsupported facts reject dependent selections;
  omitting snapshots preserves existing configured voice behavior. Managed
  agents can load fresh snapshots for each call with
  `loadProviderCapabilitySnapshots`.
- Keep snapshot loading on its own 30-second default deadline. The normal
  startup and call-handle factory deadline remains 10 seconds and is controlled
  by `startupTimeoutMs`; `providerCapabilitySnapshotTimeoutMs` configures the
  loader budget.
- Pass the selected TTS provider, selected model and voice, additional declared
  snapshot providers and selections, and registered dialogue voices to the
  snapshot loader. The callback must return an array, including when it wraps a
  loader that returns one snapshot; other values are rejected with a
  loader-specific configuration error.
- Pin managed-call capability checks to the call-admission time; lower-level TTS
  requests use invocation time unless the host supplies an evaluation time.
- Require model-scoped voice availability facts for model-specific snapshot
  checks. A model-independent voice fact no longer satisfies a selected-model
  query; the ElevenLabs snapshot loader emits one fact per requested model ID.
- Keep non-empty `sttLanguage` values as legacy raw provider values, including
  host-specific tags such as `hi_IN` and `multi`; the managed API rejects an
  empty string. Use `sttLanguagePolicy` when TVIC should normalize and preflight
  a fixed, automatic, or hinted policy.
- Exclude tool names from STT vocabulary by default. Set
  `includeToolNamesInSttVocabulary: true` to include them. The 256-term
  vocabulary limit applies before trimming and de-duplication.
- Gate built-in STT vocabulary by provider model support. Deepgram sends Nova-2 terms as
  `keywords` and Nova-3 terms as `keyterm`, with a 100-term cap; Sarvam Saaras
  v4 sends `keyterms`. Explicit `allowUnknownModel` settings keep vocabulary
  forwarding enabled for an unlisted model, including per-request settings.
- Send Soniox authentication in the WebSocket `Authorization` header.
  Vocabulary is sent in URL query parameters by Deepgram, Cartesia, ElevenLabs,
  AssemblyAI, and Sarvam; Soniox sends it in the WebSocket context payload.
- Treat Soniox `best_effort` language hints as non-restrictive hints and send
  `language_hints_strict: false`; fixed-language policies remain strict.
- Send Cartesia `locale` only for Sonic 3.6 and newer; older models receive a
  base-language value. Validate configured and per-call languages against the
  catalog language list for known models. With `allowUnknownModel`, accept
  syntactically valid language tags and leave model-specific validation to
  Cartesia.
- Reject Cartesia speed values outside `0.6`–`1.5`. A per-call or request-level
  speed requires a current capability fact, from the adapter's
  `capabilitySnapshot` or the request's snapshots, proving the selected voice is
  not a Professional Voice Clone. A speed configured on the adapter is checked
  only when snapshots are supplied.
- Restrict Cartesia normalization and pronunciation dictionaries to Sonic 3.6
  models, where the catalog declares support.
- Count Cartesia `charactersSent` from the serialized transcript at each
  provider write attempt, including generated control markup; buffered text is
  counted only when emitted. Cartesia source text is not XML-entity escaped.
  Counts describe adapter attempts and can include text from operations that
  fail before provider acceptance.
- Make `CartesiaTtsStream.finish()` rethrow a provider failure already received
  by the stream.
- Map Cartesia Bokmål (`nb`) to `no` while preserving its distinct Nynorsk
  (`nn`) code, and map ElevenLabs Bokmål and Nynorsk to its `no` code.
- Route ElevenLabs v3 and v4 through their supported Text-to-Dialogue routes,
  using the provider's configured model when a dialogue request omits `model`
  and `eleven_v3` when the configured speech model is not a dialogue model.
  v4 Turbo remains WebSocket-only, and multi-context dialogue supports v3
  models. Map BCP-47 TTS languages to the provider's language code, reject
  unsupported Flash/Turbo languages and v3/v4 speed settings, and require
  `:voice_id` in custom regular-TTS URLs used with per-call voice overrides.
- Reject a language for ElevenLabs `eleven_multilingual_v2`, which has no
  `language_code` field, instead of silently omitting it. A configured language
  is also rejected on Text-to-Dialogue routes.
- Disable ElevenLabs SSML parsing by default on regular WebSocket routes.
  `enableSsmlParsing: true` remains an explicit opt-in that sends
  `enable_ssml_parsing=true`. The HTTP routes always interpret tags on non-v3
  models, so they accept `true` without sending it and reject `false`. Untyped normalization settings are removed from
  custom URLs, and configured phoneme dictionaries remain an explicit host
  opt-in that may activate the vendor parser.
- Preserve ElevenLabs text exactly on every adapter route. Text-to-Dialogue
  bracket tags and SSML-shaped text with phoneme dictionaries may still be
  interpreted by the vendor; TVIC does not claim those strings are spoken literally.
- When snapshots are supplied, validate ElevenLabs model-scoped features against
  the effective selected model, require speaker-boost support when enabled,
  check configured language against the selected voice's verified locales, and
  require a supported account fact before forcing text normalization on
  Flash/Turbo v2.5 models.
- Check every configured ElevenLabs `dialogueVoices` value during managed-call
  preflight and pass those voices to the capability snapshot loader.
- Map the ElevenLabs `similarityBoost` option to `settings.similarity` on v4
  Text-to-Dialogue HTTP requests; regular TTS continues to use
  `similarity_boost`.
- Keep each ElevenLabs multi-context WebSocket connection on one model. A
  per-context model change is rejected before the request is sent.
- Send an explicit Sarvam `temperature` for `bulbul:v4-flash` on the WebSocket
  route, matching REST and HTTP streaming. No default temperature is sent for
  v4 on any route.
- Add the Assamese personas `kangkana_as_conversational` and
  `mouchumi_as_conversational` to the Bulbul v4 Flash voice catalog. They
  synthesize with `en-IN`, because v4 Flash rejects `as-IN`.
- Report Cartesia and ElevenLabs voice-not-found responses as
  `provider.voice_unsupported` on every route. An ElevenLabs WebSocket voice
  rejection received before any audio no longer sets `metadata.outcomeUnknown`.
- Accept a TTS voice in `evaluateProviderCompatibility` when the provider
  declares no voice catalog or voice hook, matching per-call voice selection.
- Restart Sarvam WebSocket and ElevenLabs dialogue output sequence numbers at 1
  after each commit to satisfy Web Client Audio's per-commit sequence contract.
  Sequence numbers can repeat within a multi-commit turn, so consumers that
  deduplicate output should include commit boundaries in their key.
- Report configured Sarvam Odia as `or-IN` in provider properties and
  capabilities, while serializing it as the provider's `od-IN` wire value.
- Bound AssemblyAI close while flushing partial audio and waiting for pending
  writes. If its deadline expires, reject outstanding audio writes and force
  close the socket without turning a caller-requested close into a failure.
- Preserve provider-resolved per-call TTS voice IDs when no voice facts are
  supplied. A Cartesia capability snapshot or ElevenLabs `knownVoiceIds`/
  `dialogueVoices` list enables strict local preflight for the voices it covers.
- TTS failover validates and copies request metadata before calling the
  primary, so metadata must be structured-cloneable even when the primary
  succeeds. Structured cloning converts class instances to plain objects.
- TTS failover validates text controls against the primary before synthesis
  and checks the fallback only if a fallback is attempted. A request that
  matches no declared variant fails before primary synthesis when variants map
  the request themselves.
- TTS failover rejects a speed that is not supported by both children, and
  preserves primary model and voice catalogs when a request mapper owns
  selection.
- Require `fallbackRequestVariants` when a managed agent enforces snapshots for
  a failover provider with an account-backed fallback and a custom mapper. The
  variants let startup validate the fallback voice before creating the call.
  Direct `synthesize()` calls with snapshots fail before the primary is called.
- Report managed speech-selection validation as `voice_runtime.invalid_config`
  with the previous selection error code in `metadata.selectionErrorCode`.
- Report unsupported cross-field TTS combinations with the public
  `tts.selection_unsupported` provider compatibility issue code.
- Compile the published README quick-start example as part of the public-package
  check so its loader contract and TypeScript example remain valid.

### Fixed

- Stream Hindi, Bengali, Urdu, and CJK sentences incrementally to TTS, and keep
  turn timing consistent across STT reconnect recovery.
- Apply provider-specific language, model, vocabulary, and speed settings or
  reject unsupported combinations before opening the provider stream.
- Treat expired Cartesia capability snapshots as absent so configured voices
  keep working; per-call speed overrides still require fresh metadata.
- Preserve the primary TTS failure when a mapped failover request is invalid,
  and call `onFallback` only after mapping and fallback validation succeed,
  immediately before dispatch.
- Preserve caller-selected languages across TTS failover mappings; a fallback
  variant can change only the regional tag when `languageMatch` allows it.
- Accept failover mappers that rebuild the request without copying its
  selection provenance; the wrapper restores it.
- Report malformed or throwing `requiresTtsLanguageForSelection` hooks as typed
  configuration or validation errors.
- Preserve cancellation errors when Cartesia and ElevenLabs capability
  snapshot fetches or response-body reads are aborted.
- Reconnect and replay the latest STT context if a caller cancels an in-flight
  context write whose provider-side outcome may be ambiguous.
- Keep `…` as an incremental TTS sentence boundary, preserve
  `PipelineVoiceLoop`'s legacy `ttsModelSource`, and ignore TTS selection options
  when that loop has no TTS provider.
- Preserve Sarvam's legacy `od-IN` value and send the provider's Odia wire code;
  keep `or-IN` as a compatible alias. Map Cartesia's canonical `fil` tag back
  to the provider's `tl` tag.
- Record Cartesia voice lookups that return 404 as unavailable voices, classify
  401/403 responses as authentication failures, and honor caller cancellation
  during lookup.
- Redact submitted STT vocabulary and connection URLs from stream failures,
  transport causes, and provider metadata.
- Reject route-incompatible ElevenLabs HTTP model overrides during managed-call
  preflight, before creating a durable session.
- Allow Sarvam Bulbul v4 to receive its required voice at `agent.start()` when
  the agent has no default. Validate voice-language pairs before session
  creation when the host supplies `voiceLanguages`; otherwise leave pair
  validation to Sarvam's API.
- Keep a failed AssemblyAI context update recoverable when reconnect is disabled;
  report the error and continue the call.
- Close the STT stream cleanly when hangup overlaps a reconnect open, and keep
  replay audio moving if a replayed context write times out.

## 2.1.0

### Added

- Added Sarvam Bulbul v4 Flash TTS across WebSocket, REST, and HTTP-stream
  transports, with persona voices and a caller-selected language and voice.
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
