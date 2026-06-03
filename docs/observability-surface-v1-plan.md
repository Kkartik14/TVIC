# T-vic Observability Surface v1 Plan

Status: v0.1 build plan
Scope: make runtime correctness visible, explainable, and replayable in the trace viewer
Companion docs:

- [observability-plan.md](./observability-plan.md) — product thesis and moat
- [realtime-loop-plan.md](./realtime-loop-plan.md) — the loop that emits the truth
- [runtime-contracts.md](./runtime-contracts.md) — frozen runtime contracts

## Intent

The runtime now does a lot of hard invisible work: turn lifecycle, provider
timing, tool execution, cancellation, playout confirmation, artifact alignment,
and failure accounting. That is not enough as a product.

The next milestone is to make that invisible rigor visible.

After one live call, a developer or operator should open T-vic and immediately
understand:

- what happened in each turn;
- where latency was spent;
- what the caller heard;
- whether output was only sent or actually played;
- whether the caller interrupted;
- which provider/tool failed;
- why a turn failed or was cancelled;
- how to replay the exact moment.

This is not a generic dashboard phase. This is the first product surface that
makes the infrastructure moat obvious.

## Product principle

The trace viewer must feel like a voice-native debugger, not a skin over logs.

The centerpiece is one call inspection page where transcript, traces, audio,
latency, interruptions, and failures share the same call clock.

If the page cannot answer "why did this turn fail?" without reading raw JSON, it
is not done.

## What exists today

Already implemented:

- runtime emits structured trace events with session, turn, provider, tool,
  interruption, memory, output, and playout events;
- per-call artifacts: `call.jsonl`, `manifest.json`, `input.pcm`,
  `output.pcm`;
- audio capture is consent-gated;
- output audio is persisted as sent, while turn delivery records heard/unheard;
- trace and audio offsets use the same monotonic session clock;
- latency CLI and trace viewer share `deriveCallTimeline`;
- trace viewer has a call list, call page, waterfall, latency numbers,
  transcript, interruption markers, and audio endpoints.

Current gap:

The viewer shows some correctness, but it does not yet make the call feel
inspectable end-to-end. The product still needs a richer analysis layer and a
stronger UI around cause, timing, replay, and failure.

## Runtime-backed scope and fidelity limits

The viewer must only promise what the runtime actually emits. If a metric is not
backed by trace events or artifacts, v1 must mark it unavailable instead of
inventing it.

### Endpointing is not fully observable yet

The current loop commits turns from STT metadata (`speechFinal`) and does not yet
emit local VAD speech-boundary or endpoint events. That means v1 can show an EOU
marker derived from the STT/turn commit path, but it cannot compute true endpoint
delay (`last speech frame -> turn commit`) until the VAD/endpointing state
machine from [realtime-loop-plan.md](./realtime-loop-plan.md) lands.

Implications for v1:

- `endpointMs` is nullable / unavailable.
- `speech` and `endpoint` span kinds are reserved but only rendered when backed
  by real events.
- bottleneck detection must not name endpoint/dead-air as the bottleneck unless
  endpoint events exist.
- the UI should label this honestly: "endpoint timing unavailable" rather than
  "0ms" or an inferred value.

### Tool errors are not always turn failures

The runtime can recover from tool failures by feeding a tool-error message back
to the model. A completed turn can therefore contain `tool.failed`, retries, or
validation incidents. These are not terminal failures.

v1 must separate:

- **terminal failure** — the turn/session ended failed or cancelled;
- **incident** — something went wrong inside a turn but the conversation
  recovered.

The UI should show incidents on completed turns without marking the turn failed.

### Provider stalls need better trace evidence

Today some provider stalls surface mainly through terminal turn/session errors
(for example `llm.stalled` or `tts.stalled`) rather than a dedicated
`runtime.timeout` / `provider.stalled` trace event. v1 can derive a failure
explanation from terminal errors, but the stronger product needs explicit stall
trace events.

