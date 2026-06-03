# T-vic System Architecture

Status: implementation-aligned architecture guide  
Audience: engineers joining the project, reviewers, and contributors extending
the runtime  
Scope: how the current monorepo is layered, how data flows through a live call,
how events become artifacts and UI, and where persistence belongs

## One-Sentence Architecture

T-vic is a TypeScript runtime that coordinates telephony, STT, LLMs, tools, TTS,
memory, traces, artifacts, and replay through strict provider-agnostic contracts.

```mermaid
flowchart LR
  AudioIn[Caller audio]
  Runtime[T-vic runtime]
  Reasoning[LLM + tools]
  AudioOut[Agent audio]
  Trace[Trace stream]
  Artifacts[Call artifacts]
  Viewer[Trace viewer]

  AudioIn --> Runtime
  Runtime --> Reasoning
  Reasoning --> Runtime
  Runtime --> AudioOut
  Runtime --> Trace
  Runtime --> Artifacts
  Trace --> Viewer
  Artifacts --> Viewer
```

## Product Boundary

T-vic owns the runtime and infrastructure layer for production voice systems.

T-vic owns:

- agent/session/call/turn contracts;
- provider abstraction;
- normalized media events;
- the realtime orchestration loop;
- tool execution behavior;
- conversational state and memory interfaces;
- trace events, timing, artifacts, replay, and failure explanation;
- runtime reliability behavior: cancellation, retries, timeouts, playout
  confirmation, and teardown.

T-vic does not currently own:

- foundational STT, TTS, or LLM model training;
- telecom carrier infrastructure;
- a hosted enterprise dashboard;
- billing/auth/RBAC;
- a no-code workflow builder;
- a generic call-center product.

## Monorepo Dependency Graph

The dependency graph is intentionally narrow. `@tvic/core` is the base. Runtime
coordinates other packages. React renders derived view models and does not
interpret raw trace semantics.

```mermaid
flowchart TB
  Core["@tvic/core\ncontracts, IDs, policies, entities"]
  DAL["@tvic/dal\nstores, memory, artifacts"]
  Media["@tvic/media\nmedia buffers + guards"]
  Tools["@tvic/tools\ntool registry + execution"]
  Providers["@tvic/providers\nTwilio, Deepgram, OpenAI, Cartesia"]
  Tracing["@tvic/tracing\ntrace parsing, inspection, replay"]
  Runtime["@tvic/runtime\nlifecycle, loop, media plane"]
  LiveCall["examples/live-call\nreal inbound gateway"]
  Viewer["apps/trace-viewer\nNext.js UI"]

  Core --> DAL
  Core --> Media
  Core --> Tools
  Core --> Providers
  Core --> Tracing
  Core --> Runtime
  DAL --> Runtime
  Media --> Runtime
  Tools --> Runtime
  Tracing --> Runtime
  Providers --> Runtime
  Runtime --> LiveCall
  Providers --> LiveCall
  DAL --> LiveCall
  Tracing --> LiveCall
  Tracing --> Viewer
  Core --> Viewer
```

Enforced direction:

| Package             | May import                                  | Must not import                   |
| ------------------- | ------------------------------------------- | --------------------------------- |
| `@tvic/core`        | no sibling packages                         | runtime, providers, tracing, DAL  |
| `@tvic/dal`         | `@tvic/core`                                | runtime, providers, UI            |
| `@tvic/media`       | `@tvic/core`                                | runtime, providers, DAL           |
| `@tvic/tools`       | `@tvic/core`                                | runtime, providers, UI            |
| `@tvic/providers`   | `@tvic/core`, `@tvic/media`                 | runtime, DAL, UI                  |
| `@tvic/tracing`     | `@tvic/core`, `@tvic/dal`                   | runtime, providers, UI            |
| `@tvic/runtime`     | core, DAL, media, tools, tracing, providers | UI                                |
| `apps/trace-viewer` | core, tracing                               | runtime, providers, DAL internals |

