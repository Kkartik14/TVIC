# T-vic SDK and Runtime Contracts

Status: v0.2 discussion draft  
Scope: SDK and runtime first  
Primary audience: T-vic engineers and early platform developers

## Purpose

T-vic is a production-grade voice AI infrastructure and runtime platform.

The first build is not a workflow product, call-center SaaS, no-code builder, or voice model company. The first build is the SDK and runtime layer that lets developers create, run, observe, debug, and replay realtime voice agents across providers.

This document defines the initial goals, non-goals, system boundaries, and contracts so multiple developers can work in parallel without blocking each other.

## Product Direction

T-vic v1 starts as a TypeScript SDK plus runtime.

The runtime should be designed as a library that can be embedded inside a developer backend and as a long-running runtime service that can host persistent media sessions. A Python SDK can come later as a thin client or sibling SDK for ML, evaluation, and data workflows, but the primary runtime path should be TypeScript-first.

Developers should be able to:

- define an agent
- attach tools and APIs
- configure provider adapters
- start a realtime session
- process audio, transcripts, model outputs, tool calls, and speech output
- persist conversational state
- emit trace events for every important runtime action
- inspect and replay sessions

The hosted platform, dashboard, auth, billing, large-scale deployment system, and enterprise control plane can be built later on top of this runtime foundation.

## Core Goal

Build a provider-agnostic runtime for production voice AI systems.

The runtime must own:

- realtime conversational orchestration
- provider abstraction
- telephony abstraction
- tool execution
- conversational state
- memory interfaces
- tracing and observability
- replay and debugging primitives
- reliability behavior such as retries, timeouts, interruption handling, and fallback paths

## Non-Goals For The First Build

T-vic will not initially build:

- foundational STT, TTS, or realtime model infrastructure
- a generic call-center product
- a single workflow application
- a no-code SMB workflow builder
- a full hosted enterprise dashboard
- billing, tenant management, or enterprise auth
- custom telecom infrastructure
- running the realtime media plane inside short-lived serverless functions
- provider-specific business logic inside the core runtime

Provider integrations should be adapters. They should not define the core architecture.

## First Reference Workload

The runtime should be validated with at least one reference workload, such as restaurant booking, vendor coordination, complaint follow-up, or internal operations coordination.

This reference workload is not the product.

It exists only to test whether the runtime handles:

- realtime conversation
- interruptions
- conversational state
- tool execution
- provider switching
- failure recovery
- tracing
- replay
- latency monitoring

## Design Principles

### Runtime Before Control Plane

The core runtime should work without a hosted dashboard. A developer should be able to install the SDK, configure providers, define an agent, and run a session locally or inside their own backend.

### TypeScript Runtime First

The initial runtime should be TypeScript-first because realtime voice orchestration is WebSocket-heavy, event-driven, and adapter-heavy. Twilio, Deepgram, OpenAI Realtime, Cartesia, and ElevenLabs all have strong TypeScript SDK paths, and the likely first users are developers building AI application infrastructure.

Python remains important for evaluation, data processing, and ML-adjacent workflows, but it should not be the first runtime implementation unless the team explicitly chooses that tradeoff.

### Long-Running Media Plane

The realtime media plane should run in a long-running process, not in short-lived serverless functions.

Control-plane APIs can eventually run on serverless infrastructure, but persistent telephony media sockets, realtime provider streams, interruption handling, and low-latency audio routing need a runtime host such as Fly, Render, EC2, Railway, Kubernetes, or another always-on process model.

This affects the public shape of the runtime: T-vic should expose both embeddable library APIs and service lifecycle APIs.

### Contracts Before Integrations

Provider adapters should depend on T-vic contracts. T-vic contracts should not depend on provider-specific concepts unless those concepts are generalized.

### Normalized Media Events At The Edge

Provider-specific media streams must be adapted into normalized T-vic media events at the edge.

The runtime should not consume raw Twilio, Deepgram, OpenAI, or Cartesia stream objects. It should consume structured events such as audio chunks, speech starts, speech ends, silence, DTMF, barge-in, media errors, and stream close events.

### Observability Is A Runtime Primitive

