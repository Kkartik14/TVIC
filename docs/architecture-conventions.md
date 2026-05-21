# T-vic Architecture Conventions & Refactor Punch-List

Status: actionable map (write code against this)
Goal: DRY monorepo-wide, clean layering (MVC-adapted), an explicit DAL. No fact or
helper defined twice; business logic separated from transport/plumbing; persistence
behind interfaces.

## Target layering

For an SDK/runtime (not a web app), MVC maps to five layers. Each has exactly one home.

| Layer                               | Responsibility                                                                                                             | Home                                                        | Must NOT contain                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Domain (Model)**                  | Entities + pure domain logic: state-machine transitions, policy decisions, terminal-state derivation, endpointing decision | `@tvic/core` (types) + `@tvic/core/domain` (pure functions) | I/O, persistence, provider calls, trace I/O                            |
| **DAL**                             | Persistence behind interfaces: sessions, turns, tool calls, traces, memory, artifacts                                      | `@tvic/core` (interfaces) + `@tvic/dal` _(new)_ impls       | orchestration, business rules                                          |
| **Controller (Orchestration)**      | Coordinate domain + DAL + adapters; the runtime + the voice loop                                                           | `@tvic/runtime`                                             | inline persistence, inline trace serialization, provider-specific code |
| **View (Serialization/Projection)** | Build/emit/export `TraceEvent`s, JSONL, manifest, the waterfall projection                                                 | `@tvic/tracing`                                             | business decisions, orchestration                                      |
| **Adapters (Transport)**            | Provider integrations; split transport plumbing from domain mapping                                                        | `@tvic/providers`                                           | runtime state, persistence                                             |
| **Shared constants/config**         | Provider ids, error codes, audio formats, defaults                                                                         | `@tvic/core/constants`                                      | logic                                                                  |

Rule of thumb: **a string literal or magic number that two files both know is a constant; a function two files both contain is a util; a `Map` a controller owns is a DAL.**

---

## 1. Monorepo-wide constants (DRY) — create `@tvic/core/constants.ts`

Today the same facts are re-declared per service. Centralize, then import.

### 1a. The normalized audio format `{ pcm_s16le, 16000, 1 }` — repeated 12+ times

Define once: `export const PCM16_16K_MONO: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };`
Replace at:

- `packages/providers/src/twilio.ts:39` (`TWILIO_NORMALIZED_FORMAT`)
- `packages/providers/src/deepgram.ts:26` (`DEEPGRAM_PCM_FORMAT`)
- `packages/providers/src/cartesia.ts:31` (`CARTESIA_PCM_FORMAT`)
- tests: `packages/runtime/test/runtime.test.ts:35-36`, `packages/providers/test/providers.test.ts:29,50,109,141,179`, `packages/tracing/test/tracing.test.ts:106`, `packages/media/test/media.test.ts:30`

### 1b. Magic sample rates — `8000` (PSTN/telephony) and `16000` (runtime normalized)

Define: `export const TELEPHONY_SAMPLE_RATE_HZ = 8000;` and `export const RUNTIME_SAMPLE_RATE_HZ = 16000;`
Replace the bare literals at:

- `packages/providers/src/twilio.ts:152,154,155,276` (the μ-law↔PCM resample chain)
- `packages/providers/src/{deepgram,cartesia}.ts` format decls (via 1a)

### 1c. Provider identities — `*_PROVIDER_NAME` scattered per file

Define: `export const PROVIDER_NAMES = { twilio: "twilio-media-streams", deepgram: "deepgram", cartesia: "cartesia", openaiResponses: "openai-responses" } as const;`
Replace declarations at:

- `packages/providers/src/twilio.ts:38`
- `packages/providers/src/deepgram.ts:25`
- `packages/providers/src/cartesia.ts:29`
- `packages/providers/src/openai-responses.ts:24`

### 1d. Provider error codes — `*_ERROR_CODE` scattered