## Layer Ownership

```mermaid
flowchart TB
  Domain["Domain / contracts\n@tvic/core"]
  DAL["Data access\n@tvic/dal"]
  Adapter["Provider adapters\n@tvic/providers"]
  Controller["Runtime controller\n@tvic/runtime"]
  Projection["Trace projection\n@tvic/tracing"]
  UI["View layer\napps/trace-viewer"]

  Domain --> DAL
  Domain --> Adapter
  Domain --> Controller
  DAL --> Controller
  Adapter --> Controller
  Controller --> Projection
  DAL --> Projection
  Projection --> UI
```

| Layer      | Owns                                                                        | Does not own                                          |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------- |
| Domain     | entity contracts, pure guards, policies, domain transitions                 | I/O, provider SDKs, persistence                       |
| DAL        | storing and querying sessions, turns, tool calls, traces, memory, artifacts | business decisions, provider calls                    |
| Adapters   | translating external provider streams into T-vic contracts                  | runtime state, persistence, UI                        |
| Controller | coordinating sessions, turns, providers, tools, memory, tracing             | long-term storage details, React view logic           |
| Projection | trace serialization, parsing, derived timeline/inspection/failure models    | live orchestration, provider calls                    |
| UI         | rendering view models, local UI state, audio controls                       | trace semantics, latency math, failure classification |

## Core Runtime Contracts

The runtime is built around a small set of load-bearing contracts.

```mermaid
classDiagram
  class Agent {
    id
    name
    instructions
    providers
    tools
    audioPolicy
    memoryPolicy
    interruptionPolicy
    recordingPolicy
  }
  class Session {
    id
    agentId
    status
    callId
    startedAt
    endedAt
  }
  class Call {
    id
    direction
    transport
    status
    from
    to
  }
  class Turn {
    id
    sessionId
    status
    input
    output
    latency
  }
  class ToolCall {
    id
    toolId
    turnId
    status
    attempts
  }
  class MediaEvent {
    id
    sessionId
    direction
    type
    monotonicOffsetMs
  }
  class TraceEvent {
    id
    traceId
    spanId
    parentSpanId
    status
    monotonicOffsetMs
  }
  Agent --> Session
  Session --> Call
  Session --> Turn
  Turn --> ToolCall
  MediaEvent --> TraceEvent
```

Key invariants:

- Every `Session` belongs to one `Agent`.
- A `Session` may be linked to a `Call`.
- A `Turn` is the conversational unit used by traces, latency, memory, and
  failures.
- `TraceEvent.monotonicOffsetMs` is the clock used for all latency math.
- Audio bytes are not stored in trace events.
- Tool failures can be incidents inside a completed turn; they are not always
  terminal failures.

## Runtime Loop

The current live-call path uses pipeline mode:

```mermaid
flowchart LR
  TwilioIn[Twilio media in\nmulaw 8k]
  Decode[Decode + resample\nPCM s16le 16k]
  STT[Deepgram stream]
  Policy[ConversationPolicy\nhistory + tool decision]
  LLM[OpenAI streaming]
  Tool[Tool execution]
  TTS[Cartesia streaming]
  Encode[Resample + encode\nmulaw 8k]
  TwilioOut[Twilio media out]

  TwilioIn --> Decode
  Decode --> STT
  STT --> Policy
  Policy --> LLM
  LLM --> Tool
  Tool --> LLM
  LLM --> TTS
  TTS --> Encode
  Encode --> TwilioOut
```

### Normal Turn Sequence

