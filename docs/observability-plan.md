# T-vic Observability Plan — "Datadog for Voice"

Status: v0.1 plan (trace/artifact primitives and local trace viewer implemented; live tail, fleet rollups, and replay diff pending)
Scope: turn the trace stream from the realtime loop into the product's first visible moat
Companion doc: [realtime-loop-plan.md](./realtime-loop-plan.md) — the loop emits what this consumes

## The thesis

Anyone can demo a voice bot. Almost nobody can _see inside one in production_.
When a call goes wrong — the agent talked over the caller, took 3 seconds to
respond, hallucinated a booking — teams today have an audio recording and a
shrug. Our bet: the team that makes voice systems **observable, measurable, and
replayable** wins, the same way APM (Datadog, Honeycomb) won for backend.

The reaction we are engineering for, the first time someone opens a T-vic trace:
**"holy shit — this is Datadog for voice systems."**

## Why this is a moat (not just a nice UI)

The moat is **data fidelity, and we get it for free because we own the runtime.**
Every stage boundary — endpoint, STT final, LLM first token, TTS first byte,
playout start, barge-in — is captured at the source with exact timing and
parent linkage. Anyone bolting observability onto someone else's voice stack is
reconstructing this from logs after the fact and getting it wrong. We emit it
structurally, in real time, by construction.

The `TraceEvent` schema in `@tvic/core` (≈44 typed variants, parent linkage,
status, duration, input/output refs) is already the backbone. This doc is about
what we compute from it and how we make it land.

## What makes voice traces _different_ from generic APM

A backend trace is a tree of service calls. A voice trace is a **conversation on
a timeline**, with three things generic APM has no concept of:

1. **Turns.** The unit of progress is a conversational turn, not an HTTP request.
2. **Audio.** The trace has a soundtrack. You can _listen_ to any moment.
3. **Talk-over / interruption.** Two parties can produce signal at once; the
   interesting failures live exactly there.

Our views are built around those three. That's the difference between "traces
with a voice theme" and something voice-native.

## The killer views (in priority order)

### 1. The Turn Waterfall ← the centerpiece

For each turn, a horizontal timeline of spans, aligned to a real ms axis:

```
Turn 3   "do you have a table for four at 8?"
 caller speech     ▓▓▓▓▓▓▓▓
 endpoint wait              ▓▓                (312ms)
 stt final                   ▓                (98ms)
 llm  TTFT                     ▓▓▓▓▓          (480ms)
 llm  stream                        ▓▓▓
 tool check_availability               ▓▓▓▓▓▓ (610ms)  ← bottleneck
 tts  TTFB                                   ▓▓ (140ms)
 tts  stream                                   ▓▓▓▓
 playout                                        ▓▓▓▓▓▓▓▓
 ── response latency (EOU→first audio): 1.03s ──
```

Built directly from the loop's emitted spans. The bottleneck stage is
highlighted automatically.

### 2. Latency Decomposition ← the "holy shit" number

For any turn or call: response latency broken into its parts, every time.

> **1.03s** = endpoint 312 · STT 98 · LLM TTFT 480 · tool 610 (overlapped) · TTS TTFB 140 · transport 110

You instantly know _what to fix_. This single view is the pitch.

### 3. Transcript ↔ Trace ↔ Audio alignment

A transcript where every utterance is linked to its spans and its audio. Click a
word → jump to that span and **play that exact moment**. Scrub the call timeline
and watch the transcript + spans move together. The audio is a first-class axis,
not an attachment.

### 4. Interruption / talk-over view

Barge-ins rendered explicitly: caller cut in _here_, we flushed output in 84ms,
this much agent audio was discarded, we relistened _there_. The thing that feels
broken in voice demos, finally visible and measurable.

### 5. Live tail

Watch a call's spans stream in **as the call happens** — like `tail -f` /
`datadog live tail` for a conversation. Latency numbers tick up live. This is the
demo that sells it in a room.

### 6. Call & fleet rollups