Define: `export const PROVIDER_ERROR_CODES = { twilioMedia: "twilio.media_stream.error", deepgramStt: "deepgram.stt.error", cartesiaTts: "cartesia.tts.error", openaiResponses: "openai.responses.error", openaiHttp: "openai.http_error", openaiResponseFailed: "openai.response.failed" } as const;`
Replace at:

- `packages/providers/src/deepgram.ts:23`
- `packages/providers/src/cartesia.ts:27` and the literal at `:204`
- `packages/providers/src/openai-responses.ts:22` and literals at `:164,217`
- `packages/providers/src/twilio.ts:324` (inline `"twilio.media_stream.error"`)

### 1e. Tunables that are currently magic literals

- Deepgram `endpointing=300`, `vad_events`, `punctuate` in `deepgram.ts` `open()` — move defaults to constants (`DEFAULT_ENDPOINTING_MS = 300`) so the loop plan's "tunable, traced" promise is real.
- Default models (`nova-3`, `sonic-3`, gpt list) and Cartesia API version `2026-03-01` (`cartesia.ts:30`) — `PROVIDER_DEFAULTS`.

> Note: provider **URLs and API keys stay as per-instance config** (constructor options), not global constants — they are deployment config, not shared facts.

---

## 2. DAL — make persistence explicit (no `Map`s in the controller)

Today `InMemoryRuntime` owns raw `Map`s and parallel side-tables; that is a DAL smell.

### 2a. Already-correct DAL contracts (the pattern to follow)

- `TraceStore` (`packages/core/src/trace.ts`) ✓
- `Memory` (`packages/core/src/memory.ts`) ✓
  These prove the shape: interface in core, impl elsewhere. Mirror it for the rest.

### 2b. Missing DAL contracts — add to `@tvic/core`

Define `SessionStore`, `TurnStore`, `ToolCallStore` (get/put/list-by-session/update). Then move these out of the controller:

- `packages/runtime/src/create-runtime.ts:150-152` — `#sessions`, `#turns`, `#toolCalls` Maps → behind stores.
- `packages/runtime/src/create-runtime.ts:156-162` — `#sessionStartMs`, `#sessionSpanIds`, `#sessionCorrelationIds`, `#turnStartMs`, `#turnSpanIds`, `#turnCorrelationIds` — these parallel Maps are **session/turn runtime metadata**; fold them into the stored Session/Turn record (or a `SessionRuntimeState` record in the store), not six side-tables keyed by id.

### 2c. New package `@tvic/dal`

In-memory implementations of all stores (`InMemorySessionStore`, etc.), plus re-home the existing in-memory impls so storage lives in one layer:

- move `InMemoryTraceStore` + `LocalCallArtifactWriter` from `packages/tracing/src/index.ts` **or** keep tracing as the View layer and have it depend on `@tvic/dal`. Pick one; document it.
- move `InMemoryMemory` (`packages/memory/src/index.ts`) under the DAL umbrella.
  The runtime then depends only on the **interfaces**, so swapping in Postgres later touches zero controller code.

---

## 3. View / Serialization — pull trace-building out of the controller

These pure "shape a TraceEvent" functions live inside the orchestrator today. Move to
`@tvic/tracing` (or `@tvic/runtime/src/trace-projection.ts`):

- `packages/runtime/src/create-runtime.ts:653` `sessionEndTrace`
- `packages/runtime/src/create-runtime.ts:598` `turnEndTrace`
- `packages/runtime/src/create-runtime.ts:707` `mediaEventTrace`
- `packages/runtime/src/create-runtime.ts:858` `mediaError`
- `packages/runtime/src/create-runtime.ts:867` `withParentSpan`
- the inline `session.created` / `session.started` / `turn.started` event literals in `startSession`/`startTurn` (`create-runtime.ts:233-255, 354-367`) → builder functions in the projection module.

Same in the loop:

- `packages/runtime/src/pipeline-loop.ts:446` `#traceCore`, `:363` `#emitLlmEvent`, `:418` `#emitSttFinal` — these are projection, not loop logic.