```mermaid
sequenceDiagram
  autonumber
  participant Media as Media input
  participant STT
  participant Loop as PipelineVoiceLoop
  participant Policy as ConversationPolicy
  participant LLM
  participant TTS
  participant Call as CallHandle
  participant Runtime
  participant Trace

  Media->>Loop: input audio chunks
  Loop->>STT: sendAudio(chunk)
  STT-->>Loop: stt.final transcript
  Loop->>Runtime: startTurn
  Runtime->>Trace: turn.started
  Loop->>Policy: accept transcript + history
  Policy-->>Loop: LLM messages
  Loop->>LLM: complete(messages, tools, signal)
  LLM-->>Loop: llm.token stream
  Loop->>TTS: synthesize(text, signal)
  TTS-->>Loop: output audio chunks
  Loop->>Call: send audio chunk
  Loop->>Call: send committed mark
  Call-->>Loop: playout confirmed
  Loop->>Runtime: endTurn(completed, latency)
  Runtime->>Trace: turn.ended + audio output events
```

### Tool Turn Sequence

```mermaid
sequenceDiagram
  autonumber
  participant Loop
  participant LLM
  participant Tools as @tvic/tools
  participant Tool as Developer tool
  participant Runtime
  participant Trace

  Loop->>LLM: initial pass
  LLM-->>Loop: tool call
  Loop->>Trace: tool.queued / tool.started
  Loop->>Tools: executeTool(input, timeout, retry, idempotency, signal)
  Tools->>Tool: execute
  alt success
    Tool-->>Tools: output
    Tools-->>Loop: succeeded ToolCall
    Loop->>Trace: tool.completed
  else retryable failure
    Tool-->>Tools: error
    Tools-->>Loop: retry callback
    Loop->>Trace: runtime.retry
    Tools->>Tool: retry execute
  else unrecovered failure
    Tools-->>Loop: failed ToolCall
    Loop->>Trace: tool.failed
  end
  Loop->>Runtime: recordToolCall
  Loop->>LLM: continuation with tool result or tool error
  LLM-->>Loop: response text
```

### Interruption Flow

Barge-in is a runtime behavior, not a UI feature. A turn can be cancelled after
the caller interrupts while output is active.

```mermaid
sequenceDiagram
  autonumber
  participant Caller
  participant Twilio
  participant STT
  participant Loop
  participant LLM
  participant TTS
  participant Runtime
  participant Trace

  Loop->>Twilio: output audio chunks
  Twilio-->>Caller: agent speaking
  Caller->>Twilio: starts speaking over agent
  Twilio->>STT: input audio continues
  STT-->>Loop: interim transcript while output-active
  Loop->>Trace: interrupt.detected
  Loop->>LLM: abort signal
  Loop->>TTS: abort signal
  Loop->>Twilio: cancelOutput / clear
  Loop->>Trace: output.cancelled
  Loop->>Runtime: endTurn(cancelled: barge_in)
  Runtime->>Trace: turn.ended(cancelled)
```

Important distinction:

- if output was delivered and then the caller hangs up, the turn can still be
  completed;
- if output was not heard or playout was not confirmed, the turn is cancelled
  and memory is not written as a completed exchange.

### Provider Stall / Timeout Flow

```mermaid
sequenceDiagram
  autonumber
  participant Loop
  participant Provider as LLM/TTS provider
  participant Runtime
  participant Trace

  Loop->>Provider: start stream with AbortSignal
  Provider--xLoop: no event before stall timeout
  Loop->>Trace: runtime.timeout(stage, timeoutMs, policyAction)
  alt timeout policy = fail
    Loop->>Runtime: endTurn(failed)
    Runtime->>Trace: turn.ended(failed)
  else timeout policy = interrupt
    Loop->>Provider: abort
    Loop->>Runtime: endTurn(cancelled: timeout)
    Runtime->>Trace: turn.ended(cancelled)
  end
```

## Media Plane

The media plane must run in a long-running process. It is not designed for
short-lived serverless functions.

