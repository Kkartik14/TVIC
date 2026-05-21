# T-vic Realtime Loop Plan

Status: v0.2 implementation slice (Node WS media plane, Twilio/Deepgram/OpenAI/Cartesia adapters, and first pipeline loop implemented; VAD/endpointing and hardened barge-in pending)
Scope: ONE realtime conversation loop, built end-to-end, perfect, not generic
Companion doc: [observability-plan.md](./observability-plan.md) — the loop exists partly to feed the traces

## Intent

Build a single realtime voice loop that runs a live phone call end-to-end and is
_perfect_ on that one path. Not a generic multi-provider matrix. One telephony
provider, one STT, one LLM, one TTS, one workflow. Every millisecond, every
interruption, every failure mode on that path is handled and measured.

The provider abstractions already exist in `@tvic/core`. We fill exactly one
implementation per slot, behind the existing interface. No second provider is
added until the first call is perfect.

## Decisions needed (resolve before build)

| #   | Decision                        | Recommendation                                                                                                | Why                                                                                                                                                                  |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Pipeline vs realtime (S2S) mode | **Pipeline** (Deepgram + LLM + Cartesia)                                                                      | Only pipeline exposes the per-stage latency that makes the traces moat possible. S2S is a black box.                                                                 |
| D2  | Inbound vs outbound first       | **Inbound** ("reservation line")                                                                              | Testable by calling from your own phone; identical loop mechanics; no cooperating callee required.                                                                   |
| D3  | First LLM                       | **A fast model** (e.g. gpt-4o-mini class / Haiku class), streaming, tool-calling                              | TTFT dominates perceived latency. Optimize for speed first; swap up later.                                                                                           |
| D4  | Public host for the media WS    | **Locked: local tunnel for dev; long-running Node service (Fly / Railway / Render / EC2) for first real run** | Host choice shapes TLS, WS lifetime, backpressure, reconnect behavior, Twilio webhook shape, logging, and the latency numbers themselves. Too load-bearing to defer. |

Everything below assumes D1=pipeline, D2=inbound, D3=fast model, D4=locked host
(tunnel for dev → long-running Node service for first real run). Flip D1–D3 and
the plan adjusts but the bones don't; D4 is locked because deferring it leaks
into transport, backpressure, and the latency baseline.

## The chosen slice

**Inbound restaurant reservation line, pipeline mode.**

A caller dials the agent's number. The agent answers as a restaurant's
reservation line, takes a booking (party size, time, name), calls a
`check_availability` tool, confirms or offers alternatives, and ends the call.

This one workflow exercises every hard part we care about:

- streaming STT with partial/final results
- turn-taking and endpointing
- barge-in / interruption mid-response
- a tool call mid-conversation (with latency to cover)
- conversational state across turns (slot filling)
- memory (remember the caller within the session)
- graceful teardown
- complete, replayable tracing of all of the above

## Architecture: the media plane

The loop runs in a **long-running Node process** (not serverless). It exposes a
public `wss://host/media/:callId` endpoint.

