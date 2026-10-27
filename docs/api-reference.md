# API reference

The public package exports its supported API from the root import:

```ts
import { createVoiceAgent, createRuntime, defineTool } from "voice-runtime";
```

There are no advanced package subpaths. The generated declaration file in the
published package is the final type-level reference. This page groups the main
entry points by job and links to the source that defines each contract.

## Version and release status

This page documents the current `voice-runtime@2.1.0` source surface. As of
2026-10-21, the npm registry's latest published version is `2.0.0`. Version
2.0.0 includes the managed lifecycle, transport authorization and
half-close reporting, metadata-only session tracing, durable-store contracts,
and idempotency APIs documented here. It is a major upgrade for custom durable
store adapters. Version 2.1.0 adds the audio-tap and session-usage APIs described
here. Consumers on an earlier package version may not have these exports; check
the installed package declarations before using APIs from a newer source
checkout.

Read the [2.0.0 migration guide](./migrations/2.0.0.md) before upgrading custom
`SessionLeaseStore` or `ToolIdempotencyStore` implementations.

## Managed voice agent

Source: [`packages/voice-runtime/src/managed-agent.ts`](../packages/voice-runtime/src/managed-agent.ts)

### `createVoiceAgent(options)`

Creates a validated managed agent and resolves the configured telephony, STT,
LLM, and TTS providers.

Important options:

| Option                | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `prompt`              | Agent instructions used as the base system prompt                        |
| `providers`           | Telephony, STT, LLM, and TTS provider instances or configuration objects |
| `models`              | Optional model and TTS voice overrides                                   |
| `tools`               | Application tool definitions                                             |
| `audio`               | Input and output audio formats, defaulting to PCM16 16 kHz mono          |
| `memoryPolicy`        | Memory scopes, loading, retention, and LLM memory writes                 |
| `contextPolicy`       | Bounds for prompt history and pre-call context                           |
| `interruptionPolicy`  | Caller interruption behavior                                             |
| `audioTap`            | Optional bounded asynchronous callback for caller and agent PCM frames   |
| `runtime`             | Durable state, memory, hooks, health, metrics, and shutdown options      |
| `sttVocabulary`       | Default STT vocabulary terms merged into each call's terms               |
| `ttsVoicesByLanguage` | Default language-to-voice map used when a call does not choose a voice   |

### `agent.start(options)`

Starts and attaches a session. The required `callHandle` can be a preconstructed
handle or a factory. The factory receives:

```ts
{
  sessionId,
  call,
  channel,
  signal,
}
```

The call handle factory is the recommended form for Web Client Audio and Twilio
because the transport can bind its connection to the authoritative runtime
session ID.

`agent.start()` returns a managed session with `run`, `finalSession`,
`complete()`, and `stop()`. `finalSession` resolves to the persisted terminal
session with a required ephemeral `usage` summary after runtime finalization and
transport cleanup settle. Its optional `audioTap` summary also stays in memory
and is not persisted. The runtime starts those two cleanup operations
concurrently, so their completion order is not guaranteed. If cleanup reports a
transport error but the terminal session was persisted, `finalSession` still
resolves to that terminal record and `healthCheck()` reports degraded cleanup.
It rejects when the terminal record
cannot be retrieved or was not persisted. `complete()` ends inbound media
through the transport's `endInput()` method and waits for the final session.
`stop()` cancels only that session and waits up to the managed shutdown drain
deadline. If cleanup is still pending, `stop()` and `finalSession` reject with
`voice_runtime.shutdown_failed`; the error marks `timedOut` and
`lateCleanupPending`, and cleanup may continue in the background. A
host-provided `AbortSignal` also cancels the session; it records
`terminalSource: "caller_abort"`. For compatibility, the persisted
`cancelReason` remains `"caller_hangup"` for that source, so use
`terminalSource` when distinguishing an API abort from a remote hangup.
Start `session.run`—typically by beginning to consume its event stream—before
calling `complete()`. Calling `complete()` before the run starts rejects with
`voice_runtime.session_not_running`.

Speech options can be set per call. Call-level values take precedence over
agent defaults, and the provider's configured value remains the final default.