Tracing is not a later dashboard feature. Every runtime action should emit structured events from day one.

### Interruption Handling Is Core Runtime Behavior

Interruptions are not an edge case in voice. Even in v0.1, the runtime state machine should model interruption and barge-in events explicitly.

The first version does not need perfect interruption policy, but the lifecycle must include it so `Session`, `Turn`, tracing, and media output cancellation are shaped correctly from the start.

### Replayability Shapes The Architecture

The runtime should preserve enough structured input, output, decisions, tool calls, timing data, and state transitions to replay or inspect a session.

### Deterministic Boundaries Around Probabilistic Systems

The runtime cannot make AI output deterministic, but it can make execution boundaries explicit:

- what input was received
- what state existed
- what model was called
- what tool was called
- what output was produced
- what failed
- what was retried

### Provider-Agnostic Core

Deepgram, ElevenLabs, Cartesia, OpenAI Realtime, Sarvam, Twilio, and additional providers must sit behind interfaces.

No provider SDK object should leak into the public runtime contract.

## System Layers

The first architecture should be split into these layers:

1. Runtime core
2. Media event contract and media plane
3. Provider contracts
4. Provider adapters
5. Tool execution
6. State and memory
7. Tracing and replay
8. Reference workloads
9. Future hosted control plane

Only the first seven layers are part of the initial SDK/runtime build.

## Contract Freeze Levels

Not every contract needs the same stability.

### Freeze Now

These contracts should be locked early because many developers will depend on them:

- `Agent`
- `Session`
- `Call`
- `MediaEvent`
- `Turn`
- `Tool`
- `Provider`
- `TraceEvent`
- `Memory`
- `Runtime`

### Draft But Usable

These can evolve during the first implementation:

- retry policies
- timeout policies
- detailed interruption policies
- model selection policies
- provider capability metadata
- replay storage format
- evaluation hooks

### Later

These should not block the first runtime:

- hosted dashboard APIs
- organization and tenant model
- billing model
- RBAC
- deployment orchestration
- marketplace or template system

## Core Contracts

### Agent

An `Agent` is the developer-defined conversational worker.

It describes what the voice system is allowed to do, what tools it can call, what providers it uses, and what runtime policies apply.

Required fields:

- `id`
- `name`
- `version`
- `instructions`
- `tools`
- `provider_config`
- `memory_policy`
- `interruption_policy`
- `timeout_policy`
- `metadata`

Responsibilities:

- define behavior and available capabilities
- bind tools to the runtime
- declare provider preferences
- declare memory behavior
- declare interruption and timeout behavior

Non-responsibilities:

- owning live call state
- storing transcripts
- storing trace events
- directly executing provider SDK calls

### Session

A `Session` is one live or replayed execution of an agent.

In voice, a session may be linked to a phone call, web audio stream, SIP session, or another multimodal channel.

Required fields:

- `id`
- `agent_id`
- `status`
- `channel`
- `call_id`
- `trace_id`
- `started_at`
- `ended_at`
- `state`
- `memory_refs`
- `metadata`

Allowed statuses:

- `created`
- `starting`
- `active`
- `interrupted`
- `waiting_for_tool`
- `ending`
- `completed`
- `failed`
- `cancelled`

Responsibilities:

- hold runtime execution state
- connect an agent to a live interaction
- group turns, tools, memory updates, and trace events
- expose lifecycle transitions

Non-responsibilities:

- defining the agent's behavior
- directly owning provider-specific call objects
- being a permanent customer record

### Call

A `Call` represents the telephony or realtime media envelope.

A call is not the same as a session. A session may be attached to a call, but sessions may also run over web audio, SIP, WhatsApp, or other channels.

Required fields:

- `id`
- `provider`
- `direction`
- `from`
- `to`
- `status`
- `session_id`
- `started_at`
- `ended_at`
- `media_transport`
- `recording_ref`
- `metadata`

Allowed directions:

- `inbound`
- `outbound`

Allowed statuses:

- `created`
- `ringing`
- `connected`
- `active`
- `held`
- `ended`
- `failed`

Responsibilities:

- represent call lifecycle
- normalize telephony provider status
- map provider media streams into normalized `MediaEvent` objects

Non-responsibilities:

- owning agent behavior
- storing business workflow state
- hiding all telephony details from adapters

### MediaEvent

A `MediaEvent` is the normalized realtime media contract between provider adapters and the runtime.

This is a load-bearing boundary. Telephony providers, browser audio streams, SIP sessions, STT providers, realtime model providers, and TTS providers may all speak different streaming protocols, but the runtime should operate on T-vic media events.

Required fields:

- `id`
- `session_id`
- `call_id`
- `turn_id`
- `sequence`
- `type`
- `direction`
- `timestamp`
- `duration_ms`
- `audio`
- `text`
- `control`
- `provider`
- `metadata`

Allowed directions:

- `input`
- `output`
- `internal`

Initial event types:

- `media.stream.started`
- `media.stream.ended`
- `media.audio.chunk`
- `media.audio.committed`
- `speech.started`
- `speech.ended`
- `silence.started`
- `silence.ended`
- `barge_in.detected`
- `dtmf.received`
- `media.error`

Audio payload fields:

- `encoding`
- `sample_rate_hz`
- `channels`
- `duration_ms`
- `frame_count`
- `payload`
- `payload_ref`

The preferred normalized audio shape for v0.1 is chunked PCM frames plus control events. Provider-specific encodings should be decoded or referenced at the adapter boundary unless there is a clear performance reason to defer decoding.

Responsibilities:

- normalize provider-specific media streams
- preserve enough timing data for latency analysis and replay
- represent speech, silence, and barge-in as first-class runtime inputs
- let the runtime handle media without knowing provider stream formats

Non-responsibilities:

- storing full call recordings inline
- exposing provider SDK stream objects
- replacing `TraceEvent`

### Turn

A `Turn` is a unit of conversational progress inside a session.

Voice turns are not always clean user-message and assistant-message pairs. Interruptions, partial transcripts, streaming output, and tool waits may split or merge turns.

Required fields:

- `id`
- `session_id`
- `sequence`
- `status`
- `input`
- `output`
- `tool_calls`
- `interruption_refs`
- `started_at`
- `ended_at`
- `latency`
- `metadata`

Allowed statuses:

- `started`
- `listening`
- `thinking`
- `calling_tool`
- `speaking`
- `interrupted`
- `completed`
- `failed`

Responsibilities:

- provide a structured unit for traces and replay
- group input, model reasoning, tool calls, and output
- model interruptions without flattening voice into text-chat turns
- measure latency across the turn

Non-responsibilities:

- acting as the only storage unit for the full transcript
- forcing text-chat assumptions onto realtime voice

### Provider

A `Provider` is any external service used by the runtime.

Provider categories:

- telephony
- speech-to-text
- text-to-speech
- realtime model
- LLM
- storage
- observability export

All providers should expose normalized capabilities.

Common provider fields:

- `name`
- `kind`
- `version`
- `capabilities`
- `region`
- `metadata`

Provider contract examples:

- `TelephonyProvider`
- `SpeechToTextProvider`
- `TextToSpeechProvider`
- `RealtimeModelProvider`
- `LLMProvider`
- `TraceExporter`

Provider responsibilities:

- translate T-vic runtime calls into provider-specific API calls
- translate provider events into T-vic events
- expose errors in normalized form
- report latency and usage metadata

Provider non-responsibilities:

- defining core runtime state
- deciding agent behavior
- storing canonical traces
- leaking provider SDK objects into public contracts

### Tool

A `Tool` is a callable capability attached to an agent.

Tools are how the agent interacts with business systems.

Required fields:

- `id`
- `name`
- `description`
- `input_schema`
- `output_schema`
- `timeout_ms`
- `retry_policy`
- `idempotency_policy`
- `auth_scope`
- `metadata`

Tool execution fields:

- `tool_call_id`
- `session_id`
- `turn_id`
- `input`
- `output`
- `status`
- `started_at`
- `ended_at`
- `error`

Allowed statuses:

- `queued`
- `running`
- `succeeded`
- `failed`
- `timed_out`
- `cancelled`

Responsibilities:

- expose business capabilities safely
- support validation before execution
- support timeouts and retries
- emit trace events for every execution stage

Non-responsibilities:

- storing long-term memory
- deciding conversation policy
- directly manipulating provider state unless explicitly designed for that

### Memory

`Memory` is the interface for storing and retrieving information used across the conversation.

The runtime should distinguish between session state and memory.

Session state is operational and deterministic. Memory is contextual and may be retrieved or updated based on policies.

Memory categories:

- session memory
- user memory
- organization memory
- workflow memory

Required memory operations:

- `get`
- `put`
- `append`
- `search`
- `delete`

Memory responsibilities:

- store facts and context outside the immediate turn
- expose scoped retrieval
- support traceable reads and writes
- avoid hidden state mutations

Memory non-responsibilities:

- replacing session state
- acting as the canonical trace log
- silently changing agent behavior without trace events

### TraceEvent

A `TraceEvent` is the canonical observability unit in T-vic.

Every significant runtime action should produce a trace event.

Required fields:

- `id`
- `trace_id`
- `session_id`
- `call_id`
- `turn_id`
- `parent_event_id`
- `type`
- `timestamp`
- `duration_ms`
- `status`
- `input_ref`
- `output_ref`
- `error`
- `provider`
- `metadata`

Initial event types:

- `session.created`
- `session.started`
- `session.completed`
- `session.failed`
- `call.created`
- `call.connected`
- `call.ended`
- `media.stream.started`
- `media.stream.ended`
- `audio.input.started`
- `audio.input.chunk`
- `audio.input.ended`
- `speech.started`
- `speech.ended`
- `stt.started`
- `stt.partial`
- `stt.final`
- `llm.started`
- `llm.completed`
- `llm.failed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `tts.started`
- `tts.chunk`
- `tts.completed`
- `barge_in.detected`
- `interrupt.detected`
- `interrupt.handled`
- `output.cancelled`
- `memory.read`
- `memory.write`
- `runtime.retry`
- `runtime.timeout`
- `runtime.fallback`

Responsibilities:

- make runtime behavior inspectable
- support debugging and replay
- support latency analysis
- support failure investigation
- support dashboards and exporters

Non-responsibilities:

- storing raw audio inline by default
- acting as a general analytics event with no runtime meaning

### Runtime

The `Runtime` is the orchestration engine.

It connects agents, sessions, calls, providers, tools, memory, and tracing.

Core runtime loop:

1. receive a normalized `MediaEvent` or text input
2. transcribe or normalize input
3. update session state
4. decide next action through model or realtime provider
5. execute tools if needed
6. generate output text or speech
7. handle interruption or barge-in events if they occur
8. stream output back to the channel
9. emit trace events throughout
10. persist state and memory changes

Runtime responsibilities:

- manage session lifecycle
- consume normalized `MediaEvent` objects
- coordinate providers
- execute tools
- handle interruption and barge-in events as state transitions
- cancel or revise output when interruption policy requires it
- enforce timeout and retry policies
- emit trace events
- expose replayable execution records

Runtime non-responsibilities:

- owning provider-specific API details
- owning hosted dashboard concerns
- hardcoding workflow-specific business logic

## Minimal Public SDK Shape

The first TypeScript SDK should make this kind of flow possible:

```ts
import { createRuntime, defineAgent, defineTool } from "@tvic/runtime";
import type { AgentProviders } from "@tvic/core";

const checkBookingAvailability = defineTool({
  id: "check_booking_availability",
  name: "check_booking_availability",
  description: "Check whether a restaurant can accept a booking.",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string" },
      partySize: { type: "number" },
      time: { type: "string" },
    },
    required: ["restaurantId", "partySize", "time"],
  },
  async execute(input, ctx) {
    return { available: true, confirmationWindowMinutes: 10 };
  },
});

const providers: AgentProviders = buildProductionProviderBundle();

const agent = defineAgent({
  id: "restaurant-coordinator",
  name: "restaurant-coordinator",
  instructions: "Coordinate bookings with restaurants and confirm availability.",
  tools: [checkBookingAvailability],
  providers,
  audioPolicy: {
    input: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    output: { encoding: "pcm_s16le", sampleRateHz: 24000, channels: 1 },
    resampleAtEdge: true,
  },
});