Runtime follow-up before or during v1:

- emit a timeout/stall trace when LLM/TTS stream stalls;
- include provider, stage, timeoutMs, and policy action;
- classify timeout policy correctly:
  - `onTimeout: "fail"` -> failed turn;
  - `onTimeout: "interrupt"` -> cancelled turn with cancel reason `timeout`.

### Sent vs heard is not byte-perfect

The output artifact is "agent audio delivered to the transport", not guaranteed
heard audio. Heard/unheard is currently turn-level from playout confirmation
marks. Twilio marks prove an utterance completed; they do not give a byte-precise
heard boundary at arbitrary interruption time.

Implications for v1:

- `agent_sent` replay can be precise from output PCM artifacts.
- `agent_heard` is a turn-level state, not a byte-accurate audio slice.
- for interrupted output, label the segment as "sent, not fully confirmed" rather
  than pretending to know exactly which bytes were heard.

### Word-level replay is deferred

The companion observability thesis talks about click-word-to-audio. The current
runtime does not capture per-word timings from STT. v1 supports turn/span/failure
replay; word-level replay is a v2 feature once word timings are captured in the
trace/artifact model.

### Data availability matrix

This table is the guardrail against inventing metrics. If the emitting event does
not exist, the derived field is unavailable or reserved.

| Derived field                     | Emitting event(s) / source             | v1 status                                 |
| --------------------------------- | -------------------------------------- | ----------------------------------------- |
| `endOfUtteranceMs`                | `stt.final` / turn commit path         | available                                 |
| `endpointMs`                      | `speech.ended` / `endpoint.*`          | blocked on VAD/endpoint events            |
| `llmTtftMs` initial pass          | `llm.started` -> first `llm.token`     | available                                 |
| `llmPasses[*]` per-span timing    | per-span `llm.*` events                | available                                 |
| `toolMs`                          | `tool.queued/started/completed/failed` | available                                 |
| `incident: tool_failed_recovered` | `tool.failed` inside a completed turn  | available                                 |
| `failure: provider_stalled`       | terminal turn/session error today      | available but thin; needs Workstream F    |
| `incident: provider_retry`        | none today                             | reserved for future provider retry policy |
| `agent_sent` segment              | output PCM + manifest offsets          | available                                 |
| `agent_heard` segment             | turn-level playout confirmation        | turn-granular only                        |
| `artifact_degraded`               | manifest/write failures/missing files  | available; non-event-derived              |
| word-level replay                 | per-word STT timings                   | deferred                                  |

## v1 outcome

Observability Surface v1 is complete when one recorded live call produces a
viewer page with five first-class areas:

1. **Call Summary** — status, duration, turns, failures, interruptions, degraded
   artifacts, recording mode.
2. **Conversational Timeline** — caller/agent speech, tools, memory, failures,
   interruptions, and playout on one clock.
3. **Turn Inspector** — waterfall, latency decomposition, transcript, provider
   spans, tool calls, playout status, failure reason.
4. **Replay** — play from call start, turn start, interruption, failure, or any
   span; cursor moves on the same monotonic clock as the trace.
5. **Failure Explainer** — plain engineering answer to "why did this turn fail?"
   with the exact trace evidence.

## Architecture boundary

The viewer must not become a second runtime.

Layer ownership:

| Layer               | Owns                                                          |
| ------------------- | ------------------------------------------------------------- |
| `@tvic/runtime`     | emits true events, timestamps, ids, delivery/terminal states  |
| `@tvic/tracing`     | derives view models, explanations, latency, replay segments   |
| `apps/trace-viewer` | renders view models, handles UI state, audio controls, layout |
| `@tvic/dal`         | artifact file safety, manifest reading/writing, audio bytes   |

Rules:

- React components do not infer failure semantics from raw trace events.
- React components do not compute latency math beyond formatting numbers.
- `@tvic/tracing` owns all derived concepts: turn timeline, failure
  explanation, replay segment, latency breakdown, interruption view.
- The viewer can tolerate degraded artifacts, but must label them clearly.
- Raw trace JSON can be exposed as a debug drawer, not used as the main product.

## Primary user stories

### 1. "What happened in this call?"

The call page opens with a compact summary and a chronological timeline.

The user can see:

- call start and end;
- each caller utterance;
- each agent reply;
- each tool call;
- each interruption;
- failed/cancelled/completed turns;
- degraded artifact warnings.

### 2. "Where did latency go?"

For every turn, the viewer shows:

- end-of-utterance marker;
- STT final time;
- LLM TTFT;
- tool latency and retries;
- TTS TTFB;
- output sent time;
- playout confirmation time;
- total turn time;
- response latency from EOU to first audio.

Endpoint delay is shown only when backed by real endpoint events; otherwise the
turn explicitly marks endpoint timing unavailable.

Slow stages are visually highlighted.

### 3. "Did the caller interrupt?"

The interruption view shows:

- caller speech started;
- runtime detected interruption;
- output cancelled;
- playout state at cancellation;
- frames/chunks sent;
- whether the interrupted turn was heard;
- final turn status and cancel reason.

Rejected interruption candidates are included when present.

### 4. "Can I replay the exact moment?"

Replay controls must support:

- play full call;
- play caller track;
- play agent track;
- play from turn;
- play from span;
- play from interruption;
- play from failure;
- scrub on the shared call clock.

The cursor should move over the timeline while audio plays.

### 5. "Why did this turn fail?"

For failed or cancelled turns, and for completed turns with recovered incidents,
the UI should answer in one panel:

- failure or incident category: runtime, provider, tool, transport, policy,
  artifact;
- event and timestamp;
- human explanation;
- technical code/message;
- retryability;
- user-facing effect;
- evidence trace events;
- suggested debugging path.

Examples:

- "LLM stream stalled after 10s; no reply was heard."
- "Tool `check_availability` failed output schema validation; model was given a
  tool-error message."
- "Output was sent to transport but playout was not confirmed before hangup."
- "Caller interrupted during agent playout; output was cancelled before fully
  heard."

## Derived models to add or harden in `@tvic/tracing`

The frontend should consume stable view models.

### `CallInspection`

Top-level object for the call page.

Fields:

- `callId`
- `traceId`
- `status` — from the terminal session event, independent of per-turn statuses
- `startedAt`
- `endedAt`
- `durationMs`
- `degraded`
- `artifactWarnings`
- `summary`
- `turns`
- `timeline`
- `replay`
- `recording` — manifest-derived privacy/recording policy
- `eventsById` — analyzer-populated evidence lookup for UI panels
- `rawEventCount`

### `RecordingSummary`

Manifest-derived recording/privacy state.

Fields:

- `consentMode`
- `persistAudio`
- `redactPii`
- `audioAvailable`
- `inputTrackAvailable`
- `outputTrackAvailable`

### `CallSummary`

Fields:

- `turnCount`
- `completedTurns`
- `failedTurns`
- `cancelledTurns`
- `interruptionCount`
- `toolCallCount`
- `retryCount`
- `incidentCount`
- `completedTurnsWithIncidents`
- `averageResponseLatencyMs` — averaged only over turns with measured response
  latency
- `slowestTurnId` — slowest by `responseLatencyMs`, falling back to `totalMs`
  when response latency is unavailable
- `primaryFailure` — derived from terminal session failure first, then terminal
  turn failures; artifacts can add degraded warnings but do not override runtime
  status

### `TurnInspection`

Fields:

- `turnId`
- `sequence`
- `status`
- `startedMs`
- `endedMs`
- `durationMs`
- `callerText`
- `agentText`
- `latency`
- `spans`
- `tools`
- `interruptions`
- `playout`
- `memoryWrites`
- `failure` — terminal failure/cancel explanation, if the turn ended failed or
  cancelled