```mermaid
flowchart TB
  HTTP["HTTP /twiml"]
  WS["WebSocket /media/:callId"]
  Token[Single-use signed media token]
  TwilioSig[Twilio signature validation]
  Accept[acceptWebSocket]
  Handle[TwilioMediaStreamCallHandle]
  Runtime[Runtime session + loop]

  HTTP --> TwilioSig
  TwilioSig --> Token
  Token --> WS
  WS --> Accept
  Accept --> Handle
  Handle --> Runtime
```

Responsibilities:

- serve TwiML for inbound calls;
- validate Twilio webhook signatures when configured;
- mint single-use media stream tokens;
- accept WebSocket connections;
- adapt Twilio frames into normalized input `MediaEvent`s;
- send normalized output chunks back to Twilio;
- send clear/cancel commands for interruption;
- confirm playout through Twilio marks where available.

## Provider Boundary

Provider adapters are transport-specific. The runtime consumes only T-vic
contracts.

```mermaid
flowchart LR
  subgraph ProviderWorld["Provider wire formats"]
    TwilioJson[Twilio WS JSON]
    DeepgramJson[Deepgram WS JSON]
    OpenAISse[OpenAI SSE]
    CartesiaJson[Cartesia WS JSON]
  end

  subgraph Adapter["Adapter normalization"]
    TwilioAdapter[TwilioMediaStreamCallHandle]
    DeepgramAdapter[DeepgramSttStream]
    OpenAIAdapter[OpenAiResponsesLlmProvider]
    CartesiaAdapter[CartesiaTtsStream]
  end

  subgraph Contracts["T-vic contracts"]
    CallHandle[CallHandle]
    TranscriptEvent[TranscriptEvent]
    LlmEvent[LlmStreamEvent]
    TtsEvent[TtsEvent]
    MediaEvent[MediaEvent]
  end

  TwilioJson --> TwilioAdapter --> CallHandle
  TwilioAdapter --> MediaEvent
  DeepgramJson --> DeepgramAdapter --> TranscriptEvent
  OpenAISse --> OpenAIAdapter --> LlmEvent
  CartesiaJson --> CartesiaAdapter --> TtsEvent
```

Adapter rules:

- decode provider-specific payloads at the edge;
- emit normalized PCM where the runtime expects normalized media;
- never leak provider SDK objects into `@tvic/core` contracts;
- close queues on provider close/error/cancel;
- normalize errors with provider and code metadata;
- honor `AbortSignal` where the contract provides it.

## Event Flow

Every important runtime action emits a `TraceEvent`.

```mermaid
flowchart TB
  Action[Runtime action]
  CoreTrace[TraceEvent core fields]
  TypeVariant[Typed event variant]
  Redaction[Redaction hook]
  StoreChain[TraceStore chain]
  ExporterChain[Exporter chain]
  LiveHandlers[Live subscribers]
  JSONL[call.jsonl]
  Inspection[deriveCallInspection]
  UI[Trace viewer]

  Action --> CoreTrace
  CoreTrace --> TypeVariant
  TypeVariant --> Redaction
  Redaction --> StoreChain
  Redaction --> ExporterChain
  Redaction --> LiveHandlers
  ExporterChain --> JSONL
  JSONL --> Inspection
  StoreChain --> Inspection
  Inspection --> UI
```

Core timing fields:

| Field               | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `timestamp`         | wall-clock ISO for display and external correlation |
| `monotonicOffsetMs` | call/session clock for all latency math             |
| `spanId`            | groups events into a waterfall span                 |
| `parentSpanId`      | expresses nesting without guessing from event order |
| `correlationId`     | groups a logical operation across events            |

Trace delivery is isolated:

- store and exporter sinks have independent ordered chains;
- one stuck sink cannot block realtime audio;
- per-sink ordering is preserved;
- flush behavior is bounded;
- session-level exporters are released only when their chains drain.

## DAL Segregation

DAL exists to keep persistence out of runtime controllers.