| Option                            | Purpose / limit                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sttLanguage`                     | Legacy raw provider language string; empty values are rejected.                                                         |
| `sttLanguagePolicy`               | Normalized `fixed`, `auto`, or `hints` policy; hints accept up to 16 languages.                                         |
| `sttVocabulary`                   | Terms merged with agent defaults; the 256-term cap applies before de-duplication, and each term allows 256 code points. |
| `includeToolNamesInSttVocabulary` | Adds tool names to the merged vocabulary; off by default.                                                               |
| `sttConversationContext`          | Enables supported context updates from confirmed agent speech.                                                          |
| `ttsModel`, `ttsVoice`            | Per-call model and voice overrides.                                                                                     |
| `ttsLanguage`                     | Per-call BCP-47 language override.                                                                                      |
| `ttsSpeed`                        | Per-call positive speed; the selected provider may enforce a narrower range.                                            |
| `ttsVoicesByLanguage`             | Per-call language-to-voice map; at most 128 entries.                                                                    |

### `agent.run(options)`

Starts a session and awaits the final `PipelineVoiceLoopResult`. Use this when
the application does not need to consume the public event stream.

### `agent.stop()`

Idempotently cancels active sessions and drains cleanup up to the managed
shutdown deadline. If cleanup remains pending, it rejects with
`voice_runtime.shutdown_failed`; the host should keep runtime dependencies open
until cleanup settles or the process is restarted.

### `agent.healthCheck()`

Returns a health snapshot. Cleanup failures and pending shutdown work are visible
as degraded health.

## Dual-protocol run

Source: [`packages/runtime/src/voice-event.ts`](../packages/runtime/src/voice-event.ts)

`VoiceAgentRun` and `DualProtocolResult` are both:

- `PromiseLike<PipelineVoiceLoopResult>`
- `AsyncIterable<VoiceEvent>`

The event union contains:

| Event kind         | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `transcript_delta` | Partial or final caller transcript text              |
| `audio_output`     | Output audio bytes and sequence                      |
| `turn_started`     | A new turn began                                     |
| `turn_completed`   | A turn reached completed, cancelled, or failed state |
| `tool_call`        | The LLM requested an application tool                |
| `tool_result`      | The tool returned a result                           |
| `error`            | A normalized error and recoverability flag           |
| `call_ended`       | The session reached its terminal call state          |

`tool_result` includes the terminal tool `status`. Failed results include a
safe `error.code` and `error.message`; ambiguous outcomes carry
`recoveryPolicy: "do_not_replay"` so a host can avoid an automatic retry.

Use one async iterator per run. Awaiting the run multiple times is safe.

The resolved `PipelineVoiceLoopResult` includes:

- The active session context (`session`); this is not the persisted terminal record
- `turnsHandled`
- `interruptions`
- `turnsFailed`
- `firstTurnError`
- `terminalReason`
- `terminalSource`
- Optional `audioTap` summary counters

Use the managed session's `finalSession` promise for the persisted terminal
record and its `completed`, `failed`, or `cancelled` status. See
[Runtime tracing](./runtime-tracing.md) for the opt-in content-free trace shape.

## Session usage

`ManagedVoiceAgentFinalSession.usage` is a `SessionUsageSummary` grouped by
operation kind, provider, and model. It includes only provider operations that
ran during the session; its `entries` list is empty when none ran. Each metric
identifies whether TVIC measured it or the provider reported it. Missing values
are explicit, and partial or interrupted operations are not represented as
zero. LLM request counts include tool-continuation requests. STT counts
successful physical audio writes, including reconnect replays. TTS counts
Unicode code points submitted to synthesis and audio duration read from provider
streams. The summary has no prices or currency and is not persisted.

The optional trace `usage` field has the same frozen values. See
[Runtime tracing](./runtime-tracing.md) for the metadata-only trace shape and
[Provider usage reporting](./providers.md#session-usage-reporting) for adapter
fields and provenance. The public contracts are `SessionUsageSummary`,
`SessionUsageEntry`, and `UsageMetric`, exported from the published
`voice-runtime` package.

## Audio tap

`audioTap` is off by default. Set it on `createVoiceAgent()` or
`PipelineVoiceLoop` to receive copied PCM and playback-control events. TVIC does
not store audio.

```ts
audioTap: {
  onFrame(frame) {
    if (frame.type === "audio") savePcm(frame.bytes, frame.format);
    if (frame.type === "cleared") noteClear(frame);
    if (frame.type === "playout") notePlayout(frame);
  },
  onDrained({ sessionId, summary }) {
    return flushHostRecording(sessionId, summary);
  },
}
```

Each audio frame carries copied PCM plus its direction, format, session ID,
sequence, optional turn ID, and monotonic session-relative `timestampMs`.
Caller audio is tapped before STT admission. Agent audio means the transport
accepted it; `playout` reports confirmation when supported. If a send times out,
TVIC releases its copied bytes and counts the frame as dropped.

A `cleared` frame is emitted after a successful output clear. Its sequence
watermark is captured when clear is requested, and its timestamp when clear
succeeds. `hadPendingSends` and `pendingSendTurnIds` identify late sends the
clear may also have removed. `pendingSendTurnIdsTruncated` means the list is
incomplete (TVIC keeps at most 64 turn IDs), so a host cannot safely map every
late frame to a turn from tap data alone. Use the marker to trim unconfirmed
agent audio as a best effort; the timestamp is not an exact playout time. The
[recording example](../examples/call-recording/README.md)
rejects a WAV when the turn list is truncated instead of cutting a later reply.

TVIC sends frames through a bounded queue away from the media producer. Slow
consumers can cause drops, and callback failures are counted. Each queue holds
up to 128 audio frames and 4 MiB of PCM, plus 64 control events. The pipeline,
`finalSession`, and trace summaries are close-time snapshots. An optional
`onDrained` receives a post-drain summary that can include failures from
callbacks still pending at close, if those callbacks settle. If an `onFrame`
promise never settles, `onDrained` will not run. TVIC does not wait for
`onDrained` or the host's storage work. Hosts should queue recording I/O and
apply their own deadline.

When present, `PipelineVoiceLoopResult`, managed `finalSession`, and
`RuntimeSessionTrace` expose the tap's enabled state and drop/error counters.
The summary contains no audio and is not persisted. The host owns recording
consent, storage, retention, and access controls.

## Composable runtime

Source: [`packages/runtime/src/index.ts`](../packages/runtime/src/index.ts)

| Export                              | Use                                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `createRuntime`                     | Create session, turn, tool, memory, and durable-state runtime |
| `defineAgent`                       | Define an agent with explicit providers and audio policy      |
| `defineTool`                        | Define a typed tool with schemas and lifecycle policies       |
| `createNodeMediaPlane`              | Create a Node HTTP and WebSocket server                       |
| `NodeMediaPlane`                    | Control the media server lifecycle                            |
| `PipelineVoiceLoop`                 | Run the cascaded media to STT to LLM to TTS loop              |
| `PipelineVoiceLoopBuilder`          | Build a pipeline with explicit runtime options                |
| `ConversationPolicy`                | Configure turn and endpoint behavior                          |
| `createSttSession`                  | Use a standalone STT provider session                         |
| `withSttReconnect`                  | Add bounded opt-in STT reconnect behavior                     |
| `SessionRecoveryCoordinator`        | Coordinate durable session recovery                           |
| `SessionReaper`                     | Find and finalize stale sessions                              |
| `deliverAssistantText`              | Deliver text according to the selected text mode              |
| `resolvePreCallContext`             | Resolve memory and non-memory context                         |
| `formatMemoryContextAsSystemBlock`  | Render memory context for the model                           |
| `formatPreCallContextAsSystemBlock` | Render static and memory context                              |
| `getSttRecoveryControl`             | Inspect STT recovery state                                    |
| `matchPath`                         | Match media-plane route parameters                            |
| `health` and lifecycle types        | Describe health, cleanup, recovery, and terminal events       |

`SttReconnectOptions.contextUpdateTimeoutMs` sets the deadline for provider
agent-context writes. It defaults to 2 seconds, matching the serial STT path.
`closeTimeoutMs` bounds the full journal drain during graceful close. It can be
shorter than `contextUpdateTimeoutMs`; if a context write is still pending when
the close deadline expires, `close()` fails with `stt.close_timeout` and rejects
pending commands. Set the close deadline longer than the context deadline when
you want a context timeout to settle before the overall drain deadline.

## Providers

Source: [`packages/providers/src/index.ts`](../packages/providers/src/index.ts)

### Constructors

```ts
createWebClientAudioProvider();
createTwilioMediaStreamsProvider();
createDeepgramSttProvider(options);
createCartesiaSttProvider(options);
createSarvamSttProvider(options);
createElevenLabsSttProvider(options);
createAssemblyAiSttProvider(options);
createSonioxSttProvider(options);
createGroqChatLlmProvider(options);
createOpenAiResponsesLlmProvider(options);
createCartesiaTtsProvider(options);
createElevenLabsTtsProvider(options);
createElevenLabsTtsRestProvider(options);
createElevenLabsTtsHttpStreamProvider(options);
createElevenLabsMultiContextProvider(options);
createElevenLabsTtsMultiContextProvider(options);
createElevenLabsDialogueMultiContextProvider(options);
createSarvamTtsProvider(options);
createSarvamTtsRestProvider(options);
createSarvamTtsHttpStreamProvider(options);
createTtsFailoverProvider(options);
fetchCartesiaVoiceCatalogSnapshot(options);
normalizeCartesiaVoiceCatalogSnapshot(snapshot);
```

Sarvam TTS factories accept an optional `voiceLanguages` map for host-owned
Bulbul v4 pair validation. Its keys are persona voice IDs and each value is an
array of supported language tags:

```ts
createSarvamTtsProvider({
  apiKey,
  modelId: "bulbul:v4-flash",
  voiceLanguages: {
    simran_en_customer: ["en-IN"],
    simran_hi_assistant: ["hi-IN"],
  },
});
```

The map can contain up to 128 voice IDs. It is optional; without it, TVIC checks
that the voice and language are individually valid and Sarvam decides whether
that pair is available. The same option is supported by the Sarvam REST and
HTTP-stream factories.

The package root also exports `CartesiaVoiceCatalogEntry`,
`CartesiaVoiceCatalogSnapshot`, `FetchCartesiaVoiceCatalogSnapshotOptions`,
`TtsFailoverRequestVariant`, `resolveTtsCallSelection`, and
`resolveSttCallSelection`. The `PipelineVoiceLoopOptions.sttSelection` and
`.ttsSelection` fields use the exported `SttCallSelection`,
`SttCallSelectionInput`, `TtsCallSelection`, and `TtsCallSelectionInput` types.
`MAX_TTS_VOICES_BY_LANGUAGE_ENTRIES` is the 128-entry language-to-voice map
limit. `canonicalizeLanguageTag`, `normalizeStrictLanguageTag`,
`primaryLanguageSubtag`, `normalizeLanguageStringMap`, and
`languageTagCandidates` are shared language helpers exported from the package
root. `languageTagCandidates` returns progressively broader BCP-47 parent tags.

AssemblyAI's provider instance also exposes its non-streaming STT surfaces:

```ts
const assembly = createAssemblyAiSttProvider({ apiKey });