- `incidents` — recovered problems inside the turn, even if the turn completed
- `replaySegments`
- `evidenceEventIds`

### `LatencyBreakdown`

Fields:

- `turnTags` — overlapping tags such as `tool`, `interrupted`, `failed`,
  `cancelled`; a tool turn can also be interrupted or failed
- `endpointMs` — nullable until VAD/endpoint events exist
- `sttFinalMs`
- `llmTtftMs` — first LLM pass TTFT for the turn
- `llmTotalMs` — aggregate when only one pass exists; otherwise derived from
  `llmPasses`
- `llmPasses` — one entry per LLM pass, including post-tool continuation
- `toolMs`
- `ttsTtfbMs`
- `ttsTotalMs`
- `firstAudioMs`
- `playoutMs` — playout duration from output/playout completion events, not
  first-audio-to-confirmation latency
- `totalMs`
- `bottleneck`
- `warnings`

### `LlmPassTiming`

Tool turns can run multiple LLM passes: initial reasoning, tool call, then
post-tool continuation. v1 must not flatten those into one ambiguous number.

Fields:

- `passIndex`
- `kind` — initial, post_tool
- `spanId`
- `startedMs`
- `firstTokenMs`
- `completedMs`
- `durationMs`
- `toolCallIds`
- `recoveredFromToolFailure` — derived true when this post-tool pass follows a
  failed tool result that the model recovered from; this is not a distinct
  runtime-emitted third LLM pass
- `status`

### `SpanView`

Fields:

- `spanId`
- `parentSpanId`
- `kind`
- `label`
- `provider`
- `status`
- `startMs`
- `endMs`
- `durationMs`
- `turnId`
- `correlationId`
- `metadata`
- `error`

Kinds:

- session
- turn
- speech — only when speech-boundary events exist
- endpoint — only when endpoint events exist
- stt
- llm
- tool
- tts
- output
- playout
- memory
- runtime

### `InterruptionView`

Fields:

- `turnId`
- `detectedMs`
- `handledMs`
- `cancelledOutputMs`
- `latencyMs`
- `framesSent`
- `wasSpeaking` — derived from output-active / sent frames; does not claim
  byte-level heard audio
- `framesSentBeforeCancel`
- `reason`
- `status`
- `evidenceEventIds`

### `FailureExplanation`

Fields:

- `kind`
- `severity`
- `title`
- `message`
- `technicalCode`
- `provider`
- `toolName`
- `retryable`
- `userFacingEffect`
- `occurredAtMs`
- `evidenceEventIds`
- `debugHints`

Failure kinds:

- `provider_stalled`
- `provider_failed`
- `tool_failed`
- `tool_input_validation_failed`
- `tool_output_validation_failed`
- `transport_closed`
- `playout_unconfirmed`
- `interrupted`
- `remote_hangup`
- `stt_closed_unexpectedly`
- `artifact_degraded`
- `runtime_error`
- `unknown`

Call-level failures:

Some loop failures reach the trace as a terminal session error without a
terminal turn, especially errors thrown before or between turns. The analyzer
must support a `primaryFailure` sourced from `session.failed` /
`session.timeout`, not only `turn.ended`.

Integrator contract:

`PipelineVoiceLoop.run()` can throw loop-level errors such as STT open failure,
media input failure, or unexpected STT close. Those become visible only if the
embedder ends the session with `endSession({ reason: "failed", error })`. The
live-call example already does this. v1 must either document this as a hard
embedder contract or move the responsibility into runtime/loop orchestration so
session failure traces cannot be lost by direct embedders.

### `IncidentView`

Recovered problems that did not make the turn terminal.

Fields:

- `kind`
- `severity`
- `title`
- `message`
- `technicalCode`
- `provider`
- `toolName`
- `attempt`
- `retryable`
- `occurredAtMs`
- `resolvedAtMs`
- `evidenceEventIds`

Incident kinds:

- `tool_retry`
- `tool_failed_recovered`
- `tool_input_validation_failed`
- `tool_output_validation_failed`
- `rejected_barge_in`
- `artifact_warning`

Reserved incident kinds:

- `provider_retry` — not emitted today; reserved for a future provider-level
  retry policy.

### `ReplaySegment`

Fields:

- `id`
- `kind`
- `label`
- `track`
- `startMs`
- `endMs`
- `turnId`
- `spanId`
- `mediaEventIds`
- `available`
- `unavailableReason`

`startMs` and `endMs` are the seek contract. They are always call-clock
`monotonicOffsetMs` values and must match the same aligned-audio path used by the
viewer audio route. `mediaEventIds` are metadata/evidence, not the primary seek
mechanism.

Kinds:

- caller_speech
- agent_sent
- agent_heard — turn-level confirmed, not byte-perfect
- interruption
- failure
- tool_wait
- silence

## Viewer page structure

### Route

`apps/trace-viewer/app/calls/[callId]/page.tsx`

The page reads artifacts, derives `CallInspection`, and renders sections.

### Layout

Recommended layout:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Call summary                                                                  │
│ status · duration · turns · failures · interruptions · degraded warnings      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Replay bar                                                                    │
│ play/pause · scrubber · current time · caller/agent toggles · speed           │
├───────────────────────────────┬──────────────────────────────────────────────┤
│ Conversation timeline          │ Selected turn inspector                       │
│ caller/agent/tool/failure rows  │ waterfall · latency · failure · evidence      │
├───────────────────────────────┴──────────────────────────────────────────────┤
│ Raw trace drawer / artifact details                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

This should feel dense and operational. Avoid a marketing dashboard feel.

### Call summary

Must show:

- call status;
- recording mode;
- total duration;
- turn count;
- failed/cancelled turn count;
- completed turns with incidents;
- interruption count;
- average response latency;
- slowest stage;
- artifact state.

If artifacts are degraded, the warning must be visible in the first viewport.

### Replay bar

Controls:

- play / pause;
- seek slider;
- current time / duration;
- caller track toggle;
- agent track toggle;
- jump to previous/next turn;
- playback rate.

Behavior:

- slider is in call-clock milliseconds;
- seeking updates audio and highlighted timeline cursor;
- selecting a span moves the cursor to span start;
- if audio is unavailable, replay controls remain visible but disabled with a
  clear reason.

### Conversational timeline

Rows:

- caller audio / transcript;
- agent audio / transcript;
- providers;
- tools;
- interruptions/failures.

Markers:

- EOU;
- first token;
- first audio;
- playout confirmed;
- interruption detected;
- output cancelled;
- failed event.

The timeline should make overlap visible. Talk-over must not be hidden inside a
collapsed row.

### Turn inspector

When a turn is selected:

- show the full turn waterfall;
- show latency decomposition;
- show transcript for that turn;
- show tool calls and retries;
- show playout state;
- show recovered incidents, if present;
- show failure explanation if applicable;
- show evidence events.

The selected turn should be linkable by query param:

`/calls/<id>?turn=<turnId>`

### Failure panel

Right-side or inline panel.

Must include:

- title;
- cause;
- evidence;
- timeline position;
- user-facing effect;
- retry/fallback path;
- raw error code/message.

No vague labels like "failed". The user needs to understand exactly what failed.

## Golden scenarios

Every scenario should have:

- trace fixture;
- optional manifest/audio fixture;
- expected `CallInspection` snapshot;
- viewer render test when useful.

Fixture rule:

Golden traces should be generated by running the existing runtime harness with
scripted providers, then snapshotting the emitted JSONL/artifacts. Do not
hand-write large JSONL fixtures by default. Hand-written fragments are allowed
only for narrow analyzer edge cases that the runtime cannot emit yet.