```mermaid
flowchart TB
  subgraph CoreInterfaces["@tvic/core DAL interfaces"]
    SessionStoreI[SessionStore]
    TurnStoreI[TurnStore]
    ToolCallStoreI[ToolCallStore]
    TraceStoreI[TraceStore]
    MemoryI[Memory]
    ArtifactSinkI[CallArtifactSink]
  end

  subgraph DALImpl["@tvic/dal implementations"]
    SessionStore[InMemorySessionStore]
    TurnStore[InMemoryTurnStore]
    ToolCallStore[InMemoryToolCallStore]
    TraceStore[InMemoryTraceStore]
    MemoryStore[InMemoryMemory]
    ArtifactWriter[LocalCallArtifactWriter]
  end

  subgraph Runtime["@tvic/runtime"]
    RuntimeSvc[InMemoryRuntime]
    Loop[PipelineVoiceLoop]
  end

  CoreInterfaces --> DALImpl
  DALImpl --> RuntimeSvc
  ArtifactSinkI --> Loop
  RuntimeSvc --> Loop
```

What belongs in DAL:

- storage shape;
- append/query/update/delete behavior;
- path-safety for artifact directories;
- serialized file writes and close/flush semantics;
- TTL pruning;
- memory entry storage and search.

What does not belong in DAL:

- when a turn should complete;
- whether a tool failure is recovered;
- when to interrupt output;
- provider retry decisions;
- trace span classification;
- UI failure explanations.

## Artifacts And Replay

Per-call artifacts are the bridge from runtime truth to visible debugging.

```mermaid
flowchart LR
  Runtime[Runtime]
  TraceEvents[TraceEvents]
  InputAudio[Caller PCM]
  OutputAudio[Agent PCM sent]
  Manifest[manifest.json]
  Inspection[CallInspection]
  AudioRoute[WAV audio route]
  Viewer[Trace viewer]

  Runtime --> TraceEvents --> CallJsonl[call.jsonl]
  Runtime --> InputAudio --> InputPcm[input.pcm]
  Runtime --> OutputAudio --> OutputPcm[output.pcm]
  Runtime --> Manifest

  CallJsonl --> Inspection
  Manifest --> Inspection
  InputPcm --> AudioRoute
  OutputPcm --> AudioRoute
  Manifest --> AudioRoute

  Inspection --> Viewer
  AudioRoute --> Viewer
```

Artifact files:

| File            | Meaning                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `call.jsonl`    | ordered trace events for the call                                                                |
| `manifest.json` | validated map of payload refs to files, byte ranges, offsets, privacy, write failures, integrity |
| `input.pcm`     | normalized caller PCM, when audio persistence is enabled                                         |
| `output.pcm`    | normalized agent audio that reached the transport, when audio persistence is enabled             |

Replay fidelity:

- input/output tracks are aligned to the same call clock used by traces;
- `agent_sent` is precise from output PCM;
- `agent_heard` is turn-level because Twilio marks confirm playout at utterance
  boundaries, not every byte;
- word-level replay is deferred until per-word timings are captured.

## Trace Viewer Data Path

```mermaid
flowchart TB
  Files[Call artifact directory]
  Loader[apps/trace-viewer/lib/artifacts]
  Parser[parseTraceJsonl]
  ManifestParser[parseCallArtifactManifest]
  Analysis[deriveCallInspection]
  Page[Call page]
  Components[Timeline, waterfall, panels]
  AudioApi[Audio API route]
  Player[Browser audio]

  Files --> Loader
  Loader --> Parser
  Loader --> ManifestParser
  Parser --> Analysis
  ManifestParser --> Analysis
  Analysis --> Page
  Page --> Components
  Files --> AudioApi
  ManifestParser --> AudioApi
  AudioApi --> Player
```

Viewer rule:

> React renders `CallInspection`. It does not parse raw trace semantics.

This keeps the frontend optimized and clean:

- fewer duplicated computations;
- stable derived models;
- no hidden runtime rules in components;
- tests live around `@tvic/tracing` analysis and viewer rendering separately.