P50/P95 per stage across a call, and across many calls. "TTS TTFB regressed
180ms today." "Endpoint delay p95 is 700ms on Spanish calls." Turns single-call
debugging into fleet-level operational insight — the APM upgrade path.

### 7. Failure forensics

A tool timed out → see exactly what the caller _heard_ during the gap, what the
model did, the retry/fallback path, and where recovery happened. Turn a vague
"the call felt broken" into a precise timeline.

### 8. Replay & diff (later, but design for it now)

Re-run a recorded session against a new prompt/model/voice and **diff the
traces**: latency delta, behavior delta, transcript delta. Regression testing
for conversations.

## Data model: from point events to spans

We already emit typed events with `status` (started/in_progress/succeeded/failed/
cancelled), `durationMs`, `parentEventId`, and `turnId`. That is **not enough** —
`turnId` + `parentEventId` get ambiguous fast once an LLM stream, a filler TTS, a
tool call, playout, and a barge-in all overlap inside one turn. We do not wait for
"real data" to discover the graph is ambiguous; we lock the span model now.

**Required contract additions (freeze before build):**

- `turn.started` / `turn.ended` event types — explicit per-turn bracket; the
  waterfall groups on the turn span, not an inferred boundary.
- `spanId` + `parentSpanId` on every event — an explicit span graph, independent
  of `turnId`/`parentEventId`. Nesting (e.g. `tool` under `llm`) is unambiguous.
- `correlationId` on every event — groups a logical unit across events: one
  playout, one tool invocation, one egress audio segment.
- `monotonicOffsetMs` on every event — see timestamps below.

**Spans are then derived as:**

- A span = a start event + its terminal event (e.g. `stt.started` → `stt.final`),
  joined by `spanId`; or a single event carrying start + `durationMs`.
- Grouped by the `turn.*` bracket; nested by `parentSpanId`.
- `*.token` / `*.chunk` / `*.partial` are stream markers used to plot TTFT/TTFB
  precisely (first token/byte timestamp), not just totals.

**Timestamps — dual, always.** Every trace and media event carries both:

- `timestamp` — wall-clock ISO, for display and correlation with external logs;
- `monotonicOffsetMs` — offset from session/call start on a monotonic clock, for
  _all latency math_.

Wall-clock alone is not trustworthy for waterfalls (NTP steps, clock skew). All
durations and the latency catalog below are computed from `monotonicOffsetMs`. If
the loop approximates timing, the moat evaporates — this is a hard requirement.

## Derived metrics catalog

Computed from the trace stream, surfaced per turn / per call / per fleet:

| Metric                                             | Definition                                               |
| -------------------------------------------------- | -------------------------------------------------------- |
| Response latency                                   | end-of-utterance → first audio out (the headline number) |
| Endpoint delay                                     | last speech frame → turn commit                          |
| STT final latency                                  | endpoint → `stt.final`                                   |
| LLM TTFT                                           | `llm.started` → first `llm.token`                        |
| LLM completion time                                | `llm.started` → `llm.completed`                          |
| Tool latency                                       | `tool.started` → `tool.completed`, per tool              |
| TTS TTFB                                           | `tts.started` → first `tts.chunk`                        |
| Barge-in cancel latency                            | `barge_in.detected` → output silenced                    |
| Talk-over duration                                 | overlap window of caller + agent audio                   |
| Dead air                                           | gaps with neither party producing audio                  |
| Turns per call / call duration / completion status | conversation-level rollups                               |

## Audio capture & alignment

Click-word-to-audio is a v1 view, so audio capture is a **loop responsibility from
day one**, not a viewer add-on. The loop writes per-call artifacts:

```
calls/<callId>/
  call.jsonl       # ordered TraceEvents for the call
  input.pcm        # normalized caller PCM (16k s16le)
  output.pcm       # normalized agent PCM (16k s16le)
  manifest.json    # payloadRef → { file, byteRange, monotonicOffsetMs, durationMs }
```

- Audio is **not** stored inline in traces (contract already forbids it). Chunks
  carry `payloadRef`s that resolve through `manifest.json` to a file + byte range.
