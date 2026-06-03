# T-vic Codebase Engineering Audit

Date: 2026-06-04

Scope: production source, tests, architecture checker, live-call example, and trace
viewer. Generated output (`dist`, `.next`), `node_modules`, and call artifacts were
excluded.

Verification run:

- `pnpm lint`: passed. This includes prettier, production/test typecheck, and
  `scripts/check-architecture.mjs`.
- `pnpm test`: passed. 183 tests across the monorepo.
- `pnpm build`: passed. 9 build tasks, including `next build`.
- `npx -y react-doctor@latest . --verbose --diff`: 97/100, 4 warnings.

## Executive Verdict

The codebase is in a much stronger place than the early versions: core is still the
base layer, runtime composes dependencies through contracts, tracing owns semantic
analysis, the viewer mostly renders derived models, tests are strict-typechecked,
and the architecture checker covers the major package boundaries.

The remaining serious issues are not "business logic in DAL" or generic MVC rot.
The largest risks are trust-boundary leaks and model bloat:

- persisted artifacts are sometimes cast into trusted types instead of validated;
- the viewer hydrates raw trace events into a client component;
- a few analysis paths still trust event-specific numeric fields after only core
  trace validation;
- one artifact writer can finalize a manifest using fake `"unknown"` branded IDs;
- the frontend list/inspection loader has small avoidable async inefficiencies.

These are fixable, but they are real. They are the kind of things a senior reviewer
will flag because production observability cannot crash, lie, or leak raw evidence
unnecessarily.

## Layer Verdict

Core: good. It has no sibling imports and still behaves like the stable contract
base.

DAL: mostly good. I did not find restaurant/vendor/customer business logic in DAL.
The DAL layer stores/query filters data, owns artifact persistence, memory storage,
path safety, and pruning. That is appropriate. The main issue is not business logic;
it is that manifest reads use unchecked casts.

Runtime: good directionally. The runtime owns orchestration, clock stamping, trace
fanout, turn/tool lifecycles, and session control. The remaining issue is size and
reviewability of `pipeline-loop.ts`, not an obvious layer violation.

Tracing: semantically correct, but `inspection.ts` has become a large, high-value
trust boundary. It should be split and hardened because every UI explanation depends
on it.

Viewer: scoped correctly as a single-call inspector, but it currently sends too much
raw data to the client and has a few avoidable server-side inefficiencies.

## Findings

### High - Raw trace events are hydrated into the client UI

Refs:

- `packages/tracing/src/inspection.ts:201` defines `CallInspection`.
- `packages/tracing/src/inspection.ts:219` adds the raw `eventsById` trace map.
- `apps/trace-viewer/app/calls/[callId]/page.tsx:30` passes the full
  `CallInspection` into `CallView`.
- `apps/trace-viewer/app/calls/[callId]/call-view.tsx:1` makes the entire view a
  client component.
- `apps/trace-viewer/app/calls/[callId]/call-view.tsx:616` resolves evidence out of
  raw events on the client.
- `apps/trace-viewer/app/calls/[callId]/call-view.tsx:642` renders raw trace JSON
  for the selected turn.

Why this matters:

The current shape makes the whole raw trace map part of the browser hydration
payload. Trace events can include transcripts, tool inputs/outputs, provider
metadata, error messages, and other sensitive operational evidence. Even if this is
local-only today, the model encourages a bad production pattern: ship raw evidence
to the browser because the derived model did not precompute enough display data.

It is also unnecessary virtual-tree pressure. The UI only needs a small evidence
view for panels: event type, offset, status, provider, code/message, and maybe span
id. It does not need every raw event in a client prop.

Fix direction:

- Keep `eventsById` server-side or mark it as an internal analyzer artifact, not as
  the UI model.
- Add `EvidenceView` in `@tvic/tracing`, with display-safe fields such as
  `eventId`, `type`, `offsetMs`, `status`, `provider`, `code`, and `message`.
- Make `FailureExplanation` and `IncidentView` carry resolved sanitized evidence, or
  make `deriveCallInspection` build a `evidenceById` map that contains only the
  display-safe subset.
- Split the viewer so the static summary/waterfall can remain server-rendered and
  the client part only owns replay controls, selected-turn state, and seeking.
- Keep the raw JSON drawer behind an explicit server route or dev-only flag if it
  remains useful.

Tests to add:

- A fixture with transcript/tool data proves `CallView` props do not contain raw
  `TraceEvent` payloads.
- Evidence panels still render the same type/offset/code data from sanitized
  evidence.

### High - Audio route can crash on a corrupt manifest sample rate

Refs:

- `apps/trace-viewer/lib/artifacts.ts:210` reads the first payload sample rate.
- `apps/trace-viewer/lib/artifacts.ts:211` accepts any finite positive number.
- `apps/trace-viewer/lib/wav.ts:15` writes `sampleRate` into a WAV uint32 field.
- `apps/trace-viewer/lib/wav.ts:16` writes `byteRate` into a WAV uint32 field.
- `apps/trace-viewer/app/api/calls/[callId]/audio/[track]/route.ts:18` calls
  `pcm16ToWav()` outside any validation/catch.

Why this matters:

The manifest is disk data, not a trusted TypeScript object. A payload format with
`sampleRateHz: 1e20` or `16000.5` passes `isFiniteNumber(rate) && rate > 0`, then
`Buffer.writeUInt32LE()` can throw because the WAV header requires an integer in
uint32 range. That turns one corrupt call artifact into a 500 for the audio route.

Fix direction:

- Validate audio format before reconstruction: `encoding === "pcm_s16le"`,
  `channels === 1`, and `Number.isSafeInteger(sampleRateHz)`.
- Bound the rate to supported normalized rates. For v0.1, prefer exact
  `PCM16_16K_MONO.sampleRateHz`; otherwise explicitly allow `8000..48000`.
- Make `pcm16ToWav()` defensive too. It should reject or fall back before calling
  `writeUInt32LE`.
- Mark the call degraded when payload format is invalid, rather than silently using
  a dangerous value.

Tests to add:

- Corrupt manifest with `sampleRateHz: 1e20` returns a controlled 404/422 or falls
  back safely, never throws.
- Fractional sample rate is rejected.
- Wrong channel count or encoding is rejected.

### High - Artifact manifests are parsed with casts instead of validation

Refs:

- `apps/trace-viewer/lib/artifacts.ts:59` reads `manifest.json`.
- `apps/trace-viewer/lib/artifacts.ts:61` casts `JSON.parse(body)` to
  `CallArtifactManifest`.
- `apps/trace-viewer/lib/artifacts.ts:163` checks degraded status with JavaScript
  coercion around `writeFailures`.
- `packages/dal/src/index.ts:679` reads a manifest for pruning.
- `packages/dal/src/index.ts:689` casts `JSON.parse(body)` to
  `CallArtifactManifest`.

Why this matters:

`CallArtifactManifest` is a contract, but neither the viewer nor DAL validates it
when reading from disk. Invalid values can be treated as trusted data. Example:
`writeFailures: "0"` or `writeFailures: null` can dodge the intended degraded
classification because the code relies on `>=` coercion. Payload fields are partly
filtered later, but privacy, files, timestamps, and write-failure integrity are not
centrally validated.

Fix direction:

- Add a single manifest parser, ideally in `@tvic/core` or a tiny artifact utility
  module: `parseCallArtifactManifest(value): ParsedManifest`.
- Parsed result should distinguish:
  - valid manifest;
  - missing manifest;
  - invalid manifest with reason.
- Viewer and DAL should both reuse it.
- Any invalid manifest should mark the call degraded and surface an artifact warning.

Tests to add:

- Invalid JSON, missing required fields, non-number `writeFailures`, invalid privacy,
  invalid payload byte ranges, invalid audio format.
- DAL prune should skip invalid manifests safely and not throw the whole prune pass.

### High - Local artifact writer can write fake branded IDs into the manifest

Refs:

- `packages/dal/src/index.ts:411` makes `sessionId` optional.
- `packages/dal/src/index.ts:414` says it can be learned from the first trace event.
- `packages/dal/src/index.ts:496` learns `sessionId` from the first exported event.
- `packages/dal/src/index.ts:497` learns `traceId` from the first exported event.
- `packages/dal/src/index.ts:564` writes `"unknown" as SessionId`.
- `packages/dal/src/index.ts:565` writes `"unknown" as TraceId`.

Why this matters:

This violates the same principle as "no fake thing." A manifest with required
`sessionId` and `traceId` fields should not contain branded sentinel strings. If no
trace event was exported, the manifest is incomplete and should say that honestly.

Fix direction:

- Preferred: require `sessionId` and `traceId` before `close()` can produce a valid
  manifest.
- If they are legitimately unknown, change the manifest contract to represent that:
  optional IDs plus `integrity: "invalid" | "degraded" | "complete"` or a required
  `identityMissing: true`.
- Increment a manifest integrity failure when `close()` cannot determine identity.
- Viewer should surface this as degraded.

Tests to add:

- Writer with no exported trace event closes to a degraded/invalid manifest, not
  fake IDs.
- Writer with exported `session.created` produces real `sessionId` and `traceId`.