```
PSTN caller
   │  (dials Twilio number)
   ▼
Twilio  ──TwiML <Connect><Stream>──►  wss://host/media/:callId
   │  μ-law 8kHz, 20ms frames, base64 over WS (bidirectional)
   ▼
┌──────────────────────── T-vic media plane (per call) ────────────────────────┐
│  Ingress:  μ-law 8k → PCM 16k  (decode + resample at the edge)                │
│      │                                                                        │
│      ├─► VAD / endpointer  ──► turn boundaries                               │
│      └─► Deepgram STT stream  ──► partials + finals                          │
│                    │                                                          │
│   on end-of-utterance:                                                        │
│      create/advance Turn ──► LLM (history + tools, streaming)                │
│            │                                                                  │
│            ├─ tool_call ──► execute tool (emit "filler" utterance)          │
│            │                       └─► feed result back to LLM               │
│            └─ text stream ──► Cartesia TTS (streaming)                       │
│                    │                                                          │
│  Egress:  PCM 16k → μ-law 8k  (encode + resample)                            │
│      │    pace into 20ms frames, send over WS                                │
│      └─► Twilio plays to caller                                              │
│                                                                              │
│  Barge-in monitor (always on during playout):                               │
│      input speech detected ──► Twilio `clear` (flush) + stop TTS/LLM         │
│                            ──► relisten                                       │
│                                                                              │
│  Every stage emits a TraceEvent with precise timing (see observability doc) │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Twilio Media Streams specifics we rely on

- Inbound `media` events: base64 μ-law 8kHz, 20ms frames.
- Outbound `media` messages: we send the same format, paced.
- `mark` messages: round-tripped by Twilio when a piece of audio finishes
  playing — gives us **exact playout-complete timing** (critical for the trace
  timeline and for knowing when the agent actually stopped talking).
- `clear` message: flushes Twilio's outbound buffer instantly — this is the
  mechanism that makes barge-in feel instant.

## The loop, stage by stage (and the hard problem in each)

### 1. Ingress & resampling

μ-law 8kHz → PCM s16le 16kHz at the adapter edge (per the normalized-audio
contract). Cheap, but must be allocation-light — this runs every 20ms per call.

### 2. VAD + endpointing — **the hardest problem**

Deciding _when the caller has finished speaking_ governs everything. Too eager →
we interrupt them. Too slow → dead air, feels laggy. "Commit on silence AND STT
final" is wrong — it either adds latency or deadlocks if one signal never
arrives. The real design is a small state machine with explicit ownership:

1. **Local VAD raises a tentative EOU** when speech is followed by silence ≥
   threshold (start ~300ms, tunable, traced). This is the _fast_ signal and it
   drives perceived latency.
2. **STT final confirms the text.** If the STT final lands at/near the tentative
   EOU, commit immediately with the confirmed transcript.
3. **Max-wait fallback.** If STT final hasn't arrived within a bounded window
   after tentative EOU, commit anyway with the best available transcript
   (latest partial). We never let a missing STT final block the response.
4. **Late STT final updates, never blocks.** A final that arrives after commit
   may correct the transcript in the trace/record, but must not delay or re-fire
   the response.

Every threshold and every actual EOU→commit delay is traced as a measurable
number so endpointing is tuned from data, not vibes.

### 3. Streaming STT

Feed PCM to Deepgram. Surface partials (for live transcript + barge-in context)
and finals (for the LLM). Trace partials and the final separately with timing.

### 4. LLM turn

On end-of-utterance: build messages (system + history + this turn), call the LLM
streaming with tools.

- **TTFT is the latency boss.** Measure it precisely.
- Stream tokens to the **text egress controller** (stage 5) — _not_ straight to
  TTS. Raw token streaming speaks unstable partials and races tool decisions.
- On `tool_call`: gate it _before_ any user-facing speech (the controller must
  not have spoken committed words that the tool result would contradict), speak a
  short **filler** ("let me check that for you…") to cover tool latency, execute
  the tool, feed the result back, continue.

### 5. Text egress controller (commit gating) — **the safety valve**

A small layer between the LLM token stream and TTS. Without it, the loop speaks
half-formed thoughts and can talk before it has decided to call a tool.

- **Buffer until a stable boundary** (phrase/sentence/punctuation) before
  emitting a speakable segment. Never synthesize unstable trailing partials.
- **Gate tool-call decisions** ahead of user-facing speech: if the model is about
  to call a tool, hold speech until that's resolved (or only the filler goes out).
- **Each emitted segment gets a span id** and is attached to its playout span, so
  the trace can align spoken text ↔ audio ↔ timeline exactly.
- Emits segments to TTS as soon as a boundary is reached — gating adds
  correctness, not a full-utterance wait.

### 6. Streaming TTS

Cartesia streaming, fed _segment by segment_ from the egress controller. Measure
**TTFB** (request → first audio byte) per segment. Stream audio chunks straight
to egress; never buffer the whole utterance.

### 7. Egress & playout pacing

PCM 16k → μ-law 8k, chunk into 20ms frames, **pace** them (don't dump). Track a
playout clock. Emit `mark` after each utterance so we know when playout truly
ended.

### 8. Barge-in / interruption — **the second hardest problem**

While the agent is speaking, keep the input path hot — but raw VAD during playout
is a false-positive magnet (line echo, background noise, the agent's own audio
bleeding back). Barge-in must clear a higher bar than "any input energy":

- **Min speech duration** — sustained speech, not a blip.
- **Energy threshold above the current playout level** — must exceed the echo
  floor we're producing, not just silence.
- **Optional STT partial confirmation** — a partial transcript corroborates real
  speech for ambiguous cases.
- On a confirmed barge-in:
  1. send Twilio `clear` (instant flush) — target **≤ 100ms** speech → silence
  2. cancel in-flight TTS and LLM, and the egress controller's pending segments
  3. discard the cancelled output; record how much was discarded
  4. relisten
- **Trace false positives too**: every barge-in candidate that we _reject_ (and
  why) is recorded, so we can tune the thresholds from data.
- Interruption policy already modeled in contracts (`InterruptionPolicy`).

### 9. State, slots, memory

Track conversation state across turns (party size, time, name → filled slots).
Use session memory for within-call facts. State transitions are traced.

### 10. Teardown

Agent says goodbye → hang up → finalize the turn, the session (terminal state),
flush traces, audio buffers, and the per-call artifact manifest (see Artifacts &
privacy). Clean, deterministic close.

## Latency budgets (targets, measured per stage)

A single budget can't fairly cover both normal turns and tool turns — a tool's
latency would either blow the budget or get hidden. We track them separately.

**Per-stage components**

| Segment                           | Target p50 | Target p95 |
| --------------------------------- | ---------- | ---------- |
| Endpoint delay (silence → commit) | 300 ms     | 500 ms     |
| STT final (after endpoint)        | 100 ms     | 150 ms     |
| LLM TTFT                          | 400 ms     | 700 ms     |
| TTS TTFB                          | 150 ms     | 300 ms     |
| Transport/playout overhead        | 100 ms     | 150 ms     |

**Normal turn**

| Metric                    | Target p50   | Target p95  |
| ------------------------- | ------------ | ----------- |
| **EOU → first audio out** | **≤ 800 ms** | **≤ 1.2 s** |

**Tool turn** (two budgets, because the tool sits in the middle)

| Metric                                               | Target p50 | Target p95 |
| ---------------------------------------------------- | ---------- | ---------- |
| EOU → filler first audio                             | ≤ 800 ms   | ≤ 1.2 s    |
| tool start → continuation first audio (final answer) | ≤ 1.0 s    | ≤ 1.8 s    |

**Interruption (any turn)**

| Metric                             | Target p50 | Target p95 |
| ---------------------------------- | ---------- | ---------- |
| Barge-in: speech → our audio stops | ≤ 100 ms   | ≤ 150 ms   |

These are not aspirational footnotes — they are acceptance criteria. The trace
viewer (companion doc) reports them per turn, tagged by turn type, and per call.

## What "perfect" means (acceptance criteria)

1. A real inbound call connects, converses naturally, and completes.
2. End-of-utterance → first-audio meets the p50/p95 budget above.
3. Barge-in feels instant (≤100ms to silence) and the agent recovers cleanly.
4. A tool call happens mid-conversation, covered by a filler, with no awkward gap.
5. Slots fill correctly across turns; the agent never re-asks a known answer.
6. Provider/network failures degrade gracefully (timeout, one retry, spoken
   fallback) — never a silent dead call.
7. Every one of the above is fully visible in the trace for that call, after the
   fact and live.

## What it emits (contract with the observability layer)

The loop populates **Turns** (currently never populated) and emits, per turn, a
correlated span set the viewer turns into a waterfall, bracketed by an explicit
turn span:

`turn.started → speech.started → speech.ended → stt.partial* → stt.final →
llm.started → llm.token* → llm.completed (or tool.queued → tool.started →
tool.completed) → [egress segment(s)] → tts.started → tts.chunk* → tts.completed
→ audio.output.started → audio.output.ended → turn.ended`

plus `barge_in.detected / interrupt.handled / output.cancelled` when interrupted.

Every emitted event MUST carry, beyond the existing fields:

- `spanId` + `parentSpanId` — explicit span graph (don't rely on `turnId` +
  `parentEventId` alone; overlapping LLM stream / filler TTS / tool / playout /
  barge-in make that ambiguous).
- `correlationId` — groups a logical unit across events (one playout, one tool
  invocation, one audio segment from the egress controller).
- `timestamp` (wall-clock, for display) **and** `monotonicOffsetMs` (offset from
  session/call start, for latency math). Wall-clock alone is not trustworthy for
  waterfalls.

These are additions to the `@tvic/core` `TraceEvent`/`MediaEvent` contracts and
must be frozen before build. The authoritative list is the **v0.3 Freeze Delta**
in [runtime-contracts.md](./runtime-contracts.md#v03-freeze-delta-realtime-loop--observability--source-of-truth);
this doc defers to it. Derived metrics and span semantics live in
[observability-plan.md](./observability-plan.md). The loop's job is to emit these
with accurate monotonic timing and correct span linkage so the waterfall is real,
not approximated.

## Artifacts & privacy (loop responsibility, from day one)

Click-word-to-audio is a v1 viewer feature, so the loop must write audio refs and
artifacts from the first call — not as a later add-on. Per-call local artifact
layout:

```
calls/<callId>/
  call.jsonl       # ordered TraceEvents for the call
  input.pcm        # normalized caller PCM (16k s16le)
  output.pcm       # normalized agent PCM (16k s16le)
  manifest.json    # maps payloadRefs → {file, byteRange, monotonicOffsetMs, durationMs}