const runtime = createRuntime();
await runtime.start();
const session = await runtime.startSession(agent, { channel: "phone" });
```

The pipeline mode equivalent uses `mode: "pipeline"` providers
with explicit `stt`, `llm`, and `tts` instead of `realtimeModel`.

The exact syntax can change, but the conceptual flow should not:

- define agent
- attach tools
- configure providers
- start session
- observe traces

## Parallel Workstreams

Once this document is accepted, the team can split into independent tracks.

### Runtime Core

Owns:

- `Runtime`
- `Session`
- `Turn`
- normalized `MediaEvent` ingestion
- lifecycle state machine
- interruption handling
- retry and timeout enforcement

Depends on:

- provider contracts
- media event contract
- trace event contract
- tool execution contract

### Media Plane And Transport

Owns:

- media socket lifecycle
- normalized `MediaEvent` contract implementation
- input and output audio chunk routing
- barge-in and speech boundary event routing
- service lifecycle for long-running runtime hosts

Depends on:

- `Call`
- `MediaEvent`
- `Session`
- provider adapters

### Provider Contracts And Adapters

Owns:

- provider interfaces
- Twilio adapter
- Deepgram adapter
- ElevenLabs or Cartesia adapter
- OpenAI Realtime adapter
- Sarvam adapter when needed
- provider stream to `MediaEvent` translation

Depends on:

- normalized provider contract
- normalized media event contract
- runtime event model

### Tool Execution

Owns:

- tool registration
- schema validation
- execution sandbox boundary
- timeout and retry behavior
- tool trace events

Depends on:

- `Tool`
- `TraceEvent`
- runtime state

### Tracing And Replay

Owns:

- trace event schema
- in-memory trace store
- persisted trace store
- replay format
- session inspection API

Depends on:

- `TraceEvent`
- `Session`
- `Turn`
- `Tool`

### Memory And State

Owns:

- session state store
- memory interface
- memory read/write tracing
- scoped retrieval

Depends on:

- `Session`
- `TraceEvent`

## First Milestone

The first milestone is not a full platform.

The first milestone is:

> A developer can run one realtime or simulated voice session through the SDK, with provider abstractions, tool execution, memory/state updates, complete trace events, and replayable output.

Acceptance criteria:

- an `Agent` can be defined in code
- a `Session` can be started
- a normalized `MediaEvent` can enter the runtime
- a basic interruption state transition exists and emits trace events
- at least one tool can be called with typed input and output
- session state can be updated
- memory can be read and written through an interface
- every major action emits a `TraceEvent`
- a failed provider or tool call produces a normalized error event
- a completed session can be inspected after execution
- runtime, tracing, memory, media, provider utility, and tool packages have real test coverage

## Locked Decisions

These decisions are locked for the current contracts.

1. Agent definitions are code-first TypeScript contracts.
2. Runtime media uses normalized PCM audio formats at the runtime boundary.
3. Provider transport encodings are adapter-internal.
4. Tracing starts with a discriminated `TraceEvent` union, `InMemoryTraceStore`, and JSONL export.
5. Memory is scoped by explicit `MemoryRef`, not by scope string alone.
6. Runtime package exposes `defineAgent`, `defineTool`, and `createRuntime`.
7. The media plane runs in a long-running process model.

## Current Implementation

The current repository contains:

- SDK/runtime first
- TypeScript runtime first
- discriminated contracts for session, call, turn, tool calls, media events, and trace events
- `createRuntime` in `@tvic/runtime`
- `InMemoryTraceStore` and `JsonlTraceExporter` in `@tvic/tracing`
- scoped `InMemoryMemory` in `@tvic/memory`
- media event buffer and direction guards in `@tvic/media`
- tool registry, JSON-schema subset validation, and execution utility in `@tvic/tools`
- provider capability and kind utilities in `@tvic/providers`
- normalized media events with chunked PCM frames plus control events
- interruption handling in the v0.1 state machine
- long-running runtime process for media plane; serverless only for control-plane APIs