Relationship to existing runtime tests:

- `packages/runtime/test/golden.test.ts` continues proving the loop emits the
  right trace shape.
- `@tvic/tracing` golden tests consume those runtime-shaped traces and prove the
  analyzer derives the correct inspection model.
- If runtime emission changes, fixtures should be regenerated from the harness
  instead of manually patched.

### G1 — Happy path

One caller turn, one agent reply, playout confirmed.

Asserts:

- completed turn;
- response latency present;
- first audio present;
- playout heard;
- no failure explanation.

### G2 — Tool retry

Tool fails once, retries, succeeds.

Asserts:

- retry trace appears;
- tool latency includes attempts;
- incident appears on the completed turn;
- failure panel does not mark the turn terminal-failed if recovery succeeded;
- retry count appears in summary.

### G3 — Barge-in before output fully heard

Caller interrupts during agent playout.

Asserts:

- interruption marker;
- output cancelled;
- turn cancelled;
- agent replay segment is sent, not fully heard;
- failure/cancel explanation says interrupted.

### G4 — Playout unconfirmed

Transport accepted audio but no mark acknowledgement arrives.

Asserts:

- output sent;
- playout unconfirmed;
- no memory write for that reply;
- turn cancelled/not heard.

### G5 — STT closed unexpectedly

STT stream ends before caller media ends.

Asserts:

- call-level failure explanation when no turn exists;
- turn-level failure explanation when the runtime had already opened a turn;
- session failure is present through the loop/embedder failure contract;
- provider category;
- no fake completed turn.

### G6 — LLM stalled

LLM starts and then emits nothing until stall timeout.

Asserts:

- provider stalled explanation from terminal turn/session error today;
- dedicated stall/timeout trace evidence after Workstream F;
- no agent audio replay segment;
- failed turn count increments when timeout policy is `fail`;
- cancelled turn count increments when timeout policy is `interrupt`.

### G7 — Tool validation failure

Tool returns output that does not match schema.

Asserts:

- input vs output validation is distinguished;
- validation incident appears if the model recovers;
- terminal failure explanation appears only if the turn actually fails;
- evidence includes tool failure event;
- model recovery path visible if present.

### G8 — Remote hangup mid-response

Caller hangs up while the agent is generating or playing.

Asserts:

- cancel reason remote hangup;
- output heard only if playout had been confirmed;
- memory write only if reply was heard.

### G9 — Degraded artifacts

Manifest missing or writer recorded write failures.

Asserts:

- call list degraded state;
- detail page degraded banner;
- replay disabled or partially disabled with reason.

Source:

`artifact_degraded` is derived from manifest state and artifact load results,
not from trace events.

## Workstreams

### Workstream A — Tracing analysis

Package: `@tvic/tracing`

Tasks:

1. Introduce `deriveCallInspection(events, manifest?)`.
2. Harden `deriveCallTimeline` or fold it into the new model.
3. Add `FailureExplanation` derivation.
4. Add `IncidentView` derivation for recovered tool/provider/policy problems.
5. Add replay segment derivation using monotonic offsets as the seek contract.
6. Add bottleneck detection, excluding endpoint/dead-air until endpoint events
   exist.
7. Add artifact warning derivation.
8. Add runtime-harness-generated golden fixture tests.

Ownership rule:

All semantic interpretation lives here, not in React.

### Workstream B — Artifact reading

App/package: `apps/trace-viewer/lib`

Tasks:

1. Load call artifacts safely.
2. Normalize missing/corrupt manifest states.
3. Expose audio availability by track.
4. Keep path traversal guards.
5. Return `CallInspection` to pages.

Ownership rule:

This layer reads bytes and files. It does not decide why a turn failed.

### Workstream C — Call detail UI

App: `apps/trace-viewer`

Tasks:

1. Build `CallSummaryHeader`.
2. Build `ReplayBar`.
3. Build `ConversationTimeline`.
4. Build `TurnInspector`.
5. Build `FailurePanel`.
6. Build `EvidenceEvents`.
7. Add responsive layout.

Ownership rule:

The UI renders `CallInspection`. It does not parse raw trace events except in a
raw debug drawer.

### Workstream D — Replay UX

App: `apps/trace-viewer`

Tasks:

1. Keep one call-clock cursor.
2. Sync cursor to audio time.
3. Seek caller/agent tracks together.
4. Support play-from-turn/span/failure.
5. Disable unavailable tracks explicitly.
6. Add sent vs heard labeling with turn-level heard fidelity.

Ownership rule:

Replay operates on `ReplaySegment`s and audio routes, not raw manifest math.

### Workstream E — Visual verification

Tasks:

1. Add render tests for happy path and failure path.
2. Add screenshot checks for timeline/waterfall layout.
3. Verify mobile layout does not overlap.
4. Verify long transcript text wraps.
5. Verify degraded state is visible.

### Workstream F — Runtime emission upgrades

Package: `@tvic/runtime`

Tasks:

1. Emit a stall/timeout trace at LLM stall and TTS stall sites before the
   terminal action.
2. Include `{ provider, stage, timeoutMs, policyAction }` in the trace metadata.
3. Emit the trace for both timeout policies:
   - `onTimeout: "fail"` before throwing the failed-turn error;
   - `onTimeout: "interrupt"` before aborting/cancelling the turn.
4. Decide and document the loop failure contract:
   - either the runtime/loop auto-ends the session failed when `run()` throws;
   - or direct embedders are required to catch loop errors and call
     `endSession({ reason: "failed", error })`.
5. Add regression coverage for session-level failures without turns.

Ownership rule:

The viewer can explain only what the runtime records. Provider stalls and
loop-level failures must leave trace evidence, not only thrown promises.

Architecture note:

Auto-ending the session inside the loop is the larger architectural move: it
couples loop execution to session teardown ownership. Keeping teardown in the
embedder preserves the current controller boundary, but then the embedder
contract must be explicit and tested. This decision should be made deliberately,
not hidden inside error handling.

## Build order

### Phase 0 — Runtime evidence upgrades

Deliverable:

- provider stall/timeout traces for LLM and TTS;
- explicit loop failure/session failure contract.

Acceptance:

- stalled LLM/TTS turns have evidence beyond only terminal `turn.ended`;
- loop-level failures can be derived from `session.failed` in direct and example
  embedding paths.

### Phase 1 — Analysis contract

Deliverable:

- `CallInspection` and related types exported from `@tvic/tracing`.

Acceptance:

- golden tests pass for happy path, interruption, playout unconfirmed, and one
  provider failure;
- endpoint timing fields are nullable/unavailable until endpoint events exist;
- recovered tool failures surface as incidents, not terminal failures.

### Phase 2 — Artifact ingestion

Deliverable:

- viewer artifact loader returns `CallInspection`.

Acceptance:

- corrupt/missing manifest does not crash;
- degraded warnings are derived;
- audio availability is explicit.

### Phase 3 — Call page structure

Deliverable:

- call summary;
- timeline;
- turn inspector;
- initial replay bar.

Acceptance:

- one real call artifact can be inspected without reading JSON.

### Phase 4 — Failure explainer

Deliverable:

- failure panel backed by `FailureExplanation`.

Acceptance:

- each failed/cancelled golden fixture explains the cause and evidence;
- completed turns with recovered tool/provider incidents explain the incident
  without marking the turn failed.

### Phase 5 — Replay polish

Deliverable:

- shared cursor;
- play from turn/span/failure;
- sent vs heard display.

Acceptance:

- replay and timeline stay aligned on call-clock milliseconds.
- sent vs heard fidelity is labeled honestly.