```

The manifest is what lets the viewer align a span/word to an exact byte range and
moment. Audio refs in traces point into this manifest; audio is never inlined.

**Privacy is a runtime requirement, not a later feature** — we are about to store
transcripts and call audio:

- **Recording consent mode** — per-agent/per-call: record / don't record.
- **Do-not-persist-audio mode** — keep traces + transcript, drop audio bytes.
- **PII redaction hooks** — redact transcript/trace fields before persistence.
- **Retention config** — TTL on artifacts; deletion path.

These imply a recording/privacy policy on the `Agent` contract; see the **v0.3
Freeze Delta** in [runtime-contracts.md](./runtime-contracts.md#v03-freeze-delta-realtime-loop--observability--source-of-truth).

## Sequencing

1. **Media plane skeleton** — WS server, Twilio handshake, echo PCM round-trip
   (prove the transport, μ-law↔PCM, pacing, `mark`/`clear`).
2. **One-way understanding** — ingress → VAD/endpoint → Deepgram → transcript +
   turns + traces. No speaking yet.
3. **One full turn** — add LLM (no tools) → Cartesia → playout. First real
   spoken exchange. Hit the latency budget.
4. **Barge-in** — interruption handling to spec.
5. **Tool call + filler** — `check_availability`, mid-turn, covered.
6. **Slots, memory, teardown** — full reservation flow.
7. **Hardening** — failure/retry/fallback, reconnection, the acceptance pass.

Traces are emitted from step 1 — observability is not a later phase.

## Non-goals for this loop

- No second provider in any slot.
- No outbound calling (unless D2 flips).
- No multi-language, no warm transfer, no IVR/DTMF menus.
- No dashboard auth/billing/tenancy.
- No generic workflow engine — this one flow is hand-built.

## Open questions

1. VAD: library-based (e.g. WebRTC/Silero-class) vs Deepgram-native endpointing
   only? Start with both signals; measure which wins.
2. Filler strategy: fixed phrase vs model-generated short ack? Start fixed.
3. How much audio do we persist for replay, and where? (See observability doc.)
