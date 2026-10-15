# API reference

The public package exports its supported API from the root import:

```ts
import { createVoiceAgent, createRuntime, defineTool } from "voice-runtime";
```

There are no advanced package subpaths. The generated declaration file in the
published package is the final type-level reference. This page groups the main
entry points by job and links to the source that defines each contract.

## Release status (checked 2026-09-30)

The latest published package is
[`voice-runtime@1.2.0`](https://www.npmjs.com/package/voice-runtime). Its
published declarations do not yet include this checkout's per-session
`finalSession`, `complete()`, and `stop()` APIs; half-close and remote-hangup
transport fields; the asynchronous `NodeMediaPlane.authorizeUpgrade` hook and
its timeout/capacity options; or `RuntimeSessionTrace`,
`toRuntimeSessionTrace()`, and `onSessionTrace`; or the
`ToolExecutionContext.idempotencyKey` and `tool_result` terminal status and
recovery fields; `ToolIdempotencyStore.quarantine()` and its result types; and
`IdempotencyPolicy.legacyKeyCompatibility`. Those
source-tree additions require a package release before an npm consumer can use
them; check the installed package declarations.

## Managed voice agent

Source: [`packages/voice-runtime/src/managed-agent.ts`](../packages/voice-runtime/src/managed-agent.ts)

### `createVoiceAgent(options)`

Creates a validated managed agent and resolves the configured telephony, STT,
LLM, and TTS providers.

Important options:

| Option               | Purpose                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `prompt`             | Agent instructions used as the base system prompt                        |
| `providers`          | Telephony, STT, LLM, and TTS provider instances or configuration objects |
| `models`             | Optional model and TTS voice overrides                                   |
| `tools`              | Application tool definitions                                             |
| `audio`              | Input and output audio formats, defaulting to PCM16 16 kHz mono          |
| `memoryPolicy`       | Memory scopes, loading, retention, and LLM memory writes                 |
| `contextPolicy`      | Bounds for prompt history and pre-call context                           |
| `interruptionPolicy` | Caller interruption behavior                                             |
| `runtime`            | Durable state, memory, hooks, health, metrics, and shutdown options      |

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
session after runtime finalization and transport cleanup settle. The runtime
starts those two cleanup operations concurrently, so their completion order is
not guaranteed. If cleanup reports a transport error but the terminal session
was persisted, `finalSession` still resolves to that terminal record and
`healthCheck()` reports degraded cleanup. It rejects when the terminal record
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

Use the managed session's `finalSession` promise for the persisted terminal
record and its `completed`, `failed`, or `cancelled` status. See
[Runtime tracing](./runtime-tracing.md) for the opt-in content-free trace shape.

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