### Medium - Trace inspection still trusts event-specific fields after core validation

Refs:

- `packages/tracing/src/inspection.ts:612` uses `event.attempt` directly in
  `Math.max`.
- `packages/tracing/src/inspection.ts:618` repeats direct attempt usage.
- `packages/tracing/src/inspection.ts:627` repeats direct attempt usage.
- `packages/tracing/src/inspection.ts:637` stores raw `event.attempt` in a tool
  failure.
- `packages/tracing/src/inspection.ts:655` interpolates raw `event.attempt`.
- `packages/tracing/src/inspection.ts:657` stores raw retry attempt.
- `packages/tracing/src/inspection.ts:702` stores raw `event.durationMs`.
- `packages/tracing/src/inspection.ts:707` stores raw `event.framesSent`.
- `packages/tracing/src/inspection.ts:711` stores raw memory fields.

Why this matters:

`isTraceEvent` verifies the trace core fields. It does not prove every per-event
payload field has the exact expected type/range. A corrupt `tool.failed` line with
`attempt: "2"` can push `NaN` or a string into the derived model. The viewer and
latency calculations should degrade gracefully, never trust one malformed event.

Fix direction:

- Add event-payload coercion helpers: `positiveIntOr`, `finiteDurationOrUndefined`,
  `finiteFrameCountOr`, `safeStringOr`.
- Use them for every per-event field in `deriveTurnInspection`.
- Consider adding event-specific runtime validators in `@tvic/tracing/validate.ts`
  for the event types the viewer relies on.

Tests to add:

- Malformed `tool.failed.attempt`, `runtime.retry.attempt`, `interrupt.handled.durationMs`,
  `output.cancelled.framesSent`, and `memory.write` fields.
- Derived model must contain bounded defaults/warnings, not `NaN` and not wrong
  runtime types.

### Medium - Span accumulation can attach malformed error/metadata

Refs:

- `packages/tracing/src/inspection.ts:947` assigns `"error" in event ? event.error`
  to a `NormalizedError | undefined`.
- `packages/tracing/src/inspection.ts:956` writes that value into the span.
- `packages/tracing/src/inspection.ts:973` writes the initial span error.
- `packages/tracing/src/inspection.ts:974` spreads `event.metadata` into `SpanView`.

Why this matters:

If a trace line passes core validation but has an invalid error payload, the span
view can carry a string/object that is not a `NormalizedError`. Same for metadata:
the type says `Record<string, unknown>`, but disk data can be anything. This is a
small trust-boundary hole inside the analyzer.

Fix direction:

- Use the existing `isNormalizedError` guard before attaching span errors.
- Add `isPlainRecord` before attaching metadata.
- If the event is malformed, either omit the field or add an artifact warning.

Tests to add:

- Malformed `error` on `turn.failed`/`llm.failed` does not enter `SpanView.error`.
- Non-object metadata is ignored.

### Medium - Latency CLI bypasses hardened trace parsing

Refs:

- `examples/live-call/src/latency-cli.ts:15` defines its own event loader.
- `examples/live-call/src/latency-cli.ts:20` casts every JSON line to `TraceEvent`.

Why this matters:

The viewer now has corrupt-line dropping and `isTraceEvent` validation. The latency
CLI does not. A bad line can crash the CLI or feed malformed data into
`deriveCallTimeline`. Operational tools should share the same artifact parser, not
each invent their own.

Fix direction:

- Move JSONL parsing into `@tvic/tracing` or an artifact utility module.
- Return `{ events, dropped }`.
- CLI should print a warning when dropped > 0 and continue with validated events.

Tests to add:

- CLI parser skips corrupt JSON and malformed trace-core lines.
- CLI output marks the artifact degraded/incomplete.

### Medium - `TraceExporter.export()` durability semantics are inconsistent

Refs:

- `packages/core/src/providers/trace-exporter.ts:6` defines `export()` but does not
  specify whether the returned promise means "accepted" or "durably written".
- `packages/tracing/src/index.ts:63` `JsonlTraceExporter.export()` awaits its own
  serialized append.
- `packages/dal/src/index.ts:485` `LocalCallArtifactWriter.export()` returns after
  enqueuing work.
- `packages/dal/src/index.ts:534` requires `flush()` to await the writer's chain.

Why this matters:

Two exporters implementing the same interface have different promise semantics.
That is a contract ambiguity. The runtime currently survives because it has
per-sink chains and the gateway calls `writer.close()`, but another caller awaiting
`export()` could reasonably assume the event is written when it is only queued.

Fix direction:

- Decide the contract:
  - Option A: `export()` resolves after accepted/enqueued; durability requires
    `flush()`/`close()`.
  - Option B: `export()` resolves after the write is complete.