### Phase 6 — Visual QA

Deliverable:

- responsive layout fixes;
- screenshot/DOM tests;
- production build clean.

Acceptance:

- no overlapping text;
- no hidden degraded warnings;
- no unusable mobile state;
- `pnpm lint`, `pnpm test`, `pnpm build` pass.

## Non-goals for v1

Do not build yet:

- org dashboard;
- fleet analytics;
- live tail / streaming call inspection;
- word-level click-to-audio replay;
- auth;
- billing;
- search across calls;
- annotations/comments;
- replay diff;
- live multi-call wallboard;
- provider comparison dashboards.

Those become valuable only after the single-call inspection surface is excellent.

## Risks and guardrails

### Risk: React starts interpreting traces

Guardrail:

Add tests around `@tvic/tracing` view models. Components receive already-derived
objects.

### Risk: UI looks like a generic analytics dashboard

Guardrail:

Build around a call clock, transcript, audio, and turn waterfalls. Voice-native
concepts must dominate the page.

### Risk: replay drifts from trace timing

Guardrail:

All replay positions use `monotonicOffsetMs`. Wall-clock timestamps are display
only.

### Risk: failure explanations become vague

Guardrail:

Every explanation must include evidence event ids and user-facing effect.

### Risk: recovered incidents are shown as terminal failures

Guardrail:

Turn terminal state comes from `turn.ended`; tool/provider problems inside a
completed turn become `IncidentView`s, not `FailureExplanation`s.

### Risk: unavailable endpoint timing is treated as real data

Guardrail:

Endpoint latency stays null/unavailable until runtime emits speech-boundary and
endpoint events. Bottleneck detection excludes unavailable stages.

### Risk: degraded artifacts look trustworthy

Guardrail:

If manifest/write failure/audio missing exists, show a visible degraded state.

## Acceptance checklist

Before calling Observability Surface v1 done:

- [ ] Runtime emits provider stall/timeout traces for LLM/TTS stalls.
- [ ] Loop-level thrown errors become terminal session failure traces by runtime
      responsibility or an explicit embedder contract.
- [ ] `@tvic/tracing` exports stable inspection view models.
- [ ] `CallInspection` includes `eventsById` so evidence IDs are resolvable
      without React parsing raw trace JSON.
- [ ] `CallInspection.recording` exposes manifest-derived recording/privacy
      state.
- [ ] Golden fixtures cover happy path, tool retry, barge-in, playout
      unconfirmed, STT failure, LLM failure, tool validation failure, hangup, and
      degraded artifacts.
- [ ] Golden fixtures are generated from the runtime harness unless explicitly
      marked as analyzer-only fragments.
- [ ] Call page shows summary, timeline, replay bar, turn inspector, waterfall,
      and failure panel.
- [ ] Completed turns can show incidents without being marked terminal-failed.
- [ ] Turn categories are represented as overlapping tags, not a lossy single
      enum.
- [ ] Replay can seek by turn/span/failure.
- [ ] Sent vs heard audio is explicit and fidelity-limited correctly.
- [ ] Endpoint timing is shown only when backed by endpoint events.
- [ ] Degraded artifacts are visible in call list and detail page.
- [ ] React components do not contain trace semantics that belong in
      `@tvic/tracing`.
- [ ] Runtime/tracing/viewer tests pass.
- [ ] Typecheck includes tests.
- [ ] Production build passes.
- [ ] Manual inspection of at least one real call artifact is completed.

## Definition of done

Open one call and answer, without raw JSON:

1. What did the caller say?
2. What did the agent say?
3. When did each turn start and end?
4. Where was latency spent?
5. What did the caller actually hear?
6. Was the caller interrupted or did they interrupt?
7. Which provider/tool/runtime step failed?
8. Why did the turn fail or cancel?
9. Can I replay the exact moment?

When the answer is yes, runtime correctness has become visible product value.