## Failure And Incident Model

T-vic separates terminal failures from recovered incidents.

```mermaid
flowchart TB
  Event[Trace events]
  TurnStatus[Turn terminal status]
  ToolFailure[tool.failed]
  RuntimeTimeout[runtime.timeout]
  OutputCancel[output.cancelled]
  Classifier[Failure / incident classifier]
  Failure[Terminal failure explanation]
  Incident[Recovered incident]

  Event --> Classifier
  TurnStatus --> Classifier
  ToolFailure --> Classifier
  RuntimeTimeout --> Classifier
  OutputCancel --> Classifier
  Classifier --> Failure
  Classifier --> Incident
```

Examples:

| Situation                                     | Classification                              |
| --------------------------------------------- | ------------------------------------------- |
| `tool.failed`, model recovers, turn completes | incident on completed turn                  |
| `tool.failed`, turn later fails               | terminal failure plus unrecovered incident  |
| caller barge-in during output                 | cancelled turn, interruption failure kind   |
| output sent but playout not confirmed         | cancelled turn, playout-unconfirmed failure |
| LLM/TTS stream stalls and policy fails        | failed turn with provider-stalled evidence  |
| session fails before any turn                 | call-level failure, no fake turn            |

## State Machines

### Session Lifecycle

```mermaid
stateDiagram-v2
  [*] --> created
  created --> starting
  starting --> active
  active --> completed
  active --> failed
  active --> cancelled
  completed --> [*]
  failed --> [*]
  cancelled --> [*]
```

### Turn Lifecycle

```mermaid
stateDiagram-v2
  [*] --> active
  active --> completed: reply delivered/heard
  active --> cancelled: barge-in / timeout / remote hangup / not heard
  active --> failed: unrecovered runtime/provider/tool failure
  completed --> [*]
  cancelled --> [*]
  failed --> [*]
```

### Tool Call Lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  running --> succeeded
  running --> failed
  running --> timed_out
  running --> cancelled
  failed --> running: retry
  timed_out --> running: retry
  succeeded --> [*]
  failed --> [*]
  timed_out --> [*]
  cancelled --> [*]
```

## Privacy And Trust Boundaries

The runtime handles transcripts and audio. Privacy is part of architecture.

```mermaid
flowchart LR
  Raw[Provider/raw input]
  Normalize[Normalize + validate]
  Policy[Recording/privacy policy]
  Redact[Trace redaction]
  Persist[Persist artifacts]
  Drop[Drop audio]

  Raw --> Normalize
  Normalize --> Policy
  Policy -->|record + persistAudio| Redact --> Persist
  Policy -->|do not persist audio| Drop
```

Current rules:

- recording is opt-in in the live-call example;
- audio persistence is separately gated;
- traces and artifact manifests are parsed as untrusted disk data;
- manifests are validated before being trusted;
- corrupt JSONL lines are dropped and counted;
- invalid artifacts mark calls degraded.

## Test Strategy

```mermaid
flowchart TB
  Unit[Unit tests]
  Contract[Contract tests]
  Provider[Provider adapter tests]
  Runtime[Runtime loop tests]
  Golden[Golden trace fixtures]
  State[State-machine tests]
  Chaos[Long-run chaos/leak tests]
  Ingress[Ingress security tests]
  Viewer[Viewer/artifact tests]
  Gates[pnpm lint/test/build]

  Unit --> Gates
  Contract --> Gates
  Provider --> Gates
  Runtime --> Gates
  Golden --> Gates
  State --> Gates
  Chaos --> Gates
  Ingress --> Gates
  Viewer --> Gates