- Document it in `TraceExporter`.
- Make both exporters follow the same rule.
- If Option A wins, rename internally to make that explicit (`enqueueExport` is too
  invasive for public API now, but docs/tests can lock the semantics).

Tests to add:

- Contract test shared by exporters proving the chosen semantics.
- Runtime flush test that does not depend on exporter-specific hidden chains.

### Medium - Public live-call gateway allows unauthenticated mode without production guard

Refs:

- `examples/live-call/src/gateway.ts:92` serves unauthenticated `/twiml` when
  `TWILIO_AUTH_TOKEN` is missing.
- `examples/live-call/src/main.ts:261` warns when `TWILIO_AUTH_TOKEN` is missing.
- `examples/live-call/src/main.ts:262` says unauthenticated mode is dev/tunnel only.

Why this matters:

The warning is clear, but warnings are easy to miss in deployment logs. If this
example becomes the first real deployment skeleton, it should refuse to start in a
production mode without `TWILIO_AUTH_TOKEN`. A senior reviewer will ask why a public
webhook can knowingly mint tokens for anyone when an environment guard could block
it.

Fix direction:

- Add `TVIC_ENV` or use `NODE_ENV === "production"` to fail fast unless
  `TWILIO_AUTH_TOKEN` is set.
- Keep unauthenticated mode available only behind an explicit dev flag such as
  `ALLOW_UNAUTHENTICATED_TWIML=true`.

Tests to add:

- Production config without auth token throws at startup.
- Dev config without auth token still logs warning and works.

### Medium - Endpointing is still a runtime TODO

Refs:

- `packages/runtime/src/conversation-policy.ts:23` accepts transcript events.
- `packages/runtime/src/conversation-policy.ts:29` has `TODO(endpointing-v1)`.
- `packages/runtime/src/conversation-policy.ts:31` gates on provider
  `speechFinal`.

Why this matters:

This is already documented, so it is not hidden. It still matters because endpointing
is one of the hardest parts of realtime voice. The current policy is acceptable for
the live-call skeleton, but the product should not claim VAD-based endpointing or
endpoint-latency decomposition until this TODO is replaced by the planned state
machine.

Fix direction:

- Keep the TODO visible.
- Add a tracked work item for VAD tentative EOU + STT final confirmation + max-wait
  fallback.
- Once implemented, emit speech/endpoint trace events so the viewer can show
  endpoint latency honestly.

### Medium - Largest files are still too broad for easy senior review

Refs:

- `packages/tracing/src/inspection.ts`: 1254 lines.
- `packages/runtime/src/pipeline-loop.ts`: 1197 lines.
- `packages/dal/src/index.ts`: 694 lines.
- `packages/tools/src/index.ts`: 600 lines.
- `apps/trace-viewer/app/calls/[callId]/call-view.tsx`: 645 lines.
- `packages/runtime/test/pipeline-loop.test.ts`: 1311 lines.
- `packages/runtime/test/runtime.test.ts`: 717 lines.

Why this matters:

Large files are not automatically bad. Here, however, several of these files are
high-value correctness surfaces: realtime loop behavior, inspection semantics,
artifact persistence, and the main UI. The code is test-backed, but the size makes
line-by-line review slower and increases the chance that unrelated edits land in the
same file.

Fix direction:

- Split `inspection.ts` into model/types, call summary, turn analysis, replay,
  failure/incidents, and coercion/validation.
- Split `pipeline-loop.ts` around input/STT supervision, LLM, tools, TTS/playout,
  and interruption handling while keeping `PipelineVoiceLoop` as the orchestrator.
- Split `dal/src/index.ts` into trace store, runtime stores, memory store, artifact
  writer, artifact maintenance.
- Split `call-view.tsx` into `ReplayBar`, `ConversationTimeline`, `TurnInspector`,
  `Waterfall`, `FailurePanel`, and keep a thin container.
- Split large runtime tests by behavior rather than by implementation file.

This is not urgent correctness work, but it is real maintainability debt.

### Medium - Architecture checker does not enforce all hygiene rules now needed

Refs:

- `scripts/check-architecture.mjs:67` scans import specifiers for package rules.
- `scripts/check-architecture.mjs:126` uses regexes for static imports/exports.
- `scripts/check-architecture.mjs:85` checks only the normalized audio literal.

Why this matters:

The checker catches the most important package-boundary regressions, which is good.
It does not catch dynamic imports, package dependency drift, cross-package relative
imports outside static import syntax, large-file growth, trust-boundary casts such
as `JSON.parse(...) as CallArtifactManifest`, or production `as unknown as` escape
hatches.