---

## 4. Domain (Model) — pure transitions out of the controller

Terminal-state derivation is pure domain logic; move to `@tvic/core/domain` (or co-locate with the entity):

- `packages/runtime/src/create-runtime.ts:637` `terminalSessionFromRequest`
- `packages/runtime/src/create-runtime.ts:564` `terminalTurnFromRequest`
- `packages/runtime/src/create-runtime.ts:871` `isTerminalSession`, `:877` `isTerminalTurn` (guards belong next to `Session`/`Turn` in core, like we just did for `isDtmfDigit`/`isNormalizedError`)

In the loop, separate **conversation/business logic** from **orchestration**:

- `packages/runtime/src/pipeline-loop.ts:57` system-prompt assembly, `:53` `#finalTranscriptBuffer`, `#history` management, `:438` `#findTool` (tool selection) = **domain**.
- transcript-consume / speak / barge-in wiring (`:101 #consumeTranscripts`, `:284 #speak`, `:160 #runLlm`, `:197 #executeToolCalls`) = **controller**.
  Split `PipelineVoiceLoop` into a `ConversationPolicy` (domain: given transcript+history → decide say/call-tool) and the loop (controller: wire STT→policy→TTS, handle interruption). This is the single most important separation for testability — you can unit-test the policy with no sockets.

---

## 5. Kill the triplicated infra utils (DRY)

Three counter id-generators, two trace emitters, two monotonic helpers:

- **Id generation (3 copies):** `PrefixIdGenerator` (`create-runtime.ts:68`), `ProviderEventIdFactory` (`providers/src/common.ts:13`), `LoopIds` (`pipeline-loop.ts:480`). Collapse to one: a `counterIdGenerator(prefix)` util in a shared place, and have the loop **receive the runtime's injected `IdGenerator`** instead of making its own.
- **Trace emit fan-out (store.append + handlers + exporters) (2 copies):** `create-runtime.ts:#emit` and `pipeline-loop.ts:442 #emit`. Extract one `TraceEmitter` (View layer) injected into both.
- **Monotonic offset (2 copies):** `create-runtime.ts:486 #monotonicOffsetMs` and `pipeline-loop.ts:463 #monotonicMs`. One `SessionClock`/monotonic helper shared.
- **Error builders:** `providerError`, `mediaError`, `internalError`, `validationError`, and `timeoutError` now live in `@tvic/core/errors`; package-local aliases should not be reintroduced.

---

## Suggested execution order (safe, incremental, gates green each step)

1. **`@tvic/core/constants.ts`** (§1) — pure additions, then replace literals package-by-package. Zero behavior change; easiest win, biggest readability gain.
2. **Move guards/pure domain to core** (§4 guards) — `isTerminalSession/Turn`, terminal derivation. Pure, well-tested.
3. **Extract View** (§3) — trace-projection module; runtime imports it. Behavior-preserving.
4. **Unify infra utils** (§5) — one id gen / emitter / monotonic; inject into the loop.
5. **DAL interfaces + `@tvic/dal`** (§2) — biggest change; do last, behind interfaces, so the controller diff is just "Map → store".
6. **Split the loop into ConversationPolicy + controller** (§4) — unlocks unit-testing the business logic.

## Enforcement (so it doesn't drift back)

- `pnpm lint` now runs `prettier --check`, `pnpm typecheck`, and `scripts/check-architecture.mjs`.
- `scripts/check-architecture.mjs` enforces package import boundaries: `@tvic/core` imports no siblings, `@tvic/dal` only imports `@tvic/core`, `@tvic/tracing` imports only core/DAL, media/tools import only core, memory imports only core/DAL, providers import only core/media, and runtime imports only core/DAL/media/tools/tracing.
- The same architecture check rejects re-declaring the normalized `{ pcm_s16le, 16000, 1 }` format outside `@tvic/core/constants.ts`; callers must import `PCM16_16K_MONO`.
