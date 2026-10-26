# API reference

The public package exports its supported API from the root import:

```ts
import { createVoiceAgent, createRuntime, defineTool } from "voice-runtime";
```

There are no advanced package subpaths. The generated declaration file in the
published package is the final type-level reference. This page groups the main
entry points by job and links to the source that defines each contract.

## Version and release status

This page documents the current `voice-runtime@3.0.0` source surface. As of
2026-10-26, the npm registry's latest published version is `2.1.0`. Version
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

| Option                            | Purpose                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `prompt`                          | Agent instructions used as the base system prompt                                                                  |
| `providers`                       | Telephony, STT, LLM, and TTS provider instances or configuration objects                                           |
| `models`                          | Optional model and TTS voice overrides                                                                             |
| `providerCapabilitySnapshots`     | Optional capability facts; supplying them enables strict snapshot checks                                           |
| `loadProviderCapabilitySnapshots` | Optional callback for fresh facts on every start; its signal follows caller, shutdown, and its own loader deadline |
| `tools`                           | Application tool definitions                                                                                       |
| `audio`                           | Input and output audio formats, defaulting to PCM16 16 kHz mono                                                    |
| `memoryPolicy`                    | Memory scopes, loading, retention, and LLM memory writes                                                           |
| `contextPolicy`                   | Bounds for prompt history and pre-call context                                                                     |
| `interruptionPolicy`              | Caller interruption behavior                                                                                       |
| `audioTap`                        | Optional bounded asynchronous callback for caller and agent PCM frames                                             |
| `runtime`                         | Durable state, memory, hooks, health, metrics, and shutdown options                                                |

The snapshot loader receives the selected TTS provider, model, and voice,
`providerCapabilitySnapshotProviders`, any declared
`providerCapabilitySnapshotSelections`, and
`providerCapabilitySnapshotVoices` as provider/model/voice selections, including
registered ElevenLabs dialogue voices and failover children. A wrapped
provider's selections may include `side: "primary"` or `side: "fallback"` to
identify the declaring child. `modelSource: "selected"` means the model follows
the call's selected model; `modelSource: "mapped"` preserves a model selected by
a failover mapping. Capability lookup uses provider, model, and voice.
It also receives an `AbortSignal`. Return a snapshot array; returning a single snapshot or
`undefined` is a configuration error. The callback runs for every `start()`.
Snapshots it loads replace configured snapshots for the same provider, while
configured snapshots for providers it does not return remain available.

Snapshot loading has its own `providerCapabilitySnapshotTimeoutMs`, which
defaults to 30 seconds. The ordinary startup and call-handle factory deadline
remains 10 seconds by default, controlled by `startupTimeoutMs`. Set the loader
timeout lower when the provider API should have a shorter budget.
Both timeout options must be positive integers no greater than `2_147_483_647`.
The loader signal is cancelled by caller abort, shutdown, or its own deadline;
`startupTimeoutMs` applies to later call-handle startup.

When a TTS failover mapping table is used with account-backed voices, both child
providers must expose voice selections TVIC can check. Each mapping source and
destination is checked against provider/model/voice snapshot facts before the
call starts.

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
session ID. `providerCapabilitySnapshotTimeoutMs` controls the preceding
snapshot-loader deadline; `startupTimeoutMs` controls the regular call-start
deadline after capability loading.

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
Unicode code points at the adapter's text submission or write-attempt boundary
and audio duration read from provider streams. Counts can include text from an
operation that fails before provider acceptance. Cartesia includes generated
control markup without XML-entity escaping and passes Cartesia markup embedded
in source transcript text through by default. Set `transcriptMarkup: "reject"`
to reject supported Cartesia markup before sending it. ElevenLabs and Sarvam count submitted plain text
using route-specific accounting points. The summary has no prices or currency
and is not persisted.

The optional trace `usage` field has the same frozen values. See
[Runtime tracing](./runtime-tracing.md) for the metadata-only trace shape and
[Provider usage reporting](./providers.md#session-usage-reporting) for adapter
fields and provenance. The public contracts are `SessionUsageSummary`,
`SessionUsageEntry`, and `UsageMetric` from `@tvic/core`, re-exported by
`voice-runtime`.

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
```

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