Fix direction:

- Add checks for:
  - `JSON.parse(...) as ContractType` outside tests;
  - `as unknown as` outside tests unless allowlisted;
  - large-file budgets for key source files;
  - `@tvic/*/src` deep imports;
  - package.json dependencies matching the allowed graph.
- Consider moving from regex scanning to dependency-cruiser or ESLint import rules
  if the script becomes hard to reason about.

### Low - Viewer server work has avoidable sequential awaits

Refs:

- `apps/trace-viewer/lib/artifacts.ts:127` awaits manifest before track stats.
- `apps/trace-viewer/lib/artifacts.ts:128` then starts `Promise.all` for tracks.
- `apps/trace-viewer/lib/artifacts.ts:149` awaits `loadCall()` inside a loop.

Why this matters:

React Doctor flagged these correctly. For a handful of calls it does not matter.
For a trace directory with hundreds of calls, the call list will load one call at a
time and feel slower than it needs to.

Fix direction:

- In `loadCallInspection`, read manifest and track availability concurrently after
  `call.jsonl` is read, or start all independent reads at once.
- In `listCalls`, collect safe directory names and use `Promise.all` with a small
  concurrency cap if the directory can be large.

Tests to add:

- Existing behavior tests should still pass; add a simple test that failed loads do
  not reject the whole list.

### Low - Viewer page metadata and UI copy polish

Refs:

- `apps/trace-viewer/app/page.tsx:1` has no exported metadata.
- `apps/trace-viewer/app/page.tsx:12` uses an em dash in the title text.

Why this matters:

React Doctor flagged both. This is not a backend-quality issue, but a polished
frontend should have metadata and consistent copy. The em dash is a style nit; the
metadata is a real Next app hygiene item.

Fix direction:

- Add metadata in `layout.tsx` or `page.tsx`.
- Change `T-vic - Trace Viewer` or `T-vic Trace Viewer` depending on the visual
  direction.

### Low - Provider-specific socket cast in live-call gateway is a type escape hatch

Refs:

- `examples/live-call/src/main.ts:250` casts the WebSocket through
  `unknown as TwilioMediaStreamSocket`.

Why this matters:

This is contained to the example gateway, but it is still a hard type escape at the
media-plane/provider boundary. If the media plane evolves or accepts a different
socket shape, this cast hides the mismatch.

Fix direction:

- Make `NodeMediaPlane` generic over its socket handle, or define a minimal
  structural socket interface shared by `runtime` and providers.
- Avoid `unknown as` in production/example source. Allow it in tests only.

## Removal / Refactor Candidates

These are not bugs, but they are lines/structures worth deleting or shrinking once
the main findings are fixed:

- `CallInspection.timeline` is currently a legacy compatibility model
  (`packages/tracing/src/inspection.ts:215`). The viewer detail page renders
  `turns`, not the legacy timeline. Keep it until the latency CLI/listing path is
  migrated, then remove the duplicate model surface.
- The raw JSON drawer in `call-view.tsx:635` should not be part of the normal
  client payload. Keep it dev-only or back it by a server route after evidence is
  sanitized.
- Inline page styles in `apps/trace-viewer/app/page.tsx:15` and related call-list
  layout should move into CSS modules/global classes if the viewer keeps growing.
- Comments are mostly useful and not excessive. The TODO in `conversation-policy.ts`
  should remain until endpointing is built; do not delete it just for cleanliness.

## Not Findings

- I did not find business workflow logic inside DAL. The DAL layer is broad, but the
  logic there is storage/query/artifact persistence, not restaurant/call workflow
  behavior.
- Test doubles named fake/stub are confined to tests/harnesses. They are not
  production stubs.
- The current architecture checker is valuable. The recommendation is to strengthen
  it, not replace it blindly.
- The runtime's trace sink design is directionally correct: independent ordered
  chains per sink, bounded depth, scoped flushes, and no observability backpressure
  on audio.

## Suggested Fix Order

1. Add a shared manifest validator and use it in viewer + DAL.
2. Harden audio format/sample-rate validation and WAV generation.
3. Remove fake `"unknown"` manifest IDs or mark such manifests degraded.
4. Sanitize evidence so raw `eventsById` is not hydrated into the client UI.
5. Harden `deriveCallInspection` event-specific field coercion.
6. Move JSONL parsing into a shared tracing/artifact parser and update the CLI.
7. Decide and document `TraceExporter.export()` promise semantics.
8. Add production fail-fast for unauthenticated Twilio webhooks.
9. Address React Doctor's async and metadata findings.
10. Split the largest files once correctness hardening is complete.