```

Test families:

| Suite                   | Protects                                                        |
| ----------------------- | --------------------------------------------------------------- |
| Core contract tests     | entity and guard invariants                                     |
| Provider contract tests | startup, WebSocket, parser, stream behavior                     |
| Runtime loop tests      | happy path, barge-in, stalls, tool behavior, playout            |
| Golden trace tests      | emitted trace stream -> timeline/inspection correctness         |
| State-machine tests     | terminal states, memory, heard/cancel invariants                |
| Chaos tests             | leak resistance across randomized calls                         |
| Ingress tests           | Twilio signature, media tokens, body limits, identity binding   |
| Artifact/viewer tests   | manifest validation, audio alignment, degraded state, UI models |

## First-Time Code Tour

Use this order when reading source:

1. `packages/core/src/agent.ts`
2. `packages/core/src/session.ts`
3. `packages/core/src/turn.ts`
4. `packages/core/src/media.ts`
5. `packages/core/src/trace.ts`
6. `packages/core/src/runtime.ts`
7. `packages/core/src/dal.ts`
8. `packages/runtime/src/create-runtime.ts`
9. `packages/runtime/src/pipeline-loop.ts`
10. `packages/runtime/src/conversation-policy.ts`
11. `packages/providers/src/twilio.ts`
12. `packages/providers/src/deepgram.ts`
13. `packages/providers/src/openai-responses.ts`
14. `packages/providers/src/cartesia.ts`
15. `packages/dal/src/index.ts`
16. `packages/tracing/src/inspection.ts`
17. `packages/tracing/src/turn-analysis.ts`
18. `apps/trace-viewer/app/calls/[callId]/page.tsx`
19. `examples/live-call/src/main.ts`
20. `examples/live-call/src/gateway.ts`

## Extension Guide

### Add a provider

```mermaid
flowchart LR
  ProviderSDK[Provider SDK/wire protocol]
  Adapter[New adapter package/file]
  Contract[Core provider interface]
  Tests[Provider contract tests]
  Runtime[Runtime config]

  ProviderSDK --> Adapter
  Adapter --> Contract
  Adapter --> Tests
  Contract --> Runtime
```

Checklist:

- implement the relevant core provider interface;
- normalize external events into T-vic events;
- normalize errors with provider metadata;
- respect `AbortSignal`;
- close queues on terminal provider states;
- add parser/startup/error tests;
- do not import runtime from the adapter.

### Add a trace/viewer metric

```mermaid
flowchart LR
  RuntimeEvent[Runtime emits event]
  CoreTrace[Core TraceEvent type]
  Parser[Trace parser accepts it]
  Analyzer[Tracing derives model]
  UI[Viewer renders model]
  Test[Golden/viewer tests]

  RuntimeEvent --> CoreTrace
  CoreTrace --> Parser
  Parser --> Analyzer
  Analyzer --> UI
  UI --> Test
```

Checklist:

- make sure the runtime actually emits the backing event;
- add or update the `TraceEvent` variant in `@tvic/core`;
- update `parseTraceJsonl` validation if a new event type exists;
- derive the metric in `@tvic/tracing`;
- render the derived field in React;
- add golden tests from real loop emissions.

### Add persistence

```mermaid
flowchart LR
  Interface[Core store interface]
  Impl[DAL implementation]
  Runtime[Runtime dependency injection]
  Tests[DAL + runtime tests]

  Interface --> Impl
  Impl --> Runtime
  Impl --> Tests
```

Checklist:

- keep interfaces in `@tvic/core`;
- keep implementation in `@tvic/dal` or a DAL package;
- inject stores through runtime options;
- do not add raw persistence clients to runtime loop code;
- preserve trace flush and ordering semantics.

## Known Fidelity Limits

These are honest limits, not bugs to hide:

- endpoint delay is unavailable until local VAD/endpoint events are emitted;
- word-level audio replay is deferred until STT word timings are captured;
- `agent_heard` is turn-granular, not byte-granular;
- output artifacts are "sent to transport" audio, while trace playout state says
  whether the turn was heard;
- provider-level retries are not implemented unless explicitly emitted.

The viewer should label these limits clearly instead of inventing precision.