const realtime = await assembly.open({ sessionId, format, interimResults: true });
const preRecorded = await assembly.transcribe({ audio: wavBytes, mimeType: "audio/wav" });
const protectedBatch = await assembly.transcribe({
  audio: wavBytes,
  mimeType: "audio/wav",
  model: "universal-3-5-pro",
  speakerLabels: true,
  multichannel: true,
  redactPii: true,
  redactPiiPolicies: ["person_name", "phone_number"],
});
const sync = await assembly.transcribeSync({ audio: pcmBytes, format });
async function* pcmChunks() {
  yield pcmBytes;
}
const syncLive = await assembly.transcribeSyncLive({ audio: pcmChunks(), format });
await assembly.warmSync();
```

Use the transport-specific model constants exported by `@tvic/providers` when
building a model picker: `ASSEMBLYAI_REALTIME_MODELS`,
`ASSEMBLYAI_PRE_RECORDED_MODELS`, and `ASSEMBLYAI_SYNC_MODELS`.
`transcribeSyncLive()` accepts an `AsyncIterable<Uint8Array>` for `audio` and
returns one completed transcript when the source ends.

Every provider declares its `kind`, capabilities, name, and adapter version.
Use `supportsAudioFormat`, `supportsLanguage`, `supportsModel`, `supportsBatchModel`,
`isProviderKind`, and `requireProviderKind` when building custom composition.
`createTtsFailoverProvider` is an explicit host-owned wrapper; it does not
silently route requests or change models. See the failover example in the
[voice-agent guide](./building-a-voice-agent.md).

Without `mapFallbackRequest`, failover uses identity mapping: the effective
primary model and voice are passed to the fallback. If providers use different
model or voice IDs, supply a mapper and declare the fallback values with
`fallbackRequestVariants` when they can be known before a call.

`mapFallbackRequest` may be used without `fallbackRequestVariants`. In that
case, compatibility checks preflight the primary provider and TVIC validates
the mapped fallback request only when failover is needed. Supplying
`fallbackRequestVariants` lets TVIC preflight the declared fallback settings as
well. If mapped settings fail validation, the error keeps the primary provider's
code and includes a `fallbackValidationFailure` metadata entry. `onFallback` is
called only after mapping and fallback validation succeed, immediately before
dispatch. Mapping, validation, or cancellation failures do not call it. The
callback receives the validated mapped request, and its `error` field remains
the primary provider failure.

Each variant may include `when` to match the primary call's effective model,
voice, language, or speed. Language matching is exact by default; set
`languageMatch: "base-language"` to match tags such as `en` and `en-IN`. For
preflight, omitted model and voice fields use the fallback provider's configured
defaults. An omitted language carries an explicitly supplied call language,
including a host-supplied default, and speed is preserved from the call. A
variant's declared fallback language must match a caller-selected language
under `languageMatch`; the mapper cannot silently switch that call to another
language. With no explicit call language, a
variant's declared language supplies the fallback language. If the mapper omits
language, TVIC carries through the explicit call language or applies the
matching variant's declared tag. If the mapper adds a language when the call
supplied none, TVIC validates that as an explicit fallback language while
preserving the original caller-provenance flag. The mapper's actual output is still validated
before dispatch. Once variants are declared, the mapped output must match one
applicable variant's declared fallback fields; fields a variant omits are
validated against the fallback provider's own defaults and capabilities.

The primary's configured language can be used to match a variant's `when`
condition, because those conditions use the effective primary selection. TVIC
does not copy that primary default into the fallback request when the request
itself has no language hint. This occurs with incremental sessions that omit a
language from `openSession()` as well as with other requests that omit it. In
that case, the fallback uses its own configured language unless the mapper or
matching variant supplies one. A fallback model that requires an explicit
language needs a per-call language, a host-supplied language default, or a
declared fallback language; an adapter's implicit language default does not
satisfy that rule.

Cartesia STT exposes both realtime `open()` streams and an optional complete-file
`transcribe()` operation. The latter uses the provider's batch model and returns
one complete transcript with optional word timestamps; inspect
`capabilities.batch` and `capabilities.batchModels` before selecting it. Batch
transcription is for recorded input and is not part of TVIC's live cascaded loop.

The current catalog and maturity data are in [Providers](./providers.md).

## Media helpers

Source: [`packages/media/src/index.ts`](../packages/media/src/index.ts)

The root exports:

- `createAudioNormalizer`
- `assertPcm16leFormat`
- `base64ToBytes` and `bytesToBase64`
- `durationMsForPcm16le`
- `frameCountForPcm16le`
- `splitPcm16leFrames`
- `resamplePcm16le`
- `mulawToPcm16le`
- `pcm16leToMulaw`
- `isInputMediaEvent` and `isOutputMediaEvent`
- `AsyncQueue`

TVIC's normalized runtime boundary is PCM16 little-endian audio, normally 16 kHz
mono. Provider and transport adapters may convert at their edge.

## Tools

Source: [`packages/runtime/src/define-tool.ts`](../packages/runtime/src/define-tool.ts)

`defineTool<TInput, TOutput>()` accepts:

- `id`, `name`, and `description`
- `inputSchema` and optional `outputSchema`
- `timeout`
- `retry`
- `idempotency`
- `execute(input, context)`
- Optional tags, metadata, and compatibility fields

The execution context includes session, turn, tool-call, attempt, signal, logger,
and optional tenant identity. The application enforces authorization.

## Persistence and memory

The root exports these adapters and migrations:

```ts
createInMemoryDurableRuntimeStore();
createInMemoryMemory();
createPostgresDurableRuntimeStore({ pool });
runPostgresMigrations(pool);
createRedisDurableRuntimeStore(redis);
createPostgresRedisDurableRuntimeStore({ pool, redis });
createPostgresMemory({ pool });
runPostgresMemoryMigrations(pool);
```

See [Persistence](./persistence.md) for lifecycle, ownership, scopes, retention,
and Docker integration.

## Authentication helpers

The provider package exports:

```ts
computeTwilioSignature(url, params, authToken);
verifyTwilioSignature(url, params, authToken, options);
canonicalizeTwilioData(params);
signVoiceSessionToken(payload, secret);
verifyVoiceSessionToken(token, secret, options);
```

These helpers do not replace application identity, origin checks, rate limits, or
authorization. Use the complete gateway patterns in [Transports](./transports.md).

## Errors

Source: [`packages/core/src/errors.ts`](../packages/core/src/errors.ts)

The root exports normalized error constructors and type guards, including:

- `normalizedError`
- `normalizeUnknownError`
- `isNormalizedError`
- `isTvicError`
- `TvicThrowableError`
- Category helpers such as `validationError`, `providerError`, `timeoutError`,
  `cancelledError`, and `internalError`

Use normalized errors for event payloads and persistence. Use `isTvicError` when
handling a thrown `TvicThrowableError` across an application boundary.

## Versioning

The generated declarations and package root exports are the public contract. Do
not import workspace source files or unpublished package subpaths from an
application. Read the release notes and migration notes before changing a
public type or provider capability claim.
