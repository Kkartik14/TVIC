# API reference

The public package exports its supported API from the root import:

```ts
import { createVoiceAgent, createRuntime, defineTool } from "voice-runtime";
```

There are no advanced package subpaths. The generated declaration file in the
published package is the final type-level reference. This page groups the main
entry points by job and links to the source that defines each contract.

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

### `agent.run(options)`

Starts a session and awaits the final `PipelineVoiceLoopResult`. Use this when
the application does not need to consume the public event stream.

### `agent.stop()`

Idempotently cancels active sessions, drains cleanup, and stops the runtime.

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

Use one async iterator per run. Awaiting the run multiple times is safe.

The final result includes:

- The terminal session
- `turnsHandled`
- `interruptions`
- `turnsFailed`
- `firstTurnError`
- `terminalReason`
- `terminalSource`

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

Every provider declares its `kind`, capabilities, name, and adapter version.
Use `supportsAudioFormat`, `supportsLanguage`, `supportsModel`,
`isProviderKind`, and `requireProviderKind` when building custom composition.
`createTtsFailoverProvider` is an explicit host-owned wrapper; it does not
silently route requests or change models. See the failover example in the
[voice-agent guide](./building-a-voice-agent.md).

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