- Byte ranges are tagged with `monotonicOffsetMs` on the **same clock** as the
  trace timeline, so "play this span" and "scrub to time" land exactly.
- v1: these artifacts on local disk; the viewer reads them directly. Persistent
  object storage + DB come later.

## Privacy, consent & retention (runtime requirement)

The observability moat stores transcripts and call audio. That makes privacy a
runtime concern from day one, even for a local v1 — not a compliance task bolted
on before sales. Required controls:

- **Recording consent mode** — per-agent/per-call: record / don't record. Default
  conservative.
- **Do-not-persist-audio mode** — keep traces + transcript, drop audio bytes
  (manifest still records spans, just no PCM files).
- **PII redaction hooks** — redact transcript and trace fields before they hit
  disk/exporters (names, numbers, payment data).
- **Retention config** — TTL on `calls/<callId>/` artifacts and a deletion path.

These imply a **recording/privacy policy on the `Agent` contract** and a
redaction hook in the trace export path (`@tvic/tracing`). Listed below.

## Contract changes to freeze before build

**Moved.** The authoritative list now lives in the frozen contracts doc:
[runtime-contracts.md → "v0.3 Freeze Delta (Realtime Loop + Observability) —
Source of Truth"](./runtime-contracts.md#v03-freeze-delta-realtime-loop--observability--source-of-truth).

The loop and viewer are built in parallel, so these deltas must not live as prose
in two places that can drift. This doc and `realtime-loop-plan.md` defer to that
table; if anything here disagrees with it, the contracts doc wins.

## Storage & access

- **Now:** in-memory trace store + JSONL exporter already exist (`@tvic/tracing`).
  Add per-call JSONL + audio on disk.
- **Viewer ingestion:** a small local dev server reads completed JSONL (post-call
  views) and subscribes to the live trace stream over WS (live tail). The runtime
  already exposes `onTraceEvent` for the live feed.
- **Later:** persistent store (Postgres for trace index + object storage for
  audio/payloads), retention, multi-call search.

## The viewer (what we actually build)

A local web app (Next.js, App Router) that the developer runs alongside the
runtime:

- reads per-call JSONL for historical calls;
- subscribes to the live trace WS for live tail;
- renders: turn waterfall, latency decomposition, aligned transcript+audio
  player, interruption view, and call/fleet rollups.

Deliberately **runtime-first, control-plane-later**: no auth, no multi-tenant, no
hosting. It runs locally against the one perfect loop and looks magical doing it.

## Phasing — what is "magical" in v1

**v1 (ships with the one loop):**

- Turn waterfall + latency decomposition (views 1–2)
- Aligned transcript + audio replay (view 3)
- Interruption view (view 4)
- Live tail (view 5)

That set alone produces the "holy shit" reaction. Everything else is upside.

**v2+:** fleet rollups, failure forensics, replay & diff, persistent storage,
search, alerting/regression detection.

## Definition of done (v1)

1. After any call, open the viewer and see that call's full turn waterfall with
   real per-stage timing.
2. The headline response-latency decomposition is correct and matches the loop's
   measured budget.
3. Click any span/word → hear that exact audio moment.
4. Barge-ins are visible with cancel latency and discarded-audio amount.
5. Live tail shows spans streaming during an in-progress call.
6. Numbers are trustworthy — derived from source-emitted timestamps, never
   reconstructed or estimated.

## Open questions

1. Waterfall grouping: is `turnId` + `parentEventId` enough, or do we add an
   explicit `turn.*` span pair / `spanId`? Decide from real data in loop step 2–3.
2. Audio replay fidelity: store normalized PCM (clean, larger) or the original
   μ-law (smaller, exactly what flowed)? Likely both refs, default to PCM.
3. Live tail transport: reuse `onTraceEvent` over a WS, or a dedicated SSE feed?
4. How much of the viewer is worth building before the loop hits step 3 (first
   full turn)? Probably the waterfall scaffold only, fed by recorded JSONL.
