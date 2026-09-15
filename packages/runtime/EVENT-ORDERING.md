# Event ordering guarantees (Team 2, R2-02)

Source: `packages/runtime/src/voice-event.ts`, `pipeline-loop.ts:311-358`, `dual-protocol-result.ts`.

## Per-turn base order (audio interleaves, red P1-06)

```text
turn_started
transcript_delta(isFinal:true)
([tool_call -> tool_result] sequential pairs, never interleaved)
turn_completed{status,latencyMs}   // exactly once per started turn
```

`audio_output{sequence 1..N contiguous per turn}` may appear ANYWHERE after `turn_started`: incremental TTS emits while the LLM streams and across tool continuation, so audio can precede `tool_call` and resume after `tool_result`. Tests assert micro-order only for `turn_started->transcript_delta`, tool-pair sequencing, per-turn audio contiguity, and exactly-once `turn_completed`.

`public has no partials`: `ConversationPolicy` drops `stt.partial`; only committed finals reach `VoiceEvent` (T1-signed).

## Session order

```text
(turn spans in turnSequence order, serialized on #turnChain)
call_ended{reason,totalTurns}   // always last
```

`totalTurns = turnsHandled` (started turns). `call_ended` is pushed before queue close and before promise settlement. No events are emitted after settlement (`#runEvents` is cleared in `finally`). The run-events queue is bounded at 1,024. On overflow, the queue fails with `voice_runtime.events_overflow`; awaiters reject with it and iterators throw it. Buffered events are superseded by the terminal failure. `call_ended` is intentionally omitted on overflow. Consumer-initiated close (break or abort) is not overflow: late events are dropped because cancellation has already been requested. `push() === false` is never silently dropped.

## Dual error payloads (locked by R2-08)

Iterators observe normalized `NormalizedError`; awaiters reject with the SAME normalized value (R2-08 MUST, no waiver). Mid-turn `error{recoverable}` (turn failure, unknown tool) and recoverable TTS warnings may interleave anywhere within the turn span.

## Sharing + break race

`loop.start()` caches one `DualProtocolResult`: await and iteration share one run. Break (`return()`) cancels via `supervisor.abort()`; late events after consumer close are dropped and the await side rejects with `cancelled`. The event stream has one live iterator. A second concurrent iterator throws `voice_runtime.events_already_consumed`; events are never split between consumers. Awaiting concurrently is always safe.
